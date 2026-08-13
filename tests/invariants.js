/* =============================================================================
 * tests/invariants.js — 안전 불변조건 6종
 *
 * 각 invariant는 createXxx() 팩토리가 반환하는 check(state) 함수로 표현한다.
 * check()는 그 틱에서 위반이 없으면 빈 배열 [], 있으면 위반 메시지 문자열 배열을
 * 돌려준다. 팩토리를 매 시나리오 실행마다 새로 호출해서(클로저 내부 상태 초기화)
 * 시나리오 간 상태가 섞이지 않게 한다.
 *
 * 원칙: 여기서 재구현하는 판정 로직은 sim-core.js 내부 구현을 그대로 베끼는 게
 * 아니라, "블랙박스로 관측 가능한 계약(contract)"을 독립적으로 다시 계산해서
 * 대조하는 방식을 우선한다. 그래야 sim-core.js 쪽 로직에 버그가 있어도
 * 테스트가 같은 실수를 반복하지 않는다.
 *
 * UMD: Node(require)와 브라우저(<script>) 양쪽에서 로드된다 — 이유는
 * tests/runner.js 상단 주석 참조. 본문은 변환 전과 한 글자도 다르지 않다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../sim-core.js'));
  } else {
    root.SimTestInvariants = factory(root.SimCore);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SimCore) {
'use strict';

const { CONST } = SimCore;

const EPS = 1e-6; // clamp()가 만드는 상하한 값은 부동소수점 상 정확히 일치하는 게
                   // 보통이지만, 누적 오차에 대비한 여유(허용오차)

function isAtBound(v, lo, hi) {
  return Math.abs(v - lo) < EPS || Math.abs(v - hi) < EPS;
}

/* ---- 1) 두 대 이상의 펌프가 동시에 STARTING일 수 없다 ---- */
function createInvariant1_NoSimultaneousStarting() {
  return function check(state) {
    const starting = state.pumps.filter(p => p.status === 'STARTING');
    if (starting.length >= 2) {
      return [`${starting.length}대 펌프가 동시에 STARTING (pump ${starting.map(p => p.id).join(',')})`];
    }
    return [];
  };
}

/* ---- 2) FAULT 펌프는 절대 RUNNING이 될 수 없다 ---- */
function createInvariant2_FaultNeverRunning() {
  return function check(state) {
    const bad = state.pumps.filter(p => p.fault && p.status === 'RUNNING');
    if (bad.length) return [`FAULT 펌프가 RUNNING 상태: pump ${bad.map(p => p.id).join(',')}`];
    return [];
  };
}

/* ---- 3) 운전 중 펌프 0대면 냉동기는 정지 상태여야 한다 ---- */
function createInvariant3_ChillerOffWhenNoPumps() {
  return function check(state) {
    const runningCount = state.pumps.filter(p => p.status === 'RUNNING').length;
    if (runningCount === 0 && state.chillerRunning) {
      return ['운전 중 펌프 0대인데 chillerRunning=true (냉동기 단독운전 인터록 위반)'];
    }
    return [];
  };
}

/* ---- 4) 최소유량 미달이 지연시간을 초과하면 반드시 보호모드 진입 ----
 * sim-core.js의 minFlowTimer를 그대로 읽지 않고, 이 테스트가 독립적으로
 * "유량이 최소기준 미달로 연속된 시간"을 다시 적산해 hxProtectionActive와
 * 대조한다(같은 코드를 다시 베끼는 tautology가 되지 않도록, 리셋 조건까지
 * CONST.MIN_FLOW_RELEASE_MARGIN이라는 "공개된 계약값"만 사용해 재현).
 */
function createInvariant4_MinFlowProtection(dtInnerS) {
  let externalTimer = 0;
  return function check(state) {
    if (state.masterOn && state.flowTotalM3h < CONST.MIN_FLOW_M3H) {
      externalTimer += dtInnerS;
    } else if (state.flowTotalM3h >= CONST.MIN_FLOW_M3H * CONST.MIN_FLOW_RELEASE_MARGIN) {
      externalTimer = 0;
    }
    if (externalTimer > CONST.MIN_FLOW_DELAY_S + EPS && !state.hxProtectionActive) {
      return [`유량 미달 누적 ${externalTimer.toFixed(2)}s > 지연기준 ${CONST.MIN_FLOW_DELAY_S}s인데 hxProtectionActive=false`];
    }
    return [];
  };
}

