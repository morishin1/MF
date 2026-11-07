// KEIEI > 人・組織 > 日報まとめ。毎週の会議で既存データを見ながら話すための読み取り専用画面。
// 氏名・本人の振り返り・相談内容は owner 専用 /api/keiei?view=weekly から取得する。
(() => {
  "use strict";
  let root = null;
  let isStale = () => false;
  let data = null;
  let selected = null;
  let loadingSeq = 0;
  const filters = { department: "", review: "", query: "", discuss: false };
  const esc = (s) => KeieiLayout.esc(String(s ?? ""));
  const mondayOf = (date) => {
    const d = new Date(date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  };
  const addDays = (s, n) => {
    const d = new Date(s + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const pct = (n) => n == null ? "記録なし" : n + "%";
  const symbol = (s) => s === "filled" ? "記入済" : s === "partial" ? "一部記入" : "未記入";
  const cleanText = (s) => (typeof s === "string" && s.trim()) ? esc(s.trim()) : '<span class="kw-empty">記入なし</span>';
  const paragraph = (s) => '<div class="kw-note-text">' + cleanText(s) + "</div>";
  const stat = (label, value, detail = "") => '<div class="kw-stat"><span>' + esc(label)
    + '</span><strong>' + esc(value) + '</strong><small>' + esc(detail) + "</small></div>";
  const listNotes = (items, pick, empty) => items.length
    ? items.map((it) => '<div class="kw-log"><span>' + esc(it.date || "") + '</span><div>' + pick(it) + "</div></div>").join("")
    : '<p class="kw-empty">' + esc(empty) + "</p>";

  function installStyle() {
    if (document.getElementById("kw-style")) return;
    const style = document.createElement("style");
    style.id = "kw-style";
    style.textContent = `
      .kw-page { color: var(--k-ink,#1b2440); }
      .kw-heading { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:10px; margin:0 0 14px; }
      .kw-heading h1 { font-size:23px; margin:0 0 5px; }
      .kw-heading p { color:var(--k-mute,#6b7080); font-size:12.5px; margin:0; line-height:1.7; }
      .kw-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
      .kw-tools label { font-size:12px; color:var(--k-mute,#6b7080); }
      .kw-tools input,.kw-controls input,.kw-controls select { width:auto; max-width:100%; padding:8px 10px; border:1px solid #d7dce4; border-radius:8px; background:#fff; color:#1b2440; font-size:13px; }
      .kw-tools button,.kw-copy { cursor:pointer; padding:8px 12px; border:1px solid #d7dce4; border-radius:8px; background:#fff; color:#1b2440; font-size:12.5px; font-weight:700; }
      .kw-tools button:disabled { opacity:.38; cursor:default; }
      .kw-stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:9px; margin:12px 0 14px; }
      .kw-stat { background:#fff; border:1px solid #e2e5ea; border-radius:11px; padding:12px 13px; min-width:0; }
      .kw-stat span,.kw-stat small { display:block; color:#6b7080; font-size:11px; line-height:1.5; }
      .kw-stat strong { display:block; font-size:24px; margin:4px 0 1px; line-height:1.3; font-variant-numeric:tabular-nums; }
      .kw-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
      .kw-controls input[type=search] { flex:1; min-width:150px; }
      .kw-controls label { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:#4f5665; white-space:nowrap; }
      .kw-controls input[type=checkbox] { width:auto; }
      .kw-board { display:grid; grid-template-columns:minmax(240px, 34%) minmax(0,1fr); align-items:start; gap:12px; }
      .kw-roster,.kw-detail { border:1px solid #e2e5ea; border-radius:12px; background:#fff; min-width:0; overflow:hidden; }
      .kw-roster-head { padding:12px 14px; background:#f6f8fb; border-bottom:1px solid #e2e5ea; font-size:12.5px; font-weight:700; }
      .kw-roster-items { max-height:760px; overflow-y:auto; }
      .kw-person { display:block; width:100%; text-align:left; padding:12px 13px; background:#fff; border:0; border-bottom:1px solid #f0f1f3; cursor:pointer; color:#1b2440; }
      .kw-person:hover,.kw-person.on { background:#f1f6ff; }
      .kw-person.on { box-shadow:inset 3px 0 0 #3065c3; }
      .kw-person-top { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:13px; }
      .kw-person-sub { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:#6b7080; font-size:11.5px; margin-top:6px; }
      .kw-tag { font-size:10.5px; border-radius:20px; padding:3px 8px; background:#f1f3f6; color:#586070; white-space:nowrap; }
      .kw-tag.filled { background:#eaf5ec; color:#286d3e; }
      .kw-tag.partial { background:#fff4d9; color:#8b6000; }
      .kw-tag.missing { background:#f5f5f5; color:#696969; }
      .kw-detail-in { padding:18px; }
      .kw-member-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; border-bottom:1px solid #edf0f3; padding-bottom:13px; }
      .kw-member-head h2 { font-size:20px; margin:0 0 4px; }
      .kw-member-head p { font-size:12px; color:#6b7080; margin:0; }
      .kw-person-kpis { display:flex; gap:16px; flex-wrap:wrap; padding:13px 0; font-size:12px; }
      .kw-person-kpis strong { font-size:15px; margin-left:4px; }
      .kw-discuss { background:#f6f8fc; padding:14px; border-radius:10px; margin:4px 0 18px; border:1px solid #e3e9f5; }
      .kw-discuss h3 { margin:0 0 9px; font-size:14px; }
      .kw-discuss ol { margin:0 0 0 19px; padding:0; font-size:13px; line-height:1.75; }
      .kw-discuss li + li { margin-top:5px; }
      .kw-section-title { font-size:14px; margin:18px 0 9px; }
      .kw-qa { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
      .kw-qa article { border:1px solid #e2e5ea; border-radius:9px; padding:12px; min-width:0; }
      .kw-qa h4 { font-size:12px; color:#4f5870; margin:0 0 7px; }
      .kw-note-text { line-height:1.7; font-size:13px; white-space:pre-wrap; overflow-wrap:anywhere; }
      .kw-empty { color:#8e929c; font-size:12px; }
      .kw-before { padding:11px 13px; background:#fbf9f3; border:1px solid #f0e9d9; border-radius:9px; }
      .kw-before h4 { font-size:12px; margin:0 0 6px; }
      .kw-before h4:not(:first-child) { margin-top:13px; }
      .kw-logs { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:11px; }
      .kw-logs section { background:#fff; padding:12px; border:1px solid #e2e5ea; border-radius:9px; min-width:0; }
      .kw-logs h4 { font-size:12px; margin:0 0 7px; }
      .kw-log { display:flex; gap:10px; padding:7px 0; border-bottom:1px solid #f1f2f4; font-size:12px; line-height:1.6; }
      .kw-log:last-child { border-bottom:0; }
      .kw-log > span { white-space:nowrap; color:#828b9a; font-size:10.5px; padding-top:2px; }
      .kw-log > div { min-width:0; overflow-wrap:anywhere; }
      .kw-detail-foot { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin-top:16px; font-size:12px; }
      .kw-detail-foot a { color:#2757a9; }
      .kw-footnote { color:#717988; font-size:11.5px; line-height:1.7; margin:13px 0; }
      /* 通常操作は上部バーと右側1パネルに限定する。根拠原文は必要な時だけ展開。 */
      .kw-stats { gap:6px; margin:5px 0 9px; }
      .kw-stat { padding:8px 10px; }
      .kw-stat strong { font-size:18px; margin:2px 0 0; }
      .kw-stat small { font-size:10px; }
      .kw-controls { margin-bottom:8px; }
      .kw-board { grid-template-columns:minmax(220px,28%) minmax(0,1fr); gap:10px; }
      .kw-workspace { min-width:0; }
      .kw-roster-items { max-height:555px; }
      .kw-person { padding:9px 12px; }
      .kw-detail-in { padding:13px 16px; }
      .kw-member-head { padding-bottom:8px; }
      .kw-member-head h2 { font-size:18px; }
      .kw-person-kpis { gap:12px; padding:9px 0; }
      .kw-evidence { border:1px solid #e3e9f0; border-radius:9px; margin:12px 0 0; overflow:hidden; }
      .kw-evidence summary { cursor:pointer; list-style-position:inside; background:#f8fafc; color:#35537a; font-size:12.5px; font-weight:700; padding:11px 12px; }
      .kw-evidence summary:hover { background:#f0f5fd; }
      .kw-evidence summary small { font-weight:400; color:#718096; margin-left:9px; }
      .kw-evidence-body { padding:10px 12px; max-height:500px; overflow-y:auto; }
      .kw-evidence .kw-discuss { margin-bottom:12px; }
      .kw-evidence .kw-section-title { margin-top:14px; }
      .kw-detail-foot { margin-top:10px; }
      @media(max-width:1050px) { .kw-stats { grid-template-columns:repeat(3,minmax(0,1fr)); } }
      @media(max-width:750px) { .kw-board { grid-template-columns:1fr; } .kw-roster-items { max-height:190px; } .kw-stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .kw-qa,.kw-logs { grid-template-columns:1fr; } .kw-detail-in { padding:13px; } .kw-evidence-body { max-height:380px; } }
    `;
    document.head.appendChild(style);
  }

  const filtered = () => (data?.members || []).filter((m) => {
    if (filters.department && m.department !== filters.department) return false;
    if (filters.review && m.reviewStatus !== filters.review) return false;
    if (filters.discuss && !m.needsDiscussion) return false;
    const needle = filters.query.trim().toLocaleLowerCase();
    return !needle || (m.name + " " + m.department).toLocaleLowerCase().includes(needle);
  }).sort((a, b) => Number(b.needsDiscussion) - Number(a.needsDiscussion)
      || a.department.localeCompare(b.department, "ja") || a.name.localeCompare(b.name, "ja"));

  function renderList() {
    if (!root || !data || isStale()) return;
    const rows = filtered();
    const total = root.querySelector("#kw-list-count");
    const box = root.querySelector("#kw-people");
    if (total) total.textContent = rows.length + "人 / 全" + data.members.length + "人";
    if (!box) return;
    box.innerHTML = rows.length ? rows.map((m) => `
      <button type="button" class="kw-person${m.employeeId === selected ? " on" : ""}"
        aria-pressed="${m.employeeId === selected}" onclick="KeieiWeekly.pick('${esc(m.employeeId)}')">
        <span class="kw-person-top"><b>${esc(m.name)}</b><span class="kw-tag ${esc(m.reviewStatus)}">${symbol(m.reviewStatus)}</span></span>
        <span class="kw-person-sub"><span>${esc(m.department)}</span><span>日報 ${m.submittedDays}日</span>
        <span>KGI ${pct(m.kgiRate)}</span>${m.needsDiscussion ? "<span>確認候補</span>" : ""}</span>
      </button>`).join("") : '<div class="kw-detail-in kw-empty">条件に合う社員はいません。</div>';
  }

  const item = (label, text) => '<article><h4>' + esc(label) + "</h4>" + paragraph(text) + "</article>";
  function renderDetail() {
    const box = root?.querySelector("#kw-detail");
    if (!box || !data || isStale()) return;
    const m = data.members.find((x) => x.employeeId === selected);
    if (!m) { box.innerHTML = '<div class="kw-detail-in kw-empty">左の社員を選ぶと、週の成果と振り返りを確認できます。</div>'; window.KeieiWorkflow?.selectMember(null); return; }
    const r = m.review || {};
    const prev = m.previousReview || {};
    const previous = prev.q3 || prev.q4
      ? '<div class="kw-before"><h4>先週決めた改善（実行できたかを確認）</h4>' + paragraph(prev.q3)
        + '<h4>先週設定した今週のKGI・KPI</h4>' + paragraph(prev.q4) + "</div>"
      : '<p class="kw-empty">先週の振り返り記録はありません。</p>';
    box.innerHTML = `<div class="kw-detail-in">
      <div class="kw-member-head"><div><h2>${esc(m.name)}</h2><p>${esc(m.department)} ／ ${symbol(m.reviewStatus)}</p></div>
        <button type="button" class="kw-copy" onclick="KeieiWeekly.copy()">会議用にコピー</button></div>
      <div class="kw-person-kpis">
        <span>日報提出<strong>${m.submittedDays}日</strong></span>
        <span>KGI達成<strong>${m.kgiAchieved}/${m.kgiRecorded}日</strong></span>
        <span>成果記録<strong>${m.resultsCount}件</strong></span>
        ${r.publishedScore == null ? "" : `<span>確定済み週次評価<strong>${r.publishedScore}点</strong></span>`}
      </div>
      <div id="kw-prep-feedback"></div>
      <details class="kw-evidence"><summary>本人の振り返り・日報の根拠を見る <small>先週の約束／日別の記録</small></summary><div class="kw-evidence-body">
      <div class="kw-discuss"><h3>この人と会議で確認すること</h3>
        <ol>${m.topics.map((t) => "<li>" + esc(t) + "</li>").join("")}</ol></div>
      <h3 class="kw-section-title">今週の本人の振り返り</h3>
      <div class="kw-qa">
        ${item("① KGIに貢献した行動", r.q1)}
        ${item("② 数字が伸びた・伸びなかった理由", r.q2)}
        ${item("③ 来週やめる・続ける・試すこと", r.q3)}
        ${item("④ 来週のKGI・KPI", r.q4)}
      </div>
      <h3 class="kw-section-title">先週とのつながり</h3>${previous}
      <h3 class="kw-section-title">日報に残っている根拠（本人申告）</h3>
      <div class="kw-logs">
        <section><h4>日別のKGI目標・実績</h4>${listNotes(m.kgiDays, (it) => (it.goal ? esc(it.goal) + "<div>" : "<div>") + "目標：" + esc(it.target ?? "—") + " ／ 実績：" + esc(it.actual ?? "—") + " ／ 判定：" + (it.achieved == null ? "未記録" : it.achieved ? "達成" : "未達") + "</div>", "数値・KGI判定の記録はありません。")}</section>
        <section><h4>成果・完了 (${m.resultsCount}件)</h4>${listNotes(m.results.slice(0, 8), (it) => esc(it.task) + "<div>" + esc(it.result) + "</div>", "記録された成果はありません。")}</section>
        <section><h4>未完了と理由</h4>${listNotes(m.unfinished.slice(0, 6), (it) => esc(it.task) + "<div>" + esc(it.reason) + "</div>", "未完了理由の記録はありません。")}</section>
        <section><h4>相談・困りごと</h4>${listNotes(m.consultations.slice(0, 6), (it) => esc(it.text), "相談の記録はありません。")}</section>
        <section><h4>改善・学び</h4>${listNotes(m.improvements.slice(0, 6), (it) => esc(it.text), "改善の記録はありません。")}</section>
      </div>
      ${r.publishedComment ? '<h3 class="kw-section-title">公開済みの管理者コメント</h3>' + paragraph(r.publishedComment) : ""}
      </div></details>
      <div class="kw-detail-foot"><a href="/admin-nippo.html">元の日報・勤怠を確認</a><a href="/admin-tasks.html">全員のタスクを確認</a><span id="kw-copy-result" aria-live="polite"></span></div>
    </div>`;
    window.KeieiPrep?.renderEditor(root, selected);
    window.KeieiWorkflow?.selectMember(selected);
  }

  function render() {
    if (!root || !data || isStale()) return;
    const d = data;
    root.innerHTML = `<div class="kw-page">
      <div class="kw-heading">
        <div><h1>日報まとめ｜週の振り返り</h1><p>今週の結果を見て、先週の約束・問題・来週の行動を社員と話すための画面です。</p></div>
        <div class="kw-tools"><button type="button" onclick="KeieiWeekly.shift(-1)">← 前週</button>
          <label for="kw-week">対象週</label>
          <input id="kw-week" type="date" aria-label="対象週を選択" value="${esc(d.weekStart)}" max="${today()}" onchange="KeieiWeekly.choose(this.value)">
          <button type="button" onclick="KeieiWeekly.shift(1)" ${d.weekStart >= mondayOf(today()) ? "disabled" : ""}>次週 →</button>
        </div>
      </div>
      <p class="kw-footnote">対象：${esc(d.weekStart)}〜${esc(d.weekEnd)}${d.weekEnd >= today() ? "（今週進行中。未記入は締切前の可能性があります）" : ""}</p>
      <div class="kw-stats">
        ${stat("対象社員", d.summary.total + "人")}
        ${stat("振り返り記入", d.summary.written + " / " + d.summary.total + "人", "4問すべて " + d.summary.complete + "人")}
        ${stat("未記入", d.summary.notWritten + "人", "勤務予定によって提出日が異なります")}
        ${stat("日報提出", d.summary.submittedDays + "日分", "社員全員の合計")}
        ${stat("KGI達成", pct(d.summary.kgiRate), d.summary.kgiAchieved + " / " + d.summary.kgiRecorded + "記録日")}
      </div>
      <div id="kw-prep-workflow"></div>
      <div class="kw-controls">
        <select aria-label="部署で絞る" onchange="KeieiWeekly.filter('department',this.value)">
          <option value="">部署：すべて</option>
          ${d.departments.map((dep) => '<option value="' + esc(dep) + '"' + (filters.department === dep ? " selected" : "") + ">" + esc(dep) + "</option>").join("")}
        </select>
        <select aria-label="振り返りの記入状態" onchange="KeieiWeekly.filter('review',this.value)">
          <option value="">振り返り：すべて</option>
          ${[["filled","記入済"],["partial","一部記入"],["missing","未記入"]].map(([val, label]) =>
            '<option value="' + val + '"' + (filters.review === val ? " selected" : "") + ">" + label + "</option>").join("")}
        </select>
        <label><input type="checkbox" ${filters.discuss ? "checked" : ""} onchange="KeieiWeekly.filter('discuss',this.checked)"> 確認候補のみ</label>
        <input type="search" placeholder="社員を探す" aria-label="社員を探す" value="${esc(filters.query)}" oninput="KeieiWeekly.filter('query',this.value)">
      </div>
      <div class="kw-board">
        <div class="kw-roster"><div class="kw-roster-head">社員一覧 <span id="kw-list-count"></span></div><div class="kw-roster-items" id="kw-people"></div></div>
        <div class="kw-workspace"><div id="kw-prep-toolbar" class="kw-prep-toolbar"></div><div class="kw-detail" id="kw-detail"></div></div>
      </div>
      <p class="kw-footnote">${esc(d.note)}　数値や記録がない欄は「記録なし」と表示します。振り返りは本人の申告であり、会議で実績を確認してください。</p>
    </div>`;
    window.KeieiPrep?.renderToolbar(root, { from: d.weekStart, to: d.weekEnd, selected });
    window.KeieiWorkflow?.init(root, selected, d.weekStart, d.weekEnd);
    renderList();
    renderDetail();
  }

  async function load(weekStart, initialId = null) {
    if (!root) return;
    const seq = ++loadingSeq;
    root.innerHTML = '<div class="kei-empty">週次の日報・振り返りを読み込み中…</div>';
    try {
      const result = await API.api("/api/keiei?view=weekly&weekStart=" + encodeURIComponent(weekStart));
      if (seq !== loadingSeq || isStale()) return;
      data = result;
      const preferred = initialId || selected;
      selected = result.members.some((m) => m.employeeId === preferred)
        ? preferred
        : (result.members.find((m) => m.needsDiscussion) || result.members[0] || {}).employeeId || null;
      render();
    } catch (e) {
      if (seq !== loadingSeq || isStale()) return;
      if (e.status === 403) { location.replace("/home.html"); return; }
      root.innerHTML = '<div class="kei-empty">週次データを読み込めませんでした。'
        + esc(e.hint || e.message || "通信状態を確認してください") + ' <button type="button" class="kw-copy" onclick="KeieiWeekly.reload()">再読み込み</button></div>';
    }
  }

  async function copy() {
    const m = data?.members?.find((x) => x.employeeId === selected);
    if (!m) return;
    const lines = [
      "【週次振り返り】" + data.weekStart + "〜" + data.weekEnd,
      m.name + "（" + m.department + "）",
      "日報提出：" + m.submittedDays + "日",
      "KGI達成：" + m.kgiAchieved + "/" + m.kgiRecorded + "記録日",
      "成果：" + m.resultsCount + "件",
      "① KGIに貢献した行動\n" + (m.review?.q1 || "未記入"),
      "② 数字の理由\n" + (m.review?.q2 || "未記入"),
      "③ 来週やめる・続ける・試すこと\n" + (m.review?.q3 || "未記入"),
      "④ 来週のKGI・KPI\n" + (m.review?.q4 || "未記入"),
      "先週の改善策\n" + (m.previousReview?.q3 || "記録なし"),
      "会議で確認すること\n" + m.topics.map((t) => "・" + t).join("\n"),
    ];
    const status = root?.querySelector("#kw-copy-result");
    try {
      await navigator.clipboard.writeText(lines.join("\n\n"));
      if (status) status.textContent = "コピーしました";
    } catch {
      if (status) status.textContent = "コピーできませんでした。ブラウザの権限をご確認ください";
    }
  }

  window.KeieiWeekly = {
    open(main, stale, initialId = null) {
      root = main;
      isStale = stale;
      installStyle();
      const start = data?.weekStart || mondayOf(today());
      return load(start, initialId);
    },
    shift(n) {
      if (!data || !window.KeieiPrep?.maySwitch()) return;
      const start = addDays(data.weekStart, n * 7);
      if (start > mondayOf(today())) return;
      load(start);
    },
    choose(d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z"))) return;
      if (!window.KeieiPrep?.maySwitch()) return;
      const start = mondayOf(d);
      if (start > mondayOf(today())) return;
      load(start);
    },
    reload() { load(data?.weekStart || mondayOf(today())); },
    filter(key, value) {
      if (!(key in filters)) return;
      const old = selected;
      filters[key] = value;
      if (!filtered().some((m) => m.employeeId === selected)) {
        if (!window.KeieiPrep?.maySwitch()) return;
        selected = filtered()[0]?.employeeId || null;
      }
      renderList();
      if (old !== selected) renderDetail();
    },
    pick(id) {
      if (!data?.members.some((m) => m.employeeId === id)) return;
      if (!window.KeieiPrep?.maySwitch()) return;
      selected = id;
      history.replaceState(null, "", "#weekly/" + encodeURIComponent(id));
      renderList();
      renderDetail();
    },
    copy,
  };
})();
