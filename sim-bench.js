/* =============================================================================
 * sim-bench.js — 학습 모드 A/B 벤치 드라이버 (DOM 비의존)
 *
 * 화면의 "비교 실행" 버튼이 누르는 계산 계층이다. 각 모드마다 A안/B안을
 * 헤드리스로 순차 실행하고, tests/metrics.js의 지표 함수를 그대로 써서
 * 결과를 뽑는다.
 *
 * ---- 왜 tests/ 를 그대로 재사용하는가 ----
 * 화면에 띄우는 "방금 실행" 수치와 tests/results/*.csv의 "기준 실행" 수치가
 * 기본 파라미터에서 반드시 일치해야 하기 때문이다. 표시용으로 러너나 지표를
 * 따로 구현하면 판정 밴드·확인시간·난수원이 조금만 달라져도 두 값이 갈라진다
 * (실제로 index.html의 자동측정 패널은 밴드 ±0.5°C·10초 확인·shadow 모델·
 * Math.random을 쓰고, 검증 스위트는 ±0.3°C·관측창 끝까지 유지·실계통·고정
 * 시드를 쓴다 — 같은 현상을 재도 값이 다르게 나온다). 그래서 이 파일은 지표를
 * 새로 계산하지 않고 tests/metrics.js를 호출만 한다.
 *
 * ---- 난수 ----
 * 벤치는 항상 시나리오에 박힌 고정 시드를 쓴다. Math.random을 쓰면 같은
 * 파라미터로 돌려도 매번 값이 달라져 기준 실행과의 대조 자체가 불가능해진다.
 *
 * ---- 라이브 시뮬레이션과의 관계 ----
 * 벤치는 createInitialState()/createPlant()로 매번 새 상태를 만들어 돌린다.
 * 화면에서 돌고 있는 라이브 state는 게인·SP를 읽기만 하고 절대 건드리지 않는다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./sim-core.js'), require('./sim-plant.js'), require('./sim-power-quality.js'),
      require('./tests/runner.js'), require('./tests/runner-plant.js'),
      require('./tests/scenarios.js'), require('./tests/scenarios-plant.js'),
      require('./tests/sag-demo.js'), require('./tests/metrics.js')
    );
  } else {
    root.SimBench = factory(
      root.SimCore, root.SimPlant, root.PQLayer,
      root.SimTestRunner, root.SimTestRunnerPlant,
      root.SimTestScenarios, root.SimTestScenariosPlant,
      root.SimTestSagDemo, root.SimTestMetrics
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  SimCore, SimPlant, PQLayer, SimTestRunner, SimTestRunnerPlant,
  SimTestScenarios, SimTestScenariosPlant, SimTestSagDemo, SimTestMetrics
) {
'use strict';

const { runSimulation } = SimTestRunner;
const { runPlantSimulation } = SimTestRunnerPlant;
const { runInterlockBypassDemo, runCase } = SimTestSagDemo;

// 차트에 넘길 트레이스 최대 점 개수. 1200초 시나리오는 원본이 12000점이라
// 그대로 그리면 Chart.js가 느려진다. 표시 목적상 이 정도면 파형의 최대편차·
// 회복 시점이 육안으로 구분되므로 균등 간격으로 솎아낸다(지표 계산은 항상
// 원본 전체 해상도로 하므로 이 값이 수치에 영향을 주지 않는다).
const TRACE_MAX_POINTS = 600;

function downsample(arr, pick) {
  if (arr.length <= TRACE_MAX_POINTS) return arr.map(pick);
  const stride = Math.ceil(arr.length / TRACE_MAX_POINTS);
  const out = [];
  for (let i = 0; i < arr.length; i += stride) out.push(pick(arr[i]));
  return out;
}

/* ---------------------------- 기준 실행 값 ----------------------------
 * 전부 tests/results/*.csv에서 그대로 옮긴 값이며, 출처를 파일명:행으로
 * 명시한다. 손으로 계산하거나 반올림한 값은 하나도 없다.
 * tests/run.js를 다시 돌려 CSV가 바뀌면 이 표도 같이 갱신해야 한다 —
 * verifyBaselines()가 그 불일치를 잡아준다.
 * ========================================================================= */
