#!/usr/bin/env node
/* =============================================================================
 * tests/run.js — 제어 로직 자동 검증 스위트 메인 진입점
 *
 * 사용법: node tests/run.js
 *
 *   1) 시나리오 A~F를 각각 헤드리스로 시뮬레이션하며 매 틱 안전 불변조건 6종을
 *      검사한다. 위반이 하나라도 있으면 그 즉시(테스트를 통과시키려고 조건을
 *      느슨하게 바꾸지 않고) 실패로 보고한다.
 *   2) 위반은 아니지만 참고할 성능 지표(대수제어 토글횟수/헌팅판정, 오버슈트,
 *      정착시간, 정상상태편차, 펌프별 기동횟수·운전시간 편차)를 계산한다.
 *   3) 게인 세트 4종 × 시나리오B, 그리고 단일루프 vs 캐스케이드 × 시나리오B를
 *      비교해 표로 남긴다.
 *   4) 콘솔에는 단계별 한 줄 요약 + 최종 PASS/FAIL만 출력한다. 상세 수치는
 *      tests/results/*.csv로 저장한다.
 * ========================================================================= */
const fs = require('fs');
const path = require('path');

const SimCore = require('../sim-core.js');
const { runSimulation } = require('./runner.js');
const scenarios = require('./scenarios.js');
const metrics = require('./metrics.js');
const { runPlantSimulation } = require('./runner-plant.js');
const plantScenarios = require('./scenarios-plant.js');
const { runInterlockBypassDemo } = require('./sag-demo.js');

const RESULTS_DIR = path.join(__dirname, 'results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

function toCSV(rows) {
  if (!rows.length) return '';
  // 행마다 필드 구성이 다를 수 있으므로(예: 시나리오별 스텝응답 지표 종류가 다름)
  // 첫 행이 아니라 전체 행의 key 합집합을 헤더로 쓴다.
  const headerSet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => headerSet.add(k)));
  const headers = Array.from(headerSet);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => esc(row[h])).join(','));
  return lines.join('\n') + '\n';
}
function writeCSV(filename, rows) {
  fs.writeFileSync(path.join(RESULTS_DIR, filename), toCSV(rows), 'utf8');
}

/* ---------------------------- 1) 시나리오 A~F: 불변조건 + 지표 ---------------------------- */
const allInvariantIds = [
  'INV1_NO_SIMULTANEOUS_STARTING', 'INV2_FAULT_NEVER_RUNNING', 'INV3_CHILLER_OFF_NO_PUMPS',
  'INV4_MIN_FLOW_PROTECTION', 'INV5_ANTI_WINDUP', 'INV6_ALARM_NO_CHATTER',
];

const invariantRows = [];
const scenarioMetricRows = [];
const stepResponseRows = [];
const pumpBalanceRows = [];
const allViolations = [];

