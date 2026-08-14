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
  { id: 'cascade', label: '캐스케이드 vs 단일루프', impl: true, panels: ['trend', 'tuning', 'operate', 'automeasure'] },
  { id: 'interlock', label: '인터록', impl: true, panels: ['pid', 'electrical', 'pq', 'runtime'] },
  { id: 'failover', label: '보호·절체', impl: false },
  { id: 'sensor', label: '센서 열화', impl: false },
  { id: 'full', label: '전체 보기', impl: true, panels: ALL_PANEL_KEYS },
];
const DEFAULT_MODE = 'antiwindup';

/* ---------------------------- 모드별 파라미터 ----------------------------
 * 게인·SP는 기존 튜닝/운전 패널에서 읽지만, 그 패널에 없는 모드 전용 파라미터는
 * 여기서 고른다. 값은 sim-bench.runMode()에 그대로 넘어간다. 각 항목의 첫 번째
 * 선택지가 검증 스위트의 기준 실행 조건과 같다(그래야 기본 상태에서 두 줄이
 * 일치한다). */
const MODE_PARAMS = {
  cascade: [
    { key: 'disturbanceKind', label: '외란 종류',
      options: [{ v: 'LOAD', t: '열부하 (외부루프 도메인)' }, { v: 'FLOW', t: '유량측 (내부루프 도메인)' }] },
  ],
  interlock: [
    { key: 'simultaneousStarts', label: '동시 기동 대수',
      options: [{ v: 2, t: '2대' }, { v: 3, t: '3대' }] },
    { key: 'feedMode', label: '급전모드',
      options: [{ v: 'BYPASS', t: '바이패스 (DOL)' }, { v: 'VFD', t: 'VFD 소프트스타트' }] },
  ],
};
const modeParamState = {}; // { modeId: { key: value } }

function paramsFor(modeId) {
  const defs = MODE_PARAMS[modeId];
  if (!defs) return {};
  if (!modeParamState[modeId]) {
    modeParamState[modeId] = {};
    defs.forEach(d => { modeParamState[modeId][d.key] = d.options[0].v; });
  }
  return modeParamState[modeId];
}

