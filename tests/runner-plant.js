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
  // trendSeries: tests/runner.js와 같은 형식의 순수 관측 기록. 판정·지표
  // 계산에 쓰이는 입력이 아니라 결과를 사후에 분석하기 위한 것이라, 이걸
  // 기록해도 시뮬레이션 진행에는 아무 영향이 없다(driftSeries와 동일한 성격).
  // 절체 시나리오처럼 "최종값이 아니라 과정"을 봐야 하는 경우가 있어 추가했다.
  const trendSeries = [];

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

    trendSeries.push({
      t: state.simTimeS,
      supplyTempC: state.supplyTempC,
      spTempC: state.spTempC,
      flowTotalM3h: state.flowTotalM3h,
      flowSpM3h: state.flowSpM3h,
      outerIntegral: state.outerPid.integral,
      runningCount: state.pumps.filter(p => p.status === 'RUNNING').length,
      // 절체 시나리오의 핵심은 온도가 아니라 "누가 어떤 급전모드로 몇 %를
      // 내고 있는가"다 — 바이패스로 묶인 펌프가 고정속도로 도는 동안 나머지
      // VFD 펌프가 속도를 낮춰 총유량을 맞추는 과정이 여기서만 보인다.
      pumpSpeeds: state.pumps.map(p => p.speedPct),
      feedModes: state.pumps.map(p => p.feedMode),
    });

    if (scenario.recordDrift) {
      driftSeries.push({
        t: state.simTimeS,
        trueV: state.supplyTempC,
        measV: plant.sensors.supplyTemp.measuredValue,
        diagActive: plant.sensors.supplyTemp.diag.outOfRange || plant.sensors.supplyTemp.diag.stuck || plant.sensors.supplyTemp.diag.inconsistent,
      });
    }
  }

  return { plant, state, violations, driftSeries, trendSeries };
}

return { runPlantSimulation };
});
