/* =============================================================================
 * tests/scenarios.js — 시나리오 A~F 정의 + 게인 배치 시험용 게인 세트
 * ========================================================================= */
const SimCore = require('../sim-core.js');
const { LOAD_LOW_KW, LOAD_MED_KW, LOAD_HIGH_KW } = SimCore.CONST;

/* A. 정상 부하 사이클 — 내장 3단(저/중/고) 순환 부하를 손대지 않고 그대로 사용.
 * LOAD_CYCLE_S(180s)의 3.3배 이상 돌려 여러 사이클에 걸친 정상거동을 관찰. */
function scenarioA() {
  return {
    name: 'A_normal_load_cycle',
    description: '정상 부하 사이클 (내장 저→중→고 3단 순환, 600s ≈ 3.3사이클)',
    durationS: 600,
    seed: 1001,
    events: [{ atS: 0, fn: (state) => SimCore.masterStart(state) }],
  };
}

/* B. 급격한 부하 스텝 (저→고, 고→저) — 게인 배치 시험/단일vs캐스케이드 비교에도 재사용.
 *
 * 스텝 간격(stepUpAtS→stepDownAtS 400s, stepDownAtS→durationS 400s) 근거:
 * 단일 상승스텝만 걸어 격리 측정한 결과(오염 없는 참값) 게인 4세트 중 가장
 * 느린 Conservative(외부Kp -50%)의 복귀시간이 약 134s였다(±0.3°C 밴드 기준).
 * 여기에 3배 이상 여유(약 400s)를 둬서, 어떤 게인 세트를 넣어도 다음 스텝이
 * 오기 전에 응답이 확실히 정착하도록 잡았다. 그래도 못 미치는 경우를 대비해
 * tests/run.js의 계산 자체도 다음 스텝 시각을 넘지 않는 구간으로 한정한다
 * (analyzeDisturbanceRejection의 windowEndS) — 간격을 넉넉히 잡는 것과
 * 계산을 다음 스텝 이전으로 자르는 것, 두 가지를 함께 적용한다. */
function scenarioB(opts) {
  opts = opts || {};
  const stepUpAtS = 100, stepDownAtS = 500;
  const durationS = opts.durationS ?? 900;
  return {
    name: opts.name || 'B_load_step',
    description: `급격한 부하 스텝 (저${LOAD_LOW_KW}kW→고${LOAD_HIGH_KW}kW @${stepUpAtS}s, 고→저 @${stepDownAtS}s)`,
    durationS,
    seed: opts.seed ?? 2001,
    setup(state) {
      if (opts.gains) Object.assign(state.gains, opts.gains);
      if (opts.controlStructure) state.controlStructure = opts.controlStructure;
    },
    events: [{ atS: 0, fn: (state) => SimCore.masterStart(state) }],
    loadProfile(tSec) { return tSec < stepUpAtS ? LOAD_LOW_KW : (tSec < stepDownAtS ? LOAD_HIGH_KW : LOAD_LOW_KW); },
    meta: { stepUpAtS, stepDownAtS },
  };
}

/* B'. 유량측 외란 (배관저항 급증/공급압력 저하 근사) — scenarioB의 열부하 외란과
 * 대응되는 짝. 캐스케이드/단일루프 구조 비교의 핵심은 "외란이 어느 도메인에
 * 들어오는가"이므로, scenarioB(열부하=외부루프 도메인)와 이 시나리오(유량=
 * 내부루프 도메인)를 같은 조건(부하는 중부하로 고정, 단발성 외란 1회, 지속시간
 * 60s로 동일)으로 나란히 비교한다. 부하를 순환시키지 않고 고정하는 이유는
 * "유량측 외란의 순수한 효과"만 보기 위함 — 부하가 같이 흔들리면 두 외란이
 * 섞여 원인을 분리할 수 없다. */
function scenarioBFlow(opts) {
  opts = opts || {};
  const disturbAtS = 100;
  const durationS = opts.durationS ?? 500; // FLOW_DISTURBANCE_DURATION_S(60s)의 8배 이상 관측
  return {
    name: opts.name || 'B_flow_disturbance',
    description: `유량측 외란 (배관저항 급증/공급압력 저하 근사, 부하 ${LOAD_MED_KW}kW 고정, 외란 @${disturbAtS}s×60s)`,
    durationS,
    seed: opts.seed ?? 2001,
    setup(state) {
      if (opts.gains) Object.assign(state.gains, opts.gains);
      if (opts.controlStructure) state.controlStructure = opts.controlStructure;
    },
    events: [
      { atS: 0, fn: (state) => SimCore.masterStart(state) },
      { atS: disturbAtS, fn: (state) => SimCore.applyFlowDisturbance(state) },
    ],
    loadProfile: () => LOAD_MED_KW,
    meta: { disturbAtS },
  };
}