function renderModeParams(mode) {
  const host = document.getElementById('benchParams');
  host.innerHTML = '';
  const defs = MODE_PARAMS[mode.id];
  if (!defs) return;
  const st = paramsFor(mode.id);
  defs.forEach(def => {
    const grp = document.createElement('div');
    grp.className = 'grp';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = def.label;
    grp.appendChild(lbl);
    const seg = document.createElement('div');
    seg.className = 'seg';
    def.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.textContent = opt.t;
      btn.classList.toggle('sel', st[def.key] === opt.v);
      btn.addEventListener('click', () => {
        st[def.key] = opt.v;
        Array.from(seg.children).forEach(c => c.classList.toggle('sel', c === btn));
        // 파라미터를 바꾸면 이전 결과는 다른 조건의 것이므로 지운다.
        delete resultCache[mode.id];
        clearResult();
      });
      seg.appendChild(btn);
    });
    grp.appendChild(seg);
    host.appendChild(grp);
  });
}

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

  cascade: {
    what: `캐스케이드는 제어루프를 두 겹으로 겹친 구조다. 느린 외부루프(온도→유량SP, 1000ms)가
      "유량을 얼마로 맞춰라"라고 지시하면, 빠른 내부루프(유량→펌프속도, 100ms)가 그 유량을 실제로
      맞춘다. 단일루프는 그 중간 단계 없이 온도오차에서 펌프속도를 곧바로 뽑는다.
      흔히 "캐스케이드가 더 좋다"고 배우지만, <b>그 이점은 외란이 내부루프 도메인에 들어올 때만
      나온다</b> — 내부의 빠른 루프가 외란을 온도까지 번지기 전에 먼저 흡수하기 때문이다.
      외란이 외부루프 도메인(열부하)에 들어오면 그 이점이 없고, 단계가 하나 더 있는 만큼 오히려
      느려질 수 있다. 위 <b>외란 종류</b>를 바꿔가며 두 경우를 모두 확인해야 하는 이유다.`,
    detail: `
      <table>
        <tr><th>항목</th><th>값</th><th>근거</th></tr>
        <tr><td>외부루프 주기 : 내부루프 주기</td><td>1000ms : 100ms (10:1)</td><td>제어이론 — 내부루프가 5~10배 이상 빨라야 캐스케이드가 성립(Seborg, <i>Process Dynamics and Control</i>)</td></tr>
        <tr><td>열부하 외란</td><td>저부하 1000kW → 고부하 3800kW 스텝</td><td>시나리오 B, 시드 2001</td></tr>
        <tr><td>유량측 외란</td><td>같은 속도에서 유량 ×0.7, 60초</td><td>시나리오 B′ — 배관저항 급증·공급압력 저하 근사(<code>FLOW_DISTURBANCE_FACTOR</code>)</td></tr>
        <tr><td>복귀 판정 밴드</td><td>±0.3 °C</td><td><code>tests/metrics.js analyzeDisturbanceRejection</code></td></tr>
      </table>
      <p><b>단일루프 게인은 어떻게 정했는가.</b> 두 구조를 "같은 유효 이득, 다른 구조"로 비교하려고,
      내부루프의 비례게인 <code>iKp</code>를 m³/h→% 환산계수로 삼아 외부루프 게인에 곱해 유도했다
      (<code>Kp_single = oKp × iKp</code>, 차원이 %/°C로 맞는다). <code>iKi</code>는 자체에 시간
      성분이 있어 어느 항에 곱해도 차원이 맞지 않으므로 쓸 수 없다.</p>
      <p><b>이것은 한계이기도 하다.</b> 정확한 폐루프 축소가 아니라 정적 이득 합성에 의한 근사이며,
      단일루프를 따로 최적 튜닝한 결과가 아니다. 그래서 이 비교는 "단일루프가 더 낫다/못하다"의
      결론이 아니라 "구조 차이가 외란 도메인에 따라 어떻게 다르게 작용하는가"를 보는 것으로 읽어야
      한다(<code>sim-core.js singleLoopEquivalentGains()</code> 주석 참조).</p>
      <p><b>차트의 유량 SP선(가는 파선)을 함께 보라.</b> 캐스케이드에서만 외부루프가 유량 SP를
      만들어 내부루프에 건네주므로, 그 선이 움직이는 모양이 곧 "외부루프가 내부루프에 무엇을
      지시했는가"다. 단일루프는 그 중간 신호가 없어 속도를 직접 흔든다.</p>`,
  },

  interlock: {
    what: `펌프를 동시에 여러 대 기동하지 못하게 막는 인터록이 있다(<code>anyPumpStarting</code> 잠금).
      막상 "왜 막아야 하는가"는 정상 운전에서는 관측할 수 없다 — 인터록이 그 상황을 아예 못 만들게
      하기 때문이다. 그래서 이 비교는 전기·전력품질 계층을 직접 호출해 <b>인터록을 코드 레벨에서
      일부러 우회한 가상의 상태</b>를 만들고, 그때 모선전압이 관리한계 아래로 떨어지는지를 본다.
      핵심은 급전모드다. VFD 정상 기동은 소프트스타트라 돌입전류가 정격의 110~150%에 그쳐 몇 대가
      겹쳐도 문제가 없다. 위험한 것은 <b>VFD 고장으로 상용전원 직입(바이패스, DOL)이 된 펌프가 둘
      이상 겹치는 경우</b>다 — DOL 돌입전류는 정격의 5~7배다. 위 <b>급전모드</b>를 VFD로 바꿔보면
      같은 대수를 겹쳐도 전압이 거의 내려가지 않는 것을 확인할 수 있다.`,
    detail: `
      <table>
        <tr><th>항목</th><th>값</th><th>근거</th></tr>
        <tr><td>전압 관리한계</td><td>85 %</td><td><code>PQLayer.CONST.VOLTAGE_MANAGEMENT_FLOOR_PU</code></td></tr>
        <tr><td>DOL 돌입전류</td><td>정격의 5~7배</td><td>유도전동기의 잘 알려진 표준 특성</td></tr>
        <tr><td>VFD 기동 전류</td><td>정격의 110~150 %</td><td>소프트스타트(램프+전류제한) 통상값</td></tr>
        <tr><td>계산 해상도</td><td>5 ms 서브스텝</td><td>100ms에 한 번만 계산하면 돌입 순간의 최저점을 놓친다</td></tr>
        <tr><td>관측 구간</td><td>5 초 (50틱)</td><td><code>tests/sag-demo.js</code>와 동일</td></tr>
        <tr><td>sag 판정</td><td>0.9 pu 미만이 20 ms 이상</td><td>IEEE 1159</td></tr>
      </table>
      <p><b>이 비교는 정식 시나리오가 아니다.</b> 실제 앱에서는 <code>startPump()</code>의
      <code>anyPumpStarting</code> 잠금 때문에 B안의 상태 자체가 만들어질 수 없고, 불변조건
      INV1이 매 틱 그것을 확인한다. 여기서는 그 잠금을 거치지 않고 펌프 배열을 직접 구성해
      "막지 않았다면 어떻게 되는가"를 계산한다 — 즉 <b>인터록 상수의 근거를 수치로 남기기 위한
      데모</b>다(<code>tests/sag-demo.js</code> 상단 주석 참조).</p>
      <p><b>왜 조건부로 풀지 않고 항상 거는가.</b> "바이패스일 때만 동시 기동을 막는다"로 만들면
      그 판단 로직 자체가 새로운 실수 지점이 된다. 급전모드는 VFD 고장으로 언제든 바뀌므로,
      방어적으로 모든 기동에 일괄 적용한다(<code>sim-core.js startPump()</code> 주석).</p>
      <p><b>AVR을 쓰지 않는 이유.</b> 탭체인저 같은 전압조정기는 응답이 수백 ms~수초로 느려
      ms급 sag에는 대응할 수 없다. 그래서 ESS/PCS 무효전력 주입만 쓴다
      (<code>sim-power-quality.js</code> 상단 주석).</p>`,
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
    renderModeParams(mode);
    document.getElementById('benchStatus').textContent = '비교 실행을 누르면 A안과 B안을 순차로 실행합니다.';
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
function benchParams(modeId) {
  return Object.assign(readLiveParams(), paramsFor(modeId));
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
      const result = SimBench.runMode(mode.id, benchParams(mode.id));
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
 * 모드마다 그리는 물리량은 다르지만 축 라벨 위치·범례 위치·선 규칙은 5개
 * 모드가 동일하다 — 모드를 옮겨 다닐 때 화면 구조가 흔들리면 안 되기 때문이다.
 * 공통 규칙:
 *   · 범례는 항상 위쪽 좌측 정렬
 *   · x축 제목 아래, 좌축(y) 제목 왼쪽, 우축(y1)이 있으면 제목 오른쪽
 *   · A안 = 어두운 회색, B안 = 밝은 회색. 상태색(녹/황/적)은 쓰지 않는다
 *     (실물 HMI에서 트렌드 색은 상태를 뜻하지 않는다)
 *   · 주계열은 굵은 실선, 부계열은 가는 파선, 기준선(SP·관리한계)은 점선
 * 각 모드는 아래 CHART_SPECS에 축 제목과 데이터셋 구성만 제공한다. */
const LINE = {
  main: { pointRadius: 0, borderWidth: 2 },
  mainDash: { pointRadius: 0, borderWidth: 2, borderDash: [5, 3] },
  sub: { pointRadius: 0, borderWidth: 1, borderDash: [2, 2] },
  ref: { pointRadius: 0, borderWidth: 1, borderDash: [3, 4] },
};

const CHART_SPECS = {
  antiwindup: {
    xTitle: '시뮬레이션 시간 (s)', yTitle: '공급온도 (°C)', y1Title: '외부루프 적분항',
    build: (a, b, c, labels, extra) => [
      { label: `A · ${a.label} — 공급온도`, data: a.trace.temp, borderColor: c.A, yAxisID: 'y', ...LINE.main },
      { label: `B · ${b.label} — 공급온도`, data: b.trace.temp, borderColor: c.B, yAxisID: 'y', ...LINE.mainDash },
      { label: 'A · 외부루프 적분항', data: a.trace.integral, borderColor: c.A, yAxisID: 'y1', ...LINE.sub },
      { label: 'B · 외부루프 적분항', data: b.trace.integral, borderColor: c.B, yAxisID: 'y1', ...LINE.sub },
      { label: 'SP', data: labels.map(() => a.meta.sp), borderColor: c.ref, yAxisID: 'y', ...LINE.ref },
    ],
  },
  cascade: {
    xTitle: '시뮬레이션 시간 (s)', yTitle: '공급온도 (°C)', y1Title: '유량 SP (m³/h)',
    build: (a, b, c, labels, extra) => [
      { label: `A · ${a.label} — 공급온도`, data: a.trace.temp, borderColor: c.A, yAxisID: 'y', ...LINE.main },
      { label: `B · ${b.label} — 공급온도`, data: b.trace.temp, borderColor: c.B, yAxisID: 'y', ...LINE.mainDash },
      { label: 'A · 유량 SP', data: a.trace.flowSp, borderColor: c.A, yAxisID: 'y1', ...LINE.sub },
      { label: 'B · 유량 SP', data: b.trace.flowSp, borderColor: c.B, yAxisID: 'y1', ...LINE.sub },
      { label: 'SP', data: labels.map(() => a.meta.sp), borderColor: c.ref, yAxisID: 'y', ...LINE.ref },
    ],
  },
  interlock: {
    // 5ms 해상도 파형이라 시간축 단위가 다르지만, 축 제목 위치와 범례 규칙은
    // 다른 모드와 동일하게 유지한다.
    xTitle: '기동 후 경과 시간 (s)', yTitle: '모선전압 (%)', y1Title: null,
    build: (a, b, c, labels, extra) => [
      { label: `A · ${a.label}`, data: a.trace.volt, borderColor: c.A, yAxisID: 'y', ...LINE.main },
      { label: `B · ${b.label}`, data: b.trace.volt, borderColor: c.B, yAxisID: 'y', ...LINE.mainDash },
      { label: `관리한계 ${extra.floorPct}%`, data: labels.map(() => extra.floorPct),
        borderColor: c.ref, yAxisID: 'y', ...LINE.ref },
    ],
  },
};

function drawChart(result) {
  const canvas = document.getElementById('benchChart');
  const spec = CHART_SPECS[result.modeId];
  if (!canvas || typeof Chart === 'undefined' || !spec) return;
  if (benchChart) { benchChart.destroy(); benchChart = null; }

  const [a, b] = result.runs;
  const labels = a.trace.t.map(t => t.toFixed(0));
  const c = {
    A: token('--hmi-trace-a', '#8f9dad'),
    B: token('--hmi-trace-b', '#e8eef5'),
    ref: token('--hmi-g3', '#25313f'),
  };
  const axisColor = token('--hmi-g4', '#748094'), gridColor = '#1c2532';

  const scales = {
    x: { ticks: { color: axisColor, maxTicksLimit: 10 }, grid: { color: gridColor },
         title: { display: true, text: spec.xTitle, color: axisColor } },
    y: { position: 'left', ticks: { color: axisColor }, grid: { color: gridColor },
         title: { display: true, text: spec.yTitle, color: axisColor } },
  };
  if (spec.y1Title) {
    scales.y1 = { position: 'right', ticks: { color: axisColor }, grid: { display: false },
                  title: { display: true, text: spec.y1Title, color: axisColor } };
  }

  benchChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: spec.build(a, b, c, labels, result.extra || {}) },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales,
      plugins: {
        legend: { position: 'top', align: 'start',
                  labels: { color: token('--hmi-g5', '#c9d6e3'), boxWidth: 14, font: { size: 10 } } },
      },
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
