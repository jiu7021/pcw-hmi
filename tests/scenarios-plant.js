/* =============================================================================
 * tests/scenarios-plant.js — 전기/전력품질/센서 계층을 포함하는 시나리오
 * H(센서고착), I(센서 드리프트 장시간), J(VFD 고장→바이패스 절체)
 * ========================================================================= */
const SimCore = require('../sim-core.js');
const SimPlant = require('../sim-plant.js');
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
    meta: { vfdFaultAtS },
  };
}

function allPlantScenarios() {
  return [scenarioH(), scenarioI(), scenarioJ()];
}

module.exports = { scenarioH, scenarioI, scenarioJ, allPlantScenarios };