/* C. 운전 중 펌프 1대 고장 → 자동 절체.
 * 고부하로 고정해 다수 펌프가 빨리 필요해지도록 만든 뒤 150s 시점에 고장 주입
 * (사전 실행 결과 고부하 고정시 t≈80~140s 사이에 통상 2~3대가 이미 가동 중이라
 * 150s면 여유있게 다중펌프 상태에서 고장이 발생함을 확인). */
function scenarioC() {
  return {
    name: 'C_single_pump_fault_failover',
    description: '운전 중 펌프 1대 고장(@150s) → 대기 펌프 자동 절체 확인',
    durationS: 400,
    seed: 3001,
    loadProfile: () => LOAD_HIGH_KW,
    events: [
      { atS: 0, fn: (state) => SimCore.masterStart(state) },
      { atS: 150, fn: (state) => SimCore.faultPump(state, state.pumps[0]) },
    ],
    meta: { faultAtS: [150] },
  };
}

/* D. 2대 연속 고장 (1대만 잔존) */
function scenarioD() {
  return {
    name: 'D_double_pump_fault',
    description: '2대 연속 고장(펌프1@150s, 펌프2@250s) → 1대만 잔존한 상태의 거동',
    durationS: 500,
    seed: 4001,
    loadProfile: () => LOAD_HIGH_KW,
    events: [
      { atS: 0, fn: (state) => SimCore.masterStart(state) },
      { atS: 150, fn: (state) => SimCore.faultPump(state, state.pumps[0]) },
      { atS: 250, fn: (state) => SimCore.faultPump(state, state.pumps[1]) },
    ],
    meta: { faultAtS: [150, 250] },
  };
}

/* E. SP 급변 — 부하는 중간값으로 고정해 SP 스텝의 영향만 분리해서 관찰. */
function scenarioE() {
  const spBeforeC = 21, spAfterC = 18, stepAtS = 150;
  return {
    name: 'E_setpoint_step',
    description: `SP 급변 (${spBeforeC}°C → ${spAfterC}°C @${stepAtS}s, 부하는 중간값 고정)`,
    durationS: 400,
    seed: 5001,
    loadProfile: () => LOAD_MED_KW,
    events: [
      { atS: 0, fn: (state) => SimCore.masterStart(state) },
      { atS: stepAtS, fn: (state) => { state.spTempC = spAfterC; } },
    ],
    meta: { stepAtS, spBeforeC, spAfterC },
  };
}

/* F. 부하가 대수제어 임계 근처에서 계속 진동 (헌팅 유발 적대적 시험).
 * 이론상 가장 빠른 투입→해제 왕복 주기는 STAGE_UP_DELAY_S+STAGE_DOWN_DELAY_S=45s
 * (tests/metrics.js 참조). 이보다 훨씬 짧은 25s 주기로 중부하/고부하를 오가며
 * 대수제어가 이 부근에서 자주 흔들리는지(헌팅) 적대적으로 떠본다. */
function scenarioF() {
  const period = 25;
  return {
    name: 'F_staging_boundary_oscillation',
    description: `부하를 중${LOAD_MED_KW}kW/고${LOAD_HIGH_KW}kW 사이에서 ${period}s 주기로 빠르게 진동 (헌팅 유발 시험)`,
    durationS: 600,
    seed: 6001,
    events: [{ atS: 0, fn: (state) => SimCore.masterStart(state) }],
    loadProfile(tSec) {
      const phase = tSec % period;
      return phase < period / 2 ? LOAD_MED_KW : LOAD_HIGH_KW;
    },
    meta: { period },
  };
}

