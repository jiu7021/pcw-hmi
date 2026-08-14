/* =============================================================================
 * tests/scenarios-plant.js — 전기/전력품질/센서 계층을 포함하는 시나리오
 * H(센서고착), I(센서 드리프트 장시간), J(VFD 고장→바이패스 절체)
 *
 * UMD: Node(require)와 브라우저(<script>) 양쪽에서 로드된다 — 이유는
 * tests/runner.js 상단 주석 참조. 본문은 변환 전과 한 글자도 다르지 않다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../sim-core.js'), require('../sim-plant.js'));
  } else {
    root.SimTestScenariosPlant = factory(root.SimCore, root.SimPlant);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SimCore, SimPlant) {
'use strict';

const { LOAD_MED_KW } = SimCore.CONST;

/* H. 공급온도 센서 고착(SP 근처 값에) — 제어기가 "이미 도달했다"고 착각하는 동안
 * CV가 폭주하지 않는지(INV7) 확인. 부하는 고부하로 고정해 실제로는 온도가
 * 올라가야 하는 상황을 만든다(고착된 값과 실제 상황이 어긋나도록). */
function scenarioH() {
  const stuckAtS = 60, stuckValueC = 21.0;
  return {
    name: 'H_sensor_stuck',
    description: `공급온도 센서를 SP 근처(${stuckValueC}°C)에 고착(@${stuckAtS}s) — 제어기 CV 폭주 여부(INV7) 확인`,
    durationS: 400,
    seed: 8001,
    loadProfile: () => SimCore.CONST.LOAD_HIGH_KW,
    events: [
      { atS: 0, fn: (plant) => SimCore.masterStart(plant.core) },
      { atS: stuckAtS, fn: (plant) => SimPlant.injectSensorStuck(plant, 'supplyTemp', true, stuckValueC) },
    ],
    meta: { stuckAtS, stuckValueC },
  };
}

/* I. 공급온도 센서 완전열화(degradationLevel=1.0) 장시간(1시간) — 통과/실패 판정이
 * 아니라 "드리프트가 임계 기반 진단으로 검출되지 않는 구간이 얼마나 지속되는가"를
 * 측정하기 위한 성능지표 전용 시나리오. */
function scenarioI() {
  return {
    name: 'I_sensor_drift_long_run',
    description: '공급온도 센서 완전열화(degradationLevel=1.0) 1시간 — 미검출(진단 미발동) 구간 길이 측정',
    durationS: 3600,
    seed: 9001,
    recordDrift: true,
    loadProfile: () => LOAD_MED_KW,
    events: [
      { atS: 0, fn: (plant) => { SimCore.masterStart(plant.core); SimPlant.injectSensorDegradation(plant, 'supplyTemp', 1.0); } },
    ],
  };
}

/* I-control. 시나리오 I의 대조군 — 지속시간·시드·부하를 그대로 두고 센서 열화
 * 주입만 뺀다. 대조군이 없으면 "열화 100%에서 최종 편차 1.887°C"라는 수치가
 * 큰 것인지 작은 것인지 판단할 기준이 없다(무열화에서도 센서 잡음·응답지연으로
 * 편차가 0은 아니다). 같은 시드를 쓰므로 부하 잡음까지 동일한 조건이다. */
function scenarioIControl() {
  return {
    name: 'I_control_no_degradation',
    description: '시나리오 I 대조군 — 센서 열화 없이 동일 조건 1시간 (열화 케이스와 비교용)',
    durationS: 3600,
    seed: 9001,
    recordDrift: true,
    loadProfile: () => LOAD_MED_KW,
    events: [{ atS: 0, fn: (plant) => SimCore.masterStart(plant.core) }],
  };
}

/* J. VFD 고장 → 바이패스(DOL) 절체. 고부하로 고정해 절체 이후 나머지 VFD
 * 펌프들이 대수제어로 추가 기동되도록 유도한다 — (1) 바이패스로 고정속도
 * 운전 중인 펌프가 섞인 상태에서도 온도 제어가 유지되는지, (2) 그 추가
 * 기동들이 동시 기동 금지 인터록(INV1)을 어기지 않는지를 함께 확인한다. */
function scenarioJ() {
  const vfdFaultAtS = 100;
  return {
    name: 'J_vfd_fault_bypass_failover',
    description: `VFD 고장(@${vfdFaultAtS}s) → 바이패스 절체 후 온도 제어 유지 + 나머지 펌프 기동시 인터록 확인`,
    durationS: 500,
    seed: 10001,
    loadProfile: () => SimCore.CONST.LOAD_HIGH_KW,
    events: [
      { atS: 0, fn: (plant) => SimCore.masterStart(plant.core) },
      { atS: vfdFaultAtS, fn: (plant) => SimPlant.injectVfdFault(plant, 1, true) },
    ],
    recordChangeover: true,
    meta: { vfdFaultAtS },
  };
}

/* J-control. 시나리오 J의 대조군 — VFD 고장 주입만 뺀다. 절체의 효과를 보려면
 * "절체가 없었다면 같은 시각에 온도가 어떻게 움직였는가"가 있어야 한다.
 * meta.vfdFaultAtS는 고장이 없어도 그대로 둔다 — 대조군에서도 같은 시각을
 * 기준으로 과도응답을 재야 두 실행을 나란히 비교할 수 있기 때문이다. */
function scenarioJControl() {
  const vfdFaultAtS = 100;
  return {
    name: 'J_control_no_vfd_fault',
    description: '시나리오 J 대조군 — VFD 고장 없이 동일 조건 (절체 케이스와 비교용)',
    durationS: 500,
    seed: 10001,
    loadProfile: () => SimCore.CONST.LOAD_HIGH_KW,
    events: [{ atS: 0, fn: (plant) => SimCore.masterStart(plant.core) }],
    recordChangeover: true,
    meta: { vfdFaultAtS: null, compareAtS: vfdFaultAtS },
  };
}

function allPlantScenarios() {
  return [scenarioH(), scenarioI(), scenarioIControl(), scenarioJ(), scenarioJControl()];
}

return { scenarioH, scenarioI, scenarioIControl, scenarioJ, scenarioJControl, allPlantScenarios };
});