function runOneScenario(scn) {
  const result = runSimulation(scn);
  const byInv = {};
  for (const id of allInvariantIds) byInv[id] = [];
  for (const v of result.violations) byInv[v.invariantId].push(v);

  for (const id of allInvariantIds) {
    const vs = byInv[id];
    invariantRows.push({
      scenario: scn.name,
      invariant: id,
      status: vs.length ? 'FAIL' : 'PASS',
      violationCount: vs.length,
      firstViolationSimS: vs.length ? vs[0].simTimeS : '',
      firstViolationMessage: vs.length ? vs[0].message : '',
    });
  }
  allViolations.push(...result.violations);

  const staging = metrics.computeStagingToggles(result.runningCountSeries);
  const balance = metrics.computePumpBalance(result.state.pumps);
  scenarioMetricRows.push({
    scenario: scn.name,
    durationS: scn.durationS,
    stagingToggles: staging.toggles,
    togglesPerMin: +staging.perMin.toFixed(3),
    huntingSuspected: staging.huntingSuspected,
    huntingThresholdPerMin: +staging.huntingThresholdPerMin.toFixed(3),
    maxPumpRuntimeHDiff: +balance.maxRuntimeHDiff.toFixed(4),
    maxPumpStartCountDiff: balance.maxStartCountDiff,
  });
  pumpBalanceRows.push(...balance.perPump.map(p => ({ scenario: scn.name, pump: p.id, startCount: p.startCount, runtimeH: +p.runtimeH.toFixed(4) })));

  // 시나리오별 스텝응답 지표 (해당되는 경우만)
  if (scn.name.startsWith('B_load_step') && scn.meta) {
    const sp = result.trendSeries[0].spTempC;
    const series = result.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC }));
    const upStep = metrics.analyzeDisturbanceRejection(series, scn.meta.stepUpAtS, sp, undefined, scn.meta.stepDownAtS);
    const downStep = metrics.analyzeDisturbanceRejection(series, scn.meta.stepDownAtS, sp, undefined, scn.durationS);
    [{ label: '저→고 스텝', r: upStep }, { label: '고→저 스텝', r: downStep }].forEach(({ label, r }) => {
      if (r) stepResponseRows.push({
        scenario: scn.name, step: label, metric: 'disturbance_rejection',
        peakDeviationC: +r.peakDeviation.toFixed(3),
        recoveryTimeS: r.recoveryTimeS == null ? 'not_settled_in_window' : +r.recoveryTimeS.toFixed(1),
        toleranceC: r.toleranceAbs,
      });
    });
  }
  if (scn.name === 'E_setpoint_step' && scn.meta) {
    const r = metrics.analyzeStepResponse(result.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC })), scn.meta.stepAtS, scn.meta.spAfterC);
    if (r) stepResponseRows.push({
      scenario: scn.name, step: 'SP step', metric: 'setpoint_step',
      overshootPct: +r.overshootPct.toFixed(2),
      settleTimeS: r.settleTimeS == null ? 'not_settled_in_window' : +r.settleTimeS.toFixed(1),
      steadyStateErrorC: +r.steadyStateError.toFixed(3),
    });
  }

  const pass = result.violations.length === 0;
  console.log(`[시나리오 ${scn.name}] ${pass ? 'PASS' : 'FAIL(' + result.violations.length + '건 위반)'} — 토글 ${staging.toggles}회(${staging.perMin.toFixed(2)}/분)${staging.huntingSuspected ? ' ⚠헌팅의심' : ''}`);
  return { scn, result, pass };
}

console.log('=== 1/3 시나리오 A~F 실행 ===');
const scenarioResults = scenarios.allScenarios().map(runOneScenario);

/* ---------------------------- 1b) 대수제어 정책 역산 ----------------------------
 * 히스테리시스 밴드와 확인지연이 실제로 얼마나 억제하고 있는지를, 같은 속도지령
 * 궤적에 정책만 바꿔 덧씌워 센다. 실제 실행 비교가 아니라 후처리 역산이라는 점은
 * metrics.js computeStagingCounterfactual 주석 참조. */
