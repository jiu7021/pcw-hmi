/* =============================================================================
 * tests/runner.js — 시나리오 서술을 받아 헤드리스로 시뮬레이션을 돌리는 공용 러너
 * ========================================================================= */
const SimCore = require('../sim-core.js');
const { createAllInvariants } = require('./invariants.js');

function dumpState(state) {
  return {
    simTimeS: +state.simTimeS.toFixed(2),
    masterOn: state.masterOn, mode: state.mode, controlStructure: state.controlStructure,
    supplyTempC: +state.supplyTempC.toFixed(3), returnTempC: +state.returnTempC.toFixed(3),
    flowTotalM3h: +state.flowTotalM3h.toFixed(2), dpKPa: +state.dpKPa.toFixed(2),
    tankLevelPct: +state.tankLevelPct.toFixed(2), chillerRunning: state.chillerRunning,
    hxProtectionActive: state.hxProtectionActive,
    flowSpM3h: +state.flowSpM3h.toFixed(2), speedCmdPct: +state.speedCmdPct.toFixed(2),
    outerIntegral: +state.outerPid.integral.toFixed(4), innerIntegral: +state.innerPid.integral.toFixed(4),
    pumps: state.pumps.map(p => ({ id: p.id, status: p.status, fault: p.fault, speedPct: +p.speedPct.toFixed(1) })),
  };
}

// scenario = {
//   name, description, durationS, seed,
//   setup(state, shadow) -> void,          // 초기 게인/SP 등 설정 (선택)
//   events: [{atS, fn(state, shadow)}],    // 특정 시각에 1회 실행할 액션들 (선택)
//   loadProfile(tSec) -> kW,               // 내장 3단 순환 부하 대신 쓸 프로파일 (선택)
//   useShadow: boolean (기본 true),
// }
function runSimulation(scenario) {
  const dtInner = SimCore.CONST.INNER_PERIOD_MS / 1000;
  const state = SimCore.createInitialState();
  const shadow = scenario.useShadow === false ? null : SimCore.createShadowState();
  const rng = SimCore.createSeededRng(scenario.seed ?? 1);

  if (scenario.setup) scenario.setup(state, shadow);

  const invariants = createAllInvariants(dtInner);
  const violations = [];

  const events = (scenario.events || []).slice().sort((a, b) => a.atS - b.atS);
  let nextEventIdx = 0;

  const runningCountSeries = [];
  const trendSeries = []; // {t, supplyTempC, spTempC, flowTotalM3h, shadowCascadeC, shadowSingleC}

  const totalTicks = Math.round(scenario.durationS / dtInner);
  for (let i = 0; i < totalTicks; i++) {
    const tNow = i * dtInner;
    while (nextEventIdx < events.length && events[nextEventIdx].atS <= tNow + 1e-9) {
      events[nextEventIdx].fn(state, shadow);
      nextEventIdx++;
    }

    const loadOverride = scenario.loadProfile ? scenario.loadProfile(tNow + dtInner) : undefined;
    SimCore.tick(state, shadow, rng, loadOverride);

    for (const inv of invariants) {
      const msgs = inv.check(state);
      for (const message of msgs) {
        violations.push({
          scenario: scenario.name,
          tickIndex: i,
          simTimeS: +state.simTimeS.toFixed(2),
          invariantId: inv.id,
          message,
          stateDump: dumpState(state),
        });
      }
    }

    runningCountSeries.push({ t: state.simTimeS, runningCount: state.pumps.filter(p => p.status === 'RUNNING').length });
    trendSeries.push({
      t: state.simTimeS,
      supplyTempC: state.supplyTempC,
      spTempC: state.spTempC,
      flowTotalM3h: state.flowTotalM3h,
      shadowCascadeC: shadow ? shadow.cascade.tempC : null,
      shadowSingleC: shadow ? shadow.single.tempC : null,
    });
  }

  return { state, shadow, violations, runningCountSeries, trendSeries };
}

module.exports = { runSimulation, dumpState };
