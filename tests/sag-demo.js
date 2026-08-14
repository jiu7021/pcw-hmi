/* =============================================================================
 * tests/sag-demo.js — "동시 기동 금지" 인터록의 근거를 수치로 증명하는 데모 스크립트.
 *
 * 이것은 정식 시나리오(pass/fail 판정 대상)가 아니다 — 실제 앱은 anyPumpStarting
 * 잠금 때문에 두 펌프가 절대 동시에 STARTING이 될 수 없으므로(INV1이 항상
 * 보장), "인터록을 어기면 무슨 일이 나는가"는 정상 실행 경로에서는 관측할 수
 * 없다. 그래서 sim-electrical.js/sim-power-quality.js를 SimCore 없이 직접
 * 호출해 인터록을 코드 레벨에서 일부러 우회한 가상의 펌프 상태를 만들고,
 * 그 결과 모선전압이 관리한계(85%)를 실제로 넘는지 확인한다.
 *
 * 두 케이스 모두 급전모드를 BYPASS(DOL)로 둔다 — VFD 정상 기동은 돌입이
 * 거의 없어(정격의 110~150%) 아무리 겹쳐도 관리한계를 위협하지 않는다는
 * 것이 sim-electrical.js의 핵심 전제이기 때문에, "왜 동시 기동을 막아야
 * 하는가"를 증명하려면 정확히 그 문제가 실제로 발생하는 조건(VFD 고장 시
 * 상용전원 직입 상태에서 두 대가 겹치는 경우)을 재현해야 의미가 있다.
 *
 * UMD: Node(require)와 브라우저(<script>) 양쪽에서 로드된다 — 이유는
 * tests/runner.js 상단 주석 참조. 본문은 변환 전과 한 글자도 다르지 않다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../sim-electrical.js'), require('../sim-power-quality.js'));
  } else {
    root.SimTestSagDemo = factory(root.ElecLayer, root.PQLayer);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ElecLayer, PQLayer) {
'use strict';

// 두 케이스 모두 실제 오케스트레이터(sim-plant.js)와 동일하게 ElecLayer.updateFast
// + PQLayer.updateSubstep 조합(5ms 해상도)을 쓴다 — 100ms에 한 번만 계산하면
// 그 첫 100ms 안의 최저점(돌입 순간에 가장 가까운 값)을 놓친다(README "검증
// 결과 — 전기 계층 고속화" 참조). 이 데모는 바로 그 최저점을 증거로 쓰므로,
// 실제 앱과 다른(더 낙관적인) 해상도로 계산하면 근거로서 부정확해진다.
function runCase(pumps, ticks) {
  const es = ElecLayer.createElecState();
  const pq = PQLayer.createPQState();
  const dt = 0.1;
  let t = 0;
  let minV = 1.0, essOnV = null, essOnAtS = null;
  // trace: 화면(학습 모드 인터록 탭)이 전압·전류 파형을 그리기 위한 기록.
  // 계산에는 전혀 관여하지 않는 순수 관측용 추가이므로 minV/essOnV 값은
  // 달라지지 않는다. essOnAtS는 "기동 시작 후 몇 초에 ESS가 붙었는가"이며,
  // 이 함수의 t가 0에서 시작하므로 그대로 경과시간이다(절대시각이 아니다).
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    const prevStartTimers = pumps.map(p => p.startTimer);
    t += dt;
    pumps.forEach(p => { if (p.status === 'STARTING') p.startTimer = t; });
    const { samples } = ElecLayer.updateFast(es, pumps, prevStartTimers, dt);
    const tStart = t - dt;
    samples.forEach(s => {
      const tAbs = tStart + s.tOffsetS;
      PQLayer.updateSubstep(pq, s.busVoltagePu, tAbs, () => PQLayer.classifyCause(es));
      if (s.busVoltagePu < minV) minV = s.busVoltagePu;
      if (pq.essActive && essOnV === null) { essOnV = pq.fastVoltagePu; essOnAtS = tAbs; }
      trace.push({ t: tAbs, vPu: s.busVoltagePu, iPu: s.totalCurrentPu });
    });
  }
  return { minV, essOnV, essOnAtS, trace };
}

function runInterlockBypassDemo() {
  // 케이스 A(정상): VFD 2대 정격운전 중 1대가 바이패스(DOL)로 정상적으로
  // (인터록 지켜) 기동 — 예: 그 1대만 VFD 고장으로 바이패스 절체된 상황.
  const pumpsA = [
    { id: 1, status: 'STARTING', speedPct: 0, fault: false, startTimer: 0, feedMode: 'BYPASS' },
    { id: 2, status: 'RUNNING', speedPct: 100, fault: false, startTimer: 0, feedMode: 'VFD' },
    { id: 3, status: 'RUNNING', speedPct: 100, fault: false, startTimer: 0, feedMode: 'VFD' },
  ];
  const caseA = runCase(pumpsA, 50);
  const minVA = caseA.minV;

  // 케이스 B(인터록 우회 가정): VFD 1대 운전 중 나머지 2대가 "동시에"
  // 바이패스(DOL)로 STARTING — 예: 2대가 동시에 VFD 고장이 나서 동시에
  // 절체를 시도하는 상황. (실제 앱에서는 startPump()의 anyPumpStarting
  // 잠금 때문에 이 상태 자체가 만들어질 수 없다 — 여기서는 그 잠금을
  // 거치지 않고 직접 pump 배열을 구성해 "막지 않았다면 어떻게 되는가"를 본다.)
  const pumpsB = [
    { id: 1, status: 'STARTING', speedPct: 0, fault: false, startTimer: 0, feedMode: 'BYPASS' },
    { id: 2, status: 'STARTING', speedPct: 0, fault: false, startTimer: 0, feedMode: 'BYPASS' },
    { id: 3, status: 'RUNNING', speedPct: 100, fault: false, startTimer: 0, feedMode: 'VFD' },
  ];
  const caseB = runCase(pumpsB, 50);
  const minVB = caseB.minV, essOnVB = caseB.essOnV;

  const floor = PQLayer.CONST.VOLTAGE_MANAGEMENT_FLOOR_PU;
  return {
    floorPct: floor * 100,
    // peakCurrentPct/essEngagedAtS는 화면(학습 모드)이 쓰는 관측값이다.
    // essEngagedAtS는 기동 시작을 0으로 둔 경과시간이다(시뮬레이션 절대시각 아님).
    normalCase: { minVoltagePct: minVA * 100, breachesFloor: minVA < floor,
      peakCurrentPct: Math.max(...caseA.trace.map(p => p.iPu)) * 100, essEngagedAtS: caseA.essOnAtS },
    bypassCase: { minVoltagePct: minVB * 100, breachesFloor: minVB < floor, essEngagedAtPct: essOnVB !== null ? essOnVB * 100 : null,
      peakCurrentPct: Math.max(...caseB.trace.map(p => p.iPu)) * 100, essEngagedAtS: caseB.essOnAtS },
    demonstratesInterlockNecessity: (minVA >= floor) && (minVB < floor),
  };
}

// runCase는 원래 이 파일 내부 전용이었으나, 화면(학습 모드 "인터록" 탭)이
// "동시 기동 대수·급전모드를 사용자가 바꿔가며" 같은 계산을 돌릴 수 있도록
// 함께 내보낸다. runInterlockBypassDemo()가 쓰는 고정 2케이스는 그대로 두므로
// 검증 스위트(run.js)의 결과는 전혀 달라지지 않는다.
return { runInterlockBypassDemo, runCase };
});
