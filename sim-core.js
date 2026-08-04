/* =============================================================================
 * sim-core.js — PCW HMI 제어 로직 + 플랜트 모델 (순수 계산 모듈)
 *
 * DOM/Chart.js에 의존하지 않는다. 브라우저에서는 <script src="sim-core.js">로
 * 전역 SimCore에 붙고, Node.js(테스트)에서는 require('./sim-core.js')로 그대로
 * 쓸 수 있다 (UMD 패턴). 렌더링/이벤트 바인딩은 index.html에만 남아있다.
 *
 * 모든 상수는 근거(물성치 / 업계 통상범위 대표값 / 제어이론 / 가상 설계가정)를
 * 주석으로 명시한다. 근거 없는 숫자는 넣지 않는다.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SimCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONST = Object.freeze({
    // ---------- 물성치 (표준값, 20°C 부근 물) ----------
    WATER_CP: 4186,          // J/(kg·K) 물의 비열 — 표준 물성치
    WATER_RHO: 998,          // kg/m3 물의 밀도 @20°C — 표준 물성치
    KPA_PER_M_HEAD: 9.79,    // kPa per m 수주 — ΔP[kPa]=ρ·g·h/1000, ρ=998,g=9.81 → 9.79

    // ---------- 계통 대표값 (반도체 팹 PCW 통상범위, 실제 벤더/현장 스펙 아님) ----------
    CHILLER_SP_C: 7,             // °C 1차 냉동기 냉수 출구 설정 — 공정용 칠러 통상 5~10°C대 대표값
    CHILLER_TAU_S: 25,           // s 냉동기 출구온도 1차 지연 시정수 — 대표값(정밀 모델 아님)
    AMBIENT_C: 22,               // °C 정지시 드리프트 목표(주변온도) — 알람설정치(H=23°C) 미만의
                                  // 정상 대기값이 되도록 설정한 대표값(팹 유틸리티 공간 통상 실내온도대)
    SUPPLY_TEMP_SP_DEFAULT: 21,  // °C 2차 PCW 공급온도 목표 — 팹 PCW 통상 18~23°C대 대표값
    SUPPLY_TEMP_SP_MIN: 16,
    SUPPLY_TEMP_SP_MAX: 26,

    DESIGN_FLOW_M3H: 600,        // m3/h 2차 루프 설계유량(펌프 3대 기준) — 팹 유틸리티 규모 가정치
    MIN_FLOW_M3H: 60,            // m3/h 최소유량 보호 기준(설계유량의 10%) — 판형HX 최소유속 보호 통념
    MIN_FLOW_DELAY_S: 5,         // s 최소유량 미달 지속시 보호동작 발동 지연 — 순간 노이즈 오동작 방지 대표값
    MIN_FLOW_RELEASE_MARGIN: 1.1,// 해제는 기준의 110%에서 — 채터링 방지 히스테리시스

    // ---------- 판형 열교환기 — 단순 열수지 근사 (정밀 열전달 모델링은 이 시뮬레이터의
    //            범위가 아님. 목적은 "유량이 늘수록 공급온도가 냉동기 온도에 더 가까워진다"는
    //            제어 관점의 정성적 관계만 재현하는 것) ----------
    // 공급온도 목표값 = 냉동기온도 + (환수온도-냉동기온도) × HX_MIX_FLOW_M3H/(유량+HX_MIX_FLOW_M3H)
    // HX_MIX_FLOW_M3H: 설계유량 600m3/h·고부하 환수 26°C·냉동기 7°C 조건에서 공급온도가
    //   SP 21°C 근방이 되도록 역산한 값(21=7+(26-7)×K/(600+K)를 대입해 K≈1680 산출).
    HX_MIX_FLOW_M3H: 1680,       // m3/h
    HX_THERMAL_TAU_S: 12,        // s 공급헤더/판형HX 유체 열용량에 의한 1차 지연 — 배관·소용적 혼합 대표값

    // ---------- 공정부하 시나리오 (가상 팹 배치공정 부하 패턴, 근거 없는 임의 대표값) ----------
    LOAD_CYCLE_S: 180,           // s 저→중→고 3단 순환 주기
    LOAD_LOW_KW: 1000,
    LOAD_MED_KW: 2200,
    LOAD_HIGH_KW: 3800,
    LOAD_NOISE_STD_KW: 30,       // kW 소량 랜덤 외란(가우시안, Box-Muller) 표준편차 대표값
    DISTURBANCE_STEP_KW: 1500,   // kW '외란 인가' 버튼으로 주는 임시 부하 스텝
    DISTURBANCE_DURATION_S: 60,  // s 외란 지속시간

    // ---------- 펌프 (병렬 유량배분은 "운전대수 × 속도"에 비례하는 단순 합산으로 근사) ----------
    PUMP_RATED_FLOW_M3H: 250,    // m3/h 펌프 1대가 속도 100%일 때 내는 유량 — 가정치
    PUMP_MIN_SPEED_PCT: 20,      // % VFD 최소운전속도 — 저속영역 원심펌프 불안정 방지 통념(대표값)
    PUMP_RAMP_RATE_PCT_S: 15,    // %/s VFD 가감속률 — 일반 산업용 VFD 가감속시간(수초대) 대표값
    PUMP_START_TON_S: 3,         // s 기동 인터록 지연(TON) — 모터 기동 돌입전류 안정화 대표시간

    // 배관+공정부하+HX를 합쳐 계통 전체의 유량-차압 특성을 단순 2차 관계(ΔP∝Q², 난류영역
    // 통상 근사)로만 표시용으로 대표. 설계유량 600m3/h에서 차압이 대표값 약 313kPa(수주 32m
    // 상당)이 되도록 잡은 가정 계수.
    SYSTEM_RESISTANCE_R: 32 / (600 * 600),

    // ---------- 버퍼탱크 ----------
    TANK_AREA_M2: 8,             // m2 단면적 — 팹 유틸리티 규모 가정치
    TANK_LEVEL_SP_PCT: 60,       // % 정상 수위 목표(가정치)
    TANK_MAKEUP_KP: 0.8,         // %/%error 자동보급 P제어 게인(가정치, 완만한 비례제어)
    TANK_MAKEUP_MAX_PCT_S: 0.15, // %/s 자동보급 최대속도(가정치)
    TANK_LEAK_PCT_S: 0.01,       // %/s 증발/미세누설 대표 드리프트(가정치)
    TANK_STAGE_TRANSIENT_PCT: 1.2, // % 펌프 기동/정지시 일시적 수위 요동 진폭(가정치, 정성적 재현용)

    // ---------- 캐스케이드 제어주기 ----------
    // 캐스케이드가 의미있으려면 내부(빠른)루프가 외부(느린)루프보다 충분히 빨라야 함.
    // 공정제어 교과서(Seborg et al., Process Dynamics and Control)의 통상 권장치는
    // 내부:외부 응답속도 비 5~10배 이상 분리. 본 시뮬레이터는 10:1(내부100ms:외부1000ms)로 설정.
    OUTER_PERIOD_MS: 1000,
    INNER_PERIOD_MS: 100,

    // ---------- 초기 PID 게인 (튜닝 패널에서 조정 가능한 기본값, 대표값) ----------
    OUTER_KP0: 40, OUTER_KI0: 4, OUTER_KD0: 0,     // 온도[°C] 오차 → 유량SP[m3/h] 출력
    INNER_KP0: 0.3, INNER_KI0: 0.15, INNER_KD0: 0, // 유량[m3/h] 오차 → 속도[%] 출력

    // ---------- VFD 대수제어 (staging) — 히스테리시스 + 지연으로 헌팅 방지 ----------
    STAGE_UP_SPEED_PCT: 90,      // % 이 이상 유지되면 증속 검토(가정치)
    STAGE_UP_DELAY_S: 15,        // s 유지시간(가정치)
    STAGE_DOWN_SPEED_PCT: 40,    // % 이 이하로 유지되면 감속(해제) 검토(가정치)
    STAGE_DOWN_DELAY_S: 30,      // s 해제는 투입보다 길게 — 보수적으로 두어 헌팅 억제(가정치)

    // ---------- 알람 설정값 (히스테리시스 포함, 대표값) ----------
    ALM_TEMP_H_C: 23, ALM_TEMP_HH_C: 25, ALM_TEMP_HYS_C: 0.5,
    // dp(Q)=SYSTEM_RESISTANCE_R·Q²·KPA_PER_M_HEAD 식으로 유량기준 알람(MIN_FLOW_M3H=60m3/h,
    // dp≈3kPa)과 정합되도록 환산 — 정상 1대 저속운전 영역(Q≈150~250m3/h, dp≈20~55kPa)에서는
    // 발생하지 않고 실제 최소유량 부근에서만 동작하도록 계산해 설정
    ALM_DP_L_KPA: 7, ALM_DP_LL_KPA: 3, ALM_DP_HYS_KPA: 1,
    ALM_LEVEL_H_PCT: 85, ALM_LEVEL_HH_PCT: 92,
    ALM_LEVEL_L_PCT: 25, ALM_LEVEL_LL_PCT: 15, ALM_LEVEL_HYS_PCT: 2,
  });

  /* ---------------------------- 유틸리티 ---------------------------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 기본 RNG는 Math.random(브라우저 동작 그대로). 테스트는 재현 가능한 결과를 위해
  // 시드 고정 PRNG(mulberry32)를 주입한다 — 암호학적 용도가 아니라 "같은 시드면
  // 같은 시나리오"를 보장해 회귀 비교/재현이 가능하게 하기 위함.
  function createSeededRng(seed) {
    let s = seed >>> 0;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussianRandom(rng) {
    rng = rng || Math.random;
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function fmt(v, d) { return (v == null || isNaN(v)) ? '--' : v.toFixed(d); }
  function nowStr() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  /* ---------------------------- 상태 팩토리 ---------------------------- */
  // 여러 시나리오/게인조합을 순차 실행하는 테스트에서 서로 오염되지 않도록,
  // 상태는 매번 새 객체로 생성한다(모듈 전역 상태를 두지 않는다).
  function createInitialState() {
    return {
      simTimeS: 0,
      tickCount: 0,
      masterOn: false,
      mode: 'AUTO', // AUTO | MANUAL
      controlStructure: 'CASCADE', // CASCADE | SINGLE
      manualSpeedPct: 0,
      spTempC: CONST.SUPPLY_TEMP_SP_DEFAULT,

      gains: {
        oKp: CONST.OUTER_KP0, oKi: CONST.OUTER_KI0, oKd: CONST.OUTER_KD0,
        iKp: CONST.INNER_KP0, iKi: CONST.INNER_KI0, iKd: CONST.INNER_KD0,
      },

      chillerTempC: CONST.AMBIENT_C,
      supplyTempC: CONST.AMBIENT_C,
      returnTempC: CONST.AMBIENT_C,
      chillerRunning: false,
      lastLoadKW: 0,
      flowTotalM3h: 0,
      dpKPa: 0,
      tankLevelPct: CONST.TANK_LEVEL_SP_PCT,
      tankLevelBase: CONST.TANK_LEVEL_SP_PCT,
      tankTransient: 0,

      flowSpM3h: CONST.MIN_FLOW_M3H,
      speedCmdPct: 0,

      outerPid: { integral: 0, prevError: 0 },
      innerPid: { integral: 0, prevError: 0 },

      hxProtectionActive: false,
      minFlowTimer: 0,
      stageUpTimer: 0,
      stageDownTimer: 0,
      anyPumpStarting: false,

      disturbanceTimer: 0,

      pumps: [1, 2, 3].map(id => ({
        id, status: 'STOPPED', speedPct: 0, fault: false, runtimeH: 0, startTimer: 0, startCount: 0,
      })),

      alarmStates: {}, // tag -> {active, acked, priority, desc, raisedAt}
      alarmLog: [],    // most-recent-first log entries
    };
  }

  // 비교용 축소모델(캐스케이드/단일루프) — 실제 P&ID/펌프에는 영향 없음
  function createShadowState() {
    return {
      cascade: { flowM3h: 200, tempC: CONST.AMBIENT_C, outerPid: { integral: 0, prevError: 0 }, innerPid: { integral: 0, prevError: 0 } },
      single: { flowM3h: 200, tempC: CONST.AMBIENT_C, pid: { integral: 0, prevError: 0 } },
    };
  }

  /* ---------------------------- PID (조건부 적분 anti-windup) ---------------------------- */
  // 포화 중에는 "포화를 더 심화시키는 방향"의 오차만 적분을 멈추고,
  // 포화를 "해소하는 방향"의 오차는 계속 적분한다 (conditional integration).
  //
  // 판정은 반드시 "이번 스텝의 오차를 실제로 더한 뒤(tentative integral)"의
  // 출력으로 해야 한다. 더하기 전(직전 스텝 기준) 출력으로 판정하면, 포화에
  // 막 진입하는 시점에 최소 1~2틱만큼 적분이 계속 불어나고서야 뒤늦게 멈추는
  // 지연이 생긴다(자동 검증 스위트의 anti-windup 불변조건 검사에서 실제로 발견돼
  // 수정한 문제 — tests/README 또는 README "검증 결과" 절 참조).
  function stepPID(s, error, dt, kp, ki, kd, outMin, outMax) {
    const pTerm = kp * error;
    const dTerm = dt > 0 ? kd * (error - s.prevError) / dt : 0;

    const tentativeIntegral = s.integral + error * dt;
    const tentativeOutput = pTerm + ki * tentativeIntegral + dTerm;

    const wouldExceedMax = tentativeOutput > outMax;
    const wouldExceedMin = tentativeOutput < outMin;
    const worseningDirection = (wouldExceedMax && error > 0) || (wouldExceedMin && error < 0);
    if (!worseningDirection) s.integral = tentativeIntegral; // 포화를 심화시키지 않을 때만 실제 반영

    let output = pTerm + ki * s.integral + dTerm;
    output = clamp(output, outMin, outMax);
    s.prevError = error;
    return output;
  }

  /* ---------------------------- 플랜트 물리모델 (제어 로직 검증용 단순 근사 —
   * 정밀 열전달/유체 모델링은 이 프로젝트의 범위가 아니다) ---------------------------- */
  function hxOutletTempC(flowM3h, primaryTempC, returnTempC) {
    const frac = CONST.HX_MIX_FLOW_M3H / (Math.max(flowM3h, 0) + CONST.HX_MIX_FLOW_M3H);
    return primaryTempC + frac * (returnTempC - primaryTempC);
  }
  function processDeltaTC(flowM3h, loadKW) {
    const flowKgS = Math.max(flowM3h, 1) * CONST.WATER_RHO / 3600;
    return clamp((loadKW * 1000) / (flowKgS * CONST.WATER_CP), 0, 40);
  }
  function processLoadKW(tSec, disturbanceActive, rng) {
    const pos = tSec % CONST.LOAD_CYCLE_S;
    let base;
    if (pos < CONST.LOAD_CYCLE_S / 3) base = CONST.LOAD_LOW_KW;
    else if (pos < (CONST.LOAD_CYCLE_S * 2) / 3) base = CONST.LOAD_MED_KW;
    else base = CONST.LOAD_HIGH_KW;
    const extra = disturbanceActive ? CONST.DISTURBANCE_STEP_KW : 0;
    return Math.max(0, base + extra + gaussianRandom(rng) * CONST.LOAD_NOISE_STD_KW);
  }

  // 병렬 펌프 유량배분: 펌프별 특성곡선/헤더압력 균형 계산 없이,
  // "운전 중인 각 펌프가 자기 속도(%)에 비례한 유량을 내고, 그걸 그냥 다 더한다"는
  // 가장 단순한 근사.
  function sumPumpFlows(pumps) {
    return pumps.reduce((sum, p) => {
      if (p.status !== 'RUNNING') return sum;
      return sum + (p.speedPct / 100) * CONST.PUMP_RATED_FLOW_M3H;
    }, 0);
  }

  /* ---------------------------- 펌프 기동/정지/고장 ---------------------------- */
  function eligibleStandby(state) {
    // 교번운전: 고장이 아니고 STANDBY인 펌프 중 누적운전시간이 가장 적은 것 우선
    return state.pumps
      .filter(p => p.status === 'STANDBY' && !p.fault)
      .sort((a, b) => a.runtimeH - b.runtimeH)[0];
  }
  function startPump(state, p) {
    if (!p || state.anyPumpStarting) return false; // 동시 기동 금지
    p.status = 'STARTING';
    p.startTimer = 0;
    p.startCount = (p.startCount || 0) + 1;
    state.anyPumpStarting = true;
    state.tankTransient += CONST.TANK_STAGE_TRANSIENT_PCT; // 기동 과도현상(정성적 재현)
    return true;
  }
  function stopPump(state, p) {
    p.status = state.masterOn ? 'STANDBY' : 'STOPPED';
    state.tankTransient -= CONST.TANK_STAGE_TRANSIENT_PCT;
  }
  function faultPump(state, p) {
    const wasActive = p.status === 'RUNNING' || p.status === 'STARTING';
    if (p.status === 'STARTING') state.anyPumpStarting = false;
    p.fault = true;
    p.status = 'FAULT';
    p.speedPct = 0;
    if (wasActive) {
      // 고장 펌프 자동 제외 + 대기 펌프 자동 투입 (인터록)
      const spare = eligibleStandby(state);
      if (spare) startPump(state, spare);
    }
  }
  function clearFaultUI(state, p) {
    p.fault = false;
    p.status = state.masterOn ? 'STANDBY' : 'STOPPED';
  }

  /* ---------------------------- 마스터 START/STOP, 모드전환, 외란 ---------------------------- */
  function masterStart(state) {
    if (state.masterOn) return;
    state.masterOn = true;
    const lead = state.pumps.filter(p => !p.fault).sort((a, b) => a.runtimeH - b.runtimeH)[0];
    if (lead) startPump(state, lead);
  }
  function masterStop(state) {
    state.masterOn = false;
    state.pumps.forEach(p => { if (!p.fault) p.status = 'STOPPED'; });
    state.outerPid.integral = 0; state.innerPid.integral = 0;
    state.flowSpM3h = CONST.MIN_FLOW_M3H; state.speedCmdPct = 0;
    state.minFlowTimer = 0; state.hxProtectionActive = false;
    state.stageUpTimer = 0; state.stageDownTimer = 0;
    state.anyPumpStarting = false;
  }
  function setControlMode(state, mode) {
    state.mode = mode;
    // 전환시 미분킥 방지: prevError를 현재 오차로 리셋
    state.outerPid.prevError = state.supplyTempC - state.spTempC;
    state.innerPid.prevError = state.flowSpM3h - state.flowTotalM3h;
  }
  function applyDisturbance(state) {
    state.disturbanceTimer = CONST.DISTURBANCE_DURATION_S;
  }

  /* ---------------------------- 제어 로직 ---------------------------- */
  // CV(제어변수)에 실제로 적용되는 "진짜" 유효 상하한. invariants.js(anti-windup
  // 불변조건 #5)가 "지금 CV가 포화 상태인가"를 판정하는 기준으로 이 함수들을 그대로
  // 가져다 쓴다 — outerLoopStep/innerLoopStep 내부 구현이 이 한계를 실제로
  // stepPID에 정확히 전달하는지 여부와 무관하게, 최종적으로 state.flowSpM3h /
  // state.speedCmdPct에 적용되는 참값을 나타낸다(추출 과정에서 로직을 바꾸지
  // 않기 위해 원본 index.html의 2차 clamp 수식을 그대로 옮겼다).
  function outerFlowSpBounds(state) {
    return { min: CONST.MIN_FLOW_M3H * (state.hxProtectionActive ? 1 : 0.3), max: CONST.DESIGN_FLOW_M3H * 1.1 };
  }
  function innerSpeedBounds(state) {
    return { min: state.hxProtectionActive ? 30 : 0, max: 100 };
  }

  function outerLoopStep(state, dtS) {
    const error = state.supplyTempC - state.spTempC; // 온도가 높으면 유량을 늘려야 함
    const out = stepPID(state.outerPid, error, dtS, state.gains.oKp, state.gains.oKi, state.gains.oKd,
      0, CONST.DESIGN_FLOW_M3H * 1.1);
    const b = outerFlowSpBounds(state);
    state.flowSpM3h = clamp(out, b.min, b.max);
  }
  function innerLoopStep(state, dtS) {
    const error = state.flowSpM3h - state.flowTotalM3h;
    const b = innerSpeedBounds(state);
    state.speedCmdPct = stepPID(state.innerPid, error, dtS, state.gains.iKp, state.gains.iKi, state.gains.iKd, b.min, b.max);
  }
  function singleLoopStep(state, dtS) {
    // 단일루프: 온도 오차로 펌프속도를 직접 산출 (캐스케이드 없이)
    const error = state.supplyTempC - state.spTempC;
    state.speedCmdPct = stepPID(state.innerPid, error, dtS, state.gains.oKp / 4, state.gains.oKi / 4, state.gains.oKd / 4, 0, 100);
  }

  function stagingStep(state, dtS) {
    if (state.mode !== 'AUTO' || !state.masterOn) { state.stageUpTimer = 0; state.stageDownTimer = 0; return; }
    const runningCount = state.pumps.filter(p => p.status === 'RUNNING').length;

    if (state.speedCmdPct >= CONST.STAGE_UP_SPEED_PCT) state.stageUpTimer += dtS; else state.stageUpTimer = 0;
    if (state.stageUpTimer >= CONST.STAGE_UP_DELAY_S) {
      const spare = eligibleStandby(state);
      if (spare && startPump(state, spare)) state.stageUpTimer = 0;
    }

    if (state.speedCmdPct <= CONST.STAGE_DOWN_SPEED_PCT && runningCount > 1) state.stageDownTimer += dtS; else state.stageDownTimer = 0;
    if (state.stageDownTimer >= CONST.STAGE_DOWN_DELAY_S) {
      const lag = state.pumps.filter(p => p.status === 'RUNNING').sort((a, b) => b.runtimeH - a.runtimeH)[0];
      if (lag) stopPump(state, lag);
      state.stageDownTimer = 0;
    }
  }

  function interlocksStep(state, dtS) {
    // 1) 최소유량 인터록 (열교환기 보호)
    if (state.masterOn && state.flowTotalM3h < CONST.MIN_FLOW_M3H) state.minFlowTimer += dtS;
    else if (state.flowTotalM3h >= CONST.MIN_FLOW_M3H * CONST.MIN_FLOW_RELEASE_MARGIN) state.minFlowTimer = 0;
    if (state.minFlowTimer >= CONST.MIN_FLOW_DELAY_S) state.hxProtectionActive = true;
    else if (state.flowTotalM3h >= CONST.MIN_FLOW_M3H * CONST.MIN_FLOW_RELEASE_MARGIN) state.hxProtectionActive = false;

    // 2) 냉동기 단독운전 금지: 가동중인 펌프가 1대도 없으면 냉동기 정지
    const runningCount = state.pumps.filter(p => p.status === 'RUNNING').length;
    state.chillerRunning = state.masterOn && runningCount > 0;
  }

  /* ---------------------------- 비교용 축소모델 ---------------------------- */
  function stepShadowModels(state, shadow, dtInner, loadKW) {
    if (!shadow) return;
    const drive = (m, speedPct) => {
      const flowTarget = CONST.DESIGN_FLOW_M3H * speedPct / 100;
      m.flowM3h += (flowTarget - m.flowM3h) / 3 * dtInner;
      const dT = processDeltaTC(m.flowM3h, loadKW);
      const rTemp = m.tempC + dT;
      const hxTgt = hxOutletTempC(m.flowM3h, CONST.CHILLER_SP_C, rTemp);
      m.tempC += (hxTgt - m.tempC) / CONST.HX_THERMAL_TAU_S * dtInner;
    };

    // 캐스케이드 shadow
    const c = shadow.cascade;
    if (state.tickCount % (CONST.OUTER_PERIOD_MS / CONST.INNER_PERIOD_MS) === 0) {
      const errT = c.tempC - state.spTempC;
      c._flowSp = stepPID(c.outerPid, errT, CONST.OUTER_PERIOD_MS / 1000, state.gains.oKp, state.gains.oKi, state.gains.oKd, 0, CONST.DESIGN_FLOW_M3H);
    }
    const errF = (c._flowSp ?? CONST.MIN_FLOW_M3H) - c.flowM3h;
    const speedC = stepPID(c.innerPid, errF, dtInner, state.gains.iKp, state.gains.iKi, state.gains.iKd, 0, 100);
    drive(c, speedC);

    // 단일루프 shadow
    const s = shadow.single;
    const errS = s.tempC - state.spTempC;
    const speedS = stepPID(s.pid, errS, dtInner, state.gains.oKp / 4, state.gains.oKi / 4, state.gains.oKd / 4, 0, 100);
    drive(s, speedS);
  }

  /* ---------------------------- 알람 ---------------------------- */
  function setAlarmActive(state, tag, isActive, priority, desc) {
    let st = state.alarmStates[tag];
    if (!st) { st = { active: false, acked: true }; state.alarmStates[tag] = st; }
    if (isActive && !st.active) {
      st.active = true; st.acked = false; st.priority = priority; st.desc = desc; st.raisedAt = nowStr();
      state.alarmLog.unshift({ tag, priority, desc, raisedAt: st.raisedAt, clearedAt: null, acked: false, raisedAtSimS: state.simTimeS, clearedAtSimS: null });
      if (state.alarmLog.length > 200) state.alarmLog.length = 200;
    } else if (!isActive && st.active) {
      st.active = false;
      const entry = state.alarmLog.find(e => e.tag === tag && !e.clearedAt);
      if (entry) { entry.clearedAt = nowStr(); entry.clearedAtSimS = state.simTimeS; }
    } else if (isActive && st.active) {
      st.desc = desc;
    }
  }
  function ackAlarm(state, tag) {
    const st = state.alarmStates[tag];
    if (st) st.acked = true;
    state.alarmLog.forEach(e => { if (e.tag === tag) e.acked = true; });
  }
  function ackAllCritical(state) {
    Object.keys(state.alarmStates).forEach(tag => {
      const st = state.alarmStates[tag];
      if (st.priority === 'Critical') ackAlarm(state, tag);
    });
  }

  function evaluateAlarms(state) {
    const T = state.supplyTempC, H = CONST.ALM_TEMP_HYS_C;
    setAlarmActive(state, 'TEMP_HH', T >= CONST.ALM_TEMP_HH_C, 'Critical', `공급온도 HH (${fmt(T,1)}°C ≥ ${CONST.ALM_TEMP_HH_C}°C)`);
    setAlarmActive(state, 'TEMP_H', T >= CONST.ALM_TEMP_H_C - (state.alarmStates.TEMP_H?.active ? H : 0) && T < CONST.ALM_TEMP_HH_C, 'High', `공급온도 H (${fmt(T,1)}°C ≥ ${CONST.ALM_TEMP_H_C}°C)`);

    const P = state.dpKPa, Hd = CONST.ALM_DP_HYS_KPA;
    setAlarmActive(state, 'DP_LL', state.masterOn && P <= CONST.ALM_DP_LL_KPA, 'Critical', `차압 LL (${fmt(P,0)}kPa ≤ ${CONST.ALM_DP_LL_KPA}kPa)`);
    setAlarmActive(state, 'DP_L', state.masterOn && P <= CONST.ALM_DP_L_KPA + (state.alarmStates.DP_L?.active ? Hd : 0) && P > CONST.ALM_DP_LL_KPA, 'Medium', `차압 L (${fmt(P,0)}kPa ≤ ${CONST.ALM_DP_L_KPA}kPa)`);

    const L = state.tankLevelPct;
    setAlarmActive(state, 'LVL_HH', L >= CONST.ALM_LEVEL_HH_PCT, 'Medium', `수위 HH (${fmt(L,0)}% ≥ ${CONST.ALM_LEVEL_HH_PCT}%)`);
    setAlarmActive(state, 'LVL_LL', L <= CONST.ALM_LEVEL_LL_PCT, 'Critical', `수위 LL (${fmt(L,0)}% ≤ ${CONST.ALM_LEVEL_LL_PCT}%)`);

    state.pumps.forEach(p => {
      setAlarmActive(state, `PUMP${p.id}_FAULT`, p.fault, 'Critical', `펌프 ${p.id} 고장`);
    });

    setAlarmActive(state, 'HX_PROTECT', state.hxProtectionActive, 'High', '최소유량 미달 — 열교환기 보호동작');
  }

  /* ---------------------------- 메인 시뮬레이션 틱 ---------------------------- */
  // 순수 함수(화면 렌더링 없음): state/shadow를 제자리에서 변형(mutate)한다.
  // rng를 넘기지 않으면 Math.random을 쓴다(브라우저 기본 동작과 동일).
  // loadKWOverride: 테스트 시나리오가 내장 3단 순환 부하 대신 원하는 부하 프로파일
  //   (예: 급격한 단일 스텝)을 직접 주입하기 위한 훅. 브라우저는 절대 넘기지 않으므로
  //   실제 화면 동작에는 아무 영향이 없다.
  function tick(state, shadow, rng, loadKWOverride) {
    const dtInner = CONST.INNER_PERIOD_MS / 1000;
    state.simTimeS += dtInner;
    state.tickCount++;

    if (state.disturbanceTimer > 0) state.disturbanceTimer -= dtInner;

    const loadKW = (typeof loadKWOverride === 'number')
      ? loadKWOverride
      : processLoadKW(state.simTimeS, state.disturbanceTimer > 0, rng);
    state.lastLoadKW = loadKW;

    // --- 펌프 기동 TON 진행 ---
    state.pumps.forEach(p => {
      if (p.status === 'STARTING') {
        p.startTimer += dtInner;
        if (p.startTimer >= CONST.PUMP_START_TON_S) {
          p.status = 'RUNNING';
          state.anyPumpStarting = false;
        }
      }
    });

    // --- 정지/대기 상태 갱신 (마스터 OFF면 전부 STOPPED로) ---
    state.pumps.forEach(p => {
      if (p.fault) { p.status = 'FAULT'; p.speedPct = 0; return; }
      if (!state.masterOn && (p.status === 'STANDBY' || p.status === 'STOPPED')) p.status = 'STOPPED';
      if (state.masterOn && p.status === 'STOPPED') p.status = 'STANDBY';
    });

    // --- 제어 로직 실행 ---
    interlocksStep(state, dtInner);
    if (state.masterOn && state.mode === 'AUTO') {
      if (state.controlStructure === 'CASCADE') {
        if (state.tickCount % (CONST.OUTER_PERIOD_MS / CONST.INNER_PERIOD_MS) === 0) outerLoopStep(state, CONST.OUTER_PERIOD_MS / 1000);
        innerLoopStep(state, dtInner);
      } else {
        singleLoopStep(state, dtInner);
      }
      stagingStep(state, dtInner);
    } else if (state.masterOn && state.mode === 'MANUAL') {
      state.speedCmdPct = state.manualSpeedPct;
    } else {
      state.speedCmdPct = 0;
    }

    // --- 펌프 속도 램프 (VFD 가감속률 제한) ---
    const rampStep = CONST.PUMP_RAMP_RATE_PCT_S * dtInner;
    state.pumps.forEach(p => {
      if (p.fault) return;
      const target = p.status === 'RUNNING' ? clamp(state.speedCmdPct, CONST.PUMP_MIN_SPEED_PCT, 100) : 0;
      if (p.speedPct < target) p.speedPct = Math.min(target, p.speedPct + rampStep);
      else if (p.speedPct > target) p.speedPct = Math.max(target, p.speedPct - rampStep);
    });

    // --- 유량/차압 (단순 합산 근사) ---
    state.flowTotalM3h = sumPumpFlows(state.pumps);
    state.dpKPa = CONST.SYSTEM_RESISTANCE_R * state.flowTotalM3h * state.flowTotalM3h * CONST.KPA_PER_M_HEAD;

    // --- 열역학 ---
    state.chillerTempC += ((state.chillerRunning ? CONST.CHILLER_SP_C : CONST.AMBIENT_C) - state.chillerTempC) / CONST.CHILLER_TAU_S * dtInner;
    // 순환유량이 사실상 0이면(정지) 부하식이 발산하므로 정체수가 서서히 주변온도로
    // 근접하는 것으로 근사한다(대표값 — 실제 정체수 성층/자연대류는 모델링하지 않음).
    const CIRCULATING_MIN_M3H = 5;
    if (state.flowTotalM3h > CIRCULATING_MIN_M3H) {
      const hxTarget = hxOutletTempC(state.flowTotalM3h, state.chillerTempC, state.returnTempC);
      state.supplyTempC += (hxTarget - state.supplyTempC) / CONST.HX_THERMAL_TAU_S * dtInner;
      state.returnTempC = state.supplyTempC + processDeltaTC(state.flowTotalM3h, loadKW);
    } else {
      const stagnantTauS = CONST.HX_THERMAL_TAU_S * 10;
      state.supplyTempC += (CONST.AMBIENT_C - state.supplyTempC) / stagnantTauS * dtInner;
      state.returnTempC += (CONST.AMBIENT_C - state.returnTempC) / stagnantTauS * dtInner;
    }

    // --- 버퍼탱크 수위: 기저수위(자동보급 P제어 + 미세누설) + 기동/정지 과도 요동(지수감쇠) ---
    const levelErr = CONST.TANK_LEVEL_SP_PCT - state.tankLevelBase;
    const makeup = clamp(CONST.TANK_MAKEUP_KP * levelErr, -CONST.TANK_MAKEUP_MAX_PCT_S, CONST.TANK_MAKEUP_MAX_PCT_S);
    state.tankLevelBase = clamp(state.tankLevelBase + (makeup - CONST.TANK_LEAK_PCT_S) * dtInner, 0, 100);
    state.tankTransient *= Math.exp(-dtInner / 20); // 20s 대표 감쇠시간
    state.tankLevelPct = clamp(state.tankLevelBase + state.tankTransient, 0, 100);

    // --- 누적 운전시간 ---
    state.pumps.forEach(p => { if (p.status === 'RUNNING') p.runtimeH += dtInner / 3600; });

    // --- 비교용 축소모델 (캐스케이드 vs 단일루프 shadow) ---
    stepShadowModels(state, shadow, dtInner, loadKW);

    // --- 알람 평가 ---
    evaluateAlarms(state);

    return state;
  }

  return {
    CONST,
    clamp, gaussianRandom, createSeededRng, fmt, nowStr,
    createInitialState, createShadowState,
    stepPID,
    hxOutletTempC, processDeltaTC, processLoadKW, sumPumpFlows,
    eligibleStandby, startPump, stopPump, faultPump, clearFaultUI,
    masterStart, masterStop, setControlMode, applyDisturbance,
    outerFlowSpBounds, innerSpeedBounds,
    outerLoopStep, innerLoopStep, singleLoopStep, stagingStep, interlocksStep,
    stepShadowModels,
    setAlarmActive, evaluateAlarms, ackAlarm, ackAllCritical,
    tick,
  };
});