/* ---- 5) CV가 포화된 동안 적분항의 절대값이 증가하지 않는다 (anti-windup) ----
 *
 * 주의(중요한 해석 판단 두 가지, 둘 다 최초 구현에서 실제로 틀렸다가 고친 것):
 *
 * (a) 방향 구분. "적분항의 절대값이 증가하지 않는다"를 방향과 무관하게 |I|로만
 * 검사했더니, 정상적으로 설계된 조건부 적분(conditional integration)에서도
 * 위반으로 잘못 잡히는 경우가 있었다 — CV가 하한에 붙어 있고 적분이 "포화를
 * 해소하는 방향"(하한에서 벗어나 CV를 밀어올리는 방향)으로 커지는 중이면,
 * 그건 anti-windup이 의도한 정상 동작이지 windup이 아니다(원본 요구사항 2번
 * "포화 해소 방향의 오차는 계속 적분한다"와 정확히 일치). 그래서 "절대값 증가"가
 * 아니라 "포화를 심화시키는 방향으로의 증가"만 본다: 상한 포화 중엔 적분이
 * (부호 그대로) 커질 때만, 하한 포화 중엔 작아질 때만 위반(Ki≥0 가정 — 이
 * 시뮬레이터의 모든 Ki는 0 이상, 튜닝 패널 슬라이더도 min=0).
 *
 * (b) "막 도달"과 "이미 붙어있었음"의 구분. CV가 이번 틱에 "처음으로" 경계값에
 * 정확히 도달한 경우(직전 틱엔 경계값이 아니었음)까지 위반으로 잡으면 너무
 * 엄격하다 — 정상적인 비례+적분 동작이 우연히 경계값에 정확히 착지한 것일 뿐,
 * "이미 포화된 상태에서 계속 밀어붙인" 진짜 windup이 아니기 때문이다(다중 시드
 * 스트레스 테스트에서 실제로 이 경계 사례가 나와 확인 후 고쳤다). 그래서 직전
 * 틱과 이번 틱 "둘 다" 같은 경계값에 있을 때만(=한 틱이라도 그 경계에 머물러
 * 있었다는 뜻) 위반 판정 대상으로 삼는다.
 *
 * outerFlowSpBounds/innerSpeedBounds는 sim-core.js가 export하는, "CV에 실제로
 * 적용되는 참 상하한"이다(제어 로직 자체와는 별개의 계약 함수).
 */
function windupViolation(label, curCV, prevCV, bounds, curI, prevI) {
  const curAtMax = Math.abs(curCV - bounds.max) < EPS;
  const prevAtMax = Math.abs(prevCV - bounds.max) < EPS;
  const curAtMin = Math.abs(curCV - bounds.min) < EPS;
  const prevAtMin = Math.abs(prevCV - bounds.min) < EPS;
  if (curAtMax && prevAtMax && curI > prevI + EPS) {
    return `${label} CV=${curCV.toFixed(2)}(상한 ${bounds.max.toFixed(2)}) 포화 지속 중 적분이 심화방향(+)으로 증가: ${prevI.toFixed(4)} → ${curI.toFixed(4)}`;
  }
  if (curAtMin && prevAtMin && curI < prevI - EPS) {
    return `${label} CV=${curCV.toFixed(2)}(하한 ${bounds.min.toFixed(2)}) 포화 지속 중 적분이 심화방향(-)으로 감소: ${prevI.toFixed(4)} → ${curI.toFixed(4)}`;
  }
  return null;
}
function createInvariant5_AntiWindup() {
  let prev = null; // {outerI, innerI, flowSp, speedCmd, mode, structure}
  return function check(state) {
    const cur = {
      outerI: state.outerPid.integral,
      innerI: state.innerPid.integral,
      flowSp: state.flowSpM3h,
      speedCmd: state.speedCmdPct,
      mode: state.mode,
      structure: state.controlStructure,
    };
    const violations = [];
    // 모드/제어구조가 바뀐 직후는 비교 대상(직전 값의 "의미")이 달라지므로 건너뛴다.
    const comparable = prev && prev.mode === cur.mode && prev.structure === cur.structure;

    if (comparable && state.masterOn && state.mode === 'AUTO') {
      if (state.controlStructure === 'CASCADE') {
        const ob = SimCore.outerFlowSpBounds(state);
        const v1 = windupViolation('외부루프', cur.flowSp, prev.flowSp, ob, cur.outerI, prev.outerI);
        if (v1) violations.push(v1);
        const ib = SimCore.innerSpeedBounds(state);
        const v2 = windupViolation('내부루프', cur.speedCmd, prev.speedCmd, ib, cur.innerI, prev.innerI);
        if (v2) violations.push(v2);
      } else {
        // 단일루프는 innerPid를 재사용하고 상하한은 0~100 고정(singleLoopStep 참조)
        const v3 = windupViolation('단일루프', cur.speedCmd, prev.speedCmd, { min: 0, max: 100 }, cur.innerI, prev.innerI);
        if (v3) violations.push(v3);
      }
    }
    prev = cur;
    return violations;
  };
}