const BASELINE = {
  // antiwindup_compare.csv:2,3
  antiwindup: {
    A: { maxIntegral: 168.86, peakUndershootC: 1.955, recoveryTimeS: 91.9 },
    B: { maxIntegral: 620.86, peakUndershootC: 7.245, recoveryTimeS: 163.1 },
    source: 'antiwindup_compare.csv:2,3',
  },
  // disturbance_type_compare.csv:2~5
  cascade: {
    LOAD: {
      A: { peakDeviationC: 3.343, recoveryTimeS: 92.7 },
      B: { peakDeviationC: 1.891, recoveryTimeS: 32.3 },
    },
    FLOW: {
      A: { peakDeviationC: 1.743, recoveryTimeS: 60.1 },
      B: { peakDeviationC: 1.166, recoveryTimeS: 91.6 },
    },
    source: 'disturbance_type_compare.csv:2~5',
  },
  // interlock_bypass_demo.csv:2,3
  interlock: {
    A: { minVoltagePct: 88.08, breachesFloor: false },
    B: { minVoltagePct: 80.67, breachesFloor: true, essEngagedAtPct: 81.78 },
    floorPct: 85,
    source: 'interlock_bypass_demo.csv:2,3',
  },
  // bypass_changeover.csv:2,3 (2행=절체, 3행=대조군)
  failover: {
    A: { finalSpeedPct: '83.9/83.9/83.9', finalFeedModes: 'VFD/VFD/VFD', finalErrorC: -0.008, finalFlowM3h: 629.1 },
    B: { finalSpeedPct: '100/74.9/74.9', finalFeedModes: 'BYPASS/VFD/VFD', finalErrorC: -0.011, finalFlowM3h: 624.6 },
    source: 'bypass_changeover.csv:2,3',
  },
  // drift_blind_spot.csv:2,3 (2행=열화 100%, 3행=대조군)
  sensor: {
    A: { finalDeviationC: 0.031, exceededSampleRatioPct: 1.00, blindSpotDurationS: 3596.6 },
    B: { finalDeviationC: 1.887, exceededSampleRatioPct: 53.55, blindSpotDurationS: 3596.6 },
    source: 'drift_blind_spot.csv:2,3',
  },
};

/* ---------------------------- 라이브 파라미터 주입 ----------------------------
 * 시나리오의 기존 setup()을 지우지 않고 뒤에 덧붙인다 — 예를 들어 시나리오 G의
 * setup은 antiWindupEnabled를 설정하는데, 그걸 덮어쓰면 A/B 구분 자체가 사라진다.
 * gains/spTempC를 주지 않으면(기본 파라미터) 아무것도 덮어쓰지 않으므로 검증
 * 스위트가 돌리는 것과 완전히 동일한 실행이 된다. */
function injectCoreParams(scn, params) {
  const orig = scn.setup;
  scn.setup = function (state, shadow) {
    if (orig) orig(state, shadow);
    if (params.gains) Object.assign(state.gains, params.gains);
    if (params.spTempC != null) state.spTempC = params.spTempC;
  };
  return scn;
}
function injectPlantParams(scn, params) {
  const orig = scn.setup;
  scn.setup = function (plant) {
    if (orig) orig(plant);
    if (params.gains) Object.assign(plant.core.gains, params.gains);
    if (params.spTempC != null) plant.core.spTempC = params.spTempC;
  };
  return scn;
}

/* ============================ 모드 1: Anti-windup ============================
 * A = 조건부 적분 ON(실제 동작), B = OFF(비교용). 시나리오 G로 외부루프 유량
 * SP를 300초 동안 확실히 포화시킨 뒤 부하를 정상으로 되돌린다. */
