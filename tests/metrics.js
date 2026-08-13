/* =============================================================================
 * tests/metrics.js — 위반은 아니지만 측정해서 기록하는 성능 지표
 *
 * UMD: Node(require)와 브라우저(<script>) 양쪽에서 로드된다 — 이유는
 * tests/runner.js 상단 주석 참조. 본문은 변환 전과 한 글자도 다르지 않다.
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SimTestMetrics = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

/* ---- 대수제어 토글 횟수 (헌팅 판정 기준 포함) ----
 * runningCountSeries: [{t, runningCount}]
 *
 * 헌팅 판정 기준 근거: 대수제어는 투입 전 STAGE_UP_DELAY_S(15s) 유지, 해제 전
 * STAGE_DOWN_DELAY_S(30s) 유지를 요구한다. 따라서 "투입→해제"를 한 번 왕복하는
 * 데 이론적으로 가능한 가장 빠른 주기는 15+30=45s이고, 그 45s 동안 토글은
 * 반드시 2회(투입 1회 + 해제 1회) 발생한다. 즉 이론상 최대 토글 속도는
 * 2/45*60 ≈ 2.67회/분이다. 이 값의 절반(≈1.33회/분)을 넘게 지속되면 대수제어가
 * 상/하한 부근에서 자주 흔들리고 있다는 신호로 보고 "헌팅 의심"으로 표시한다.
 * (명확한 산업표준은 없고, 위 지연시간 설계값에서 역산한 가정 기준임을 명시)
 */
const STAGE_UP_DOWN_ROUNDTRIP_S = 15 + 30; // CONST.STAGE_UP_DELAY_S + CONST.STAGE_DOWN_DELAY_S
const THEORETICAL_MAX_TOGGLES_PER_MIN = (2 / STAGE_UP_DOWN_ROUNDTRIP_S) * 60; // ≈2.67
const HUNTING_WARN_THRESHOLD_PER_MIN = THEORETICAL_MAX_TOGGLES_PER_MIN * 0.5; // ≈1.33

function computeStagingToggles(runningCountSeries) {
  let toggles = 0;
  for (let i = 1; i < runningCountSeries.length; i++) {
    if (runningCountSeries[i].runningCount !== runningCountSeries[i - 1].runningCount) toggles++;
  }
  const durationS = runningCountSeries.length
    ? runningCountSeries[runningCountSeries.length - 1].t - runningCountSeries[0].t
    : 0;
  const perMin = durationS > 0 ? toggles / (durationS / 60) : 0;
  return {
    toggles,
    durationS,
    perMin,
    huntingSuspected: perMin > HUNTING_WARN_THRESHOLD_PER_MIN,
    huntingThresholdPerMin: HUNTING_WARN_THRESHOLD_PER_MIN,
  };
}

/* ---- 스텝응답 지표: 오버슈트 / 정착시간 / 정상상태편차 ----
 * series: [{t, v}] (t 오름차순), stepTimeS: 스텝을 준 시각, targetValue: 목표값
 * 정착시간은 통상적인 제어공학 관행(허용오차 밴드, 기본 ±5%)을 기준으로 계산.
 */
function analyzeStepResponse(series, stepTimeS, targetValue, opts) {
  opts = opts || {};
  const tolPct = opts.tolPct ?? 0.05;
  const tailWindowS = opts.tailWindowS ?? 10;

  const before = series.filter(p => p.t < stepTimeS);
  const after = series.filter(p => p.t >= stepTimeS);
  if (!after.length) return null;
  const initial = before.length ? before[before.length - 1].v : after[0].v;
  const stepSize = targetValue - initial;

  let overshootPct = 0;
  if (Math.abs(stepSize) > 1e-9) {
    let peak = 0;
    after.forEach(p => {
      const excess = stepSize > 0 ? (p.v - targetValue) : (targetValue - p.v);
      if (excess > peak) peak = excess;
    });
    overshootPct = (peak / Math.abs(stepSize)) * 100;
  }

  const band = Math.max(Math.abs(stepSize) * tolPct, 1e-9);
  let settleTimeS = null;
  for (let i = 0; i < after.length; i++) {
    if (Math.abs(after[i].v - targetValue) <= band) {
      const staysIn = after.slice(i).every(p => Math.abs(p.v - targetValue) <= band);
      if (staysIn) { settleTimeS = after[i].t - stepTimeS; break; }
    }
  }

  const lastT = after[after.length - 1].t;
  const tail = after.filter(p => p.t >= lastT - tailWindowS);
  const tailAvg = tail.reduce((s, p) => s + p.v, 0) / tail.length;
  const steadyStateError = tailAvg - targetValue;

  return {
    initial, targetValue, stepSize,
    overshootPct,
    settleTimeS, // null이면 관측 구간 내 정착 못함
    steadyStateError,
    tolPct,
  };
}