/* ---- 6) 알람은 히스테리시스 밴드 안에서 반복 발생/해소하지 않는다 (채터링) ----
 * 태그별로 "해소(active:false) 이후 다시 발생(active:true)"까지 걸린 시간을
 * 기록해서, 그 간격이 너무 짧으면(=재발생) 위반으로 본다.
 *
 * 판정 기준(MIN_RETRIGGER_S=2초, 20틱): 명확한 산업표준이 있는 값은 아니다(가정치).
 * 알람 평가 주기(100ms)의 20배 이상 간격이면 순간적 임계값 노이즈가 아니라
 * 실질적인 공정 재변화로 볼 수 있다는 보수적 기준으로 잡았다. 이보다 짧게
 * 반복되면 "설정된 히스테리시스 폭이 실제 신호 노이즈 진폭을 못 덮는다"는
 * 뜻이므로 채터링으로 판정한다.
 */
const MIN_RETRIGGER_S = 2;
function createInvariant6_AlarmHysteresis(minRetriggerS) {
  minRetriggerS = minRetriggerS ?? MIN_RETRIGGER_S;
  const lastRiseS = {};
  const wasActive = {};
  return function check(state) {
    const violations = [];
    for (const tag in state.alarmStates) {
      const isActive = state.alarmStates[tag].active;
      const prevActive = wasActive[tag] || false;
      if (isActive && !prevActive) {
        if (lastRiseS[tag] != null && (state.simTimeS - lastRiseS[tag]) < minRetriggerS) {
          violations.push(`알람 ${tag} 재발생 간격 ${(state.simTimeS - lastRiseS[tag]).toFixed(2)}s < 최소기준 ${minRetriggerS}s (채터링 의심)`);
        }
        lastRiseS[tag] = state.simTimeS;
      }
      wasActive[tag] = isActive;
    }
    return violations;
  };
}

/* ---- 7) 센서 고장(고착/열화) 중에도 CV가 정의된 상하한을 벗어나지 않는다 ----
 * stepPID의 clamp()가 구조적으로 항상 보장해야 하는 성질이지만, "엉터리
 * 측정값이 들어와도 액추에이터 지령이 폭주하지 않는다"는 것을 센서 계층을
 * 도입한 뒤에도 명시적으로 재확인하기 위한 회귀 방지용 체크.
 */
