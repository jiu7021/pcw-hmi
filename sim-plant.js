/* =============================================================================
 * sim-plant.js — 오케스트레이터: sim-core.js(제어/플랜트) 위에 전기·전력품질·
 * 센서 계층을 "얹어" 한 틱 안에서 순서대로 엮는다.
 *
 * 통신 계층(PLC↔HMI)은 이번 범위에서 제외했다 — 이 웹 시뮬레이터는 표시
 * 경로만 재현 가능한데, 표시 경로만 두면 제어 로직이 그 계층을 아예 거치지
 * 않으므로 "통신 두절 중에도 안전 불변조건이 유지된다"는 검증이 자명하게
 * 참이 되어(제어가 애초에 그 계층을 본 적이 없으므로) 검증으로서 의미가
 * 약하다고 판단했다. 원본(OpenPLC+Ignition, Modbus TCP)에는 실제 통신
 * 계층이 있었다는 점은 README "원본 대비 차이"/"한계"에 남겨둔다.
 *
 * 계층 간 의존은 단방향이다(전기/PQ/센서는 sim-core.js를 알지만, 그 반대는
 * 아니다). 이 파일만 그 계층들을 서로 알고, 실행 순서를 결정한다.
 * index.html과 tests/ 양쪽 다 SimCore.tick()을 직접 부르지 않고 이 파일의
 * tick()을 부른다(신규 계층을 쓰고 싶을 때만 — 기존 SimCore.tick()은
 * 그대로 남아있고 무수정 회귀 검증에 계속 쓰인다).
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./sim-core.js'), require('./sim-electrical.js'),
      require('./sim-power-quality.js'), require('./sim-sensors.js')
    );
  } else {
    root.SimPlant = factory(root.SimCore, root.ElecLayer, root.PQLayer, root.SensorLayer);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SimCore, ElecLayer, PQLayer, SensorLayer) {
  'use strict';

  function createPlant() {
    return {
      core: SimCore.createInitialState(),
      shadow: SimCore.createShadowState(),
      elec: ElecLayer.createElecState(),
      pq: PQLayer.createPQState(),
      sensors: SensorLayer.createSensorSet(),
    };
  }

  // 한 "제어 틱"(100ms) 분량을 전 계층에 걸쳐 진행한다.
  // loadKWOverride: 테스트 시나리오가 내장 3단 순환 부하 대신 원하는 부하를
  //   직접 주입하기 위한 훅(SimCore.tick과 동일한 개념). 브라우저는 넘기지 않는다.
  function tick(plant, rng, loadKWOverride) {
    const dtInner = SimCore.CONST.INNER_PERIOD_MS / 1000;
    const state = plant.core;

    // 1) 센서: 이번 SimCore.tick() 호출 "이전"(=직전 틱 물리 결과)의 참값을
    //    입력으로 측정값을 만든다. 이는 기존(센서 없던 시절) outerLoopStep이
    //    state.supplyTempC를 읽던 시점과 정확히 같은 타이밍이라 인과관계가
    //    어긋나지 않는다.
    const trueValues = {
      supplyTempC: state.supplyTempC,
      flowTotalM3h: state.flowTotalM3h,
      tankLevelPct: state.tankLevelPct,
      dpKPa: state.dpKPa,
    };
    SensorLayer.updateAll(plant.sensors, trueValues, dtInner, rng);
    const measured = SensorLayer.readMeasured(plant.sensors);

    // 2) 제어 로직 + 플랜트 물리 — 센서 측정값을 제어입력으로 사용(참값 접근 없음)
    SimCore.tick(state, plant.shadow, rng, loadKWOverride, measured);

    // 3) 전기 계층: 이번 틱에 갱신된 펌프 상태/속도로 전동기 전류·모선전압 계산
    const newTrips = ElecLayer.update(plant.elec, state.pumps, dtInner);
    newTrips.forEach(({ id }) => {
      const pump = state.pumps.find(p => p.id === id);
      if (pump && !pump.fault) SimCore.faultPump(state, pump); // 기존 고장/절체 경로 재사용
    });

    // 4) 전력품질 계층: 모선전압 고속 샘플링 + sag 검출/원인분류/ESS 대응
    const substeps = PQLayer.update(plant.pq, plant.elec, state.simTimeS, dtInner);
    SimCore.setAlarmActive(state, 'VOLTAGE_SAG', plant.pq.sagActive, 'High',
      plant.pq.currentEvent
        ? `순간전압강하 진행중 (최저 ${(plant.pq.currentEvent.minVoltagePu * 100).toFixed(0)}%, 원인:${plant.pq.currentEvent.cause})`
        : '순간전압강하');

    // 5) 센서 진단 → 기존 알람 시스템에 통합
    const diagFlags = SensorLayer.runDiagnostics(plant.sensors, state.pumps, dtInner);
    const diagLabel = { RANGE: '범위이탈', STUCK: '값고착', INCONSISTENT: '정합성모순' };
    ['supplyTemp', 'flow', 'tankLevel', 'dp'].forEach(key => {
      ['RANGE', 'STUCK', 'INCONSISTENT'].forEach(type => {
        const active = diagFlags.some(f => f.sensor === key && f.type === type);
        SimCore.setAlarmActive(state, `SENSOR_${key}_${type}`, active, 'High', `센서(${key}) 진단: ${diagLabel[type]}`);
      });
    });

    return { pqSubsteps: substeps, measured };
  }

  /* ---------------------------- 데모/테스트용 주입 헬퍼 ---------------------------- */
  function clearPumpFault(plant, pumpId) {
    const pump = plant.core.pumps.find(p => p.id === pumpId);
    if (pump) SimCore.clearFaultUI(plant.core, pump);
    ElecLayer.resetPumpProtection(plant.elec, pumpId);
  }
  function injectPhaseLoss(plant, pumpId, on) { ElecLayer.setPhaseLoss(plant.elec, pumpId, on); }
  function injectMechanicalOverload(plant, pumpId, mult) { ElecLayer.setMechanicalOverload(plant.elec, pumpId, mult); }
  function injectExternalGridSag(plant, dropPu) { ElecLayer.setExternalGridDrop(plant.elec, dropPu); }
  function injectSensorDegradation(plant, key, level) { SensorLayer.setDegradation(plant.sensors, key, level); }
  function injectSensorStuck(plant, key, stuck, atValue) { SensorLayer.setStuck(plant.sensors, key, stuck, atValue); }
  // VFD 고장 주입 → 바이패스(DOL) 절체. faulted=false로 부르면 VFD로 복구.
  function injectVfdFault(plant, pumpId, faulted) {
    SimCore.setPumpFeedMode(plant.core, pumpId, faulted ? 'BYPASS' : 'VFD');
  }

  return {
    createPlant, tick,
    clearPumpFault,
    injectPhaseLoss, injectMechanicalOverload, injectExternalGridSag,
    injectSensorDegradation, injectSensorStuck,
    injectVfdFault,
  };
});