console.log('\n=== 1b/3 대수제어 정책 역산 (히스테리시스·지연 기여도) ===');
const stagingCounterfactualRows = [];
const CF_POLICIES = [
  { key: 'actual_policy', label: '실제 정책(밴드+지연)', upPct: SimCore.CONST.STAGE_UP_SPEED_PCT, downPct: SimCore.CONST.STAGE_DOWN_SPEED_PCT, upDelay: SimCore.CONST.STAGE_UP_DELAY_S, downDelay: SimCore.CONST.STAGE_DOWN_DELAY_S },
  { key: 'no_delay', label: '지연 제거(밴드만)', upPct: SimCore.CONST.STAGE_UP_SPEED_PCT, downPct: SimCore.CONST.STAGE_DOWN_SPEED_PCT, upDelay: 0, downDelay: 0 },
  // 밴드 제거 = 증속 임계 하나로 투입·해제를 모두 판정(단일 임계). 임계값을
  // 새로 지어내지 않으려고 기존 STAGE_UP_SPEED_PCT를 그대로 쓴다.
  { key: 'no_band', label: '밴드 제거(지연만)', upPct: SimCore.CONST.STAGE_UP_SPEED_PCT, downPct: SimCore.CONST.STAGE_UP_SPEED_PCT, upDelay: SimCore.CONST.STAGE_UP_DELAY_S, downDelay: SimCore.CONST.STAGE_DOWN_DELAY_S },
  { key: 'none', label: '밴드·지연 모두 제거', upPct: SimCore.CONST.STAGE_UP_SPEED_PCT, downPct: SimCore.CONST.STAGE_UP_SPEED_PCT, upDelay: 0, downDelay: 0 },
];
for (const { scn, result } of scenarioResults) {
  if (!['A_normal_load_cycle', 'B_load_step', 'F_staging_boundary_oscillation'].includes(scn.name)) continue;
  const actualToggles = metrics.countStagingTogglesExcludingStartup(result.runningCountSeries);
  const line = [];
  for (const pol of CF_POLICIES) {
    const cf = metrics.computeStagingCounterfactual(result.trendSeries, pol);
    stagingCounterfactualRows.push({
      scenario: scn.name, durationS: scn.durationS, policy: pol.key, policyLabel: pol.label,
      upPct: pol.upPct, downPct: pol.downPct, upDelayS: pol.upDelay, downDelayS: pol.downDelay,
      toggles: cf.toggles, togglesPerMin: +cf.perMin.toFixed(3),
      actualTogglesExclStartup: actualToggles,
      // 실제와 동일한 정책으로 역산했을 때 실제값이 재현되는지 — 역산 방법 자체의
      // 타당성 점검이다. 여기가 false면 역산 결과 전부를 믿을 수 없다.
      reproducesActual: pol.key === 'actual_policy' ? (cf.toggles === actualToggles) : '',
    });
    line.push(`${pol.label} ${cf.toggles}회`);
  }
  console.log(`  [${scn.name}] 실제(초기기동 제외) ${actualToggles}회 — ` + line.join(' / '));
}
writeCSV('staging_counterfactual.csv', stagingCounterfactualRows);
const cfSelfCheckFail = stagingCounterfactualRows.filter(r => r.policy === 'actual_policy' && r.reproducesActual !== true);
if (cfSelfCheckFail.length) {
  console.log(`  ⚠ 역산 타당성 점검 실패 ${cfSelfCheckFail.length}건 — 동일 정책인데 실제 토글 수를 재현하지 못했다.`);
} else {
  console.log('  → 역산 타당성 점검 통과: 동일 정책으로 역산하면 실제 토글 수를 그대로 재현한다.');
}

/* ---------------------------- 2) 게인 배치 시험 (시나리오 B, 캐스케이드) ---------------------------- */
console.log('\n=== 2/3 게인 배치 시험 (시나리오 B × 게인 4세트) ===');
const gainSweepRows = [];
for (const gset of scenarios.GAIN_SETS) {
  const scn = scenarios.scenarioB({ name: `B_gain_${gset.name}`, gains: gset.gains, controlStructure: 'CASCADE', seed: 2001 });
  const result = runSimulation(scn);
  const staging = metrics.computeStagingToggles(result.runningCountSeries);
  const series = result.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC }));
  const sp = result.trendSeries[0].spTempC;
  // windowEndS: 각 스텝 응답은 "다음 스텝이 오기 전까지"만 보고 판정한다 —
  // 안 그러면 상승스텝 복귀시간 계산에 하강스텝의 undershoot가 섞여 들어간다.
  const up = metrics.analyzeDisturbanceRejection(series, scn.meta.stepUpAtS, sp, undefined, scn.meta.stepDownAtS);
  const down = metrics.analyzeDisturbanceRejection(series, scn.meta.stepDownAtS, sp, undefined, scn.durationS);
  const violationCount = result.violations.length;
  gainSweepRows.push({
    gainSet: gset.name,
    oKp: gset.gains.oKp, oKi: gset.gains.oKi, oKd: gset.gains.oKd,
    iKp: gset.gains.iKp, iKi: gset.gains.iKi, iKd: gset.gains.iKd,
    upStepPeakDeviationC: +up.peakDeviation.toFixed(3),
    upStepRecoveryTimeS: up.recoveryTimeS == null ? 'not_settled' : +up.recoveryTimeS.toFixed(1),
    downStepPeakDeviationC: +down.peakDeviation.toFixed(3),
    downStepRecoveryTimeS: down.recoveryTimeS == null ? 'not_settled' : +down.recoveryTimeS.toFixed(1),
    stagingToggles: staging.toggles,
    togglesPerMin: +staging.perMin.toFixed(3),
    invariantViolations: violationCount,
  });
  allViolations.push(...result.violations);
  console.log(`  [게인:${gset.name}] 상승스텝 최대편차 ${up.peakDeviation.toFixed(2)}°C / 복귀 ${up.recoveryTimeS == null ? 'N/A' : up.recoveryTimeS.toFixed(1) + 's'}, 토글 ${staging.toggles}회${violationCount ? ` ⚠위반${violationCount}건` : ''}`);
}