/* G. Anti-windup 효과 비교 — 외부루프(유량 SP)를 확실하게, 오래 포화시킨 뒤
 * 부하를 정상으로 되돌려 anti-windup ON/OFF의 차이를 본다.
 *
 * 과부하 크기(6000kW) 근거: 결정론적 부하(노이즈 제외)로 임계점을 스캔해보면
 * 외부루프 CV(flowSpM3h)가 상한(660 m3/h)에 처음 닿기 시작하는 지점이 약
 * 4200kW다. UI 부하슬라이더 상한(6000kW, README "부하 슬라이더 상한" 참조)과
 * 맞춰, 임계점 대비 여유 있게 포화가 "확실히, 노이즈에 흔들리지 않고" 유지되는
 * 수준으로 잡았다.
 * 과부하 지속시간(300s) 근거: anti-windup OFF일 때 적분이 계속 불어나는
 * 것을 보여주려면, ON일 때 적분이 포화 직후 곧바로 멈추는 것과 뚜렷이
 * 대비될 만큼 충분히 길게 유지해야 한다. 이 시나리오의 지배적 시정수
 * (HX_THERMAL_TAU_S=12s, 외부루프 주기 1s)의 수십 배 이상으로 잡아 과도응답이
 * 아니라 "정상상태로 포화가 유지된 뒤"의 효과를 보도록 했다.
 * 기준부하(2200kW=LOAD_MED_KW)·복귀 후 관측시간(600s) 근거: 기준부하는 다른
 * 시나리오(scenarioBFlow)와 동일하게 "중부하"를 재사용해 별도로 새 대표값을
 * 만들지 않았고, 관측시간은 사전 프로토타입 실행에서 ON/OFF 둘 다 밴드
 * 복귀가 380s 이내에 끝나는 것을 확인한 뒤 여유를 더해 잡았다. */
function scenarioAntiWindup(opts) {
  opts = opts || {};
  const baselineKW = LOAD_MED_KW;
  const overloadKW = 6000;
  const overloadAtS = 300; // 기준부하로 안정화할 시간(정착시간 대비 충분한 여유)
  const overloadDurS = 300;
  const returnAtS = overloadAtS + overloadDurS;
  const durationS = opts.durationS ?? returnAtS + 600;
  return {
    name: opts.name || 'G_antiwindup_compare',
    description: `Anti-windup 비교: 중부하(${baselineKW}kW) 안정화 → 과부하(${overloadKW}kW) ${overloadDurS}s → 중부하 복귀`,
    durationS,
    seed: opts.seed ?? 7001,
    setup(state) {
      state.antiWindupEnabled = opts.antiWindupEnabled ?? true;
    },
    events: [{ atS: 0, fn: (state) => SimCore.masterStart(state) }],
    loadProfile(tSec) {
      return (tSec >= overloadAtS && tSec < returnAtS) ? overloadKW : baselineKW;
    },
    meta: { baselineKW, overloadKW, overloadAtS, overloadDurS, returnAtS },
  };
}

function allScenarios() {
  return [scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE(), scenarioF()];
}

/* ---- 게인 배치 시험용 게인 세트 ----
 * Default는 CONST.OUTER_KP0 등 실제 기본값과 동일. 나머지는 그 대비 -50%/+100%,
 * 그리고 D항 추가(PID 프리셋과 동일하게 Kd=20)로 비교 대상을 넓힌 것으로,
 * "최적으로 튜닝된 값"이 아니라 게인 크기가 오버슈트/정착시간/토글횟수에 미치는
 * 영향을 보여주기 위한 예시 세트임을 명시한다. */
const GAIN_SETS = [
  { name: 'Conservative(외부Kp -50%)', gains: { oKp: 20, oKi: 2, oKd: 0, iKp: 0.15, iKi: 0.08, iKd: 0 } },
  { name: 'Default(기본값)', gains: { oKp: 40, oKi: 4, oKd: 0, iKp: 0.3, iKi: 0.15, iKd: 0 } },
  { name: 'Aggressive(외부Kp +100%)', gains: { oKp: 80, oKi: 8, oKd: 0, iKp: 0.6, iKi: 0.3, iKd: 0 } },
  { name: 'PID(D항 추가, Kd=20)', gains: { oKp: 40, oKi: 4, oKd: 20, iKp: 0.3, iKi: 0.15, iKd: 0 } },
];

module.exports = { scenarioA, scenarioB, scenarioBFlow, scenarioC, scenarioD, scenarioE, scenarioF, scenarioAntiWindup, allScenarios, GAIN_SETS };