function runAntiWindup(params) {
  const runs = ['A', 'B'].map(key => {
    const on = key === 'A';
    const scn = injectCoreParams(
      SimTestScenarios.scenarioAntiWindup({ name: `G_antiwindup_${on ? 'ON' : 'OFF'}`, antiWindupEnabled: on, seed: 7001 }),
      params
    );
    const r = runSimulation(scn);
    const sp = r.trendSeries[0].spTempC;
    const m = SimTestMetrics.analyzeAntiWindup(r.trendSeries, scn.meta.overloadAtS, scn.meta.returnAtS, sp, 0.3, scn.durationS);
    return {
      key, label: on ? 'anti-windup ON' : 'anti-windup OFF',
      metrics: {
        maxIntegral: m.maxIntegralDuringOverload,
        peakUndershootC: m.peakUndershootC,
        recoveryTimeS: m.recoveryTimeS,
      },
      trace: {
        t: downsample(r.trendSeries, p => p.t),
        temp: downsample(r.trendSeries, p => p.supplyTempC),
        integral: downsample(r.trendSeries, p => p.outerIntegral),
      },
      meta: { sp, overloadAtS: scn.meta.overloadAtS, returnAtS: scn.meta.returnAtS },
    };
  });

  const [on, off] = runs;
  const ratio = (a, b) => (a != null && b != null && b !== 0) ? (a / b) : null;
  const rInt = ratio(off.metrics.maxIntegral, on.metrics.maxIntegral);
  const rUnd = ratio(off.metrics.peakUndershootC, on.metrics.peakUndershootC);
  const rRec = ratio(off.metrics.recoveryTimeS, on.metrics.recoveryTimeS);

  return {
    modeId: 'antiwindup',
    runs,
    rows: [
      row('과부하 중 외부루프 적분항 최댓값', '', 2, on, off, 'maxIntegral', BASELINE.antiwindup),
      row('복귀 후 최대 언더슈트', '°C', 3, on, off, 'peakUndershootC', BASELINE.antiwindup),
      row('±0.3°C 밴드 복귀시간', 's', 1, on, off, 'recoveryTimeS', BASELINE.antiwindup),
    ],
    baselineSource: BASELINE.antiwindup.source,
    verdict: rInt == null ? '측정 실패' :
      `포화가 풀린 뒤 OFF는 ON 대비 적분항 ${rInt.toFixed(1)}배, 언더슈트 ${rUnd.toFixed(1)}배, 복귀시간 ${rRec == null ? 'N/A' : rRec.toFixed(1) + '배'}. ` +
      `적분항이 포화 중에도 계속 불어난 만큼, 부하가 정상으로 돌아온 뒤 그 누적분을 토해내며 SP 아래로 ${off.metrics.peakUndershootC.toFixed(2)}°C까지 내려간다 — ` +
      `조건부 적분은 이 되돌림 구간을 없애는 것이 목적이지 응답을 빠르게 만드는 장치가 아니다.`,
  };
}

/* ==================== 모드 2: 캐스케이드 vs 단일루프 ====================
 * A = 캐스케이드, B = 단일루프. 외란 도메인(params.disturbanceKind)에 따라
 * 시나리오 B(열부하=외부루프 도메인) 또는 B'(유량=내부루프 도메인)를 쓴다.
 * 이 모드의 결론은 "어느 구조가 우수한가"가 아니라 "외란이 어느 도메인에
 * 들어오느냐에 따라 우열이 뒤집힌다"는 것이다. */