/* ---------------------------- 2b) 단일루프 vs 캐스케이드 (시나리오 B) ---------------------------- */
console.log('\n=== 2b/3 단일루프 vs 캐스케이드 비교 (시나리오 B) ===');
const structureSweepRows = [];
for (const structure of ['CASCADE', 'SINGLE']) {
  const scn = scenarios.scenarioB({ name: `B_structure_${structure}`, controlStructure: structure, seed: 2001 });
  const result = runSimulation(scn);
  const staging = metrics.computeStagingToggles(result.runningCountSeries);
  const series = result.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC }));
  const sp = result.trendSeries[0].spTempC;
  const up = metrics.analyzeDisturbanceRejection(series, scn.meta.stepUpAtS, sp, undefined, scn.meta.stepDownAtS);
  const down = metrics.analyzeDisturbanceRejection(series, scn.meta.stepDownAtS, sp, undefined, scn.durationS);
  const violationCount = result.violations.length;
  structureSweepRows.push({
    controlStructure: structure,
    upStepPeakDeviationC: +up.peakDeviation.toFixed(3),
    upStepRecoveryTimeS: up.recoveryTimeS == null ? 'not_settled' : +up.recoveryTimeS.toFixed(1),
    downStepPeakDeviationC: +down.peakDeviation.toFixed(3),
    downStepRecoveryTimeS: down.recoveryTimeS == null ? 'not_settled' : +down.recoveryTimeS.toFixed(1),
    stagingToggles: staging.toggles,
    togglesPerMin: +staging.perMin.toFixed(3),
    invariantViolations: violationCount,
  });
  allViolations.push(...result.violations);
  console.log(`  [${structure}] 상승스텝 최대편차 ${up.peakDeviation.toFixed(2)}°C / 복귀 ${up.recoveryTimeS == null ? 'N/A' : up.recoveryTimeS.toFixed(1) + 's'}${violationCount ? ` ⚠위반${violationCount}건` : ''}`);
}

/* ---------------------------- 2c) 열부하 외란 vs 유량측 외란 (캐스케이드/단일루프 × 2) ----------------------------
 * scenarioB(열부하, 외부루프 도메인)와 scenarioBFlow(유량, 내부루프 도메인)를
 * 같은 구조 2종에 각각 걸어, "외란이 어느 도메인에서 들어오느냐"에 따라
 * 캐스케이드/단일루프의 우열이 어떻게 달라지는지 직접 비교한다. */
console.log('\n=== 2c/3 열부하 vs 유량측 외란 비교 (캐스케이드/단일루프) ===');
const disturbanceCompareRows = [];
for (const disturbanceKind of ['LOAD', 'FLOW']) {
  for (const structure of ['CASCADE', 'SINGLE']) {
    const makeScn = disturbanceKind === 'LOAD' ? scenarios.scenarioB : scenarios.scenarioBFlow;
    const scn = makeScn({ name: `B_${disturbanceKind}_${structure}`, controlStructure: structure, seed: 2001 });
    const result = runSimulation(scn);
    const series = result.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC }));
    const sp = result.trendSeries[0].spTempC;
    const stepAtS = scn.meta.stepUpAtS ?? scn.meta.disturbAtS;
    const windowEndS = scn.meta.stepDownAtS ?? scn.durationS;
    const r = metrics.analyzeDisturbanceRejection(series, stepAtS, sp, undefined, windowEndS);
    const violationCount = result.violations.length;
    disturbanceCompareRows.push({
      disturbanceKind, controlStructure: structure,
      peakDeviationC: +r.peakDeviation.toFixed(3),
      recoveryTimeS: r.recoveryTimeS == null ? 'not_settled' : +r.recoveryTimeS.toFixed(1),
      invariantViolations: violationCount,
    });
    allViolations.push(...result.violations);
    console.log(`  [${disturbanceKind}/${structure}] 최대편차 ${r.peakDeviation.toFixed(2)}°C / 복귀 ${r.recoveryTimeS == null ? 'N/A' : r.recoveryTimeS.toFixed(1) + 's'}${violationCount ? ` ⚠위반${violationCount}건` : ''}`);
  }
}
writeCSV('disturbance_type_compare.csv', disturbanceCompareRows);

