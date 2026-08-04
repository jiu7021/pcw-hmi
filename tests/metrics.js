/* =============================================================================
 * tests/metrics.js — 위반은 아니지만 측정해서 기록하는 성능 지표
 * ========================================================================= */

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
 */
function analyzeDisturbanceRejection(series, stepTimeS, targetValue, toleranceAbs) {
  toleranceAbs = toleranceAbs ?? 0.3;
  const after = series.filter(p => p.t >= stepTimeS);
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
  return { peakDeviation, recoveryTimeS, toleranceAbs };
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

module.exports = {
  computeStagingToggles,
  analyzeStepResponse,
  analyzeDisturbanceRejection,
  computePumpBalance,
  THEORETICAL_MAX_TOGGLES_PER_MIN,
  HUNTING_WARN_THRESHOLD_PER_MIN,
};
