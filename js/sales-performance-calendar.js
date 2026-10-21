// Officeホームの月間カレンダーを参考にしたSalesメンバー別実績。
// 元データは /api/sales/member-performance（権限別集計・JST日付）。画面では再集計して水増ししない。
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.SalesLayout.esc(s);
  const dateJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const dateOf = (s) => new Date(s + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (day, n) => { const d = dateOf(day); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const shift = (ym, n) => { const d = dateOf(ym + "-01"); d.setUTCMonth(d.getUTCMonth() + n); return iso(d).slice(0, 7); };
  const diffMonth = (a, b) => (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12 + Number(a.slice(5, 7)) - Number(b.slice(5, 7));
  const state = { ym: dateJst().slice(0, 7), today: dateJst(), metric: "sent", day: dateJst(), data: null, seq: 0 };
  const DOW = ["月", "火", "水", "木", "金", "土", "日"];
  let ready = false;

  function init() {
    if (!$("sp-calendar") || ready) return;
    ready = true;
    $("sp-metric").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-metric]");
      if (!btn || !state.data?.metrics?.some((m) => m.key === btn.dataset.metric)) return;
      state.metric = btn.dataset.metric;
      render();
    });
    load();
  }

  function monthMove(n) {
    const next = n ? shift(state.ym, n) : state.today.slice(0, 7);
    const delta = diffMonth(next, state.today.slice(0, 7));
    if (delta < -24 || delta > 1) return;
    state.ym = next;
    state.day = (next === state.today.slice(0, 7) ? state.today : next + "-01");
    load();
  }
  function selectDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    if (day.slice(0, 7) !== state.ym) { state.ym = day.slice(0, 7); state.day = day; load(); return; }
    state.day = day;
    renderCalendar(); renderDay();
  }
  async function load() {
    const my = ++state.seq;
    $("sp-month").textContent = state.ym.slice(0, 4) + "年" + Number(state.ym.slice(5, 7)) + "月";
    $("sp-notice").textContent = "実績を集計しています…";
    $("sp-calendar").innerHTML = '<div class="sl-empty">読み込み中…</div>';
    $("sp-member").innerHTML = "";
    try {
      // salesホームの他の一覧の読込みと独立。実績APIが失敗しても通常業務は止まらない。
      const d = await window.API.api("/api/sales/member-performance?month=" + encodeURIComponent(state.ym));
      if (my !== state.seq) return;
      state.data = d;
      if (!d.metrics?.some((m) => m.key === state.metric)) state.metric = "sent";
      render();
    } catch (e) {
      if (my !== state.seq) return;
      state.data = null;
      $("sp-notice").textContent = e.hint || e.detail || e.message || "集計できませんでした。時間をおいて再読み込みしてください";
      $("sp-calendar").innerHTML = '<div class="sl-empty">実績を表示できません</div>';
      $("sp-tiles").innerHTML = "";
      $("sp-metric").innerHTML = "";
      $("sp-member").innerHTML = "";
      $("sp-day").innerHTML = "";
      if ($("sp-mini-tiles")) $("sp-mini-tiles").innerHTML =
        '<div class="db-mini-loading">実績を読み込めませんでした。実績タブで再確認してください。</div>';
      if ($("sp-mini-members")) $("sp-mini-members").innerHTML = "";
      renderNav();
    }
  }
  function renderNav() {
    $("sp-month").textContent = state.ym.slice(0, 4) + "年" + Number(state.ym.slice(5, 7)) + "月";
    const relative = diffMonth(state.ym, state.today.slice(0, 7));
    $("sp-prev").disabled = relative <= -24;
    $("sp-next").disabled = relative >= 1;
    $("sp-today").disabled = relative === 0;
  }
  const count = (v) => Number(v || 0).toLocaleString("ja-JP");
  const countMetric = (row, key) => Number(row?.[key] || 0);
  const monthLabel = (day) => Number(day.slice(5, 7)) + "/" + Number(day.slice(8, 10));
  const maxFor = (key) => Math.max(1, ...(state.data?.members || []).map((x) => countMetric(x.totals, key)));

  function render() {
    if (!state.data) return;
    const d = state.data;
    renderNav();
    renderCompact();
    $("sp-notice").textContent = d.note || "";
    $("sp-role-note").textContent = d.manager
      ? "全員の実績です。CS担当・クロージング担当を変更しても過去の実施者の数字は残ります。"
      : "自分の実績です。チーム全体の数字はSales管理者のみ確認できます。";
    $("sp-tiles").innerHTML = d.metrics.map((m) => '<button type="button" class="sp-tile' +
      (m.key === state.metric ? " selected" : "") + '" onclick="SalesPerformanceCalendar.choose(\'' + m.key + '\')">' +
      '<span>' + esc(m.label) + '</span><strong>' + count(d.totals[m.key]) + '</strong><small>' + esc(m.unit) + '</small></button>').join("");
    $("sp-metric").innerHTML = d.metrics.map((m) => '<button type="button" data-metric="' + m.key + '"' +
      (m.key === state.metric ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + esc(m.short) + '</button>').join("");
    $("sp-definition").textContent = d.definitions?.[state.metric] || "";
    renderCalendar();
    renderMembers();
    renderDay();
  }

  // 初期タブでは4つの数字と上位6人だけ。Office風の月間カレンダーと9指標は実績タブで閲覧する。
  function renderCompact() {
    const d = state.data;
    if (!d || !$("sp-mini-tiles")) return;
    const keys = ["attacks", "sent", "connected", "won"];
    const names = { attacks: "フォーム送信", sent: "提案送信", connected: "企業接続", won: "成約" };
    const units = { attacks: "件", sent: "件", connected: "件", won: "件" };
    $("sp-mini-tiles").innerHTML = keys.map((k) =>
      '<div class="db-mini-tile"><span>' + names[k] + '</span><strong>' +
      count(d.totals?.[k]) + '</strong><small>' + units[k] + '</small></div>').join("");
    const members = [...(d.members || [])].sort((a, b) => {
      const score = (r) => countMetric(r.totals, "sent") + countMetric(r.totals, "connected")
        + countMetric(r.totals, "won");
      return score(b) - score(a) || String(a.name).localeCompare(String(b.name), "ja");
    });
    const cols = ["sent", "connected", "won"];
    $("sp-mini-members").innerHTML =
      '<b>' + (d.manager ? "メンバー別の実績" : "自分の実績") + '</b>' +
      '<div class="db-mini-member head"><span class="nm">名前</span>' +
      '<span>提案</span><span>接続</span><span>成約</span></div>' +
      (members.slice(0, 6).map((r) => '<div class="db-mini-member"><span class="nm" title="' +
        esc(r.name) + '">' + esc(r.name) + '</span>' +
        cols.map((k) => '<span>' + countMetric(r.totals, k) + '</span>').join("") + '</div>').join("") ||
        '<p class="sl-empty">表示できる実績はありません</p>') +
      (members.length > 6 ? '<p class="db-mini-note">ほか' + (members.length - 6) +
        '名の実績は詳細で確認できます。</p>' : "");
    $("sp-mini-note").textContent = Number(state.ym.slice(5, 7)) +
      "月の記録から集計（日本時間）。詳細では電話・引継ぎ・面談も確認できます。";
  }

  function choose(metric) {
    if (!state.data?.metrics.some((m) => m.key === metric)) return;
    state.metric = metric; render();
  }

  function renderCalendar() {
    const d = state.data;
    if (!d) return;
    const first = state.ym + "-01";
    const offset = (dateOf(first).getUTCDay() + 6) % 7;
    const start = addDays(first, -offset);
    // 必要な週数だけ作る。6週固定の余分な空白を防ぐ。
    const [year, month] = state.ym.split("-").map(Number);
    const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const cellCount = Math.ceil((offset + monthDays) / 7) * 7;
    const days = Array.from({ length: cellCount }, (_, i) => addDays(start, i));
    // 日付の下に選択した指標の数字と、実施した人の名前を表示
    const cell = (day) => {
      const total = countMetric(d.days?.[day], state.metric);
      const out = day.slice(0, 7) !== state.ym;
      const off = [5, 6].includes((dateOf(day).getUTCDay() + 6) % 7);
      const active = (d.members || []).filter((m) => countMetric(m.days?.[day], state.metric) > 0)
        .sort((a, b) => countMetric(b.days?.[day], state.metric) - countMetric(a.days?.[day], state.metric));
      return '<button type="button" class="sp-day' +
        (out ? " outside" : "") + (off ? " weekend" : "") + (day === state.today ? " today" : "") +
        (day === state.day ? " selected" : "") + '" onclick="SalesPerformanceCalendar.selectDay(\'' + day + '\')" ' +
        'aria-label="' + esc(day + ' ' + (d.metrics.find((m) => m.key === state.metric)?.label || "") + ' ' + total + '件') + '">' +
        '<span class="sp-day-num">' + Number(day.slice(8, 10)) + '</span>' +
        (total ? '<strong>' + count(total) + '<small>件</small></strong>' : '<span class="sp-zero">—</span>') +
        (!out && active.length ? '<span class="sp-day-names">' + esc(active.slice(0, 2).map((x) => x.name).join("・")) +
          (active.length > 2 ? ' ほか' + (active.length - 2) + '名' : '') + '</span>' : '') +
        '</button>';
    };
    $("sp-calendar").innerHTML = '<div class="sp-week-head">' + DOW.map((w) => '<span>' + w + '</span>').join("") +
      '</div><div class="sp-grid">' + days.map(cell).join("") + '</div>';
    const thisMonthDays = days.filter((day) => day.slice(0, 7) === state.ym);
    $("sp-mobile-days").innerHTML = thisMonthDays.map((day) =>
      '<button type="button" class="' + (day === state.day ? "on" : "") +
      '" onclick="SalesPerformanceCalendar.selectDay(\'' + day + '\')"><small>' +
      DOW[(dateOf(day).getUTCDay() + 6) % 7] + '</small><b>' + Number(day.slice(8, 10)) + '</b><i>' +
      (countMetric(d.days?.[day], state.metric) || "—") + '</i></button>').join("");
  }

  function renderMembers() {
    const d = state.data;
    if (!d) return;
    const key = state.metric, mx = maxFor(key);
    const rows = [...(d.members || [])].sort((a, b) => countMetric(b.totals, key) - countMetric(a.totals, key) ||
      String(a.name).localeCompare(String(b.name), "ja"));
    const heads = d.metrics.map((m) => '<th class="' + (m.key === key ? "sp-active-col" : "") +
      '" title="' + esc(d.definitions?.[m.key] || "") + '">' + esc(m.short) + '</th>').join("");
    $("sp-member").innerHTML = '<div class="sp-table-scroll"><table class="sl-table sp-table"><thead><tr>' +
      '<th>担当者</th>' + heads + '</tr></thead><tbody>' +
      rows.map((r) => '<tr><td><b>' + esc(r.name) + '</b>' +
        (r.role?.length ? '<small>' + esc(r.role.join("・")) + '</small>' : '') +
        '<span class="sp-bar"><i style="width:' + Math.round(100 * countMetric(r.totals, key) / mx) + '%"></i></span></td>' +
        d.metrics.map((m) => '<td class="sp-n' + (m.key === key ? " sp-active-col" : "") + '">' +
          countMetric(r.totals, m.key) + '</td>').join("") + '</tr>').join("") +
      '<tr class="sp-total"><td>合計</td>' + d.metrics.map((m) =>
        '<td class="sp-n' + (m.key === key ? " sp-active-col" : "") + '">' + count(d.totals[m.key]) + '</td>').join("") +
      '</tr></tbody></table></div>' +
      (!rows.length ? '<div class="sl-empty">この月の実績はありません</div>' : '');
  }

  function renderDay() {
    const d = state.data;
    if (!d) return;
    const day = state.day?.slice(0, 7) === state.ym ? state.day : state.ym + "-01";
    const metric = d.metrics.find((m) => m.key === state.metric);
    const memberRows = (d.members || []).filter((r) => countMetric(r.days?.[day], state.metric))
      .sort((a, b) => countMetric(b.days?.[day], state.metric) - countMetric(a.days?.[day], state.metric));
    const total = countMetric(d.days?.[day], state.metric);
    $("sp-day").innerHTML = '<h3>' + monthLabel(day) + '（' + DOW[(dateOf(day).getUTCDay() + 6) % 7] + '）' +
      '　' + esc(metric?.label || "") + '：' + count(total) + esc(metric?.unit || "件") + '</h3>' +
      (memberRows.length ? memberRows.map((r) =>
        '<div class="sp-member-day"><b>' + esc(r.name) + '</b><strong>' + countMetric(r.days?.[day], state.metric) +
        '<small>' + esc(metric?.unit || "件") + '</small></strong></div>').join("") :
        '<p class="sl-empty">この日の該当実績はありません。</p>');
  }

  window.SalesPerformanceCalendar = { init, monthMove, selectDay, choose };
}());