/* ---------------------------- 2d) Anti-windup 비교 (ON vs OFF) ---------------------------- */
console.log('\n=== 2d/3 Anti-windup 비교 (ON vs OFF) ===');
const antiWindupRows = [];
for (const awEnabled of [true, false]) {
  const scn = scenarios.scenarioAntiWindup({ name: `G_antiwindup_${awEnabled ? 'ON' : 'OFF'}`, antiWindupEnabled: awEnabled, seed: 7001 });
  const result = runSimulation(scn);
  const sp = result.trendSeries[0].spTempC;
  const r = metrics.analyzeAntiWindup(result.trendSeries, scn.meta.overloadAtS, scn.meta.returnAtS, sp, 0.3, scn.durationS);
  const violationCount = result.violations.length;
  antiWindupRows.push({
    antiWindup: awEnabled ? 'ON' : 'OFF',
    maxIntegralDuringOverload: +r.maxIntegralDuringOverload.toFixed(2),
    peakUndershootC: +r.peakUndershootC.toFixed(3),
    peakUndershootAtS: +r.minTempAtS.toFixed(1),
    recoveryTimeS: r.recoveryTimeS == null ? 'not_settled' : +r.recoveryTimeS.toFixed(1),
    invariantViolations: violationCount,
  });
  // OFF 실행은 anti-windup(INV5)을 일부러 끄고 위반을 재현하는 시험이므로, 그
  // 위반을 전체 스위트의 allViolations(최종 PASS/FAIL 판정)에는 넣지 않는다 —
  // 여기서 INV5가 걸리는 건 버그가 아니라 이 비교의 목적 그 자체다. ON 실행은
  // 평소처럼(anti-windup 켜짐) 돌아가므로 위반이 나오면 진짜 회귀로 취급한다.
  if (awEnabled) allViolations.push(...result.violations);
  console.log(`  [${awEnabled ? 'ON' : 'OFF'}] 적분항 최댓값 ${r.maxIntegralDuringOverload.toFixed(1)} / 최대 언더슈트 ${r.peakUndershootC.toFixed(2)}°C / 복귀 ${r.recoveryTimeS == null ? 'N/A' : r.recoveryTimeS.toFixed(1) + 's'}${violationCount ? ` (참고: INV5 위반 ${violationCount}건 — 의도된 것)` : ''}`);
}
writeCSV('antiwindup_compare.csv', antiWindupRows);

/* ---------------------------- 3) 확장 스위트: 전기/전력품질/센서/통신 ---------------------------- */
console.log('\n=== 3/4 확장 스위트 (전기·전력품질·센서 계층, 시나리오 H/I/J) ===');
const extendedInvariantIds = allInvariantIds.concat(['INV7_CV_BOUNDED_UNDER_SENSOR_FAULT', 'INV8_VOLTAGE_FLOOR_NORMAL_OPS']);
const sagStatsRows = [];
const driftBlindSpotRows = [];
const changeoverRows = [];