function runCascade(params) {
  const kind = params.disturbanceKind === 'FLOW' ? 'FLOW' : 'LOAD';
  const make = kind === 'FLOW' ? SimTestScenarios.scenarioBFlow : SimTestScenarios.scenarioB;

  const runs = ['A', 'B'].map(key => {
    const structure = key === 'A' ? 'CASCADE' : 'SINGLE';
    const scn = injectCoreParams(make({ name: `B_${kind}_${structure}`, controlStructure: structure, seed: 2001 }), params);
    const r = runSimulation(scn);
    const sp = r.trendSeries[0].spTempC;
    const series = r.trendSeries.map(p => ({ t: p.t, v: p.supplyTempC }));
    const stepAtS = scn.meta.stepUpAtS ?? scn.meta.disturbAtS;
    const windowEndS = scn.meta.stepDownAtS ?? scn.durationS;
    const m = SimTestMetrics.analyzeDisturbanceRejection(series, stepAtS, sp, undefined, windowEndS);
    return {
      key, label: structure === 'CASCADE' ? '캐스케이드' : '단일루프',
      metrics: { peakDeviationC: m.peakDeviation, recoveryTimeS: m.recoveryTimeS },
      trace: {
        t: downsample(r.trendSeries, p => p.t),
        temp: downsample(r.trendSeries, p => p.supplyTempC),
        flowSp: downsample(r.trendSeries, p => p.flowSpM3h),
      },
      meta: { sp, stepAtS, windowEndS },
    };
  });

  const [cas, sng] = runs;
  const kindLabel = kind === 'FLOW' ? '유량측 외란(내부루프 도메인)' : '열부하 외란(외부루프 도메인)';
  const devWin = cas.metrics.peakDeviationC < sng.metrics.peakDeviationC ? '캐스케이드' : '단일루프';
  // 복귀시간은 null(관측창 안에서 미복귀)이 나올 수 있으므로 별도 처리 —
  // 미복귀를 0이나 무한대로 치환해 비교하면 사실과 다른 판정이 나온다.
  let recWin;
  const ca = cas.metrics.recoveryTimeS, sa = sng.metrics.recoveryTimeS;
  if (ca == null && sa == null) recWin = null;
  else if (ca == null) recWin = '단일루프';
  else if (sa == null) recWin = '캐스케이드';
  else recWin = ca < sa ? '캐스케이드' : '단일루프';

  let verdict = `${kindLabel}: 최대편차는 ${devWin}가 작고(${Math.min(cas.metrics.peakDeviationC, sng.metrics.peakDeviationC).toFixed(3)}°C vs ${Math.max(cas.metrics.peakDeviationC, sng.metrics.peakDeviationC).toFixed(3)}°C), `;
  verdict += recWin == null ? '복귀시간은 양쪽 모두 관측창 안에서 확정되지 않았다. '
    : `복귀시간은 ${recWin}가 빠르다(${Math.min(ca ?? Infinity, sa ?? Infinity).toFixed(1)}s vs ${Math.max(ca ?? 0, sa ?? 0).toFixed(1)}s). `;
  verdict += (devWin === recWin)
    ? `이 외란에서는 두 지표가 같은 방향을 가리켜 ${devWin}가 우세하다. `
    : `두 지표의 승자가 갈린다 — ${devWin}는 편차를 덜 키우고 ${recWin}는 더 빨리 복귀한다. `;
  verdict += '구조의 우열은 외란이 어느 도메인에 들어오는지에 따라 뒤집히므로, 외란 종류를 바꿔 두 경우를 모두 확인해야 한다.';

  return {
    modeId: 'cascade',
    runs,
    rows: [
      row('SP 대비 최대편차', '°C', 3, cas, sng, 'peakDeviationC', { A: BASELINE.cascade[kind].A, B: BASELINE.cascade[kind].B }),
      row('±0.3°C 밴드 복귀시간', 's', 1, cas, sng, 'recoveryTimeS', { A: BASELINE.cascade[kind].A, B: BASELINE.cascade[kind].B }),
    ],
    baselineSource: BASELINE.cascade.source,
    verdict,
  };
}

/* ======================== 모드 3: 동시 기동 금지 인터록 ========================
 * A = 인터록 준수(1대만 기동), B = 우회(N대 동시 기동). sim-core를 거치지 않고
 * 전기·전력품질 계층을 직접 돌린다 — 실제 앱에서는 anyPumpStarting 잠금 때문에
 * B 상태 자체가 만들어질 수 없어서, 인터록의 필요성은 이렇게 코드 레벨에서
 * 일부러 우회해야만 관측할 수 있다(tests/sag-demo.js 상단 주석 참조).
 *
 * 이 모드는 게인·SP와 무관하다 — 조작 파라미터는 동시 기동 대수와 급전모드다. */
