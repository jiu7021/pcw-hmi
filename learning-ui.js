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
  // 히스테리시스: 라이브 패널을 하나도 두지 않는다. 라이브는 정지 상태(STOP 0%,
  // 투입 대수 0/3)인데 A/B 그래프에서는 3대가 도는 것처럼 보여서, 두 화면이
  // 같은 것을 말한다고 오해하게 만들었다. 라이브가 필요하면 "전체 보기"로 간다.
  { id: 'hysteresis', label: '히스테리시스', impl: true, panels: [] },
  { id: 'antiwindup', label: 'Anti-windup', impl: true, panels: ['trend', 'tuning', 'operate', 'automeasure'] },
  // 캐스케이드: 계통도를 넣고, 외부루프·내부루프가 어디에 걸리는지 주석을 얹는다.
  { id: 'cascade', label: '캐스케이드 vs 단일루프', impl: true, panels: ['pid', 'trend', 'tuning', 'operate'], loopAnnotation: true },
  { id: 'interlock', label: '인터록(SAG)', impl: true, panels: ['pid', 'electrical', 'pq', 'runtime'] },
  { id: 'failover', label: '보호·절체', impl: true, panels: ['pid', 'fault', 'electrical', 'runtime', 'alarms'] },
  { id: 'sensor', label: '센서 열화', impl: true, panels: ['sensors', 'trend', 'alarms'] },
  { id: 'full', label: '전체 보기', impl: true, panels: ALL_PANEL_KEYS },
];
const DEFAULT_MODE = 'antiwindup';

/* ---------------------------- 모드별 파라미터 ----------------------------
 * 게인·SP는 기존 튜닝/운전 패널에서 읽지만, 그 패널에 없는 모드 전용 파라미터는
 * 여기서 고른다. 값은 sim-bench.runMode()에 그대로 넘어간다. 각 항목의 첫 번째
 * 선택지가 검증 스위트의 기준 실행 조건과 같다(그래야 기본 상태에서 두 줄이
 * 일치한다). */
const MODE_PARAMS = {
  hysteresis: [
    { key: 'cfScenario', label: '부하 상황',
      options: [{ v: 'F', t: '대수제어 경계에서 부하가 흔들릴 때' },
                { v: 'A', t: '평소처럼 부하가 오르내릴 때' },
                { v: 'B', t: '부하가 갑자기 크게 뛸 때' }] },
    // B안 정책은 "히스테리시스 없음" 하나로 고정한다 — 선택지를 셋으로 두면
    // 처음 보는 사람에게는 무엇을 고르라는 것인지 알 수 없다. 중간 변형
    // (확인지연만 제거 / 임계 차이만 제거)은 "더 알아보기"의 수치로만 남긴다.
  ],
  cascade: [
    { key: 'disturbanceKind', label: '외란이 생기는 곳',
      options: [{ v: 'LOAD', t: '열부하가 갑자기 늘 때' }, { v: 'FLOW', t: '배관이 막혀 유량이 줄 때' }] },
  ],
  interlock: [
    { key: 'simultaneousStarts', label: '한꺼번에 켜는 펌프',
      options: [{ v: 2, t: '2대' }, { v: 3, t: '3대' }] },
    { key: 'feedMode', label: '기동 방식',
      options: [{ v: 'BYPASS', t: '상용전원 직입 (DOL)' }, { v: 'VFD', t: '인버터 소프트스타트 (VFD)' }] },
  ],
  sensor: [
    { key: 'degradationLevel', label: '센서가 낡은 정도',
      options: [{ v: 1.0, t: '많이 낡음' }, { v: 0.5, t: '절반쯤' }, { v: 0.25, t: '조금' }] },
  ],
};