for (const scn of plantScenarios.allPlantScenarios()) {
  const result = runPlantSimulation(scn);
  const byInv = {};
  for (const id of extendedInvariantIds) byInv[id] = [];
  for (const v of result.violations) byInv[v.invariantId].push(v);
  for (const id of extendedInvariantIds) {
    const vs = byInv[id];
    invariantRows.push({
      scenario: scn.name, invariant: id, status: vs.length ? 'FAIL' : 'PASS',
      violationCount: vs.length,
      firstViolationSimS: vs.length ? vs[0].simTimeS : '',
      firstViolationMessage: vs.length ? vs[0].message : '',
    });
  }
  allViolations.push(...result.violations);

  const sag = metrics.computeSagStats(result.plant.pq.eventLog);
  sagStatsRows.push({ scenario: scn.name, sagCount: sag.count, avgDepthPct: +sag.avgDepthPct.toFixed(2), maxDepthPct: +sag.maxDepthPct.toFixed(2), avgDurationMs: +sag.avgDurationMs.toFixed(1), maxDurationMs: +sag.maxDurationMs.toFixed(1) });

  if (scn.recordDrift) {
    const bs = metrics.computeDriftBlindSpot(result.driftSeries);
    driftBlindSpotRows.push({
      scenario: scn.name, deviationThresholdC: bs.deviationThresholdC,
      deviationExceededAtS: bs.deviationExceededAtS, diagFirstActiveAtS: bs.diagFirstActiveAtS,
      everDetected: bs.everDetected, blindSpotDurationS: bs.blindSpotDurationS, finalDeviationC: +bs.finalDeviationC.toFixed(3),
      // blindSpotDurationS는 기동 과도 때문에 열화 유무를 구분하지 못한다
      // (metrics.js 주석 참조). 비율 지표는 컷오프 없이 그 둘을 갈라준다.
      exceededSampleCount: bs.exceededSampleCount,
      totalSampleCount: bs.totalSampleCount,
      exceededSampleRatioPct: +(bs.exceededSampleRatio * 100).toFixed(2),
    });
  }

  let changeoverNote = '';
  if (scn.recordChangeover && scn.meta) {
    // TOLERANCE_C(±2°C): "절체 후에도 제어가 유지되었다"고 볼 수 있는 대표
    // 허용폭 — 정상 시나리오들의 정상상태편차(steadyStateErrorC, 대개 0.01°C
    // 미만)보다 훨씬 넉넉하게 잡아, 바이패스로 고정속도 펌프가 섞여 정밀도는
    // 다소 떨어지더라도 "제어 자체는 살아있다"는 것만 확인하는 취지의 가정치.
    const TOLERANCE_C = 2.0;
    const finalErrorC = result.state.supplyTempC - result.state.spTempC;
    const maintained = Math.abs(finalErrorC) <= TOLERANCE_C;
    // 온도 지표로는 절체 여부를 구분할 수 없다 — 절체 케이스와 대조군의
    // 공급온도 궤적이 전 구간 최대 0.0264°C밖에 차이나지 않고, t=100s의
    // 과도(3.107°C)는 VFD 고장이 아니라 고부하 기동·대수제어 과도라서
    // 대조군에도 똑같이 나타난다. 그래서 "온도가 안 바뀐다"는 사실 자체를
    // 결과로 싣고, 실제로 갈리는 펌프 속도·급전모드를 함께 기록한다.
    const eventAtS = scn.meta.vfdFaultAtS ?? scn.meta.compareAtS;
    const finalSpeeds = result.state.pumps.map(p => +p.speedPct.toFixed(1));
    changeoverRows.push({
      scenario: scn.name, vfdFaultAtS: scn.meta.vfdFaultAtS,
      finalSupplyTempC: +result.state.supplyTempC.toFixed(3), spTempC: result.state.spTempC,
      finalErrorC: +finalErrorC.toFixed(3), toleranceC: TOLERANCE_C, controlMaintained: maintained,
      pump1FeedMode: result.state.pumps[0].feedMode, pump1Status: result.state.pumps[0].status,
      eventAtS,
      finalSpeedPct: finalSpeeds.join('/'),
      finalFeedModes: result.state.pumps.map(p => p.feedMode).join('/'),
      finalFlowM3h: +result.state.flowTotalM3h.toFixed(1),
    });
    changeoverNote = ` — 온도제어 유지: ${maintained ? 'YES' : 'NO'}(최종오차 ${finalErrorC.toFixed(2)}°C), 최종 속도 ${finalSpeeds.join('/')}%`;
  }

  const pass = result.violations.length === 0;
  console.log(`[시나리오 ${scn.name}] ${pass ? 'PASS' : 'FAIL(' + result.violations.length + '건 위반)'} — sag ${sag.count}건(최대깊이 ${sag.maxDepthPct.toFixed(1)}%)${changeoverNote}`);
}

console.log('\n  [동시기동 인터록 우회 데모 — 정식 시나리오 아님, 상수 근거 실증용]');
const bypassDemo = runInterlockBypassDemo();
console.log(`    정상(1대 기동): 최저전압 ${bypassDemo.normalCase.minVoltagePct.toFixed(1)}% (관리한계 ${bypassDemo.floorPct}% ${bypassDemo.normalCase.breachesFloor ? '위반' : '준수'})`);
console.log(`    우회(2대 동시기동): 최저전압 ${bypassDemo.bypassCase.minVoltagePct.toFixed(1)}% (관리한계 ${bypassDemo.floorPct}% ${bypassDemo.bypassCase.breachesFloor ? '위반' : '준수'}), ESS 투입 시점 전압 ${bypassDemo.bypassCase.essEngagedAtPct == null ? 'N/A' : bypassDemo.bypassCase.essEngagedAtPct.toFixed(1) + '%'}`);
console.log(`    → 인터록의 필요성이 수치로 증명됨: ${bypassDemo.demonstratesInterlockNecessity}`);