function makePumps(startingCount, feedMode) {
  return [1, 2, 3].map(id => ({
    id,
    status: id <= startingCount ? 'STARTING' : 'RUNNING',
    speedPct: id <= startingCount ? 0 : 100,
    fault: false, startTimer: 0,
    // 기동 중인 펌프만 지정 급전모드를 따른다. 이미 정격으로 돌고 있는 펌프는
    // 돌입과 무관하므로 VFD로 둔다(원본 데모의 케이스 구성과 동일).
    feedMode: id <= startingCount ? feedMode : 'VFD',
  }));
}
function runInterlock(params) {
  const feedMode = params.feedMode === 'VFD' ? 'VFD' : 'BYPASS';
  const simultaneous = Math.min(3, Math.max(2, params.simultaneousStarts ?? 2));
  const floorPct = PQLayer.CONST.VOLTAGE_MANAGEMENT_FLOOR_PU * 100;
  const TICKS = 50; // tests/sag-demo.js runInterlockBypassDemo()와 동일(5초 관측)

  const cases = [
    { key: 'A', label: `인터록 준수 (1대만 ${feedMode} 기동)`, pumps: makePumps(1, feedMode) },
    { key: 'B', label: `인터록 우회 (${simultaneous}대 동시 ${feedMode} 기동)`, pumps: makePumps(simultaneous, feedMode) },
  ];
  const runs = cases.map(c => {
    const r = runCase(c.pumps, TICKS);
    return {
      key: c.key, label: c.label,
      metrics: {
        minVoltagePct: r.minV * 100,
        breachesFloor: r.minV < PQLayer.CONST.VOLTAGE_MANAGEMENT_FLOOR_PU,
        essEngagedAtPct: r.essOnV != null ? r.essOnV * 100 : null,
      },
      trace: { t: downsample(r.trace, p => p.t), volt: downsample(r.trace, p => p.vPu * 100) },
    };
  });

  const [ok, bad] = runs;
  const gap = ok.metrics.minVoltagePct - bad.metrics.minVoltagePct;
  const margin = bad.metrics.minVoltagePct - floorPct;
  return {
    modeId: 'interlock',
    runs,
    rows: [
      row('최저 모선전압', '%', 2, ok, bad, 'minVoltagePct', BASELINE.interlock),
    ],
    extra: { floorPct },
    baselineSource: BASELINE.interlock.source,
    verdict:
      `준수 ${ok.metrics.minVoltagePct.toFixed(2)}% → 우회 ${bad.metrics.minVoltagePct.toFixed(2)}%로 ${gap.toFixed(2)}%p 더 내려간다. ` +
      `관리한계 ${floorPct}% 기준 우회 케이스는 ${margin < 0 ? Math.abs(margin).toFixed(2) + '%p 위반' : margin.toFixed(2) + '%p 여유(위반 아님)'}, ` +
      `준수 케이스는 ${(ok.metrics.minVoltagePct - floorPct).toFixed(2)}%p 여유. ` +
      (feedMode === 'VFD'
        ? 'VFD 소프트스타트는 돌입이 정격의 110~150%에 그쳐 겹쳐도 관리한계를 위협하지 않는다 — 인터록이 실제로 막아야 하는 것은 이 경우가 아니다.'
        : 'DOL 돌입전류는 정격의 5~7배라 중첩되면 모선전압이 관리한계 아래로 떨어진다 — 인터록이 막아야 하는 것이 정확히 이 상황이다.'),
  };
}

/* ==================== 모드 4: 보호·절체 (VFD 고장 → 바이패스) ====================
 * A = VFD 정상, B = VFD 고장 후 DOL 바이패스 절체. 고부하 고정이라 절체 뒤
 * 나머지 펌프가 대수제어로 추가 투입되는 상황까지 함께 본다. */