/* ---- 외란(부하 스텝) 대응 지표: SP 대비 최대편차 / 정상범위 복귀시간 ----
 * 시나리오 B(부하 스텝)처럼 SP는 그대로인데 "부하"라는 외란이 들어오는 경우,
 * analyzeStepResponse의 스텝크기(=target-initial)가 0에 가까워 %기반 오버슈트
 * 정의가 무의미해진다. 대신 SP로부터의 절대편차로 직접 평가한다.
 * toleranceAbsC 기본값 0.3°C: 명확한 표준은 없고, "정상 운전 범위로 복귀했다"고
 * 볼 수 있는 대표 허용폭으로 잡은 가정치.
 *
 * windowEndS(선택): 다음 외란이 들어오는 시각(또는 관측 종료 시각)을 넘겨서
 * 주면, 그 시각 이후의 데이터는 최대편차·복귀시간 계산에서 완전히 제외한다.
 * 이 경계가 없으면 "이 스텝에 대한 복귀시간"을 구하는 도중에 다음 스텝의
 * 외란이 섞여 들어가(예: 상승스텝 복귀를 보다가 하강스텝의 undershoot까지
 * 같이 잡음), 두 외란이 뒤엉킨 값이 나온다 — 실제로 초기 버전에서 이 문제가
 * 있었다(README "정착시간 판정 재검토" 절 참조). 경계 안에서 끝까지도 밴드
 * 안에 못 들어오면 recoveryTimeS는 null(호출부에서 "미정착"으로 명시 처리).
 */
function analyzeDisturbanceRejection(series, stepTimeS, targetValue, toleranceAbs, windowEndS) {
  toleranceAbs = toleranceAbs ?? 0.3;
  const after = series.filter(p => p.t >= stepTimeS && (windowEndS == null || p.t < windowEndS));
  if (!after.length) return null;
  let peakDeviation = 0;
  after.forEach(p => { const d = Math.abs(p.v - targetValue); if (d > peakDeviation) peakDeviation = d; });
  let recoveryTimeS = null;
  for (let i = 0; i < after.length; i++) {
    if (Math.abs(after[i].v - targetValue) <= toleranceAbs) {
      const staysIn = after.slice(i).every(p => Math.abs(p.v - targetValue) <= toleranceAbs);
      if (staysIn) { recoveryTimeS = after[i].t - stepTimeS; break; }
    }
  }
  return { peakDeviation, recoveryTimeS, toleranceAbs, windowS: after.length ? after[after.length - 1].t - stepTimeS : 0 };
}

/* ---- 펌프별 기동 횟수 / 누적 운전시간 편차 (교번운전이 실제로 균등한가) ---- */
function computePumpBalance(pumps) {
  const starts = pumps.map(p => p.startCount || 0);
  const hours = pumps.map(p => p.runtimeH);
  const avgHours = hours.reduce((a, b) => a + b, 0) / hours.length;
  const maxHourDiff = Math.max(...hours) - Math.min(...hours);
  return {
    perPump: pumps.map(p => ({ id: p.id, startCount: p.startCount || 0, runtimeH: p.runtimeH })),
    maxStartCountDiff: Math.max(...starts) - Math.min(...starts),
    maxRuntimeHDiff: maxHourDiff,
    runtimeHDiffPctOfAvg: avgHours > 1e-9 ? (maxHourDiff / avgHours) * 100 : 0,
  };
}

/* ---- 센서 드리프트 "미검출 구간" 길이 ----
 * driftSeries: [{t, trueV, measV, diagActive}]
 * deviationThresholdC(대표값 1.0°C): "이 정도 어긋나면 실무에서 문제가 될 만하다"고
 * 볼 수 있는 대표적 편차 폭 — 명확한 산업표준은 없는 가정치. 그 편차에 처음
 * 도달한 시각부터, 진단(범위이탈/고착/정합성)이 처음 발동한 시각까지의 간격을
 * "미검출 구간"으로 본다. 오프셋 드리프트는 이 시뮬레이터가 구현한 진단 어느
 * 것으로도 원천적으로 검출되지 않도록 설계했으므로(README 참조), 대개는
 * diagFirstActiveAtS가 null로 나오는 것 자체가 의도된 결과다.
 */
function computeDriftBlindSpot(driftSeries, deviationThresholdC) {
  deviationThresholdC = deviationThresholdC ?? 1.0;
  let deviationExceededAtS = null;
  let diagFirstActiveAtS = null;
  for (const p of driftSeries) {
    const dev = Math.abs(p.trueV - p.measV);
    if (deviationExceededAtS === null && dev >= deviationThresholdC) deviationExceededAtS = p.t;
    if (diagFirstActiveAtS === null && p.diagActive) diagFirstActiveAtS = p.t;
  }
  const last = driftSeries[driftSeries.length - 1];
  const finalDeviationC = last ? Math.abs(last.trueV - last.measV) : 0;
  const blindSpotEndS = diagFirstActiveAtS != null ? diagFirstActiveAtS : (last ? last.t : null);
  return {
    deviationThresholdC,
    deviationExceededAtS,
    diagFirstActiveAtS,
    everDetected: diagFirstActiveAtS !== null,
    blindSpotDurationS: (deviationExceededAtS != null && blindSpotEndS != null) ? (blindSpotEndS - deviationExceededAtS) : null,
    finalDeviationC,
  };
}

