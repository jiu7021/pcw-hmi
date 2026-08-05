/* =============================================================================
 * sim-power-quality.js — 전력품질 감시 계층 (sim-electrical.js의 모선전압을
 * 입력으로 받는다. 파형 시뮬레이션이 아니라 RMS 준정적 근사 — sim-electrical.js
 * 상단 주석 참조).
 *
 * "제어 주기보다 훨씬 짧게" 샘플링하라는 요구를 만족시키기 위해, 전기 계층이
 * 100ms 제어 틱마다 한 번 계산해주는 busVoltagePu를 "목표치"로 두고, 그 목표치로
 * 전기적 시정수(대표값 10ms)로 수렴해가는 과정 자체를 5ms 간격(200Hz, 제어주기의
 * 1/20)으로 20번 나눠 추적한다. 이렇게 하면 100ms짜리 계단형 신호가 아니라
 * 실제로 매 5ms마다 값이 달라지는 신호를 얻을 수 있고, sag의 시작/해소 판정도
 * 그 해상도로 이뤄진다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PQLayer = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  const CONST = Object.freeze({
    SAMPLE_MS: 5,                 // 200Hz 상당 — 제어주기(100ms)의 1/20
    VOLTAGE_TAU_S: 0.01,          // 모선전압이 목표치로 수렴하는 전기적 시정수 대표값(10ms) —
                                   // 100ms 제어주기보다 한 자릿수 빨라, 5ms 샘플링이 실제로
                                   // 의미있는 해상도를 갖도록 하는 설계상의 선택(가정치)

    // IEEE 1159(전력품질 권장관행): sag(순간전압강하) = RMS전압이 정격의
    // 10~90% 범위로 0.5사이클~1분간 지속되는 현상. 임계 0.9pu는 그 표준
    // 경계값을 그대로 사용.
    SAG_THRESHOLD_PU: 0.9,
    SAG_RECOVER_PU: 0.92,         // 복귀 판정 히스테리시스(채터링 방지, 기존 알람 설계와 동일 사상)
    // 표준상 sag 최소 지속시간 하한은 0.5사이클(60Hz 기준 약 8.3ms). 순간
    // 샘플 잡음으로 인한 오검출을 막기 위해 그 2배 이상 여유를 둔 20ms를
    // 확정 지연으로 사용.
    SAG_CONFIRM_MS: 20,
    SAG_RECOVER_CONFIRM_MS: 20,

    // ESS/PCS 무효전력 주입 대응. AVR(OLTC 탭체인저 등)은 의도적으로 쓰지
    // 않는다 — 기계식 탭체인저 응답은 통상 수백ms~수초(1탭 전환에도 초
    // 단위가 걸림)인데, sag 지속시간은 수십ms~수초로 그보다 훨씬 짧아
    // 개입 시점을 놓치는 것이 표준적으로 알려진 한계다. 대신 PCS의 반도체
    // 스위칭 기반 무효전력 제어는 ms 단위로 반응할 수 있어 sag 대응에 쓴다.
    ESS_RESPONSE_DELAY_MS: 20,     // PCS 스위칭 대역 기준 대표값
    ESS_MITIGATION_FRACTION: 0.5,  // ESS 무효전력 용량이 유한하다는 가정하에, 편차의 50%만 상쇄(대표값)

    VOLTAGE_MANAGEMENT_FLOOR_PU: 0.85, // 관리한계(대표값) — 검증 스위트 INV8이 이 값을 그대로 참조
  });

  function createPQState() {
    return {
      fastVoltagePu: 1.0,      // RC 수렴만 반영한 "raw" 전압(ESS 보정 전)
      belowThresholdMs: 0,
      aboveRecoverMs: 0,
      sagActive: false,
      essActive: false,
      currentEvent: null,       // {startSimS, minVoltagePu, cause, essEngageMs}
      eventLog: [],             // 완료된 sag 이벤트(최신이 앞)
    };
  }

  function classifyCause(elecState) {
    const total = elecState.internalDropPu + elecState.externalGridDropPu;
    if (total <= 1e-6) return 'UNKNOWN';
    const internalFrac = elecState.internalDropPu / total;
    if (internalFrac >= 0.7) return 'INTERNAL_LOAD_START'; // 구내 대부하 기동
    if (internalFrac <= 0.3) return 'GRID_SIDE_FAULT';       // 계통측 사고
    return 'COMBINED';
  }

  // dtControlS(기본 0.1) 동안 SAMPLE_MS 간격으로 substeps번 나눠 계산한다.
  // 반환값에 substeps 배열(각 {tOffsetS, voltagePu, effectiveVoltagePu})을 담아
  // 돌려준다 — 화면의 고속 트렌드는 이 substep 배열을 그대로 이어붙여 그린다
  // (표시용 버퍼는 이 모듈이 들고 있지 않는다, sim-core.js의 uiTrend와 동일한 설계 원칙).
  function update(pq, elecState, simTimeS, dtControlS) {
    dtControlS = dtControlS ?? 0.1;
    const dtSub = CONST.SAMPLE_MS / 1000;
    const steps = Math.round(dtControlS / dtSub);
    const targetV = elecState.busVoltagePu;
    const tStart = simTimeS - dtControlS;
    const substeps = [];

    for (let k = 0; k < steps; k++) {
      const tSub = tStart + (k + 1) * dtSub;
      pq.fastVoltagePu += (targetV - pq.fastVoltagePu) / CONST.VOLTAGE_TAU_S * dtSub;

      // 중요: sag 발생/해소 판정은 반드시 "보정 전(raw)" 전압으로만 한다.
      // ESS가 보정한 effectiveV로 판정하면, ESS가 개입해 electiveV를 문턱 위로
      // 올리는 순간 "해소"로 판정되어 ESS가 꺼지고, 그러면 electiveV가 다시
      // raw 수준으로 떨어져 즉시 "재발생"하는 자기잠식 채터링이 생긴다
      // (개발 중 실제로 관측하고 고친 문제 — README 검증 결과 참조).
      const rawV = pq.fastVoltagePu;
      const deficit = 1 - rawV;
      const effectiveV = pq.essActive ? (1 - deficit * (1 - CONST.ESS_MITIGATION_FRACTION)) : rawV;

      if (rawV < CONST.SAG_THRESHOLD_PU) {
        pq.belowThresholdMs += CONST.SAMPLE_MS;
        pq.aboveRecoverMs = 0;
        if (!pq.sagActive && pq.belowThresholdMs >= CONST.SAG_CONFIRM_MS) {
          pq.sagActive = true;
          pq.currentEvent = {
            startSimS: +(tSub - CONST.SAG_CONFIRM_MS / 1000).toFixed(4),
            minVoltagePu: rawV,
            minEffectiveVoltagePu: effectiveV,
            cause: classifyCause(elecState),
            essEngageMs: 0,
          };
        }
      } else if (rawV >= CONST.SAG_RECOVER_PU) {
        pq.aboveRecoverMs += CONST.SAMPLE_MS;
        pq.belowThresholdMs = 0;
        if (pq.sagActive && pq.aboveRecoverMs >= CONST.SAG_RECOVER_CONFIRM_MS) {
          pq.sagActive = false;
          pq.currentEvent.endSimS = +tSub.toFixed(4);
          pq.currentEvent.durationS = +(pq.currentEvent.endSimS - pq.currentEvent.startSimS).toFixed(4);
          pq.eventLog.unshift(pq.currentEvent);
          if (pq.eventLog.length > 200) pq.eventLog.length = 200;
          pq.currentEvent = null;
          pq.essActive = false;
        }
      }
      // 밴드 사이(회색지대, 0.9~0.92pu)에서는 두 타이머 모두 유지 — 채터링 방지.

      if (pq.sagActive && pq.currentEvent) {
        if (rawV < pq.currentEvent.minVoltagePu) pq.currentEvent.minVoltagePu = rawV;
        if (effectiveV < pq.currentEvent.minEffectiveVoltagePu) pq.currentEvent.minEffectiveVoltagePu = effectiveV;
        pq.currentEvent.essEngageMs += CONST.SAMPLE_MS;
        if (!pq.essActive && pq.currentEvent.essEngageMs >= CONST.ESS_RESPONSE_DELAY_MS) {
          pq.essActive = true;
        }
      }

      substeps.push({ tOffsetS: tSub, voltagePu: rawV, effectiveVoltagePu: effectiveV });
    }

    return substeps;
  }

  return { CONST, createPQState, classifyCause, update };
});