function runFailover(params) {
  const runs = ['A', 'B'].map(key => {
    const scn = key === 'A' ? SimTestScenariosPlant.scenarioJControl() : SimTestScenariosPlant.scenarioJ();
    injectPlantParams(scn, params);
    const r = runPlantSimulation(scn);
    const finalErrorC = r.state.supplyTempC - r.state.spTempC;
    const TOLERANCE_C = 2.0; // tests/run.js와 동일한 가정치
    const eventAtS = scn.meta.vfdFaultAtS ?? scn.meta.compareAtS;
    return {
      key, label: key === 'A' ? 'VFD 정상(대조군)' : `VFD 고장 → 바이패스 절체(@${eventAtS}s)`,
      metrics: {
        // 주지표: 절체로 실제로 갈리는 것은 온도가 아니라 급전모드와 속도다.
        finalSpeedPct: r.state.pumps.map(p => +p.speedPct.toFixed(1)).join('/'),
        finalFeedModes: r.state.pumps.map(p => p.feedMode).join('/'),
        finalFlowM3h: r.state.flowTotalM3h,
        // 보조: 온도가 "안 바뀌었다"는 것을 보이기 위한 근거값
        finalErrorC,
        controlMaintained: Math.abs(finalErrorC) <= TOLERANCE_C,
        violations: r.violations.length,
      },
      trace: {
        t: downsample(r.trendSeries, p => p.t),
        speeds: [0, 1, 2].map(i => downsample(r.trendSeries, p => p.pumpSpeeds[i])),
        temp: downsample(r.trendSeries, p => p.supplyTempC),
      },
      // 판정문의 "전 구간 최대 온도차"는 솎아낸 트레이스가 아니라 원본
      // 해상도로 계산해야 한다 — 표시용으로 걸러낸 점들 사이에 더 큰 차이가
      // 숨어 있으면 실제보다 작은 값을 주장하게 된다.
      fullTemp: r.trendSeries.map(p => p.supplyTempC),
      meta: { eventAtS, toleranceC: TOLERANCE_C, spTempC: r.state.spTempC },
    };
  });

  const [normal, bypass] = runs;
  // 두 실행의 공급온도 궤적이 실제로 얼마나 다른지 — "온도가 안 바뀐다"를
  // 주장하려면 그 차이를 수치로 제시해야 한다.
  const n = Math.min(normal.fullTemp.length, bypass.fullTemp.length);
  let maxTempGapC = 0;
  for (let i = 0; i < n; i++) maxTempGapC = Math.max(maxTempGapC, Math.abs(normal.fullTemp[i] - bypass.fullTemp[i]));
  // 표시 계층으로 넘길 필요가 없는 큰 배열은 버린다(트레이스만 남긴다).
  runs.forEach(r => { delete r.fullTemp; });

  return {
    modeId: 'failover',
    runs,
    rows: [
      rowText('최종 펌프 속도 P1/P2/P3', '%', normal, bypass, 'finalSpeedPct', BASELINE.failover),
      rowText('급전모드 P1/P2/P3', '', normal, bypass, 'finalFeedModes', BASELINE.failover),
      row('총 유량', 'm³/h', 1, normal, bypass, 'finalFlowM3h', BASELINE.failover),
      row('최종 정상상태 편차', '°C', 3, normal, bypass, 'finalErrorC', BASELINE.failover),
    ],
    extra: { maxTempGapC },
    baselineSource: BASELINE.failover.source,
    verdict:
      `P-1이 바이패스로 절체되며 속도가 100% 고정으로 묶이자, 나머지 두 대가 ` +
      `${normal.metrics.finalSpeedPct.split('/')[1]}%에서 ${bypass.metrics.finalSpeedPct.split('/')[1]}%로 물러나 총유량을 ` +
      `${normal.metrics.finalFlowM3h.toFixed(1)}→${bypass.metrics.finalFlowM3h.toFixed(1)} m³/h로 맞췄다. ` +
      `그 결과 공급온도 궤적은 두 실행이 전 구간 최대 ${maxTempGapC.toFixed(4)}°C밖에 차이나지 않는다. ` +
      `온도가 안 변한 것 자체가 결과다 — 바이패스 전용 절체 로직을 따로 두지 않았는데도, ` +
      `내부루프가 "설정유량 − 전체유량(고정속도 펌프 기여분 포함)" 오차를 그대로 보고 나머지 VFD 펌프를 조정해 흡수했다. ` +
      `절체 중 동시 기동 금지 인터록 위반 ${bypass.metrics.violations}건.`,
  };
}

/* ======================== 모드 5: 센서 열화 (드리프트 사각지대) ========================
 * A = 열화 없음, B = 열화 주입. 임계 기반 진단(범위이탈·값고착·정합성 모순)으로는
 * 오프셋 드리프트가 원천적으로 검출되지 않는다는 것을 미검출 구간 길이로 보여준다. */
