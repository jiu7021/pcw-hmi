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
    const upStep = metrics.analyzeDisturbanceRejection(series, scn.meta.stepUpAtS, sp);
    const downStep = metrics.analyzeDisturbanceRejection(series, scn.meta.stepDownAtS, sp);
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

/* ---------------------------- 2) 게인 배치 시험 (시나리오 B, 캐스케이드) ---------------------------- */
console.log('\n=== 2/3 게인 배치 시험 (시나리오 B × 게인 4세트) ===');
const gainSweepRows = [];
for (const gset of scenarios.GAIN_SETS) {
  const scn = scenarios.scenarioB({ name: `B_gain_${gset.name}`, gains: gset.gains, controlStructure: 'CASCADE', seed: 2001 });
  const result = runSimulation(scn);
  const staging = metrics.computeStagingToggles(result.runningCountSeries);
  const series = result.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC }));
  const sp = result.trendSeries[0].spTempC;
  const up = metrics.analyzeDisturbanceRejection(series, scn.meta.stepUpAtS, sp);
  const down = metrics.analyzeDisturbanceRejection(series, scn.meta.stepDownAtS, sp);
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
  const up = metrics.analyzeDisturbanceRejection(series, scn.meta.stepUpAtS, sp);
  const down = metrics.analyzeDisturbanceRejection(series, scn.meta.stepDownAtS, sp);
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

/* ---------------------------- 3) CSV 저장 ---------------------------- */
console.log('\n=== 3/3 결과 저장 ===');
writeCSV('invariants.csv', invariantRows);
writeCSV('scenario_metrics.csv', scenarioMetricRows);
writeCSV('step_response.csv', stepResponseRows);
writeCSV('pump_balance.csv', pumpBalanceRows);
writeCSV('gain_sweep.csv', gainSweepRows);
writeCSV('structure_sweep.csv', structureSweepRows);
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
for (const id of allInvariantIds) invByType[id] = { pass: 0, fail: 0 };
for (const row of invariantRows) {
  if (row.status === 'PASS') invByType[row.invariant].pass++; else invByType[row.invariant].fail++;
}
let anyFail = false;
for (const id of allInvariantIds) {
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
    console.log(`    state: ${JSON.stringify(v.stateDump)}`);
  });
  process.exitCode = 1;
} else {
  console.log('\n✅ 6종 안전 불변조건 전부 PASS (시나리오 A~F + 게인배치시험 + 구조비교, 전 틱 기준)');
}
