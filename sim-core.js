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

    // ---------- 유량측 외란 (배관 저항 급증 / 공급압력 저하) ----------
    // 위 열부하 외란은 "외부루프(온도) 도메인"에서 생기는 외란이라 캐스케이드의
    // 이점(내부의 빠른 유량루프가 외란을 온도까지 번지기 전에 먼저 흡수)이
    // 드러나지 않는다. 이 외란은 반대로 "내부루프(유량) 도메인"에 직접 걸리는
    // 외란이다 — 배관 저항이 갑자기 커지거나(밸브 오작동, 스트레이너 막힘 등)
    // 공급측 압력이 떨어지면, 펌프 속도(%)는 그대로인데 실제로 통과하는 유량은
    // 줄어든다. sim-core.js는 펌프곡선/헤더압력을 정밀히 풀지 않는 단순화된
    // 모델이므로(README "플랜트 수치 모델" 참조), 이 현상을 "같은 속도%가 내는
    // 유량에 곱해지는 배율(<1)이 일시적으로 줄어든다"는 승수 하나로 근사한다 —
    // 정밀 유체해석이 아니라 캐스케이드/단일루프 구조 차이를 드러내기 위한
    // 최소한의 장치임을 명시한다.
    FLOW_DISTURBANCE_FACTOR: 0.7, // 외란 중 유량 = 정상 유량 × 0.7 — 배관저항 급증/압력저하로
                                   // 같은 속도에서 유량이 30% 줄어드는 상황(대표값). 펌프가
                                   // 3대까지 증속할 여력이 있어 극단적 유량 고갈(최소유량 보호
                                   // 진입)까지는 가지 않으면서도, 내부루프가 뚜렷이 반응해야
                                   // 하는 수준으로 잡았다.
    FLOW_DISTURBANCE_DURATION_S: 60, // s 열부하 외란(DISTURBANCE_DURATION_S)과 동일하게 맞춰
                                      // 두 외란 종류를 같은 시간창에서 비교할 수 있게 함.

    // ---------- 펌프 (병렬 유량배분은 "운전대수 × 속도"에 비례하는 단순 합산으로 근사) ----------
    PUMP_RATED_FLOW_M3H: 250,    // m3/h 펌프 1대가 속도 100%일 때 내는 유량 — 가정치
    PUMP_MIN_SPEED_PCT: 20,      // % VFD 최소운전속도 — 저속영역 원심펌프 불안정 방지 통념(대표값)
    PUMP_RAMP_RATE_PCT_S: 15,    // %/s VFD 가감속률 — 일반 산업용 VFD 가감속시간(수초대) 대표값
    PUMP_START_TON_S: 3,         // s 기동 인터록 지연(TON) — 모터 기동 돌입전류 안정화 대표시간
    // 바이패스(VFD 고장 시 상용전원 직입, DOL) 급전 시에는 속도 제어 자체가
    // 없다 — 컨택터가 붙으면 사실상 정격속도로 고정 운전된다는 뜻으로 100%를
    // 대표값으로 둔다(sim-electrical.js의 급전모드 설명 참조).
    BYPASS_FIXED_SPEED_PCT: 100,

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
    // 발생하지 않고 실제 최소유량 부근에서만 동작하도록 계산해 설정.
    // ALM_DP_HYS_KPA=2: 펌프 기동 램프 구간에서는 유량이 매 틱 수 m3/h씩 바뀌고
    // dp∝flow²이라 경계값 부근에서 틱당 dp 변화가 1kPa 안팎이 될 수 있다 — 애초
    // 1kPa로 뒀더니 자동 검증 스위트(다중 시드 스트레스 테스트)에서 램프 도중
    // 경계를 잠깐 넘었다가 한 틱만에 되돌아오는 채터링이 실제로 잡혀서, 그
    // 틱당 변화폭의 2배 이상 여유를 두도록 2kPa로 넓혔다(README 검증 결과 참조).
    ALM_DP_L_KPA: 7, ALM_DP_LL_KPA: 3, ALM_DP_HYS_KPA: 2,
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
      antiWindupEnabled: true, // 시험 전용 — stepPID() 주석 참조. 기본은 항상 true(켜짐).
      pumpPolicy: 'ALL', // 'ALL'(전대수, 기본) | 'N_PLUS_1'(예비) — dutyPumpCap() 참조
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
      flowDisturbanceTimer: 0, // FLOW_DISTURBANCE_DURATION_S 참조

      loadMode: 'CYCLE', // 'CYCLE'(기존 저→중→고 3단 순환) | 'FIXED'(부하 고정, 측정용)
      fixedLoadKW: CONST.LOAD_MED_KW, // loadMode='FIXED'일 때 쓰는 고정 부하값 — 중부하를 기본값으로

      pumps: [1, 2, 3].map(id => ({
        id, status: 'STOPPED', speedPct: 0, fault: false, runtimeH: 0, startTimer: 0, startCount: 0,
        feedMode: 'VFD', // 'VFD' | 'BYPASS' — setPumpFeedMode()로만 바꾼다
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
  // antiWindupEnabled(선택, 기본 true): false를 주면 조건부 적분(anti-windup)을 끄고
  // 포화 중에도 오차를 무조건 적분한다 — anti-windup의 효과를 정량적으로 비교하기
  // 위한 시험 전용 옵션이다(README "검증 결과 — anti-windup 비교" 참조). 인자를
  // 생략하면 항상 켜진 상태(anti-windup 적용)로 기존과 완전히 동일하게 동작한다 —
  // 실제 화면(index.html)은 이 인자를 절대 넘기지 않으므로 기본 동작은 그대로다.
  function stepPID(s, error, dt, kp, ki, kd, outMin, outMax, antiWindupEnabled) {
    const awEnabled = antiWindupEnabled ?? true;
    const pTerm = kp * error;
    const dTerm = dt > 0 ? kd * (error - s.prevError) / dt : 0;

    const tentativeIntegral = s.integral + error * dt;
    const tentativeOutput = pTerm + ki * tentativeIntegral + dTerm;

    const wouldExceedMax = tentativeOutput > outMax;
    const wouldExceedMin = tentativeOutput < outMin;
    const worseningDirection = (wouldExceedMax && error > 0) || (wouldExceedMin && error < 0);
    if (!awEnabled || !worseningDirection) s.integral = tentativeIntegral; // 포화를 심화시키지 않을 때만 실제 반영(끄면 항상 반영)

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
  // fixedLoadKW(선택): 생략(undefined)하면 기존과 완전히 동일한 저→중→고 3단
  // 순환 부하를 쓴다. 숫자를 주면 그 값을 기저부하로 고정한다 — "고정 부하
  // 모드"(관측/측정용, README "부하 프로파일 선택" 참조)에서만 쓰인다.
  function processLoadKW(tSec, disturbanceActive, rng, fixedLoadKW) {
    let base;
    if (typeof fixedLoadKW === 'number') {
      base = fixedLoadKW;
    } else {
      const pos = tSec % CONST.LOAD_CYCLE_S;
      if (pos < CONST.LOAD_CYCLE_S / 3) base = CONST.LOAD_LOW_KW;
      else if (pos < (CONST.LOAD_CYCLE_S * 2) / 3) base = CONST.LOAD_MED_KW;
      else base = CONST.LOAD_HIGH_KW;
    }
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
  // 동시 기동 금지(anyPumpStarting 잠금): VFD 정상 기동은 소프트스타트라 돌입이
  // 사실상 없어(정격의 110~150%) 겹쳐도 문제가 되지 않는다. 이 잠금이 실제로
  // 막아야 하는 위험한 상황은 "바이패스(VFD 고장 시 상용전원 직입, DOL) 기동이
  // 두 대 이상 겹치는 경우"다 — DOL 돌입전류(정격의 5~7배)가 중첩되면 모선
  // 전압이 관리한계 아래로 떨어진다(sim-electrical.js CONST 주석, README
  // "검증 결과"의 인터록 우회 데모 참조). 그래서 이 잠금은 급전모드와 무관하게
  // 항상 걸어둔다 — 바이패스 상황을 특정해서 조건부로 풀면, 그 판단 로직 자체가
  // 또 다른 실수 지점이 되기 때문에(방어적으로) 모든 기동에 일괄 적용한다.
  function startPump(state, p) {
    if (!p || state.anyPumpStarting) return false;
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
  // VFD 고장 → 바이패스(DOL) 절체, 또는 복구 → VFD로 되돌림.
  // 바이패스 중에는 속도 지령(speedCmdPct)을 받지 않고 BYPASS_FIXED_SPEED_PCT로
  // 고정 운전한다(tick()의 펌프 속도 램프 구간 참조) — 별도의 "나머지 펌프로
  // 제어" 특수 로직을 두지 않아도, 내부루프가 "설정유량 - 전체유량(바이패스
  // 펌프의 고정 기여분 포함)" 오차를 그대로 보고 나머지 VFD 펌프 속도를
  // 조정하므로 기존 폐루프 구조가 자연스럽게 그 역할을 한다.
  function setPumpFeedMode(state, pumpId, mode) {
    const p = state.pumps.find(pp => pp.id === pumpId);
    if (p) p.feedMode = mode;
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
  // 유량측 외란(배관저항 급증/공급압력 저하 근사) — FLOW_DISTURBANCE_FACTOR/
  // FLOW_DISTURBANCE_DURATION_S 주석 참조. 열부하 외란(applyDisturbance)과
  // 별개 타이머로 관리해 두 외란을 동시에도, 따로도 걸 수 있게 한다.
  function applyFlowDisturbance(state) {
    state.flowDisturbanceTimer = CONST.FLOW_DISTURBANCE_DURATION_S;
  }

  /* ---------------------------- 제어 로직 ---------------------------- */
  // CV(제어변수)에 실제로 적용되는 "진짜" 유효 상하한. invariants.js(anti-windup
  // 불변조건 #5)가 "지금 CV가 포화 상태인가"를 판정하는 기준으로 이 함수들을 그대로
  // 가져다 쓴다 — outerLoopStep/innerLoopStep 내부 구현이 이 한계를 실제로
  // stepPID에 정확히 전달하는지 여부와 무관하게, 최종적으로 state.flowSpM3h /
  // state.speedCmdPct에 적용되는 참값을 나타낸다(추출 과정에서 로직을 바꾸지
  // 않기 위해 원본 index.html의 2차 clamp 수식을 그대로 옮겼다).
  // 운전 대수 정책: 정상(무고장) 상태에서 대수제어가 듀티로 투입할 수 있는
  // 최대 펌프 대수. 'ALL'(전대수)은 보유 펌프 전부(3대), 'N_PLUS_1'(예비)은
  // 2대만 듀티로 쓰고 1대는 상시 예비로 남긴다. 고장 시 예비 자동투입
  // (faultPump()의 eligibleStandby+startPump)은 이 상한과 무관하게 항상
  // 작동한다 — 이 상한은 "고장 없는 정상 상태에서 대수제어가 스스로 몇 대까지
  // 늘리는가"만 제한한다.
  function dutyPumpCap(state) {
    return state.pumpPolicy === 'N_PLUS_1' ? 2 : state.pumps.length;
  }
  // 외부루프 CV(유량 SP) 상한 산정 근거: 이 정책에서 정상적으로 듀티 투입될 수
  // 있는 펌프 대수(dutyPumpCap) × 펌프 1대의 물리적 최대 유량(PUMP_RATED_FLOW_M3H,
  // 속도 100%일 때) — 즉 "이 정책이 물리적으로 낼 수 있는 최대 유량 그 자체"다.
  // 과거에는 CONST.DESIGN_FLOW_M3H(설계유량, 600)에 근거 없는 1.1배를 곱한
  // 660이었는데(설계유량 자체도 펌프 3대 기준값이라 정책별 차이를 반영할 수
  // 없었고, 1.1이라는 배수도 어디에도 설명이 없는 임의값이었다), 왜 그 값을
  // 썼는지 코드 어디에도 근거가 없어서(이 프로젝트의 "근거 없는 상수 금지"
  // 원칙 위반) 정책별 실제 펌프 물리 용량으로 다시 산정했다. 추가 여유(margin)를
  // 두지 않은 이유: 이건 컨트롤러 튜닝값이 아니라 "이 대수로 물리적으로 낼 수
  // 있는 최댓값"이라는 하드 리밋 그 자체이므로, 그 위에 또 다른 임의의 배수를
  // 얹으면 똑같은 문제(근거 없는 값)가 반복될 뿐이다.
  function outerFlowSpBounds(state) {
    return { min: CONST.MIN_FLOW_M3H * (state.hxProtectionActive ? 1 : 0.3), max: dutyPumpCap(state) * CONST.PUMP_RATED_FLOW_M3H };
  }
  function innerSpeedBounds(state) {
    return { min: state.hxProtectionActive ? 30 : 0, max: 100 };
  }

  // 단일루프 등가 게인 유도 — "같은 유효 이득, 다른 구조"로 비교하기 위함.
  //
  // 캐스케이드는 온도오차(°C)를 외부루프(oKp/oKi/oKd, 단위: (m3/h)/°C·s 계열)가
  // 유량SP(m3/h)로 바꾸고, 그 유량오차(m3/h)를 내부루프(iKp/iKi/iKd, 단위: %/(m3/h)·s
  // 계열)가 다시 속도(%)로 바꾸는 2단 구성이다. 단일루프는 온도오차(°C)에서 속도(%)를
  // 곧바로 뽑아야 하므로, 두 루프 사이의 "m3/h → %" 변환을 대신해줄 계수가 필요하다.
  //
  // 그 변환계수로 iKp(%/(m3/h))만 쓸 수 있다 — 차원을 맞춰보면:
  //   Kp_single = oKp[(m3/h)/°C]      × iKp[%/(m3/h)]   = %/°C       (필요한 P게인 차원과 일치)
  //   Ki_single = oKi[(m3/h)/(°C·s)]  × iKp[%/(m3/h)]   = %/(°C·s)   (필요한 I게인 차원과 일치)
  //   Kd_single = oKd[(m3/h·s)/°C]    × iKp[%/(m3/h)]   = %·s/°C     (필요한 D게인 차원과 일치)
  // iKi(%/(m3/h·s))는 쓸 수 없다 — 이미 그 자체로 시간(1/s) 성분을 포함하고 있어서, 위
  // 세 식 어디에 곱해도 나오는 차원이 P/I/D 어느 게인의 정의와도 맞지 않는다(예: oKp×iKi
  // = %/(°C·s), 이건 I게인의 차원이지 P게인의 차원이 아니다). 즉 "적분·미분항도 같은
  // 방식으로 유도"가 가능한 것은 iKp 하나뿐이고, 그 하나로 P/I/D 세 항을 전부 일관되게
  // 변환할 수 있다 — 내부루프의 "즉각적인 비례 반응 정도"를 두 도메인 사이의 단일
  // 환산비율로 보고, 외부루프가 만드는 P/I/D 성분 각각에 동일하게 적용하는 것이다.
  //
  // 주의: 이것은 정확한 폐루프 축소(reduction)가 아니라 "정적 이득(gain) 합성"에 의한
  // 근사다 — 실제 캐스케이드는 내부루프 자체의 동특성(응답지연·자체 적분)을 갖고
  // 있어서 두 PID를 곱으로 합치는 게 수학적으로 등가는 아니다. 여기서는 "같은 크기의
  // 이득으로 단일 PID를 구성하면 구조 차이(내부 피드백 루프의 유무) 자체가 응답에
  // 어떤 영향을 주는지"를 분리해서 보기 위한 근사 기준일 뿐, 단일루프를 별도로 최적
  // 튜닝한 결과가 아니다(README "한계" 참조).
  function singleLoopEquivalentGains(state) {
    const conv = state.gains.iKp; // m3/h → % 환산계수로 쓸 수 있는 유일한 값(위 주석 참조)
    return {
      kp: state.gains.oKp * conv,
      ki: state.gains.oKi * conv,
      kd: state.gains.oKd * conv,
    };
  }

  // measuredSupplyTempC/measuredFlowM3h: 센서 계층(sim-sensors.js)이 있을 때
  // 오케스트레이터(sim-plant.js)가 넘겨주는 "측정값". 생략하면(undefined)
  // 기존과 완전히 동일하게 state.*(참값)를 직접 쓴다 — 센서 계층이 없는 기존
  // 호출부(브라우저의 이전 동작, tests/의 기존 6종 검증)는 이 변경으로
  // 동작이 전혀 바뀌지 않는다.
  function outerLoopStep(state, dtS, measuredSupplyTempC) {
    const supplyTempC = measuredSupplyTempC ?? state.supplyTempC;
    const error = supplyTempC - state.spTempC; // 온도가 높으면 유량을 늘려야 함
    // stepPID에 넘기는 상하한은 반드시 outerFlowSpBounds()가 반환하는 "진짜"
    // 유효 한계와 같아야 한다 — 예전엔 stepPID 호출부와 최종 clamp가 서로 다른
    // 상수(고정 0~DESIGN_FLOW_M3H*1.1 vs outerFlowSpBounds())를 따로 썼는데,
    // 우연히 둘 다 660으로 같아서 드러나지 않았을 뿐이었다. 상한이 운전 대수
    // 정책에 따라 달라지게 되면서(dutyPumpCap 참조) 이 둘이 실제로 어긋날 수
    // 있게 됐다 — 어긋나면 anti-windup 판정(stepPID 내부)이 실제 적용되는
    // 한계가 아닌 엉뚱한 한계를 기준으로 포화 여부를 판단해, 예전에 이미 한 번
    // 발견해 고쳤던 것과 같은 종류의 "한 틱 지연" 버그가 재발한다(README
    // "검증 결과 — 발견된 문제" A-3 참조). 그래서 b를 먼저 구해 그대로 넘긴다.
    const b = outerFlowSpBounds(state);
    const out = stepPID(state.outerPid, error, dtS, state.gains.oKp, state.gains.oKi, state.gains.oKd,
      b.min, b.max, state.antiWindupEnabled);
    state.flowSpM3h = clamp(out, b.min, b.max);
  }
  function innerLoopStep(state, dtS, measuredFlowM3h) {
    const flowM3h = measuredFlowM3h ?? state.flowTotalM3h;
    const error = state.flowSpM3h - flowM3h;
    const b = innerSpeedBounds(state);
    state.speedCmdPct = stepPID(state.innerPid, error, dtS, state.gains.iKp, state.gains.iKi, state.gains.iKd, b.min, b.max, state.antiWindupEnabled);
  }
  function singleLoopStep(state, dtS, measuredSupplyTempC) {
    // 단일루프: 온도 오차로 펌프속도를 직접 산출 (캐스케이드 없이).
    // 게인은 캐스케이드의 유효 이득과 같게 맞춘 값 — singleLoopEquivalentGains() 주석 참조.
    const supplyTempC = measuredSupplyTempC ?? state.supplyTempC;
    const error = supplyTempC - state.spTempC;
    const g = singleLoopEquivalentGains(state);
    state.speedCmdPct = stepPID(state.innerPid, error, dtS, g.kp, g.ki, g.kd, 0, 100, state.antiWindupEnabled);
  }

  function stagingStep(state, dtS) {
    if (state.mode !== 'AUTO' || !state.masterOn) { state.stageUpTimer = 0; state.stageDownTimer = 0; return; }
    const runningCount = state.pumps.filter(p => p.status === 'RUNNING').length;

    if (state.speedCmdPct >= CONST.STAGE_UP_SPEED_PCT) state.stageUpTimer += dtS; else state.stageUpTimer = 0;
    if (state.stageUpTimer >= CONST.STAGE_UP_DELAY_S) {
      // dutyPumpCap: N+1 예비 정책에서는 정상 대수제어가 예비 펌프까지 듀티로
      // 끌어오지 못하게 막는다 — 예비는 고장(faultPump)에서만 투입된다.
      if (runningCount < dutyPumpCap(state)) {
        const spare = eligibleStandby(state);
        if (spare && startPump(state, spare)) state.stageUpTimer = 0;
      }
    }

    if (state.speedCmdPct <= CONST.STAGE_DOWN_SPEED_PCT && runningCount > 1) state.stageDownTimer += dtS; else state.stageDownTimer = 0;
    if (state.stageDownTimer >= CONST.STAGE_DOWN_DELAY_S) {
      const lag = state.pumps.filter(p => p.status === 'RUNNING').sort((a, b) => b.runtimeH - a.runtimeH)[0];
      if (lag) stopPump(state, lag);
      state.stageDownTimer = 0;
    }
  }

  function interlocksStep(state, dtS, measuredFlowM3h) {
    const flowM3h = measuredFlowM3h ?? state.flowTotalM3h;
    // 1) 최소유량 인터록 (열교환기 보호)
    if (state.masterOn && flowM3h < CONST.MIN_FLOW_M3H) state.minFlowTimer += dtS;
    else if (flowM3h >= CONST.MIN_FLOW_M3H * CONST.MIN_FLOW_RELEASE_MARGIN) state.minFlowTimer = 0;
    if (state.minFlowTimer >= CONST.MIN_FLOW_DELAY_S) state.hxProtectionActive = true;
    else if (flowM3h >= CONST.MIN_FLOW_M3H * CONST.MIN_FLOW_RELEASE_MARGIN) state.hxProtectionActive = false;

    // 2) 냉동기 단독운전 금지: 가동중인 펌프가 1대도 없으면 냉동기 정지
    const runningCount = state.pumps.filter(p => p.status === 'RUNNING').length;
    state.chillerRunning = state.masterOn && runningCount > 0;
  }

  /* ---------------------------- 비교용 축소모델 ---------------------------- */
  function stepShadowModels(state, shadow, dtInner, loadKW) {
    if (!shadow) return;
    const drive = (m, speedPct) => {
      // 유량측 외란은 실제 계통(tick())과 동일한 승수로 축소모델에도 반영한다 —
      // 그래야 캐스케이드/단일루프 shadow가 같은 조건에서 정직하게 비교된다.
      const flowFactor = state.flowDisturbanceTimer > 0 ? CONST.FLOW_DISTURBANCE_FACTOR : 1;
      const flowTarget = CONST.DESIGN_FLOW_M3H * speedPct / 100 * flowFactor;
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

    // 단일루프 shadow — 게인은 singleLoopStep()과 동일하게 유도(singleLoopEquivalentGains() 참조)
    const s = shadow.single;
    const errS = s.tempC - state.spTempC;
    const gs = singleLoopEquivalentGains(state);
    const speedS = stepPID(s.pid, errS, dtInner, gs.kp, gs.ki, gs.kd, 0, 100);
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

  // HH/H, LL/L처럼 인접한 2단 임계값을 갖는 알람은 반드시 (1) 각 단계 스스로도
  // 히스테리시스로 해소되고, (2) 상위(더 심각한) 단계의 "해소 여부"로 하위 단계를
  // 배타적으로 걸러야 한다. 처음엔 상위단계(HH/LL)에 히스테리시스가 없고 하위단계가
  // 원시 임계값(예: P > ALM_DP_LL_KPA)으로만 상위단계를 배제했는데, 값이 그 경계
  // 바로 위/아래에서 흔들리면 상위단계 자체가 매 틱 켜졌다 꺼졌다 하면서 하위단계도
  // 덩달아 채터링했다 — 자동 검증 스위트(다중 시드 스트레스 테스트)가 펌프 기동
  // 램프 중 실제로 이 상태를 잡아냈다(README 검증 결과 참조). 그래서 상위단계에도
  // 자기 히스테리시스를 주고, 하위단계는 "히스테리시스가 적용된 상위단계 활성상태"로
  // 배제하도록 통일했다.
  function evaluateAlarms(state) {
    const T = state.supplyTempC, Ht = CONST.ALM_TEMP_HYS_C;
    const hhActive = T >= CONST.ALM_TEMP_HH_C - (state.alarmStates.TEMP_HH?.active ? Ht : 0);
    setAlarmActive(state, 'TEMP_HH', hhActive, 'Critical', `공급온도 HH (${fmt(T,1)}°C ≥ ${CONST.ALM_TEMP_HH_C}°C)`);
    const hActive = !hhActive && T >= CONST.ALM_TEMP_H_C - (state.alarmStates.TEMP_H?.active ? Ht : 0);
    setAlarmActive(state, 'TEMP_H', hActive, 'High', `공급온도 H (${fmt(T,1)}°C ≥ ${CONST.ALM_TEMP_H_C}°C)`);

    const P = state.dpKPa, Hd = CONST.ALM_DP_HYS_KPA;
    const llActive = state.masterOn && P <= CONST.ALM_DP_LL_KPA + (state.alarmStates.DP_LL?.active ? Hd : 0);
    setAlarmActive(state, 'DP_LL', llActive, 'Critical', `차압 LL (${fmt(P,0)}kPa ≤ ${CONST.ALM_DP_LL_KPA}kPa)`);
    const lActive = !llActive && state.masterOn && P <= CONST.ALM_DP_L_KPA + (state.alarmStates.DP_L?.active ? Hd : 0);
    setAlarmActive(state, 'DP_L', lActive, 'Medium', `차압 L (${fmt(P,0)}kPa ≤ ${CONST.ALM_DP_L_KPA}kPa)`);

    const L = state.tankLevelPct, Hl = CONST.ALM_LEVEL_HYS_PCT;
    setAlarmActive(state, 'LVL_HH', L >= CONST.ALM_LEVEL_HH_PCT - (state.alarmStates.LVL_HH?.active ? Hl : 0), 'Medium', `수위 HH (${fmt(L,0)}% ≥ ${CONST.ALM_LEVEL_HH_PCT}%)`);
    setAlarmActive(state, 'LVL_LL', L <= CONST.ALM_LEVEL_LL_PCT + (state.alarmStates.LVL_LL?.active ? Hl : 0), 'Critical', `수위 LL (${fmt(L,0)}% ≤ ${CONST.ALM_LEVEL_LL_PCT}%)`);

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
  // measured: 센서 계층이 있을 때 오케스트레이터가 넘기는 선택적 측정값
  // 객체 {supplyTempC, flowM3h}. 생략하면 기존과 완전히 동일하게 동작한다.
  function tick(state, shadow, rng, loadKWOverride, measured) {
    const dtInner = CONST.INNER_PERIOD_MS / 1000;
    state.simTimeS += dtInner;
    state.tickCount++;

    if (state.disturbanceTimer > 0) state.disturbanceTimer -= dtInner;
    if (state.flowDisturbanceTimer > 0) state.flowDisturbanceTimer -= dtInner;

    const loadKW = (typeof loadKWOverride === 'number')
      ? loadKWOverride
      : processLoadKW(state.simTimeS, state.disturbanceTimer > 0, rng, state.loadMode === 'FIXED' ? state.fixedLoadKW : undefined);
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

    // --- 제어 로직 실행 (센서 계층이 있으면 측정값을, 없으면 참값을 사용) ---
    interlocksStep(state, dtInner, measured?.flowM3h);
    if (state.masterOn && state.mode === 'AUTO') {
      if (state.controlStructure === 'CASCADE') {
        if (state.tickCount % (CONST.OUTER_PERIOD_MS / CONST.INNER_PERIOD_MS) === 0) outerLoopStep(state, CONST.OUTER_PERIOD_MS / 1000, measured?.supplyTempC);
        innerLoopStep(state, dtInner, measured?.flowM3h);
      } else {
        singleLoopStep(state, dtInner, measured?.supplyTempC);
      }
      stagingStep(state, dtInner);
    } else if (state.masterOn && state.mode === 'MANUAL') {
      state.speedCmdPct = state.manualSpeedPct;
    } else {
      state.speedCmdPct = 0;
    }

    // --- 펌프 속도 램프 (VFD 가감속률 제한) ---
    // 바이패스(DOL) 급전 중인 펌프는 속도 지령을 받지 않고 고정속도로
    // 수렴한다(setPumpFeedMode() 주석 참조) — 그 외에는 기존과 동일하게 램프.
    const rampStep = CONST.PUMP_RAMP_RATE_PCT_S * dtInner;
    state.pumps.forEach(p => {
      if (p.fault) return;
      let target;
      if (p.status !== 'RUNNING') target = 0;
      else if (p.feedMode === 'BYPASS') target = CONST.BYPASS_FIXED_SPEED_PCT;
      else target = clamp(state.speedCmdPct, CONST.PUMP_MIN_SPEED_PCT, 100);
      if (p.speedPct < target) p.speedPct = Math.min(target, p.speedPct + rampStep);
      else if (p.speedPct > target) p.speedPct = Math.max(target, p.speedPct - rampStep);
    });

    // --- 유량/차압 (단순 합산 근사) ---
    // 유량측 외란 중에는 같은 속도가 내는 유량이 FLOW_DISTURBANCE_FACTOR만큼
    // 줄어든다(배관저항 급증/공급압력 저하 근사 — applyFlowDisturbance() 주석 참조).
    // 이건 "펌프가 실제로 내는 유량"에 대한 외란이므로, 내부루프가 flowSpM3h와
    // 비교하는 flowTotalM3h에 직접 반영돼야 내부루프가 이 외란을 감지하고 반응한다.
    state.flowTotalM3h = sumPumpFlows(state.pumps) * (state.flowDisturbanceTimer > 0 ? CONST.FLOW_DISTURBANCE_FACTOR : 1);
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
    eligibleStandby, startPump, stopPump, faultPump, clearFaultUI, setPumpFeedMode,
    masterStart, masterStop, setControlMode, applyDisturbance, applyFlowDisturbance,
    outerFlowSpBounds, innerSpeedBounds, singleLoopEquivalentGains, dutyPumpCap,
    outerLoopStep, innerLoopStep, singleLoopStep, stagingStep, interlocksStep,
    stepShadowModels,
    setAlarmActive, evaluateAlarms, ackAlarm, ackAllCritical,
    tick,
  };
});
