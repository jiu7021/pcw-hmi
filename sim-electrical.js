/* =============================================================================
 * sim-electrical.js — 전동기·전기 계층 (순수 계산 모듈, sim-core.js와 무관하게
 * 독립적으로 단위테스트 가능하다. sim-core.js의 pump 객체를 "읽기 전용"으로만
 * 참조하고, 트립 여부는 boolean으로만 보고한다 — 실제로 SimCore.faultPump()를
 * 호출하는 것은 오케스트레이터(sim-plant.js)의 책임이다(계층 간 단방향 의존).
 *
 * 급전 모드(corePump.feedMode, sim-core.js가 관리)에 따라 기동 특성이 완전히
 * 다르다:
 *   - VFD(정상): 소프트스타트 — 램프+전류제한으로 돌입전류가 사실상 거의 없다
 *     (통상 정격의 110~150%). 속도 제어 가능.
 *   - BYPASS(VFD 고장 시 상용전원 직입, DOL): 소프트스타트가 없어 돌입전류가
 *     정격의 5~7배에 달한다(유도전동기의 잘 알려진 표준 특성). 속도 제어
 *     불가 — 사실상 정격속도 고정.
 * "동시 기동 금지" 인터록이 실제로 막아야 하는 위험한 상황은 VFD 정상 기동이
 * 아니라 **바이패스(DOL) 기동이 두 대 이상 겹치는 경우**다 — 이 계층의 목적은
 * 그 인과관계를 수치로 드러내는 것이다. 파형(순시치) 시뮬레이션이 아니라
 * RMS 도메인 준정적 근사이며, 이는 sim-power-quality.js에서도 동일하게
 * 적용되는 전제다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ElecLayer = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  const CONST = Object.freeze({
    // ---------- 전동기 운전전류 모델 ----------
    // I_pu = 무부하전류비율 + (1-무부하전류비율) × speedFrac²
    // 전동기 동력은 속도의 세제곱(펌프 affinity law)에 비례하지만, 전류는
    // 동력이 아니라 "토크"에 비례한다(전기적으로 부하전류-토크 관계가 지배적,
    // 자속이 일정하면 전류∝토크). 동력=토크×속도이므로 토크=동력/속도∝speed³/speed
    // =speed² — 그래서 부하전류 성분은 speed³가 아니라 speed²에 비례하도록 잡았다.
    MOTOR_NO_LOAD_CURRENT_FRAC: 0.35, // 유도전동기 무부하전류/정격전류 통상범위(25~40%대)의 대표값(가정치)

    // ---------- 돌입전류 — 급전모드(VFD/BYPASS)에 따라 완전히 다르다 ----------
    // VFD 정상 기동: 소프트스타트(가감속 램프 + 전류제한)로 돌입이 사실상 거의
    // 없다는 것이 VFD의 잘 알려진 특성 — 통상 정격의 110~150% 범위, 중간값 대표.
    INRUSH_MULTIPLIER_VFD: 1.3,
    // 바이패스(VFD 고장 시 상용전원 직입, DOL) 기동: 소프트스타트가 전혀 없어
    // 돌입전류가 정격의 5~7배에 달한다는 것이 유도전동기의 표준적으로 알려진
    // 특성(NEMA/IEC 문헌에서 흔히 인용되는 범위) — 중간값 6배를 대표값으로 채택.
    INRUSH_MULTIPLIER_BYPASS: 6.0,
    INRUSH_DECAY_TAU_S: 0.5,      // 돌입전류 감쇠 시정수 — 통상 수백ms~1s 내 소멸한다는 통념(가정치)

    // ---------- 모선(전원 임피던스) 모델 ----------
    // V_pu = 1 - BUS_SOURCE_REACTANCE_PU × I_total_pu (I_total_pu 기준: 펌프
    // 1대 정격전류 = 1.0). 파형이 아니라 RMS 준정적 근사. 계수는 아래 세
    // 대표 동작점이 나오도록 역산한 값(가정치):
    //   · VFD 3대 전부 정격 동시운전(I=3.0): 강하 4.5% → 건전한 모선(VFD
    //     정상 운전에서는 돌입이 작아 이런 강하가 사실상 발생하지 않는다)
    //   · VFD 2대 정격운전 중 1대가 바이패스(DOL)로 기동(I=1+1+6=8.0):
    //     강하 12% → 전압 88%, IEEE1159 sag 경계(90%) 아래 — 바이패스
    //     기동 "한 대"는 인터록이 지켜지는 정상적 절체 상황이며 관리한계
    //     (85%)는 지킨다.
    //   · (인터록을 일부러 우회했다고 가정) VFD 1대 운전 중 바이패스 2대가
    //     동시 기동(I=1+6+6=13.0): 강하 19.5% → 전압 80.5%, 관리한계(INV8,
    //     85%) 아래로 떨어져 "바이패스 동시기동 금지가 왜 필요한지"를
    //     수치로 증명한다. VFD 정상 기동끼리는 이 문제가 원천적으로 없다.
    BUS_SOURCE_REACTANCE_PU: 0.015,

    // ---------- 과부하 보호 (열적 레플리카, IEC 60255-8 개념 τ·dθ/dt=(I/Ip)²-θ) ----------
    // Ip(트립 설정전류)는 정격의 115%(서비스팩터 1.15 통상값을 트립 마진으로
    // 사용하는 일반적 현장 관행) — 그래야 연속 정격운전(I_pu=1.0)에서 열상태가
    // θ_ss=(1/1.15)²≈0.76로 100% 미만에 정착해 오동작(nuisance trip)이 없다.
    // τ는 NEMA/IEC 통상 트립등급 Class 10(정격 600%에서 냉간 10초 이내 트립)
    // 조건 1=(6/1.15)²(1-e^(-10/τ))을 풀어 역산: τ≈267s.
    THERMAL_TRIP_PICKUP_PU: 1.15,
    THERMAL_TRIP_TAU_S: 267,
    THERMAL_TRIP_LEVEL: 1.0,

    // ---------- 결상(단상 운전) 보호 ----------
    // 결상 시 잔여 상전류가 동일 부하를 유지하려 하며 상승하는 정도를 전력
    // 삼각형 관계상 대표값 √3(≈1.73)배로 근사(가정치). 결상은 방치하면 잔여
    // 권선을 빠르게 손상시키므로, 열적 과부하 곡선(느림)과 별도로 훨씬 빠른
    // 전용 판정을 쓰는 것이 현장 관행 — 확인지연은 대표값(가정치).
    PHASE_LOSS_CURRENT_MULT: 1.73,
    PHASE_LOSS_TRIP_DELAY_S: 0.5,

    // ---------- 고속 서브스텝(모선전압) ----------
    // 기존에는 이 계층이 제어주기(100ms)마다 한 번만 갱신됐다. 문제는 돌입전류
    // 지수감쇠(INRUSH_DECAY_TAU_S=0.5s)가 100ms 안에서도 크게 변하는데, 100ms에
    // 한 번만 계산하면 그 첫 100ms 구간 안의 최저점(돌입 순간에 가장 가까운
    // 값)을 아예 못 보고 건너뛴다 — 실측 결과 바이패스(DOL) 동시기동 시 이미
    // 첫 제어틱(t=0.1s)에 모선전압이 최저치(83.57%)까지 내려가 있었다(README
    // "검증 결과" 참조). 실제 전력품질 계측기가 반사이클 단위(50Hz 기준 10ms,
    // 60Hz 기준 8.33ms)로 RMS를 재는 것이 업계 통념이므로, 그보다도 빠른
    // 5ms(기존 sim-power-quality.js SAMPLE_MS와 동일 해상도로 맞춤 — 두 계층이
    // 서로 다른 시간축으로 어긋나지 않게)로 이 계층도 서브스텝을 돈다.
    FAST_SAMPLE_MS: 5,
  });

  function createElecState() {
    return {
      pumps: [1, 2, 3].map(id => ({
        id,
        currentPu: 0,
        thermalState: 0,          // 0~1(=100%), 1에서 과부하 트립
        mechanicalOverloadMult: 1.0, // 테스트/데모 훅: 기계적 과부하(베어링 등)를 흉내내는 배수
        phaseLossInjected: false,
        phaseLossConfirmTimer: 0,
        tripped: false,
        tripReason: null,          // 'OVERLOAD' | 'PHASE_LOSS' | null
      })),
      busVoltagePu: 1.0,
      totalCurrentPu: 0,
      internalDropPu: 0,           // 자체 전류로 인한 강하분(원인 분류에 사용)
      externalGridDropPu: 0,       // 외부(계통측) 주입 강하분 — 기본 0, 테스트/UI가 설정
    };
  }

  // corePump: sim-core.js pump 객체(status, speedPct, startTimer, fault, feedMode)를 읽기 전용으로 참조
  function motorRunningCurrentPu(speedPct) {
    const speedFrac = clamp(speedPct, 0, 100) / 100;
    return CONST.MOTOR_NO_LOAD_CURRENT_FRAC + (1 - CONST.MOTOR_NO_LOAD_CURRENT_FRAC) * Math.pow(speedFrac, 2);
  }

  // 한 펌프의 전동기 전류·보호 상태를 한 틱 갱신한다. 새로 트립되면 true를 반환.
  function updatePumpElectrical(ep, corePump, dt) {
    if (corePump.status === 'STOPPED' || corePump.status === 'STANDBY' || corePump.fault) {
      ep.currentPu = 0;
    } else if (corePump.status === 'STARTING') {
      const inrushMult = corePump.feedMode === 'BYPASS' ? CONST.INRUSH_MULTIPLIER_BYPASS : CONST.INRUSH_MULTIPLIER_VFD;
      const excessAtStart = inrushMult - CONST.MOTOR_NO_LOAD_CURRENT_FRAC;
      const excess = excessAtStart * Math.exp(-corePump.startTimer / CONST.INRUSH_DECAY_TAU_S);
      ep.currentPu = CONST.MOTOR_NO_LOAD_CURRENT_FRAC + excess;
    } else {
      ep.currentPu = motorRunningCurrentPu(corePump.speedPct) * ep.mechanicalOverloadMult;
    }

    if (ep.phaseLossInjected && ep.currentPu > 0) {
      ep.currentPu *= CONST.PHASE_LOSS_CURRENT_MULT;
    }

    // 열적 보호 (조건부 없이 항상 적산 — 실제 열 관성처럼 전류가 0이어도 서서히 식는다)
    const iRatio = ep.currentPu / CONST.THERMAL_TRIP_PICKUP_PU;
    const dTheta = (iRatio * iRatio - ep.thermalState) / CONST.THERMAL_TRIP_TAU_S * dt;
    ep.thermalState = Math.max(0, ep.thermalState + dTheta);

    let newlyTripped = false;
    if (!ep.tripped && ep.thermalState >= CONST.THERMAL_TRIP_LEVEL) {
      ep.tripped = true; ep.tripReason = 'OVERLOAD'; newlyTripped = true;
    }

    // 결상 전용 빠른 판정
    if (ep.phaseLossInjected) {
      ep.phaseLossConfirmTimer += dt;
      if (!ep.tripped && ep.phaseLossConfirmTimer >= CONST.PHASE_LOSS_TRIP_DELAY_S) {
        ep.tripped = true; ep.tripReason = 'PHASE_LOSS'; newlyTripped = true;
      }
    } else {
      ep.phaseLossConfirmTimer = 0;
    }

    return newlyTripped;
  }

  // elecState.pumps와 corePumps는 같은 순서(id 1,2,3)라고 가정.
  // 반환값: 이번 틱에 새로 트립된 펌프의 {id, reason} 배열(오케스트레이터가 SimCore.faultPump 호출에 사용).
  function update(elecState, corePumps, dt) {
    const newTrips = [];
    let totalCurrentPu = 0;
    elecState.pumps.forEach((ep, i) => {
      const corePump = corePumps[i];
      const newlyTripped = updatePumpElectrical(ep, corePump, dt);
      if (newlyTripped) newTrips.push({ id: ep.id, reason: ep.tripReason });
      totalCurrentPu += ep.currentPu;
    });
    elecState.totalCurrentPu = totalCurrentPu;
    elecState.internalDropPu = CONST.BUS_SOURCE_REACTANCE_PU * totalCurrentPu;
    elecState.busVoltagePu = clamp(1 - elecState.internalDropPu - elecState.externalGridDropPu, 0, 1.2);
    return newTrips;
  }

  // update()의 고속 서브스텝 버전 — 오케스트레이터(sim-plant.js)가 이걸 쓴다.
  // update()는 기존 그대로 남겨둔다(다른 호출부, 예: tests/sag-demo.js가
  // 여전히 100ms 단위 결과만으로 충분해서 이걸 직접 쓴다 — 무수정 회귀 유지).
  //
  // prevStartTimers: 이번 제어틱 "시작 시점"의 corePump.startTimer 스냅샷
  // (오케스트레이터가 SimCore.tick() 호출 *전에* 떠서 넘겨준다). STARTING
  // 상태인 펌프는 그 값과 corePump.startTimer(틱 끝 시점 값) 사이를 서브스텝
  // 개수만큼 선형보간해서, 100ms 동안 실제로 흘러간 시간처럼 돌입전류 지수감쇠를
  // 촘촘히 반영한다 — corePump.startTimer 자체(TON 판정에 쓰이는 진짜 상태)는
  // 건드리지 않고, 이 계산에서만 보간값을 쓴다.
  //
  // 반환값: { newTrips, samples } — samples: [{ tOffsetS, busVoltagePu,
  // totalCurrentPu }, ...] FAST_SAMPLE_MS 간격. sim-plant.js가 이 배열을
  // 그대로 PQLayer.updateSubstep()에 하나씩 넘겨 전력품질 계층도 같은
  // 해상도로 반응하게 한다.
  function updateFast(elecState, corePumps, prevStartTimers, dtControlS) {
    const dtSub = CONST.FAST_SAMPLE_MS / 1000;
    const steps = Math.max(1, Math.round(dtControlS / dtSub));
    const newTrips = [];
    const samples = [];

    for (let k = 0; k < steps; k++) {
      const frac = (k + 1) / steps; // 이 서브스텝이 이번 틱 구간에서 차지하는 진행률(0~1]
      let totalCurrentPu = 0;
      elecState.pumps.forEach((ep, i) => {
        const corePump = corePumps[i];
        const prevST = prevStartTimers[i] ?? corePump.startTimer;
        const interpStartTimer = prevST + (corePump.startTimer - prevST) * frac;
        const proxyPump = { status: corePump.status, speedPct: corePump.speedPct, fault: corePump.fault, feedMode: corePump.feedMode, startTimer: interpStartTimer };
        const newlyTripped = updatePumpElectrical(ep, proxyPump, dtSub);
        if (newlyTripped) newTrips.push({ id: ep.id, reason: ep.tripReason });
        totalCurrentPu += ep.currentPu;
      });
      elecState.totalCurrentPu = totalCurrentPu;
      elecState.internalDropPu = CONST.BUS_SOURCE_REACTANCE_PU * totalCurrentPu;
      elecState.busVoltagePu = clamp(1 - elecState.internalDropPu - elecState.externalGridDropPu, 0, 1.2);
      samples.push({ tOffsetS: dtSub * (k + 1), busVoltagePu: elecState.busVoltagePu, totalCurrentPu });
    }

    return { newTrips, samples };
  }

  // 고장 해제 시(펌프 FAULT 클리어) 열/결상 보호 메모리도 함께 리셋 — 실제 보호계전기
  // 리셋과 동일한 관행(냉각/점검 후 리셋).
  function resetPumpProtection(elecState, pumpId) {
    const ep = elecState.pumps.find(p => p.id === pumpId);
    if (!ep) return;
    ep.thermalState = 0;
    ep.tripped = false;
    ep.tripReason = null;
    ep.phaseLossConfirmTimer = 0;
  }

  function setPhaseLoss(elecState, pumpId, injected) {
    const ep = elecState.pumps.find(p => p.id === pumpId);
    if (ep) ep.phaseLossInjected = !!injected;
  }
  function setMechanicalOverload(elecState, pumpId, multiplier) {
    const ep = elecState.pumps.find(p => p.id === pumpId);
    if (ep) ep.mechanicalOverloadMult = multiplier;
  }
  function setExternalGridDrop(elecState, dropPu) {
    elecState.externalGridDropPu = dropPu;
  }

  return {
    CONST,
    createElecState,
    motorRunningCurrentPu,
    updatePumpElectrical,
    update,
    updateFast,
    resetPumpProtection,
    setPhaseLoss,
    setMechanicalOverload,
    setExternalGridDrop,
  };
});
