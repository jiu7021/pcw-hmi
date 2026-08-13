/* =============================================================================
 * tests/runner.js — 시나리오 서술을 받아 헤드리스로 시뮬레이션을 돌리는 공용 러너
 *
 * ---- UMD로 바꾼 이유 (tests/ 전 모듈 공통) ----
 * 화면(index.html)의 "학습 모드"가 결과 해석에 띄우는 수치는 반드시 검증
 * 스위트가 계산한 값과 같은 코드 경로에서 나와야 한다 — 표시용으로 러너나
 * 지표 계산을 따로 구현하면 두 값이 서로 갈라져서, "기본 파라미터로 돌리면
 * 화면 값과 tests/results/*.csv 값이 일치한다"는 보장이 깨진다. 그런데 기존
 * CommonJS(require)는 브라우저에서 로드할 수 없어서, sim-plant.js가 이미 쓰고
 * 있는 것과 동일한 의존성 주입 UMD 형태로 통일했다.
 *
 * 본문 들여쓰기를 factory 안으로 밀어넣지 않은 것은 의도적이다 — 전체를 한 단계
 * 들여쓰면 파일의 모든 줄이 diff에 잡혀서 "로직은 하나도 안 바뀌었다"를 눈으로
 * 확인할 수 없게 된다. 여기서 바뀐 것은 헤더/푸터뿐이고, Node 경로(require)의
 * 동작은 변환 전과 완전히 동일하다(CSV 12종 diff 0으로 확인).
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../sim-core.js'), require('./invariants.js'));
  } else {
    root.SimTestRunner = factory(root.SimCore, root.SimTestInvariants);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SimCore, SimTestInvariants) {
'use strict';

const { createAllInvariants } = SimTestInvariants;

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
      flowSpM3h: state.flowSpM3h,
      outerIntegral: state.outerPid.integral,
      shadowCascadeC: shadow ? shadow.cascade.tempC : null,
      shadowSingleC: shadow ? shadow.single.tempC : null,
    });
  }

  return { state, shadow, violations, runningCountSeries, trendSeries };
}

return { runSimulation, dumpState };
});