function runSensor(params) {
  const level = params.degradationLevel != null ? params.degradationLevel : 1.0;
  const runs = ['A', 'B'].map(key => {
    let scn;
    if (key === 'A') {
      scn = SimTestScenariosPlant.scenarioIControl();
    } else {
      scn = SimTestScenariosPlant.scenarioI();
      if (level !== 1.0) {
        scn.events = [{ atS: 0, fn: (plant) => {
          SimCore.masterStart(plant.core);
          SimPlant.injectSensorDegradation(plant, 'supplyTemp', level);
        } }];
      }
    }
    injectPlantParams(scn, params);
    const r = runPlantSimulation(scn);
    const bs = SimTestMetrics.computeDriftBlindSpot(r.driftSeries);
    return {
      key, label: key === 'A' ? '열화 없음(대조군)' : `센서 열화 ${(level * 100).toFixed(0)}%`,
      metrics: {
        finalDeviationC: bs.finalDeviationC,
        exceededSampleRatioPct: bs.exceededSampleRatio * 100,
        blindSpotDurationS: bs.blindSpotDurationS,
        everDetected: bs.everDetected,
        deviationExceededAtS: bs.deviationExceededAtS,
        exceededSampleCount: bs.exceededSampleCount,
        totalSampleCount: bs.totalSampleCount,
      },
      trace: {
        t: downsample(r.driftSeries, p => p.t),
        trueV: downsample(r.driftSeries, p => p.trueV),
        measV: downsample(r.driftSeries, p => p.measV),
      },
      meta: { durationS: scn.durationS, thresholdC: bs.deviationThresholdC },
    };
  });

  const [clean, degraded] = runs;
  const devRatio = clean.metrics.finalDeviationC > 1e-9
    ? degraded.metrics.finalDeviationC / clean.metrics.finalDeviationC : null;
  return {
    modeId: 'sensor',
    runs,
    extra: { thresholdC: degraded.meta.thresholdC, durationS: degraded.meta.durationS },
    rows: [
      // 주지표 — 컷오프 없이 열화 유무를 갈라준다.
      row('참값 대비 최종 편차', '°C', 3, clean, degraded, 'finalDeviationC', BASELINE.sensor),
      // 보조지표 — 기동 과도가 전체의 1% 남짓이라 자연히 묻힌다.
      row('편차 1.0°C 초과 샘플 비율', '%', 2, clean, degraded, 'exceededSampleRatioPct', BASELINE.sensor),
      // 원 수치 — A/B를 구분하지 못한다는 사실 자체를 보이기 위해 그대로 둔다.
      row('미검출 구간(원 지표)', 's', 1, clean, degraded, 'blindSpotDurationS', BASELINE.sensor),
    ],
    baselineSource: BASELINE.sensor.source,
    verdict:
      `열화 ${(level * 100).toFixed(0)}%에서 최종 편차 ${degraded.metrics.finalDeviationC.toFixed(3)}°C — ` +
      `대조군 ${clean.metrics.finalDeviationC.toFixed(3)}°C의 ${devRatio == null ? 'N/A' : devRatio.toFixed(0) + '배'}다. ` +
      `편차가 1.0°C를 넘은 샘플 비율도 ${degraded.metrics.exceededSampleRatioPct.toFixed(2)}% 대 ${clean.metrics.exceededSampleRatioPct.toFixed(2)}%로 갈린다. ` +
      `그런데 진단(범위이탈·값고착·정합성 모순)은 ${degraded.meta.durationS}초 내내 ` +
      `${degraded.metrics.everDetected ? '발동했다' : '한 번도 발동하지 않았다'} — ` +
      `이 셋은 모두 "값이 튀는 것"을 잡는 진단이라 서서히 어긋나는 오프셋 드리프트에는 원리적으로 걸리지 않는다. ` +
      `알람이 전부 정상이라는 것이 측정값이 맞다는 뜻은 아니다.`,
  };
}

/* ---------------------------- 표시용 행 조립 ----------------------------
 * digits가 숫자면 수치 행(허용오차 비교), null이면 문자열 행(정확히 일치해야
 * 함) — 절체 모드의 "100/74.9/74.9"처럼 숫자 하나로 줄일 수 없는 지표가 있다. */
function makeRow(label, unit, digits, runA, runB, metricKey, baseline) {
  const cell = (run, side) => {
    const b = baseline && baseline[side] ? baseline[side][metricKey] : undefined;
    return {
      measured: run.metrics[metricKey],
      baseline: b === undefined ? null : b,
      hasBaseline: b !== undefined && b !== null,
    };
  };
  return { label, unit, digits, metricKey, a: cell(runA, 'A'), b: cell(runB, 'B') };
}
function row(label, unit, digits, runA, runB, metricKey, baseline) {
  return makeRow(label, unit, digits, runA, runB, metricKey, baseline);
}
function rowText(label, unit, runA, runB, metricKey, baseline) {
  return makeRow(label, unit, null, runA, runB, metricKey, baseline);
}

/* ---------------------------- 모드 레지스트리 ----------------------------
 * 히스테리시스 모드는 아직 없다 — A/B가 "지연·히스테리시스가 없었다면"이라는
 * 역산 근사라서, 나머지 모드가 확정된 뒤에 별도로 붙인다. */
const MODES = [
  { id: 'antiwindup', label: 'Anti-windup', run: runAntiWindup },
  { id: 'cascade', label: '캐스케이드 vs 단일루프', run: runCascade },
  { id: 'interlock', label: '인터록', run: runInterlock },
  { id: 'failover', label: '보호·절체', run: runFailover },
  { id: 'sensor', label: '센서 열화', run: runSensor },
];

