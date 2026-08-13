/* =============================================================================
 * tests/runner-plant.js — sim-plant.js(전기/전력품질/센서 포함 전 계층)를
 * 돌리는 헤드리스 러너. tests/runner.js(기존 6종, SimCore만 사용)와는 별개로
 * 둬서 기존 회귀 검증 경로를 절대 건드리지 않는다.
 *
 * UMD: Node(require)와 브라우저(<script>) 양쪽에서 로드된다 — 이유는
 * tests/runner.js 상단 주석 참조. 본문은 변환 전과 한 글자도 다르지 않다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../sim-core.js'), require('../sim-plant.js'),
      require('./invariants.js'), require('./runner.js')
    );
  } else {
    root.SimTestRunnerPlant = factory(root.SimCore, root.SimPlant, root.SimTestInvariants, root.SimTestRunner);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SimCore, SimPlant, SimTestInvariants, SimTestRunner) {
'use strict';

const { createExtendedInvariants } = SimTestInvariants;
const { dumpState } = SimTestRunner;

// scenario = {
//   name, description, durationS, seed,
//   setup(plant) -> void,
//   events: [{atS, fn(plant)}],
//   loadProfile(tSec) -> kW,
//   recordDrift: boolean,   // true면 driftSeries(참값/측정값/진단상태) 기록
// }
function runPlantSimulation(scenario) {
  const dtInner = SimCore.CONST.INNER_PERIOD_MS / 1000;
  const plant = SimPlant.createPlant();
  const state = plant.core;
  const rng = SimCore.createSeededRng(scenario.seed ?? 1);

  if (scenario.setup) scenario.setup(plant);

  const invariants = createExtendedInvariants(dtInner);
  const violations = [];

  const events = (scenario.events || []).slice().sort((a, b) => a.atS - b.atS);
  let nextEventIdx = 0;

  const driftSeries = [];

  const totalTicks = Math.round(scenario.durationS / dtInner);
  for (let i = 0; i < totalTicks; i++) {
    const tNow = i * dtInner;
    while (nextEventIdx < events.length && events[nextEventIdx].atS <= tNow + 1e-9) {
      events[nextEventIdx].fn(plant);
      nextEventIdx++;
    }

    const loadOverride = scenario.loadProfile ? scenario.loadProfile(tNow + dtInner) : undefined;
    SimPlant.tick(plant, rng, loadOverride);

    for (const inv of invariants) {
      const msgs = inv.check(state, plant);
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

    if (scenario.recordDrift) {
      driftSeries.push({
        t: state.simTimeS,
        trueV: state.supplyTempC,
        measV: plant.sensors.supplyTemp.measuredValue,
        diagActive: plant.sensors.supplyTemp.diag.outOfRange || plant.sensors.supplyTemp.diag.stuck || plant.sensors.supplyTemp.diag.inconsistent,
      });
    }
  }

  return { plant, state, violations, driftSeries };
}

return { runPlantSimulation };
});