function createInvariant7_CVBoundedUnderSensorFault() {
  return function check(state) {
    if (!(state.masterOn && state.mode === 'AUTO')) return [];
    const violations = [];
    if (state.controlStructure === 'CASCADE') {
      const ob = SimCore.outerFlowSpBounds(state);
      if (state.flowSpM3h < ob.min - EPS || state.flowSpM3h > ob.max + EPS) {
        violations.push(`flowSpM3h(${state.flowSpM3h.toFixed(2)})가 상하한[${ob.min.toFixed(2)},${ob.max.toFixed(2)}] 밖`);
      }
      const ib = SimCore.innerSpeedBounds(state);
      if (state.speedCmdPct < ib.min - EPS || state.speedCmdPct > ib.max + EPS) {
        violations.push(`speedCmdPct(${state.speedCmdPct.toFixed(2)})가 상하한[${ib.min.toFixed(2)},${ib.max.toFixed(2)}] 밖`);
      }
    } else if (state.speedCmdPct < -EPS || state.speedCmdPct > 100 + EPS) {
      violations.push(`(단일루프) speedCmdPct(${state.speedCmdPct.toFixed(2)})가 상하한[0,100] 밖`);
    }
    return violations;
  };
}

/* ---- 8) 정상 대수제어(인터록이 지켜지는 상태) 중 모선전압이 관리한계 아래로 내려가지 않는다 ----
 * plant(전기 계층)가 있을 때만 의미가 있다 — plant가 없으면(기존 6종 검증
 * 스위트처럼 SimCore만 도는 경우) 아무것도 하지 않는다.
 */
function createInvariant8_VoltageFloorUnderNormalOps(floorPu) {
  floorPu = floorPu ?? 0.85; // sim-power-quality.js CONST.VOLTAGE_MANAGEMENT_FLOOR_PU 값과 동일(대표값)
  return function check(state, plant) {
    if (!plant || !plant.elec) return [];
    if (plant.elec.busVoltagePu < floorPu - EPS) {
      return [`정상 운전 중 모선전압 ${(plant.elec.busVoltagePu * 100).toFixed(1)}% < 관리한계 ${(floorPu * 100).toFixed(0)}%`];
    }
    return [];
  };
}

// 시나리오 러너가 사용할 표준 목록: [id, 설명, 팩토리]
function createAllInvariants(dtInnerS) {
  return [
    { id: 'INV1_NO_SIMULTANEOUS_STARTING', desc: '두 대 이상 펌프 동시 STARTING 금지', check: createInvariant1_NoSimultaneousStarting() },
    { id: 'INV2_FAULT_NEVER_RUNNING', desc: 'FAULT 펌프는 RUNNING 불가', check: createInvariant2_FaultNeverRunning() },
    { id: 'INV3_CHILLER_OFF_NO_PUMPS', desc: '운전 펌프 0대면 냉동기 정지', check: createInvariant3_ChillerOffWhenNoPumps() },
    { id: 'INV4_MIN_FLOW_PROTECTION', desc: '최소유량 미달 지속시 보호모드 진입', check: createInvariant4_MinFlowProtection(dtInnerS) },
    { id: 'INV5_ANTI_WINDUP', desc: 'CV 포화 중 적분항 절대값 비증가', check: createInvariant5_AntiWindup() },
    { id: 'INV6_ALARM_NO_CHATTER', desc: '알람 히스테리시스 밴드 내 반복 발생/해소 금지', check: createInvariant6_AlarmHysteresis() },
  ];
}

// 확장 스위트(전기/전력품질/센서/통신 계층 포함 plant 시나리오)가 쓰는 8종 전체 목록
function createExtendedInvariants(dtInnerS) {
  return createAllInvariants(dtInnerS).concat([
    { id: 'INV7_CV_BOUNDED_UNDER_SENSOR_FAULT', desc: '센서 고장 중에도 CV가 상하한을 벗어나지 않음', check: createInvariant7_CVBoundedUnderSensorFault() },
    { id: 'INV8_VOLTAGE_FLOOR_NORMAL_OPS', desc: '정상 대수제어 중 모선전압이 관리한계 이상 유지', check: createInvariant8_VoltageFloorUnderNormalOps() },
  ]);
}

return {
  createAllInvariants,
  createExtendedInvariants,
  MIN_RETRIGGER_S,
  createInvariant1_NoSimultaneousStarting,
  createInvariant2_FaultNeverRunning,
  createInvariant3_ChillerOffWhenNoPumps,
  createInvariant4_MinFlowProtection,
  createInvariant5_AntiWindup,
  createInvariant6_AlarmHysteresis,
  createInvariant7_CVBoundedUnderSensorFault,
  createInvariant8_VoltageFloorUnderNormalOps,
};
});
