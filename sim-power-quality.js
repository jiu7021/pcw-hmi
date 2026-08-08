/* =============================================================================
 * sim-power-quality.js — 전력품질 감시 계층 (sim-electrical.js의 모선전압을
 * 입력으로 받는다. 파형 시뮬레이션이 아니라 RMS 준정적 근사 — sim-electrical.js
 * 상단 주석 참조).
 *
 * "제어 주기보다 훨씬 짧게" 샘플링하라는 요구를 만족시키기 위해, 5ms 간격
 * (200Hz 상당, 실제 전력품질 계측기가 반사이클 단위로 RMS를 재는 것보다도
 * 빠름)으로 목표전압을 향해 전기적 시정수(대표값 10ms)로 수렴해가는 과정을
 * 추적한다. sag의 시작/해소 판정도 그 해상도로 이뤄진다.
 *
 * 목표전압 자체도 이제 5ms마다 새로 들어온다 — sim-electrical.js가
 * updateFast()로 그만큼 촘촘하게 계산해 넘겨주기 때문이다(과거에는 100ms
 * 제어틱마다 한 번만 갱신되는 목표전압을 여기서 5ms로 쪼개 "쫓아가기만"
 * 했는데, 그러면 100ms 안에서 실제로 벌어지는 급격한 변화(돌입전류 등)의
 * 초반부를 통째로 놓친다 — README "검증 결과 — 전기 계층 고속화" 참조).
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
    // 경계값을 그대로 사용. 대응(ESS)도 같은 0.9pu를 본다 — 검출과 대응을
    // 다른 전압 레벨로 나눌 근거가 없다(둘 다 "정상 범위를 벗어났다"는
    // 같은 물리적 사실에 반응하는 것이므로). 다만 "그 사실을 확정해서 로그에
    // 남기는 것"과 "그 사실에 반응해서 보정을 시작하는 것"은 서로 다른
    // 목적을 가진 별개의 타이머다 — 아래 SAG_CONFIRM_MS/ESS_RESPONSE_DELAY_MS 참조.
    SAG_THRESHOLD_PU: 0.9,
    SAG_RECOVER_PU: 0.92,         // 복귀 판정 히스테리시스(채터링 방지, 기존 알람 설계와 동일 사상)
    // 표준상 sag 최소 지속시간 하한은 0.5사이클(60Hz 기준 약 8.3ms). 순간
    // 샘플 잡음으로 인한 오검출을 막기 위해 그 2배 이상 여유를 둔 20ms를
    // 확정 지연으로 사용. 이 지연은 "사람이 보는 로그/알람에 남길 만큼
    // 확실한가"를 판정하는 디바운스이지, ESS가 반응해도 되는 시점과는
    // 무관하다(아래 참조).
    SAG_CONFIRM_MS: 20,
    SAG_RECOVER_CONFIRM_MS: 20,

    // ESS/PCS 무효전력 주입 대응. AVR(OLTC 탭체인저 등)은 의도적으로 쓰지
    // 않는다 — 기계식 탭체인저 응답은 통상 수백ms~수초(1탭 전환에도 초
    // 단위가 걸림)인데, sag 지속시간은 수십ms~수초로 그보다 훨씬 짧아
    // 개입 시점을 놓치는 것이 표준적으로 알려진 한계다. 대신 PCS의 반도체
    // 스위칭 기반 무효전력 제어는 ms 단위로 반응할 수 있어 sag 대응에 쓴다.
    //
    // 이 지연은 "전압이 0.9pu 아래로 내려간 순간부터 PCS 자신의 물리적
    // 반응시간"만 나타낸다 — SAG_CONFIRM_MS(알람 확정용 디바운스)가 끝나기를
    // 기다렸다가 그 위에 추가로 얹는 지연이 아니다. 예전 구현은 ESS 발동
    // 조건을 "sagActive(=이미 확정된 이벤트)가 있고, 그 이벤트가 생성된
    // 뒤로 ESS_RESPONSE_DELAY_MS가 지났는가"로 봤는데, 그러면 실제로는
    // SAG_CONFIRM_MS + ESS_RESPONSE_DELAY_MS = 40ms가 지나야 ESS가 켜진다.
    // PCS는 사람이 보는 알람처럼 디바운스를 거칠 이유가 없는 자동 제어
    // 장치라 이 중복은 근거가 없었다 — 실측 결과 이 중복 때문에 ESS가
    // 이미 전압이 바닥까지 떨어진 뒤에야 켜지는 경우가 있었다(가장 깊은
    // 시나리오에서 83.57%, 즉 최저점에서야 겨우 켜짐 — README 참조).
    // 지금은 SAG_CONFIRM_MS와 완전히 독립적으로, 0.9pu 아래로 내려간 시점
    // 그 자체부터 재는 것으로 고쳤다.
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

  // 한 서브스텝(SAMPLE_MS)만큼 pq 상태를 갱신한다. targetV: 이 서브스텝이
  // 향해 수렴할 목표전압(전기 계층의 순시 근사치) — 100ms 동안 고정된 값을
  // 여러 번 넘겨도(update() 참조) 매번 다른 값을 넘겨도(updateFast 경로,
  // sim-plant.js 참조) 똑같이 동작한다. tSub: 이 서브스텝이 끝나는 시각(절대
  // 시뮬레이션 시각). causeFn: 지연평가 — sag가 새로 확정될 때만 호출한다
  // (매 서브스텝 호출할 필요 없는 계산이라 필요한 순간에만 부른다).
  function updateSubstep(pq, targetV, tSub, causeFn) {
    pq.fastVoltagePu += (targetV - pq.fastVoltagePu) / CONST.VOLTAGE_TAU_S * (CONST.SAMPLE_MS / 1000);

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
          cause: causeFn(),
          essEngageMs: 0,
        };
      }
      // ESS 대응: 로그용 확정(sagActive)과는 독립적으로, "0.9pu 아래로
      // 내려간 시간"(belowThresholdMs)이 PCS 자신의 응답지연을 넘기면 바로
      // 켠다 — sagActive/currentEvent가 아직 없어도(즉 알람이 아직 확정되기
      // 전이라도) 상관없다.
      if (!pq.essActive && pq.belowThresholdMs >= CONST.ESS_RESPONSE_DELAY_MS) {
        pq.essActive = true;
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
      }
      if (pq.essActive && pq.aboveRecoverMs >= CONST.SAG_RECOVER_CONFIRM_MS) {
        pq.essActive = false;
      }
    }
    // 밴드 사이(회색지대, 0.9~0.92pu)에서는 두 타이머 모두 유지 — 채터링 방지.

    if (pq.currentEvent) {
      if (rawV < pq.currentEvent.minVoltagePu) pq.currentEvent.minVoltagePu = rawV;
      if (effectiveV < pq.currentEvent.minEffectiveVoltagePu) pq.currentEvent.minEffectiveVoltagePu = effectiveV;
      if (pq.essActive) pq.currentEvent.essEngageMs += CONST.SAMPLE_MS; // "이 이벤트 동안 ESS가 실제로 켜져 있던 시간"
    }

    return { tOffsetS: tSub, voltagePu: rawV, effectiveVoltagePu: effectiveV, essActive: pq.essActive };
  }

  // dtControlS(기본 0.1) 동안 SAMPLE_MS 간격으로 steps번 나눠 계산한다.
  // 목표전압(elecState.busVoltagePu)은 이 100ms 동안 고정된 값으로 본다 —
  // sim-electrical.js의 update()(100ms 단위 버전)와 짝을 이루는 하위호환
  // 경로다. sim-plant.js는 이걸 쓰지 않고 updateFast 경로(아래 참조)를 쓴다.
  function update(pq, elecState, simTimeS, dtControlS) {
    dtControlS = dtControlS ?? 0.1;
    const dtSub = CONST.SAMPLE_MS / 1000;
    const steps = Math.round(dtControlS / dtSub);
    const targetV = elecState.busVoltagePu;
    const tStart = simTimeS - dtControlS;
    const substeps = [];
    for (let k = 0; k < steps; k++) {
      const tSub = tStart + (k + 1) * dtSub;
      substeps.push(updateSubstep(pq, targetV, tSub, () => classifyCause(elecState)));
    }
    return substeps;
  }

  return { CONST, createPQState, classifyCause, update, updateSubstep };
});