/* 지금 파라미터가 검증 스위트와 같은 조건인가.
 * 기준 실행 값은 "기본 파라미터일 때의 스위트 값"이므로, 사용자가 게인이나
 * SP를 바꾼 뒤에는 두 값이 달라지는 것이 정상이다. 그 경우까지 "불일치"로
 * 표시하면 정상 동작을 버그로 오인하게 되므로, 일치 판정은 이 함수가 true를
 * 돌려줄 때만 한다. */
function coreParamsAreDefault(params) {
  const C = SimCore.CONST;
  if (params.spTempC != null && params.spTempC !== C.SUPPLY_TEMP_SP_DEFAULT) return false;
  const g = params.gains;
  if (g) {
    if (g.oKp !== C.OUTER_KP0 || g.oKi !== C.OUTER_KI0 || g.oKd !== C.OUTER_KD0) return false;
    if (g.iKp !== C.INNER_KP0 || g.iKi !== C.INNER_KI0 || g.iKd !== C.INNER_KD0) return false;
  }
  return true;
}
// 모드별 추가 파라미터의 기본값 — 각 모드의 기준 실행이 그 조건으로 계산됐다.
// cascade의 disturbanceKind는 여기 없다: 열부하/유량측 두 경우 모두 검증
// 스위트에 기준값이 있고(disturbance_type_compare.csv 4행) 선택에 따라 그
// 기준값도 같이 바뀌므로, 어느 쪽을 골라도 "기본에서 벗어난" 상태가 아니다.
const MODE_PARAM_DEFAULTS = {
  interlock: (p) => (p.feedMode ?? 'BYPASS') === 'BYPASS' && (p.simultaneousStarts ?? 2) === 2,
  sensor: (p) => (p.degradationLevel ?? 1.0) === 1.0,
};

function runMode(modeId, params) {
  const mode = MODES.find(m => m.id === modeId);
  if (!mode) throw new Error(`알 수 없는 모드: ${modeId}`);
  params = params || {};
  const t0 = Date.now();
  const result = mode.run(params);
  result.label = mode.label;
  result.elapsedMs = Date.now() - t0;
  const extraOk = MODE_PARAM_DEFAULTS[modeId] ? MODE_PARAM_DEFAULTS[modeId](params) : true;
  result.paramsAreDefault = coreParamsAreDefault(params) && extraOk;
  return result;
}

/* ---------------------------- 기준값 대조 검사 ----------------------------
 * 기본 파라미터로 각 모드를 돌려 "방금 실행" 값이 BASELINE(=검증 스위트 CSV)과
 * 일치하는지 확인한다. 일치하지 않으면 화면의 두 줄이 어긋난다는 뜻이므로 버그다.
 * 허용오차 근거: CSV는 toFixed로 자릿수를 잘라 저장하므로, 그 마지막 자리의
 * 반올림 폭(0.5 LSB)만큼만 차이를 허용한다 — 그보다 크면 계산 경로가 실제로
 * 다른 것이다. */
function verifyBaselines() {
  const report = [];
  for (const mode of MODES) {
    const result = runMode(mode.id, {}); // 기본 파라미터 = 스위트와 동일 조건
    for (const r of result.rows) {
      for (const side of ['a', 'b']) {
        const cell = r[side];
        const runLabel = result.runs[side === 'a' ? 0 : 1].label;
        if (!cell.hasBaseline) {
          report.push({ mode: mode.id, metric: r.label, run: runLabel, status: 'NO_BASELINE',
            measured: cell.measured, baseline: null, diff: null });
          continue;
        }
        if (r.digits == null) { // 문자열 지표는 정확히 일치해야 한다
          report.push({
            mode: mode.id, metric: r.label, run: runLabel,
            status: String(cell.measured) === String(cell.baseline) ? 'MATCH' : 'MISMATCH',
            measured: cell.measured, baseline: cell.baseline, diff: null, tol: null,
          });
          continue;
        }
        const tol = 0.5 * Math.pow(10, -r.digits);
        const diff = (cell.measured == null) ? null : Math.abs(cell.measured - cell.baseline);
        report.push({
          mode: mode.id, metric: r.label, run: runLabel,
          status: diff != null && diff <= tol ? 'MATCH' : 'MISMATCH',
          measured: cell.measured, baseline: cell.baseline, diff, tol,
        });
      }
    }
  }
  return report;
}

return { MODES, BASELINE, runMode, verifyBaselines, TRACE_MAX_POINTS };
});