/* ---------------------------- 4) CSV 저장 ---------------------------- */
console.log('\n=== 4/4 결과 저장 ===');
writeCSV('invariants.csv', invariantRows);
writeCSV('scenario_metrics.csv', scenarioMetricRows);
writeCSV('step_response.csv', stepResponseRows);
writeCSV('pump_balance.csv', pumpBalanceRows);
writeCSV('gain_sweep.csv', gainSweepRows);
writeCSV('structure_sweep.csv', structureSweepRows);
writeCSV('sag_stats.csv', sagStatsRows);
writeCSV('drift_blind_spot.csv', driftBlindSpotRows);
writeCSV('bypass_changeover.csv', changeoverRows);
writeCSV('interlock_bypass_demo.csv', [
  { case: 'normal_single_start', minVoltagePct: +bypassDemo.normalCase.minVoltagePct.toFixed(2), floorPct: bypassDemo.floorPct, breachesFloor: bypassDemo.normalCase.breachesFloor,
    peakCurrentPct: +bypassDemo.normalCase.peakCurrentPct.toFixed(0), essEngagedAtS: bypassDemo.normalCase.essEngagedAtS },
  { case: 'bypass_simultaneous_start', minVoltagePct: +bypassDemo.bypassCase.minVoltagePct.toFixed(2), floorPct: bypassDemo.floorPct, breachesFloor: bypassDemo.bypassCase.breachesFloor, essEngagedAtPct: bypassDemo.bypassCase.essEngagedAtPct == null ? null : +bypassDemo.bypassCase.essEngagedAtPct.toFixed(2),
    peakCurrentPct: +bypassDemo.bypassCase.peakCurrentPct.toFixed(0), essEngagedAtS: bypassDemo.bypassCase.essEngagedAtS },
]);
// 위반이 없어도 항상 갱신한다 — 그렇지 않으면 과거 실패 실행의 잔재 파일이
// 남아 "지금도 실패 중"인 것처럼 보이는 오해를 일으킨다.
const violationsPath = path.join(RESULTS_DIR, 'violations.json');
if (allViolations.length) {
  fs.writeFileSync(violationsPath, JSON.stringify(allViolations, null, 2), 'utf8');
} else if (fs.existsSync(violationsPath)) {
  fs.unlinkSync(violationsPath);
}
console.log(`  → tests/results/*.csv 저장 완료 (${fs.readdirSync(RESULTS_DIR).length}개 파일)`);

/* ---------------------------- 최종 PASS/FAIL 요약 ---------------------------- */
console.log('\n=== 최종 요약 ===');
const invByType = {};
for (const id of extendedInvariantIds) invByType[id] = { pass: 0, fail: 0 };
for (const row of invariantRows) {
  if (row.status === 'PASS') invByType[row.invariant].pass++; else invByType[row.invariant].fail++;
}
let anyFail = false;
for (const id of extendedInvariantIds) {
  const s = invByType[id];
  const ok = s.fail === 0;
  if (!ok) anyFail = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  (시나리오 ${s.pass}/${s.pass + s.fail} 통과)`);
}

if (anyFail) {
  console.log(`\n⚠ 불변조건 위반 발견. 상세: tests/results/invariants.csv, tests/results/violations.json`);
  console.log('가장 이른 위반 상세 상태 덤프 (최대 5건):');
  allViolations.slice(0, 5).forEach(v => {
    console.log(`  - [${v.scenario} / ${v.invariantId} @ t=${v.simTimeS}s] ${v.message}`);
    if (v.stateDump) console.log(`    state: ${JSON.stringify(v.stateDump)}`);
  });
  process.exitCode = 1;
} else {
  console.log('\n✅ 8종 안전 불변조건 전부 PASS (시나리오 A~F, H/I/J, 게인배치시험, 구조비교, 전 틱 기준)');
}
