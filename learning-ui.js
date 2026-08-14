/* =============================================================================
 * learning-ui.js — 학습 모드 표시 계층 (DOM 담당)
 *
 * 계산은 전부 sim-bench.js에 있고(그리고 그 안은 tests/의 러너·지표를 그대로
 * 호출한다), 이 파일은 그 결과를 화면에 붙이는 일만 한다.
 *
 * 이 파일이 지키는 것:
 *  1) index.html의 기존 마크업을 수정하지 않는다 — 패널을 감추고 되살리는 일은
 *     기존 요소가 이미 갖고 있는 고유 id를 앵커로 삼아 .closest('.panel')로
 *     찾아서 클래스만 토글한다. 그래야 "전체 보기" 탭이 기존 화면과 물리적으로
 *     같은 DOM이 된다.
 *  2) 기존 인라인 스크립트의 상태(plant/state/chart)를 읽기만 하고 쓰지 않는다.
 *  3) umami가 없어도(차단·로컬 실행) 조용히 넘어간다.
 * ========================================================================= */
(function () {
'use strict';

/* ---------------------------- 방문 통계 ----------------------------
 * 방문자를 식별하거나 IP를 수집하거나 쿠키를 심는 코드는 넣지 않는다.
 * 보내는 것은 "어떤 모드를 눌렀는가"뿐이다. */
function track(event, data) {
  try {
    if (typeof umami !== 'undefined' && umami && typeof umami.track === 'function') {
      umami.track(event, data);
    }
  } catch (e) { /* 통계 실패가 화면 동작을 막아서는 안 된다 — 조용히 무시 */ }
}

/* ---------------------------- 패널 앵커 ----------------------------
 * 값은 index.html에 이미 존재하는 고유 id다. 마크업에 data-* 속성을 새로
 * 심지 않으려고 이 방식을 쓴다(위 1번 원칙). */
const PANEL_ANCHORS = {
  pid: 'pid', alarms: 'alarmTableBody', electrical: 'elecPumpBody', pq: 'pqChart',
  trend: 'trendChart', operate: 'spTempInput', fault: 'faultList', tuning: 'oKp',
  automeasure: 'autoMeasureIdle', runtime: 'runtimeBody', sensors: 'sensTrueTemp',
};
const panelCache = {};
function panel(key) {
  if (panelCache[key] === undefined) {
    const anchor = document.getElementById(PANEL_ANCHORS[key]);
    panelCache[key] = anchor ? anchor.closest('.panel') : null;
  }
  return panelCache[key];
}
const ALL_PANEL_KEYS = Object.keys(PANEL_ANCHORS);

/* ---------------------------- 모드 정의 ----------------------------
 * panels: 그 모드에서 남겨둘 기존 패널. doc: 시뮬레이터 아래 설명 3개 절.
 * 아직 구현하지 않은 모드는 impl:false — 탭은 보이되 준비 중으로 표시한다
 * (탭 배치·가로 스크롤을 먼저 확인할 수 있게).
 * 히스테리시스는 A/B가 역산 근사라 맨 마지막에 붙인다. */
const MODES = [
  { id: 'hysteresis', label: '히스테리시스', impl: false },
  { id: 'antiwindup', label: 'Anti-windup', impl: true, panels: ['trend', 'tuning', 'operate', 'automeasure'] },
  { id: 'cascade', label: '캐스케이드 vs 단일루프', impl: false },
  { id: 'interlock', label: '인터록', impl: false },
  { id: 'failover', label: '보호·절체', impl: false },
  { id: 'sensor', label: '센서 열화', impl: false },
  { id: 'full', label: '전체 보기', impl: true, panels: ALL_PANEL_KEYS },
];
const DEFAULT_MODE = 'antiwindup';

/* ---------------------------- 설명문 ----------------------------
 * 수치를 본문에 박아넣지 않는다 — 실행할 때마다 달라지는 값은 결과 해석
 * 표와 판정문이 담당하고, 여기에는 변하지 않는 원리만 쓴다. */
const DOCS = {
  antiwindup: {
    what: `적분기가 있는 제어기는 출력이 상하한에 걸려도(포화) 오차가 남아 있으면 적분을 계속 쌓는다.
      쌓인 적분은 포화가 풀린 뒤에야 빠져나오므로, 제어량이 목표를 한참 지나쳐 반대편으로 넘어갔다가
      되돌아온다 — 이것이 적분기 와인드업이다.
      이 시뮬레이터는 조건부 적분(conditional integration)으로 막는다: 포화 중에는 포화를
      <b>더 심화시키는 방향</b>의 오차만 적분을 멈추고, 포화를 <b>푸는 방향</b>의 오차는 계속 적분한다.
      아래 비교는 외부루프(온도→유량SP)를 300초 동안 확실히 포화시킨 뒤 부하를 정상으로 되돌려,
      그 되돌림 구간에서 둘이 얼마나 갈라지는지를 본다.`,
    detail: `
      <table>
        <tr><th>항목</th><th>값</th><th>근거</th></tr>
        <tr><td>외부루프 주기 / 내부루프 주기</td><td>1000ms / 100ms (10:1)</td><td>제어이론 — 내부루프가 5~10배 이상 빨라야 캐스케이드가 성립</td></tr>
        <tr><td>기본 게인 (외부 Kp/Ki/Kd)</td><td>40 / 4 / 0</td><td><code>CONST.OUTER_KP0</code> 등</td></tr>
        <tr><td>기본 게인 (내부 Kp/Ki/Kd)</td><td>0.3 / 0.15 / 0</td><td><code>CONST.INNER_KP0</code> 등</td></tr>
        <tr><td>과부하</td><td>6000 kW × 300초</td><td>외부루프 CV 포화 시작점이 약 4200kW라 여유를 두고 잡은 값</td></tr>
        <tr><td>기준부하</td><td>2200 kW (<code>LOAD_MED_KW</code>)</td><td>다른 시나리오와 동일한 중부하 재사용</td></tr>
        <tr><td>복귀 판정 밴드</td><td>±0.3 °C</td><td>오프라인 성능지표 기준(<code>tests/metrics.js</code>)</td></tr>
        <tr><td>난수</td><td>고정 시드 7001</td><td>같은 파라미터면 항상 같은 결과가 나와야 기준값과 대조할 수 있다</td></tr>
      </table>
      <p><b>anti-windup을 끄는 것은 시험 전용 경로다.</b> <code>state.antiWindupEnabled</code>는 검증
      스위트가 이 비교를 위해 쓰는 인자이고, 실제 화면 조작으로는 절대 꺼지지 않는다
      (<code>sim-core.js</code> <code>stepPID()</code> 주석 참조). OFF 실행에서 나오는 불변조건
      INV5 위반은 버그가 아니라 이 비교의 목적 그 자체이며, 스위트의 최종 PASS/FAIL 판정에서는
      제외된다(<code>tests/run.js</code>).</p>
      <p><b>"방금 실행"과 "기준 실행"이 왜 일치하는가.</b> 두 값은 같은 함수·같은 시드·같은 판정
      밴드를 쓴다 — 화면은 표시용 러너를 따로 갖고 있지 않고 <code>tests/runner.js</code>와
      <code>tests/metrics.js</code>를 그대로 호출한다. 기본 게인·기본 SP로 돌리면 검증 스위트가
      돌리는 것과 완전히 같은 실행이 되므로 두 줄이 일치해야 정상이다. 게인이나 SP를 바꾸면
      "방금 실행"만 따라 움직인다.</p>
      <p><b>화면 오른쪽 "자동 측정 패널"과 값이 다른 이유.</b> 그 패널은 실시간 신호를 직접 보는
      온라인 지표라 판정 기준이 다르다 — 밴드 ±0.5 °C(노이즈로 인한 재진입 반복을 피하려고 넓게),
      밴드 안 10초 연속 유지를 요구하고, 관측 대상도 축소모델(shadow)이며, 난수도
      <code>Math.random</code>이다. 반면 이 표는 오프라인 지표(±0.3 °C, 관측창 끝까지 유지, 실계통,
      고정 시드)다. 같은 현상을 재도 값이 다르게 나오는 것이 정상이며, 어느 쪽이 틀린 것이 아니라
      온라인 지표와 오프라인 지표의 목적이 다른 것이다.</p>`,
  },
};

/* ---------------------------- 상태 ---------------------------- */
let currentMode = DEFAULT_MODE;
let benchChart = null;
let benchRunning = false;
const resultCache = {}; // 모드별 마지막 실행 결과

/* ---------------------------- 탭 ---------------------------- */
function buildTabs() {
  const nav = document.getElementById('modeTabs');
  nav.innerHTML = '';
  MODES.forEach(m => {
    const btn = document.createElement('button');
    btn.textContent = m.label;
    btn.dataset.modeId = m.id;
    btn.addEventListener('click', () => {
      selectMode(m.id);
      track('mode', { name: m.label });
    });
    nav.appendChild(btn);
  });
}

function selectMode(modeId) {
  const mode = MODES.find(m => m.id === modeId);
  if (!mode) return;
  currentMode = modeId;

  document.querySelectorAll('#modeTabs button').forEach(b => {
    b.classList.toggle('sel', b.dataset.modeId === modeId);
  });

  applyPanelVisibility(mode);
  renderDoc(mode);

  const benchPanel = document.getElementById('benchPanel');
  benchPanel.classList.toggle('hmi-hidden', !mode.impl || mode.id === 'full');
  if (mode.impl && mode.id !== 'full') {
    const cached = resultCache[modeId];
    if (cached) renderResult(cached); else clearResult();
  }

  // 숨겨져 있던 캔버스는 크기가 0으로 잡혀 있으므로 다시 보일 때 재계산해야
  // 한다(Chart.js는 숨김 상태의 부모에서 높이를 0으로 읽는다).
  requestAnimationFrame(resizeCharts);
}

function applyPanelVisibility(mode) {
  const isFull = mode.id === 'full';
  const keep = mode.panels || [];
  ALL_PANEL_KEYS.forEach(key => {
    const el = panel(key);
    if (el) el.classList.toggle('hmi-hidden', !keep.includes(key));
  });
  // 전체 보기에서만 기존 배너와 제목줄을 되살린다 — 학습 모드에서는 새 헤더의
  // 제목·배지와 중복되기 때문. 배속 토글은 어느 모드에서나 쓸 수 있게 남긴다.
  const simBanner = document.querySelector('.sim-banner');
  if (simBanner) simBanner.classList.toggle('hmi-hidden', !isFull);
  const topTitle = document.querySelector('.topbar h1');
  if (topTitle) topTitle.classList.toggle('hmi-hidden', !isFull);
  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.classList.toggle('hmi-compact', !isFull);

  // 패널이 한쪽 컬럼에만 남으면 빈 컬럼을 접어 2단 그리드가 절반을 낭비하지
  // 않게 한다. 전체 보기에서는 두 컬럼 모두 살아있으므로 원래 배치 그대로다.
  const cols = Array.from(document.querySelectorAll('.grid > .col'));
  let visibleCols = 0;
  cols.forEach(col => {
    const hasVisible = Array.from(col.querySelectorAll('.panel'))
      .some(p => !p.classList.contains('hmi-hidden'));
    col.classList.toggle('hmi-hidden', !hasVisible);
    if (hasVisible) visibleCols++;
  });
  const grid = document.querySelector('.grid');
  if (grid) grid.classList.toggle('hmi-onecol', visibleCols < 2);
}

function resizeCharts() {
  const live = [];
  if (typeof chart !== 'undefined') live.push(chart);
  if (typeof pqChart !== 'undefined') live.push(pqChart);
  live.push(benchChart);
  live.forEach(c => {
    try { if (c && typeof c.resize === 'function') c.resize(); } catch (e) { /* 무시 */ }
  });
}

/* Chart.js는 캔버스에 직접 그리므로 CSS 변수(var(--x))를 색으로 넘길 수 없다.
 * 토큰이 한 곳에만 정의되도록, 실제 색값은 :root에서 읽어와 쓴다. */
function token(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

/* ---------------------------- 설명 ---------------------------- */
function renderDoc(mode) {
  const el = document.getElementById('modeDoc');
  if (mode.id === 'full') { el.classList.add('hmi-hidden'); return; }
  const doc = DOCS[mode.id];
  if (!doc) {
    el.classList.remove('hmi-hidden');
    el.innerHTML = `<h3>${mode.label}</h3><p>이 모드는 아직 준비 중입니다. 현재는 <b>Anti-windup</b>과 <b>전체 보기</b>만 동작합니다.</p>`;
    return;
  }
  el.classList.remove('hmi-hidden');
  el.innerHTML = `
    <h3>이 모드는 무엇인가</h3>
    <p>${doc.what}</p>
    <h3>결과 해석</h3>
    <div id="docResult"><p>위 <b>비교 실행</b>을 누르면 이번 회차 실측값이 여기에 표시됩니다.</p></div>
    <details id="docDetail">
      <summary>더 알아보기 — 제어 파라미터, 판정 기준, 검증 내역</summary>
      <div>${doc.detail}</div>
    </details>`;
  const det = document.getElementById('docDetail');
  det.addEventListener('toggle', () => {
    if (det.open) track('expand_detail', { mode: mode.label });
  });
}

/* ---------------------------- 실행 ---------------------------- */
// 라이브 시뮬레이션이 쓰고 있는 게인/SP를 읽어 벤치에 넘긴다. 라이브 state는
// 절대 수정하지 않는다(읽기 전용).
function readLiveParams() {
  // 인라인 스크립트의 state/chart는 최상위 let/const라 전역 렉시컬 환경에만
  // 들어간다 — window의 속성이 아니므로 window.state로는 못 읽는다. 로드
  // 순서가 어긋났을 때 ReferenceError로 죽지 않도록 typeof로 확인한다.
  const s = (typeof state !== 'undefined') ? state : null;
  if (!s) return {};
  return {
    gains: { oKp: s.gains.oKp, oKi: s.gains.oKi, oKd: s.gains.oKd,
             iKp: s.gains.iKp, iKi: s.gains.iKi, iKd: s.gains.iKd },
    spTempC: s.spTempC,
  };
}

function runBench() {
  if (benchRunning) return;
  const mode = MODES.find(m => m.id === currentMode);
  if (!mode || !mode.impl || mode.id === 'full') return;

  benchRunning = true;
  const btn = document.getElementById('btnRunBench');
  const status = document.getElementById('benchStatus');
  btn.disabled = true;
  status.textContent = 'A안 · B안 순차 실행 중…';
  track('run_comparison', { mode: mode.label });

  // 계산은 동기라 그대로 부르면 위 "실행 중" 표시가 그려지기 전에 화면이
  // 멈춘다. 한 프레임 양보해 상태 표시를 먼저 그린 뒤 실행한다.
  requestAnimationFrame(() => setTimeout(() => {
    try {
      const result = SimBench.runMode(mode.id, readLiveParams());
      resultCache[mode.id] = result;
      renderResult(result);
      status.textContent = `완료 — A안·B안 각 1회 실행 (${result.elapsedMs}ms, 고정 시드)`;
    } catch (e) {
      status.textContent = '실행 실패: ' + e.message;
      console.error(e);
    } finally {
      btn.disabled = false;
      benchRunning = false;
    }
  }, 0));
}

/* ---------------------------- 결과 렌더 ---------------------------- */
function fmtVal(v, digits) {
  if (v == null) return '미회복';
  if (digits == null) return String(v);
  return Number(v).toFixed(digits);
}

function cellHTML(cell, digits, unit, paramsAreDefault) {
  const measured = fmtVal(cell.measured, digits);
  if (!cell.hasBaseline) {
    return `<span class="hmi-num">${measured}${unit}</span>
      <span class="hmi-sub">기준 실행 : — (검증 스위트 미수록)</span>`;
  }
  const base = fmtVal(cell.baseline, digits);
  // 파라미터를 바꾼 뒤에는 두 값이 다른 것이 정상이다 — 일치/불일치 판정은
  // 기본 파라미터로 돌렸을 때만 의미가 있다.
  if (!paramsAreDefault) {
    return `<span class="hmi-num">${measured}${unit}</span>
      <span class="hmi-sub">기준 실행 : ${base}${unit} (기본 파라미터 기준)</span>`;
  }
  let match;
  if (digits == null) {
    match = String(cell.measured) === String(cell.baseline);
  } else {
    // CSV는 toFixed로 잘려 저장되므로 마지막 자리의 반올림 폭까지만 허용한다.
    const tol = 0.5 * Math.pow(10, -digits);
    match = cell.measured != null && Math.abs(cell.measured - cell.baseline) <= tol;
  }
  return `<span class="hmi-num">${measured}${unit}</span>
    <span class="hmi-sub ${match ? 'hmi-match' : 'hmi-mismatch'}">기준 실행 : ${base}${unit} ${match ? '일치' : '⚠ 불일치'}</span>`;
}

function clearResult() {
  document.getElementById('benchResult').innerHTML = '';
  const dr = document.getElementById('docResult');
  if (dr) dr.innerHTML = '<p>위 <b>비교 실행</b>을 누르면 이번 회차 실측값이 여기에 표시됩니다.</p>';
  if (benchChart) { benchChart.destroy(); benchChart = null; }
  // 실행 전에는 빈 캔버스를 큰 여백으로 남기지 않는다.
  document.querySelector('.bench-chart').classList.add('hmi-hidden');
}

function renderResult(result) {
  document.querySelector('.bench-chart').classList.remove('hmi-hidden');
  drawChart(result);

  const [a, b] = result.runs;
  const def = result.paramsAreDefault;
  const rowsHTML = result.rows.map(r => {
    const unit = r.unit ? ' ' + r.unit : '';
    return `<tr>
      <td class="metric">${r.label}</td>
      <td>${cellHTML(r.a, r.digits, unit, def)}</td>
      <td>${cellHTML(r.b, r.digits, unit, def)}</td>
    </tr>`;
  }).join('');

  const html = `
    <table class="hmi-result">
      <thead><tr><th>지표</th><th>A · ${a.label}</th><th>B · ${b.label}</th></tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>
    <div class="hmi-verdict">${result.verdict}</div>
    <p class="hmi-sub" style="margin-top:8px">
      "방금 실행" = 지금 화면의 파라미터로 이번에 계산한 값 ·
      "기준 실행" = 검증 스위트 값(<code>tests/results/${result.baselineSource}</code>)
      ${def
        ? ' · 기본 파라미터이므로 두 줄이 일치해야 정상입니다.'
        : ' · <b>지금은 기본 파라미터가 아닙니다</b> — 기준 실행은 기본값 기준이므로 두 줄이 다른 것이 정상입니다.'}
    </p>`;

  document.getElementById('benchResult').innerHTML = html;
  const dr = document.getElementById('docResult');
  if (dr) dr.innerHTML = html;
}

/* ---- A/B 차트 ----
 * 트레이스에는 상태색을 쓰지 않는다(회색조 명도 2단 + 실선/파선). SP선만
 * 기준선임을 알 수 있게 점선으로 둔다. */
function drawChart(result) {
  const canvas = document.getElementById('benchChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (benchChart) { benchChart.destroy(); benchChart = null; }

  const [a, b] = result.runs;
  const labels = a.trace.t.map(t => t.toFixed(0));
  const cA = token('--hmi-trace-a', '#8f9dad');
  const cB = token('--hmi-trace-b', '#e8eef5');
  const cRef = token('--hmi-g3', '#25313f');
  const datasets = [];

  if (result.modeId === 'antiwindup') {
    datasets.push(
      { label: `A · ${a.label} — 공급온도`, data: a.trace.temp, borderColor: cA,
        yAxisID: 'y', pointRadius: 0, borderWidth: 2 },
      { label: `B · ${b.label} — 공급온도`, data: b.trace.temp, borderColor: cB,
        yAxisID: 'y', pointRadius: 0, borderWidth: 2, borderDash: [5, 3] },
      { label: 'A · 외부루프 적분항', data: a.trace.integral, borderColor: cA,
        yAxisID: 'y1', pointRadius: 0, borderWidth: 1, borderDash: [2, 2] },
      { label: 'B · 외부루프 적분항', data: b.trace.integral, borderColor: cB,
        yAxisID: 'y1', pointRadius: 0, borderWidth: 1, borderDash: [2, 2] },
      { label: 'SP', data: labels.map(() => a.meta.sp), borderColor: cRef,
        yAxisID: 'y', pointRadius: 0, borderWidth: 1, borderDash: [3, 4] },
    );
  }

  const axisColor = '#748094', gridColor = '#1c2532';
  benchChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: axisColor, maxTicksLimit: 10 }, grid: { color: gridColor },
             title: { display: true, text: '시뮬레이션 시간 (s)', color: axisColor } },
        y: { position: 'left', ticks: { color: axisColor }, grid: { color: gridColor },
             title: { display: true, text: '공급온도 (°C)', color: axisColor } },
        y1: { position: 'right', ticks: { color: axisColor }, grid: { display: false },
              title: { display: true, text: '적분항', color: axisColor } },
      },
      plugins: { legend: { labels: { color: '#c9d6e3', boxWidth: 14, font: { size: 10 } } } },
    },
  });
}

/* ---------------------------- 초기화 ---------------------------- */
function init() {
  if (typeof SimBench === 'undefined') {
    console.error('sim-bench.js가 로드되지 않았습니다.');
    return;
  }
  buildTabs();
  document.getElementById('btnRunBench').addEventListener('click', runBench);
  selectMode(DEFAULT_MODE);
  window.addEventListener('resize', resizeCharts);
}
window.addEventListener('DOMContentLoaded', init);
})();