// 화면에서 바로 읽어야 하는 한 줄 보충 설명(모드별).
const MODE_HINTS = {
  interlock: 'VFD 소프트스타트는 주파수를 0부터 올리며 전류를 제한해 기동하므로 돌입전류가 정격의 110~150%에 그친다. ' +
    '상용전원 직입(DOL)은 그 제한이 없어 600~800%가 흐른다 — 그래서 동시 기동 금지 인터록이 실제로 필요한 것은 DOL 조건뿐이다. ' +
    '기동 방식을 VFD로 바꿔보면 같은 대수를 겹쳐도 관리한계를 넘지 않는 것을 확인할 수 있다.',
  hysteresis: '투입은 90%에서 15초, 해제는 40%에서 30초 — 임계를 다르게 둬서 경계에서 반복 기동을 막는다.',
  cascade: '계통도의 점선 상자가 각 루프가 걸리는 구간이다 — 내부루프는 펌프·유량계, 외부루프는 공급온도.',
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
  hysteresis: {
    what: `<span class="hmi-readguide">가로축은 시뮬레이션 시간. 회색 실선이 펌프 속도지령이고, 회색 점선 둘은 투입 임계 90%와 해제 임계 40%. <b>시안 계단이 A안(히스테리시스 적용) 투입 대수, 주황 파선 계단이 B안(히스테리시스 없음)</b>이다. <b>시안 계단이 평평하게 유지되는 구간에서 주황이 몇 번 오르내리는지를 보라</b> — 그 차이가 곧 걸러낸 기동 횟수다.</span>
      <b>투입은 90%에서 15초, 해제는 40%에서 30초 — 임계를 다르게 둬서 경계에서 반복 기동을 막는다.</b>
      대수제어는 펌프를 몇 대 돌릴지 정하는 로직이다. 속도지령이 투입 임계를 넘으면 한 대 더 붙이고,
      해제 임계 아래로 내려가면 한 대 뺀다. 두 임계가 같고 유지시간도 없다면 속도지령이 경계에서
      조금만 흔들려도 펌프가 계속 붙었다 떨어졌다 한다 — 헌팅이다. 실제 설비에서 기동 횟수는 곧
      마모와 수명이므로 이것은 비용 문제이기도 하다.
      차트에서 속도지령선은 하나뿐이고(A·B가 같은 궤적을 공유한다), 갈라지는 것은 우축의 투입 대수
      계단뿐이다.`,
    detail: `
      <table>
        <tr><th>항목</th><th>값</th><th>근거</th></tr>
        <tr><td>증속 임계 / 유지시간</td><td>90 % / 15 초</td><td><code>STAGE_UP_SPEED_PCT</code>, <code>STAGE_UP_DELAY_S</code> (가정치)</td></tr>
        <tr><td>해제 임계 / 유지시간</td><td>40 % / 30 초</td><td><code>STAGE_DOWN_SPEED_PCT</code>, <code>STAGE_DOWN_DELAY_S</code> — 해제를 투입보다 길게 둬 보수적으로 억제</td></tr>
        <tr><td>헌팅 의심 기준</td><td>1.33 회/분</td><td>이론상 최속 왕복 15+30=45초 → 최대 2.67회/분, 그 절반을 경고선으로 잡은 가정치</td></tr>
        <tr><td>밴드 제거의 정의</td><td>단일 임계 90 %</td><td>임계값을 새로 지어내지 않으려고 기존 상수를 그대로 재사용</td></tr>
      </table>
      <p><b>이 모드의 A/B는 실행 두 번이 아니다.</b> 히스테리시스를 끈 실행은 임계값·지연이
      <code>Object.freeze</code>된 <code>CONST</code>에 있어 <code>sim-core.js</code>를 고치지 않으면
      만들 수 없고, 이 프로젝트는 제어 로직을 건드리지 않는 것이 전제다. 그래서 한 번 실행해 얻은
      속도지령 궤적에 판정 규칙만 바꿔 덧씌운다. <b>정책이 실제로 달랐다면 투입 대수가 달라지고
      따라서 속도지령 궤적 자체도 달라졌을 것이므로, B안의 숫자는 근사다.</b> 다른 모드처럼
      "두 조건을 실제로 돌려 비교한 값"으로 읽으면 안 된다.</p>
      <p><b>그래도 방법 자체는 점검했다.</b> 실제와 동일한 정책을 넣어 역산하면 실제 토글 수가
      그대로 재현되어야 하고, 시나리오 A·B·F 전부에서 재현된다(<code>tests/run.js</code>의 역산
      타당성 점검, <code>staging_counterfactual.csv</code>의 <code>reproducesActual</code> 열).
      재현되지 않으면 역산 결과 전부를 믿을 수 없다는 뜻이므로 스위트가 그것을 먼저 확인한다.
      초기 마스터 기동에 의한 0→1 전이는 대수제어의 판단이 아니므로 양쪽 모두에서 제외한다.</p>
      <p><b>두 장치 중 무엇이 일하고 있는가.</b> 화면에서는 "히스테리시스 없음"(둘 다 제거)만
      비교하지만, 확인지연과 임계 차이를 하나씩만 빼면 이렇게 갈린다(토글 횟수, 초기 기동 제외):</p>
      <table>
        <tr><th>부하 상황</th><th>적용</th><th>확인지연만 제거</th><th>임계 차이만 제거</th><th>둘 다 제거</th></tr>
        <tr><td>대수제어 경계에서 흔들릴 때</td><td>2</td><td>2</td><td>4</td><td>32</td></tr>
        <tr><td>평소처럼 오르내릴 때</td><td>2</td><td>12</td><td>4</td><td>368</td></tr>
        <tr><td>갑자기 크게 뛸 때</td><td>3</td><td>8</td><td>6</td><td>134</td></tr>
      </table>
      <p>경계에서 흔들릴 때는 확인지연을 빼도 토글이 늘지 않는다 — 임계 차이만으로 이미 걸러지기
      때문이다. 반면 평소 부하에서는 확인지연이 6배를 걸러낸다. 어느 한 장치가 항상 주역인 것이
      아니라 부하 패턴에 따라 기여도가 달라진다(<code>staging_counterfactual.csv</code>).</p>`,
  },

  antiwindup: {
    what: `<span class="hmi-readguide">가로축은 시뮬레이션 시간. 굵은 선 둘은 왼쪽 축의 공급온도(시안=A안 ON, 주황 파선=B안 OFF), 얇은 선 둘은 오른쪽 축의 외부루프 적분항이다. 회색 점선은 목표 온도(SP). <b>과부하가 끝나는 600초 부근에서 주황 온도선이 SP 아래로 얼마나 깊이 내려갔다 돌아오는지를 보라</b> — 그 직전에 주황 적분항이 얼마나 높이 쌓여 있었는지가 원인이다.</span>
      적분기가 있는 제어기는 출력이 상하한에 걸려도(포화) 오차가 남아 있으면 적분을 계속 쌓는다.
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
    what: `<span class="hmi-readguide">가로축은 시뮬레이션 시간. 굵은 선 둘은 왼쪽 축의 공급온도(시안=A안 캐스케이드, 주황 파선=B안 단일루프), 얇은 선 둘은 오른쪽 축의 유량 SP다. 회색 점선은 목표 온도(SP). <b>외란이 들어간 뒤 두 굵은 선 중 어느 쪽이 SP에서 덜 벗어나고 더 빨리 돌아오는지를 보라</b> — 외란 종류를 바꾸면 그 답이 뒤집힌다.</span>
      캐스케이드는 제어루프를 두 겹으로 겹친 구조다. 느린 외부루프(온도→유량SP, 1000ms)가
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
    what: `<span class="hmi-readguide">가로축은 기동 후 경과 시간(초). 굵은 선 둘은 왼쪽 축의 모선전압(시안=A안 인터록 준수, 주황 파선=B안 우회), 얇은 선 둘은 오른쪽 축의 기동전류다. 회색 점선은 관리한계 85%. <b>기동 직후 0.1초 안쪽에서 주황 전압선이 회색 점선 아래로 떨어지는지를 보라</b> — 떨어지면 인터록을 어긴 대가가 나타난 것이다. 주황 삼각형 표식이 ESS가 붙은 시점이다.</span>
      펌프를 동시에 여러 대 기동하지 못하게 막는 인터록이 있다(<code>anyPumpStarting</code> 잠금).
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

  failover: {
    what: `<span class="hmi-readguide">가로축은 시뮬레이션 시간, 세로축은 펌프 속도. 시안이 A안(VFD 정상), 주황 파선이 B안(바이패스 절체)이고, 각 안마다 굵은 선이 절체 대상인 P-1, 얇은 선 둘이 나머지 P-2·P-3다. <b>100초 부근에서 주황 굵은 선이 100%로 올라붙어 고정되고, 주황 얇은 선 둘이 그만큼 내려가는지를 보라</b> — 그 맞물림이 내부루프가 절체를 흡수하는 장면이다.</span>
      펌프의 VFD가 고장나면 상용전원 직입(바이패스, DOL)으로 절체된다. 절체된 펌프는 속도 제어를
      받지 못하고 컨택터가 붙는 순간부터 사실상 정격속도로 고정 운전된다. 그러면 "속도를 조절해
      유량을 맞춘다"는 제어 전제가 그 펌프에서는 깨진다.
      이 비교는 고부하 운전 중 P-1의 VFD를 고장내고(@100초), 절체가 없었던 대조군과 나란히 놓는다.
      <b>봐야 할 것은 최종 온도가 아니라 절체 과정이다</b> — 차트에서 대조군은 3대가 같은 속도라
      한 줄로 겹쳐 보이고, 절체 후에는 100% 고정 1대와 낮아진 2대로 갈라진다. 그런데도 아래쪽
      온도선 두 개는 계속 겹쳐 있다.`,
    detail: `
      <table>
        <tr><th>항목</th><th>값</th><th>근거</th></tr>
        <tr><td>VFD 고장 시각</td><td>100 초</td><td>시나리오 J, 시드 10001</td></tr>
        <tr><td>부하</td><td>3800 kW 고정 (<code>LOAD_HIGH_KW</code>)</td><td>절체 후 나머지 펌프가 대수제어로 추가 투입되는 상황까지 보려고 고부하로 고정</td></tr>
        <tr><td>바이패스 고정속도</td><td>100 %</td><td><code>BYPASS_FIXED_SPEED_PCT</code> — DOL은 속도 제어가 없다</td></tr>
        <tr><td>제어 유지 허용폭</td><td>±2.0 °C</td><td>가정치 — 정상 시나리오의 정상상태편차(대개 0.01°C 미만)보다 훨씬 넉넉하게 잡아 "제어가 살아있는가"만 확인하는 취지</td></tr>
      </table>
      <p><b>온도가 안 변한 것 자체가 결과다.</b> 별도의 "바이패스 전용 절체 제어" 로직을 두지
      않았는데도 공급온도 궤적이 대조군과 사실상 같다. 내부루프가 보는 오차는
      "설정유량 − 전체유량"인데, 이 전체유량에는 고정속도로 도는 바이패스 펌프의 기여분이 이미
      포함되어 있다. 그래서 내부루프는 아무 특수 처리 없이 나머지 VFD 펌프의 속도를 낮춰
      총유량을 맞춘다 — 기존 폐루프 구조가 절체를 그대로 흡수한 것이다
      (<code>sim-core.js setPumpFeedMode()</code> 주석 참조).</p>
      <p><b>최종 정상상태 편차를 주지표로 쓰지 않는 이유.</b> 절체 −0.011 °C, 대조군 −0.008 °C로
      차이가 거의 없어 그 숫자만 보면 절체가 일어났는지조차 알 수 없다. 온도 과도(최대편차·회복시간)도
      마찬가지다 — 100초 부근의 온도 움직임은 VFD 고장이 아니라 고부하 기동·대수제어 과도이고,
      대조군에도 똑같이 나타난다. 그래서 실제로 갈리는 펌프 속도와 급전모드를 주지표로 삼고,
      온도는 "바뀌지 않았다"는 근거로 함께 싣는다.</p>
      <p><b>보호 리셋은 자동이 아니다.</b> 결상·과부하 트립은 원인이 살아 있으면 리셋이 거부된다.
      원인 미해소 상태에서 리셋을 허용하면 재기동 즉시 다시 트립되거나 위험한 상태로 운전이
      계속되기 때문이며, 왼쪽 전기 계통 패널에서 직접 확인할 수 있다.</p>`,
  },

  sensor: {
    what: `<span class="hmi-readguide">가로축은 시뮬레이션 시간. 왼쪽 축의 주황 선 둘은 열화 센서의 참값(굵은 선)과 측정값(얇은 선), 오른쪽 축의 두 선은 참값과 측정값의 편차(시안=A안 열화 없음, 주황=B안 열화)다. 회색 점선은 판정 임계 1.0°C. <b>주황 두 선이 시간이 갈수록 벌어지는데 알람이 하나도 뜨지 않는 것을 보라</b> — 오른쪽 축의 시안 편차선은 바닥에 붙어 있어 대조가 된다.</span>
      센서 진단은 보통 세 가지를 본다 — 범위이탈(값이 계측범위를 벗어남), 값고착(값이 전혀 안 움직임),
      정합성 모순(다른 신호와 앞뒤가 안 맞음). 셋 다 <b>"값이 튀는 것"</b>을 잡는 진단이다.
      그런데 실제 현장에서 흔한 열화는 값이 튀지 않고 <b>서서히 어긋나는 오프셋 드리프트</b>다.
      측정값은 계속 정상 범위 안에 있고, 계속 움직이고, 다른 신호와도 모순되지 않는다.
      아래 비교는 공급온도 센서를 열화시킨 1시간 실행과 열화 없는 대조군을 나란히 놓는다.
      차트에서 열화 쪽은 참값선과 측정값선이 벌어지는데, <b>그동안 알람은 하나도 뜨지 않는다.</b>`,
    detail: `
      <table>
        <tr><th>항목</th><th>값</th><th>근거</th></tr>
        <tr><td>실행 시간</td><td>3600 초 (1시간)</td><td>시나리오 I, 시드 9001</td></tr>
        <tr><td>부하</td><td>2200 kW 고정 (<code>LOAD_MED_KW</code>)</td><td>드리프트만 분리해 보려고 부하를 고정</td></tr>
        <tr><td>편차 판정 임계</td><td>1.0 °C</td><td>가정치 — "이 정도 어긋나면 실무에서 문제가 될 만하다"는 대표 폭, 명확한 산업표준은 없다</td></tr>
        <tr><td>대조군</td><td>동일 조건, 열화만 제거</td><td>시나리오 I-control</td></tr>
      </table>
      <p><b>주지표를 최종 편차로 잡은 이유 — 미검출 구간 지표의 한계.</b> 원래 이 시나리오의 지표는
      "미검출 구간"(편차가 임계를 처음 넘은 시각부터 진단이 발동할 때까지)이었다. 그런데 그 값이
      열화 100%와 대조군에서 <b>둘 다 3596.6초로 똑같이</b> 나온다. 기동 직후 22 °C에서 21 °C로
      냉각되는 과도구간에서는 열화가 전혀 없어도 센서 응답지연만으로 편차가 임계를 넘기 때문이다
      (대조군 실측: t=3.4초에 1.0 °C 초과, 최대 4.357 °C @6.1초, 마지막 초과 71.9초). 즉 이 지표는
      "최초 시각" 하나에 좌우돼 열화 유무를 구분하지 못한다.</p>
      <p>과도구간을 잘라내는 컷오프 시각을 두는 방법도 있지만, "왜 하필 그 시각인가"라는 임의성이
      생기고 기동 과도 길이가 바뀌면 또 흔들린다. 그래서 컷오프가 필요 없는 두 지표를 쓴다 —
      <b>최종 편차</b>(주지표)와 <b>편차 1.0 °C 초과 샘플 비율</b>(보조). 후자는 기동 과도가 전체의
      1% 남짓이라 자연히 묻히고 지속적인 드리프트만 비율로 남는다. 원 지표도 표에 그대로 남겨두었다 —
      <b>이 지표가 A/B를 구분하지 못한다는 사실 자체가 이 모드에서 볼 것</b>이기 때문이다. 지표를
      잘못 고르면 "측정했다"는 사실만 남고 아무것도 판별하지 못한다.</p>
      <p><b>이 사각지대는 의도적으로 만든 것이다.</b> 드리프트를 검출하는 진단(예: 다중 센서 교차
      비교, 장기 추세 감시)을 넣지 않은 상태를 그대로 보여주는 것이 목적이다. 알람이 전부 정상이라는
      것이 측정값이 맞다는 뜻은 아니며, 이 화면은 그 간극을 눈으로 확인하는 자리다
      (<code>sim-sensors.js</code> 상단 주석 참조).</p>
      <p><b>실행에 1~2초 걸린다.</b> 1시간 시뮬레이션을 A안·B안 두 번 돌리므로 다른 모드보다 오래
      걸린다(다른 모드는 100 ms 안팎).</p>`,
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
  hideLiveActuators(mode);
  applyLoopAnnotation(mode);
  const hintEl = document.getElementById('benchHint');
  const hint = MODE_HINTS[mode.id];
  hintEl.innerHTML = hint || '';
  hintEl.classList.toggle('hmi-hidden', !hint || !mode.impl || mode.id === 'full');
  if (mode.impl && mode.id !== 'full') {
    renderModeParams(mode);
    document.getElementById('benchStatus').textContent = '비교 실행을 누르면 A안과 B안을 순차로 실행합니다.';
    const cached = resultCache[modeId];
    if (cached) renderResult(cached); else clearResult();
  }

  // 숨겨져 있던 캔버스는 크기가 0으로 잡혀 있으므로 다시 보일 때 재계산해야
  // 한다(Chart.js는 숨김 상태의 부모에서 높이를 0으로 읽는다).
  setTimeout(resizeCharts, 16);
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

/* ---- 라이브 액추에이터 숨김 ----
 * 학습 모드는 A/B 비교만 보여주는 화면이다. 라이브 시뮬레이터를 직접 켜고 끄는
 * START/STOP이 같이 떠 있으면, 정지 상태인 라이브와 3대가 도는 A/B 그래프가
 * 한 화면에 섞여 어느 쪽 이야기인지 알 수 없게 된다. 게인·SP처럼 벤치에
 * 입력으로 들어가는 컨트롤은 그대로 둔다. */
function hideLiveActuators(mode) {
  const learning = mode.impl && mode.id !== 'full';
  const startBtn = document.getElementById('btnStart');
  const grp = startBtn ? startBtn.closest('.toggle-group') : null;
  if (grp) grp.classList.toggle('hmi-hidden', learning);
}

/* ---- 계통도 루프 주석 (캐스케이드 모드) ----
 * 기존 SVG(buildPID)는 건드리지 않고, 이 모드에서만 주석 그룹을 덧붙였다가
 * 모드를 벗어나면 통째로 지운다 — 다른 모드와 전체 보기에는 흔적이 남지 않는다. */
const SVG_NS = 'http://www.w3.org/2000/svg';
function applyLoopAnnotation(mode) {
  const svg = document.getElementById('pid');
  if (!svg) return;
  const old = svg.querySelector('#loopAnnot');
  if (old) old.remove();
  if (!mode.loopAnnotation || !mode.impl || mode.id === 'full') return;

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('id', 'loopAnnot');
  const box = (x, y, w, h, color) => {
    const r = document.createElementNS(SVG_NS, 'rect');
    Object.entries({ x, y, width: w, height: h, rx: 8, fill: 'none', stroke: color,
      'stroke-width': 1.5, 'stroke-dasharray': '6 4' }).forEach(([k, v]) => r.setAttribute(k, v));
    return r;
  };
  const text = (x, y, t, color) => {
    const e = document.createElementNS(SVG_NS, 'text');
    e.setAttribute('x', x); e.setAttribute('y', y); e.setAttribute('fill', color);
    e.setAttribute('font-size', '12'); e.setAttribute('font-weight', '700');
    e.textContent = t;
    return e;
  };
  const cA = token('--hmi-a-strong', '#06b6d4');
  const cB = token('--hmi-b-strong', '#f97316');
  // 내부루프: 펌프 3대와 그 토출 유량(유량계) 구간 — 100ms 주기
  g.appendChild(box(150, 205, 140, 215, cA));
  g.appendChild(text(150, 200, '내부루프 100ms — 유량 → 펌프속도', cA));
  // 외부루프: 공급온도 계측 지점 — 1000ms 주기
  g.appendChild(box(600, 115, 200, 45, cB));
  g.appendChild(text(600, 110, '외부루프 1000ms — 온도 → 유량SP', cB));
  svg.appendChild(g);
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
  // 멈춘다. 한 박자 양보해 상태 표시를 먼저 그린 뒤 실행한다.
  // requestAnimationFrame을 쓰면 안 된다 — 브라우저 탭이 백그라운드일 때는
  // rAF 콜백이 발화하지 않아 실행이 영영 시작되지 않고 "실행 중"에서 멈춘다.
  setTimeout(() => {
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
  }, 16);
}

/* ---------------------------- 결과 렌더 ---------------------------- */
function fmtVal(v, digits, nullLabel) {
  if (v == null) return nullLabel || '미회복';
  if (digits == null) return String(v);
  return Number(v).toFixed(digits);
}

function cellHTML(cell, digits, unit, paramsAreDefault, nullLabel) {
  const measured = fmtVal(cell.measured, digits, nullLabel);
  if (!cell.hasBaseline) {
    return `<span class="hmi-num">${measured}${unit}</span>
      <span class="hmi-sub">기준 실행 : — (검증 스위트 미수록)</span>`;
  }
  const base = fmtVal(cell.baseline, digits, nullLabel);
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
      <td>${cellHTML(r.a, r.digits, unit, def, r.nullLabel)}</td>
      <td>${cellHTML(r.b, r.digits, unit, def, r.nullLabel)}</td>
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
/* 선 스타일 —
 *   안(案)은 색상으로: A=시안 계열 실선, B=주황 계열 파선
 *   축은 톤·굵기로: 좌축(주 지표)=진한 톤 2.5px, 우축(보조 지표)=옅은 톤 1.5px
 *   기준선(SP·임계·관리한계)=회색 점선, A/B 색을 쓰지 않는다
 * 범례 라벨에는 항상 (좌)/(우)를 붙여 어느 축을 읽어야 하는지 밝힌다. */
const W_MAIN = 2.5, W_SUB = 1.5;
const DASH_B = [6, 4], DASH_REF = [2, 4];

function sA(axis) { // A안
  return axis === 'y1'
    ? { yAxisID: 'y1', borderColor: 'A_SOFT', pointRadius: 0, borderWidth: W_SUB }
    : { yAxisID: 'y', borderColor: 'A_STRONG', pointRadius: 0, borderWidth: W_MAIN };
}
function sB(axis) { // B안
  return axis === 'y1'
    ? { yAxisID: 'y1', borderColor: 'B_SOFT', pointRadius: 0, borderWidth: W_SUB, borderDash: DASH_B }
    : { yAxisID: 'y', borderColor: 'B_STRONG', pointRadius: 0, borderWidth: W_MAIN, borderDash: DASH_B };
}
function sRef(axis) {
  return { yAxisID: axis || 'y', borderColor: 'REF', pointRadius: 0, borderWidth: 1, borderDash: DASH_REF };
}
function sNeutral(axis) {
  return { yAxisID: axis || 'y', borderColor: 'NEUTRAL', pointRadius: 0, borderWidth: W_SUB };
}
// 색 이름을 실제 토큰 값으로 바꾼다(Chart.js는 캔버스에 그려 CSS 변수를 못 읽는다).
function resolveColors(datasets, c) {
  datasets.forEach(d => {
    const map = { A_STRONG: c.aStrong, A_SOFT: c.aSoft, B_STRONG: c.bStrong, B_SOFT: c.bSoft,
                  REF: c.ref, NEUTRAL: c.neutral };
    if (typeof d.borderColor === 'string' && map[d.borderColor]) d.borderColor = map[d.borderColor];
  });
  return datasets;
}

/* 각 모드에서 실제로 봐야 할 계열만 남긴다 — 모든 모드에 10개씩 띄우면 범례가
 * 그림보다 커지고 무엇을 보라는 것인지 알 수 없다. 전체 보기 탭의 기존 트렌드
 * 차트는 손대지 않으므로 거기서는 종전대로 전부 보인다. */
const CHART_SPECS = {
  hysteresis: {
    // 히스테리시스는 온도가 아니라 속도지령과 투입 대수에서 나타나는 현상이다.
    // 속도지령은 A·B가 공유하므로 어느 안의 것도 아니다 → 중립 회색.
    // A·B는 각각 계열이 하나뿐이라 축으로 더 나눌 필요가 없어 둘 다 주 스타일을 쓴다.
    xTitle: '시뮬레이션 시간 (s)', yTitle: '펌프 속도지령 (%)', y1Title: '투입 대수',
    build: (a, b, c, labels, extra) => [
      { label: '속도지령 (좌) — A·B 공통', data: a.trace.speedCmd, ...sNeutral('y') },
      { label: `투입 임계 ${extra.upPct}% · 15초 유지 (좌)`, data: labels.map(() => extra.upPct), ...sRef('y') },
      { label: `해제 임계 ${extra.downPct}% · 30초 유지 (좌)`, data: labels.map(() => extra.downPct), ...sRef('y') },
      { label: 'A · 투입 대수 (우) — 히스테리시스 적용', data: a.trace.count,
        ...sA('y'), yAxisID: 'y1', stepped: true },
      { label: 'B · 투입 대수 (우) — 히스테리시스 없음', data: b.trace.count,
        ...sB('y'), yAxisID: 'y1', stepped: true },
    ],
  },
  antiwindup: {
    xTitle: '시뮬레이션 시간 (s)', yTitle: '공급온도 (°C)', y1Title: '외부루프 적분항',
    build: (a, b, c, labels) => [
      { label: 'A · 공급온도 (좌) — anti-windup ON', data: a.trace.temp, ...sA('y') },
      { label: 'B · 공급온도 (좌) — anti-windup OFF', data: b.trace.temp, ...sB('y') },
      { label: 'SP (좌)', data: labels.map(() => a.meta.sp), ...sRef('y') },
      { label: 'A · 적분항 (우)', data: a.trace.integral, ...sA('y1') },
      { label: 'B · 적분항 (우)', data: b.trace.integral, ...sB('y1') },
    ],
  },
  cascade: {
    xTitle: '시뮬레이션 시간 (s)', yTitle: '공급온도 (°C)', y1Title: '유량 SP (m³/h)',
    build: (a, b, c, labels) => [
      { label: 'A · 공급온도 (좌) — 캐스케이드', data: a.trace.temp, ...sA('y') },
      { label: 'B · 공급온도 (좌) — 단일루프', data: b.trace.temp, ...sB('y') },
      { label: 'SP (좌)', data: labels.map(() => a.meta.sp), ...sRef('y') },
      { label: 'A · 유량 SP (우)', data: a.trace.flowSp, ...sA('y1') },
      { label: 'B · 유량 SP (우)', data: b.trace.flowSp, ...sB('y1') },
    ],
  },
  interlock: {
    xTitle: '기동 후 경과 시간 (s)', yTitle: '모선전압 (%)', y1Title: '기동전류 (%FLA)',
    build: (a, b, c, labels, extra) => {
      const ds = [
        { label: 'A · 모선전압 (좌) — 인터록 준수', data: a.trace.volt, ...sA('y') },
        { label: 'B · 모선전압 (좌) — 인터록 우회', data: b.trace.volt, ...sB('y') },
        { label: `관리한계 ${extra.floorPct}% (좌)`, data: labels.map(() => extra.floorPct), ...sRef('y') },
        { label: 'A · 기동전류 (우)', data: a.trace.curr, ...sA('y1') },
        { label: 'B · 기동전류 (우)', data: b.trace.curr, ...sB('y1') },
      ];
      // ESS 투입 시점은 시각 하나짜리 값이라 선으로 그릴 수 없어 점 마커로 찍는다.
      // x는 기동 시작을 0으로 둔 경과시간이다(시뮬레이션 절대시각이 아니다).
      if (extra.essB != null) {
        const xi = nearestIndex(a.trace.t, extra.essB);
        ds.push({ label: `B · ESS 투입 (좌) — 기동 후 ${extra.essB.toFixed(3)}s`,
          data: labels.map((_, i) => (i === xi ? 100 : null)), borderColor: 'B_STRONG',
          pointRadius: labels.map((_, i) => (i === xi ? 6 : 0)), pointStyle: 'triangle',
          yAxisID: 'y', borderWidth: 0, showLine: false, spanGaps: false });
      }
      return ds;
    },
  },
  failover: {
    // 세 대가 모두 같은 좌축에 놓이므로 축으로는 못 가른다. 대신 절체 대상인
    // P-1을 주 스타일(진한·굵은)로, 보상하는 나머지 두 대를 옅은·얇은 선으로
    // 둬서 같은 안 안에서도 무엇을 먼저 볼지가 드러나게 했다.
    xTitle: '시뮬레이션 시간 (s)', yTitle: '펌프 속도 (%)', y1Title: null,
    build: (a, b, c) => {
      const ds = [];
      ds.push({ label: 'A · P-1 속도 (좌) — VFD', data: a.trace.speeds[0], ...sA('y') });
      [1, 2].forEach(i => ds.push({ label: `A · P-${i + 1} 속도 (좌) — VFD`, data: a.trace.speeds[i],
        ...sA('y1'), yAxisID: 'y' }));
      ds.push({ label: `B · P-1 속도 (좌) — ${b.trace.feedModes[0]} 고정`, data: b.trace.speeds[0], ...sB('y') });
      [1, 2].forEach(i => ds.push({ label: `B · P-${i + 1} 속도 (좌) — ${b.trace.feedModes[i]}`, data: b.trace.speeds[i],
        ...sB('y1'), yAxisID: 'y' }));
      return ds;
    },
  },
  sensor: {
    xTitle: '시뮬레이션 시간 (s)', yTitle: '공급온도 (°C)', y1Title: '참값 − 측정값 편차 (°C)',
    build: (a, b, c, labels, extra) => {
      const dev = (run) => run.trace.trueV.map((v, i) => Math.abs(v - run.trace.measV[i]));
      // 참값과 측정값은 둘 다 같은 좌축·같은 B안이라 축 규칙만으로는 갈리지
      // 않는다(그대로 두면 우축 편차선과도 색·굵기가 겹친다). 이 한 곳만
      // 파선 패턴으로 추가 구분한다 — 참값은 긴 파선, 측정값은 촘촘한 점선.
      return [
        { label: 'B · 참값 (좌) — 열화 센서', data: b.trace.trueV, ...sB('y'), borderDash: [10, 4] },
        { label: 'B · 측정값 (좌) — 열화 센서', data: b.trace.measV, ...sB('y'), borderWidth: 2, borderDash: [2, 3] },
        { label: 'A · 편차 (우) — 열화 없음', data: dev(a), ...sA('y1') },
        { label: 'B · 편차 (우) — 열화 센서', data: dev(b), ...sB('y1') },
        { label: `판정 임계 ${extra.thresholdC ?? 1.0}°C (우)`, data: labels.map(() => extra.thresholdC ?? 1.0), ...sRef('y1') },
      ];
    },
  },
};

function nearestIndex(arr, target) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - target);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function drawChart(result) {
  const canvas = document.getElementById('benchChart');
  const spec = CHART_SPECS[result.modeId];
  if (!canvas || typeof Chart === 'undefined' || !spec) return;
  if (benchChart) { benchChart.destroy(); benchChart = null; }

  const [a, b] = result.runs;
  const labels = a.trace.t.map(t => t.toFixed(0));
  // A안=밝은 시안 실선, B안=주황 파선으로 6개 모드 전부 고정한다.
  // neutral은 A·B가 공유하는 계열(히스테리시스의 속도지령)에만 쓴다.
  const c = {
    aStrong: token('--hmi-a-strong', '#06b6d4'), aSoft: token('--hmi-a-soft', '#a5f3fc'),
    bStrong: token('--hmi-b-strong', '#f97316'), bSoft: token('--hmi-b-soft', '#fdba74'),
    ref: token('--hmi-trace-ref', '#8b97a8'),
    neutral: token('--hmi-g5', '#c9d6e3'),
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
    data: { labels, datasets: resolveColors(spec.build(a, b, c, labels, result.extra || {}), c) },
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