/* ---- sag 이벤트 통계 (깊이/지속시간) ---- */
function computeSagStats(eventLog) {
  if (!eventLog.length) return { count: 0, avgDurationMs: 0, maxDurationMs: 0, avgDepthPct: 0, maxDepthPct: 0 };
  const durationsMs = eventLog.map(e => e.durationS * 1000);
  const depthsPct = eventLog.map(e => (1 - e.minVoltagePu) * 100);
  return {
    count: eventLog.length,
    avgDurationMs: durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length,
    maxDurationMs: Math.max(...durationsMs),
    avgDepthPct: depthsPct.reduce((a, b) => a + b, 0) / depthsPct.length,
    maxDepthPct: Math.max(...depthsPct),
  };
}

/* ---- 바이패스 절체 후 정상상태 온도편차 (시나리오 J) ----
 * trendSeries: [{t, v}] (공급온도), changeoverAtS 이후 마지막 tailWindowS초
 * 평균과 SP의 차이를 "절체 후에도 제어가 유지되는가"의 척도로 쓴다.
 */
function computeChangeoverSteadyStateError(trendSeries, changeoverAtS, spTempC, tailWindowS) {
  tailWindowS = tailWindowS ?? 30;
  const after = trendSeries.filter(p => p.t >= changeoverAtS);
  if (!after.length) return null;
  const lastT = after[after.length - 1].t;
  const tail = after.filter(p => p.t >= lastT - tailWindowS);
  const tailAvg = tail.reduce((s, p) => s + p.v, 0) / tail.length;
  return { tailAvgC: tailAvg, errorC: tailAvg - spTempC, tailWindowS };
}

/* ---- Anti-windup 효과 비교 (시나리오 G) ----
 * fullSeries: [{t, supplyTempC, outerIntegral}] (runSimulation의 trendSeries 원본)
 * overloadAtS~overloadEndS: 과부하(포화 유발) 구간. 그 구간에서 외부루프 적분항
 * 최댓값을 구하고, 과부하가 끝나 부하가 정상으로 돌아온 뒤(overloadEndS 이후)
 * "최대 언더슈트"(SP보다 얼마나 더 내려가는지)와 "±band 밴드 복귀시간"을 잰다.
 * 복귀시간 판정은 analyzeDisturbanceRejection과 동일하게 "그 시점부터 관측
 * 구간(windowEndS) 끝까지 계속 밴드 안에 머무는 첫 시점"을 쓴다(스텝 간격
 * 오염을 피하려고 도입한 것과 같은 방식 — README "정착시간 판정 재검토" 참조).
 */
function analyzeAntiWindup(fullSeries, overloadAtS, overloadEndS, spTempC, band, windowEndS) {
  band = band ?? 0.3;
  const duringOverload = fullSeries.filter(p => p.t >= overloadAtS && p.t < overloadEndS);
  const maxIntegralDuringOverload = duringOverload.length
    ? Math.max(...duringOverload.map(p => p.outerIntegral))
    : null;
  const integralAtOverloadEnd = duringOverload.length
    ? duringOverload[duringOverload.length - 1].outerIntegral
    : null;

  const after = fullSeries.filter(p => p.t >= overloadEndS && (windowEndS == null || p.t < windowEndS));
  let minTempC = Infinity, minTempAtS = null;
  after.forEach(p => {
    if (p.supplyTempC < minTempC) { minTempC = p.supplyTempC; minTempAtS = p.t - overloadEndS; }
  });
  const peakUndershootC = after.length ? (spTempC - minTempC) : null; // 양수면 SP보다 아래로 벗어났다는 뜻

  let recoveryTimeS = null;
  for (let i = 0; i < after.length; i++) {
    if (Math.abs(after[i].supplyTempC - spTempC) <= band) {
      const staysIn = after.slice(i).every(p => Math.abs(p.supplyTempC - spTempC) <= band);
      if (staysIn) { recoveryTimeS = after[i].t - overloadEndS; break; }
    }
  }
  return { maxIntegralDuringOverload, integralAtOverloadEnd, minTempC, minTempAtS, peakUndershootC, recoveryTimeS, band };
}

return {
  computeStagingToggles,
  analyzeStepResponse,
  analyzeDisturbanceRejection,
  analyzeAntiWindup,
  computePumpBalance,
  computeDriftBlindSpot,
  computeSagStats,
  computeChangeoverSteadyStateError,
  THEORETICAL_MAX_TOGGLES_PER_MIN,
  HUNTING_WARN_THRESHOLD_PER_MIN,
};
});
