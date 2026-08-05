/* =============================================================================
 * sim-sensors.js — 가상 센서 계층
 *
 * 참값(플랜트 물리모델이 계산한 실제 값)이 "센서"라는 관문을 통과해야만
 * 측정값이 되고, 제어기와 알람은 오직 이 측정값만 본다는 원칙을 구현한다.
 * 참값 자체는 이 모듈이 만들지 않는다(sim-core.js가 계속 담당) — 이 모듈은
 * 참값을 입력으로 받아 "이상이 있는 계측기를 거치면 무엇이 보이는가"만 계산한다.
 *
 * 처리 순서(매 틱): 참값 → 1차 지연 필터 → 노이즈 부가 → 분해능 양자화 →
 * 측정범위 클램프. 열화(degradationLevel)가 진행되면 응답이 둔해지고 노이즈가
 * 커지며 오프셋 드리프트가 쌓인다 — 이 드리프트는 아래 진단(범위이탈/고착/
 * 정합성 교차확인) 중 어느 것으로도 잡히지 않도록 "의도적으로" 설계했다
 * (임계 기반 진단으로는 검출되지 않는 열화가 실제로 존재함을 보여주는 것이 목적).
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SensorLayer = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function gaussianRandom(rng) {
    rng = rng || Math.random;
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // 센서 종류별 대표 특성(가정치). 실제 계기 스펙이 아니라, 이 시뮬레이터의
  // "센서를 거치면 참값과 달라진다"는 개념을 보여주기 위한 대표값이다.
  const SENSOR_SPECS = Object.freeze({
    temp: { // 예: RTD 온도변환기
      rangeMin: -10, rangeMax: 60,   // 산업용 온도 변환기 통상 측정범위 대표값(°C)
      resolution: 0.1,                // 통상 표시 분해능 대표값(°C)
      tauS: 3,                        // 보호관 삽입형 RTD 열응답 시정수 통상값(수초대) 대표값
      noiseStdDev: 0.05,              // 전기적 노이즈 대표값(°C)
    },
    flow: { // 예: 전자유량계
      rangeMin: 0, rangeMax: 800,     // 설계유량(600m3/h)보다 여유를 둔 계기 스팬 대표값
      resolution: 1,                   // 1 m3/h 대표값
      tauS: 0.5,                       // 전자유량계는 온도센서보다 훨씬 빠르다는 통념(대표값)
      noiseStdDev: 3,
    },
    level: { // 예: 정전용량식/초음파 레벨계
      rangeMin: 0, rangeMax: 100,
      resolution: 0.5,
      tauS: 2,
      noiseStdDev: 0.3,
    },
    dp: { // 차압 트랜스미터
      rangeMin: 0, rangeMax: 500,      // 설계유량 근처 대표 차압(≈313kPa)보다 여유 있는 스팬
      resolution: 1,
      tauS: 0.3,                        // 압력 트랜스미터는 온도보다 훨씬 빠르다는 통념(대표값)
      noiseStdDev: 2,
    },
  });

  const DEGRADATION_CONST = Object.freeze({
    // degradationLevel(0~1)이 1.0(=완전 열화)일 때 각 특성이 얼마나 나빠지는지의 배수(가정치)
    TAU_MULT_AT_FULL: 3,          // 응답이 최대 3배 둔해짐
    NOISE_MULT_AT_FULL: 4,         // 노이즈가 최대 4배 커짐
    DRIFT_RATE_PER_HOUR_AT_FULL: 2, // degradationLevel=1일 때 시간당 오프셋 누적 속도(센서 고유단위/h, 가정치)
  });

  const DIAG_CONST = Object.freeze({
    STUCK_DETECT_S: 30,       // 이 시간 동안 값이 사실상 안 바뀌면 고착 의심(가정치) —
                               // 정상 센서라면 노이즈만으로도 이보다 훨씬 짧은 시간 안에
                               // 분해능 이상 흔들리는 것이 자연스럽다는 전제.
    STUCK_EPS_FACTOR: 0.5,     // "안 바뀌었다"의 기준: 분해능의 0.5배 이내
    RANGE_STUCK_AT_BOUND_S: 5, // 경계값에 이만큼 붙어있으면 범위이탈 의심(가정치)
    FLOW_INCONSISTENCY_MIN_SPEED_PCT: 20, // 펌프가 이 속도 이상으로 RUNNING인데
    FLOW_INCONSISTENCY_MAX_FLOW: 10,       // 측정유량이 이 미만으로 지속되면 물리적 모순(가정치)
    FLOW_INCONSISTENCY_CONFIRM_S: 3,       // 확인지연(가정치, 순간 노이즈 오검출 방지)
  });

  function createSensor(kind) {
    const spec = SENSOR_SPECS[kind];
    return {
      kind,
      rangeMin: spec.rangeMin, rangeMax: spec.rangeMax,
      resolution: spec.resolution, tauS: spec.tauS, noiseStdDev: spec.noiseStdDev,
      degradationLevel: 0,     // 0~1, UI/테스트에서 직접 진행시킬 수 있는 열화 진행도
      driftOffset: 0,
      filteredValue: null,      // 최초 update에서 참값으로 초기화
      measuredValue: 0,
      isStuck: false,
      stuckValue: 0,
      unchangedTimer: 0,
      lastMeasuredRounded: null,
      atMinTimer: 0, atMaxTimer: 0,
      inconsistencyTimer: 0,
      diag: { outOfRange: false, stuck: false, inconsistent: false },
    };
  }

  function createSensorSet() {
    return {
      supplyTemp: createSensor('temp'),
      flow: createSensor('flow'),
      tankLevel: createSensor('level'),
      dp: createSensor('dp'),
    };
  }

  function updateSensor(sensor, trueValue, dt, rng) {
    if (sensor.filteredValue === null) sensor.filteredValue = trueValue;

    if (sensor.isStuck) {
      sensor.measuredValue = sensor.stuckValue;
    } else {
      const effTau = sensor.tauS * (1 + sensor.degradationLevel * (DEGRADATION_CONST.TAU_MULT_AT_FULL - 1));
      sensor.filteredValue += (trueValue - sensor.filteredValue) / effTau * dt;

      const effNoiseStd = sensor.noiseStdDev * (1 + sensor.degradationLevel * (DEGRADATION_CONST.NOISE_MULT_AT_FULL - 1));
      sensor.driftOffset += DEGRADATION_CONST.DRIFT_RATE_PER_HOUR_AT_FULL * sensor.degradationLevel * (dt / 3600);

      let raw = sensor.filteredValue + sensor.driftOffset + gaussianRandom(rng) * effNoiseStd;
      raw = clamp(raw, sensor.rangeMin, sensor.rangeMax);
      sensor.measuredValue = Math.round(raw / sensor.resolution) * sensor.resolution;
    }

    // 진단 1) 범위이탈: 경계값에 지속적으로 붙어있는가
    if (Math.abs(sensor.measuredValue - sensor.rangeMax) < sensor.resolution / 2) sensor.atMaxTimer += dt; else sensor.atMaxTimer = 0;
    if (Math.abs(sensor.measuredValue - sensor.rangeMin) < sensor.resolution / 2) sensor.atMinTimer += dt; else sensor.atMinTimer = 0;
    sensor.diag.outOfRange = sensor.atMaxTimer >= DIAG_CONST.RANGE_STUCK_AT_BOUND_S || sensor.atMinTimer >= DIAG_CONST.RANGE_STUCK_AT_BOUND_S;

    // 진단 2) 값 고착: 그럴듯하지 않게 오래 변화가 없는가
    // 주의: 이 진단은 "고착 주입(isStuck)"이 실제로 발생했을 때는 잡아내지만,
    // "오프셋 드리프트"는 값이 계속 서서히 움직이므로(고착이 아니므로) 이
    // 진단으로는 절대 잡히지 않는다 — 의도된 설계(README 참조).
    if (sensor.lastMeasuredRounded !== null && Math.abs(sensor.measuredValue - sensor.lastMeasuredRounded) < sensor.resolution * DIAG_CONST.STUCK_EPS_FACTOR) {
      sensor.unchangedTimer += dt;
    } else {
      sensor.unchangedTimer = 0;
    }
    sensor.lastMeasuredRounded = sensor.measuredValue;
    sensor.diag.stuck = sensor.unchangedTimer >= DIAG_CONST.STUCK_DETECT_S;
  }

  function updateAll(sensors, trueValues, dt, rng) {
    updateSensor(sensors.supplyTemp, trueValues.supplyTempC, dt, rng);
    updateSensor(sensors.flow, trueValues.flowTotalM3h, dt, rng);
    updateSensor(sensors.tankLevel, trueValues.tankLevelPct, dt, rng);
    updateSensor(sensors.dp, trueValues.dpKPa, dt, rng);
  }

  function readMeasured(sensors) {
    return {
      supplyTempC: sensors.supplyTemp.measuredValue,
      flowM3h: sensors.flow.measuredValue,
      tankLevelPct: sensors.tankLevel.measuredValue,
      dpKPa: sensors.dp.measuredValue,
    };
  }

  // 진단 3) 물리적 정합성 교차확인 — 예: 펌프가 유의미한 속도로 도는데
  // 측정유량이 0에 가깝게 지속되면 모순(유량계 고장/막힘/배선단선 등 의심).
  // corePumps: sim-core.js state.pumps (읽기 전용 참조)
  function checkFlowPumpConsistency(flowSensor, corePumps, dt) {
    const anyPumpRunningFast = corePumps.some(p => p.status === 'RUNNING' && p.speedPct >= DIAG_CONST.FLOW_INCONSISTENCY_MIN_SPEED_PCT);
    const flowLooksZero = flowSensor.measuredValue < DIAG_CONST.FLOW_INCONSISTENCY_MAX_FLOW;
    if (anyPumpRunningFast && flowLooksZero) {
      flowSensor.inconsistencyTimer += dt;
    } else {
      flowSensor.inconsistencyTimer = 0;
    }
    flowSensor.diag.inconsistent = flowSensor.inconsistencyTimer >= DIAG_CONST.FLOW_INCONSISTENCY_CONFIRM_S;
  }

  // 진단을 전부 실행하고, 활성 상태인 것들을 평평한 목록으로 돌려준다
  // (오케스트레이터/UI가 기존 알람 시스템에 그대로 태워 넣기 쉽도록).
  function runDiagnostics(sensors, corePumps, dt) {
    checkFlowPumpConsistency(sensors.flow, corePumps, dt);
    const flags = [];
    for (const key of ['supplyTemp', 'flow', 'tankLevel', 'dp']) {
      const s = sensors[key];
      if (s.diag.outOfRange) flags.push({ sensor: key, type: 'RANGE' });
      if (s.diag.stuck) flags.push({ sensor: key, type: 'STUCK' });
      if (s.diag.inconsistent) flags.push({ sensor: key, type: 'INCONSISTENT' });
    }
    return flags;
  }

  function setDegradation(sensors, key, level) {
    if (sensors[key]) sensors[key].degradationLevel = clamp(level, 0, 1);
  }
  function setStuck(sensors, key, stuck, atValue) {
    const s = sensors[key];
    if (!s) return;
    s.isStuck = !!stuck;
    if (stuck) s.stuckValue = atValue ?? s.measuredValue;
  }

  return {
    SENSOR_SPECS, DEGRADATION_CONST, DIAG_CONST,
    createSensor, createSensorSet,
    updateSensor, updateAll, readMeasured,
    checkFlowPumpConsistency, runDiagnostics,
    setDegradation, setStuck,
  };
});
