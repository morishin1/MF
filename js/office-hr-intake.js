// Office 人事・労務：HRからの引き継ぎ（早期引き渡し〔db/143〕を受けた人。admin-hr.html の上に一覧、開くと右のドロワー）
//
// ■ 何を出すか（サーバ GET/POST /api/hr/office-intakes が正。状態・次にやること・権限は画面で決めない）
//   一覧：候補者・採用区分・希望条件・採用担当・Office担当・状態（9つ）・NEXT ACTION・期限。状態で絞り込む
//   詳細：上に NEXT ACTION と主ボタン1つ。下は折りたたみ（引き継ぎ内容・希望条件・面談の結果・応募書類・採用条件・契約手続き・履歴・その他の操作）
//   面談の結果・希望条件・履歴書／職務経歴書／スキルシートは閲覧専用（HR で登録した原本を見るだけ。再アップロードしない）
// ■ 給与：希望額・会社の給与・条件PDF は、給与を見られる人だけ（サーバが外す）。給与を入れる・条件を確定するのは経営者だけ（can.decideSalary）
// ■ 機能フラグ（HR_OFFICE_INTAKE）OFF のときは何も出さない（API が { enabled:false }）
// ■ 本人へメールは送らない（本人専用URLを発行して手で送り、［送付済みにする］）。通知・Slack も送らない（PR C）
(function () {
  "use strict";
  const OI = {};
  const API_PATH = "/api/hr/office-intakes";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);
  const fmt = (iso) => (iso ? (typeof window.fmtDateTime === "function" ? window.fmtDateTime(iso) : String(iso).replace("T", " ").slice(0, 16)) : "—");
  const ymd = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "—");
  const yen = (n) => (n === null || n === undefined || n === "" ? "" : `${Number(n).toLocaleString("ja-JP")}円`);
  const TERMINAL = ["completed", "withdrawn"];
  const post = (body) => API.api(API_PATH, { method: "POST", body, invalidates: [] });
  let host = null;
  let list = null;
  let filter = "open";
  let cur = null;          // 開いている詳細（GET ?intake= の応答）
  let curId = null;
  let form = null;         // 開いている入力（"offer" | "request" | …）
  let issued = null;       // 発行した本人専用URL（この画面を開いている間だけ。保存しない）

  const STYLE = `
    .oi-card { margin-bottom:14px; border-left:4px solid #2f6fd6; }
    .oi-card .hd { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:14px; color:#1b2440; margin-bottom:8px; }
    .oi-card .hd .n { background:#e5ecfb; color:#2a4fa8; border-radius:999px; padding:1px 9px; font-size:12px; font-weight:700; }
    .oi-card .hd .muted { font-size:12px; }
    .oi-chips { display:flex; gap:6px; flex-wrap:wrap; margin:0 0 6px; }
    .oi-chips button { border:1px solid var(--border, #e2e5ee); background:#fff; color:#1b2440; border-radius:999px; padding:3px 10px; font-size:12px;
      font-family:inherit; cursor:pointer; min-height:30px; }
    .oi-chips button[aria-pressed="true"] { background:#1b2440; color:#fff; border-color:#1b2440; }
    .oi-chips button .c { font-weight:700; margin-left:4px; }
    .oi-chips button[data-zero="1"] { color:#8a8fa3; }
    .oi-row { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:4px 12px; padding:12px 0; border-top:1px solid var(--border, #e2e5ee); align-items:center; }
    .oi-row .who { display:flex; gap:6px; flex-wrap:wrap; align-items:center; min-width:0; }
    .oi-row .who b { font-size:14px; color:#1b2440; }
    .oi-chip { font-size:11px; background:#e7eaf3; color:#1b2440; border-radius:999px; padding:1px 8px; white-space:nowrap; }
    .oi-st { font-size:11px; font-weight:700; border-radius:999px; padding:1px 9px; background:#fff3d6; color:#7d5a00; white-space:nowrap; }
    .oi-st[data-st="not_started"] { background:#fde7e5; color:#b3261e; }
    .oi-st[data-st="preparing_join"], .oi-st[data-st="completed"] { background:#e5f1e2; color:#2f6f3a; }
    .oi-st[data-st="withdrawn"] { background:#eef0f5; color:#4a5068; }
    .oi-row .facts { grid-column:1; font-size:12.5px; color:#1b2440; display:flex; gap:4px 12px; flex-wrap:wrap; min-width:0; overflow-wrap:anywhere; }
    .oi-row .facts.muted { color:var(--muted, #6b7080); font-size:12px; }
    .oi-nx { display:flex; gap:6px 10px; flex-wrap:wrap; align-items:baseline; font-size:13px; color:#1b2440; min-width:0; }
    .oi-nx .k { font-size:10.5px; font-weight:800; letter-spacing:.04em; color:#fff; background:#2f6fd6; border-radius:4px; padding:1px 6px; }
    .oi-nx .muted { font-size:12px; color:var(--muted, #6b7080); }
    .oi-row .oi-nx { grid-column:1; }
    .oi-row .act { grid-column:2; grid-row:1 / span 4; }
    .oi-empty { font-size:13px; color:var(--muted, #6b7080); padding:10px 0; }
    .oi-bg { position:fixed; inset:0; background:rgba(16,22,40,.35); z-index:60; }
    .oi-drawer { position:fixed; top:0; right:0; bottom:0; width:min(620px, 100vw); background:#fff; z-index:61; overflow-y:auto; overflow-x:hidden;
      box-shadow:-8px 0 24px rgba(16,22,40,.18); padding:16px 18px 40px; box-sizing:border-box; }
    .oi-drawer header { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
    .oi-drawer header h2 { font-size:18px; margin:0; color:#1b2440; flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
    .oi-x { border:0; background:none; cursor:pointer; font-size:22px; line-height:1; padding:6px; color:#1b2440; }
    .oi-next { border:1px solid #c9d6f5; background:#f4f7fe; border-radius:10px; padding:12px; margin-bottom:12px; }
    .oi-next .why { font-size:12px; color:#6b7080; margin:6px 0 0; }
    .oi-next .btn { margin-top:8px; }
    .oi-sec { border-top:1px solid var(--border, #e2e5ee); padding:8px 0; }
    .oi-sec > summary { cursor:pointer; font-weight:700; color:#1b2440; font-size:13.5px; padding:4px 0; }
    .oi-dl { display:grid; grid-template-columns:auto minmax(0, 1fr); gap:4px 14px; margin:8px 0 0; font-size:12.5px; }
    .oi-dl dt { color:#6b7080; } .oi-dl dd { margin:0; color:#1b2440; white-space:pre-wrap; overflow-wrap:anywhere; }
    .oi-un { color:#9a5b00; font-weight:700; }
    .oi-ro { font-size:11.5px; color:#6b7080; margin:6px 0 0; }
    .oi-line { font-size:12.5px; padding:6px 0; border-top:1px solid #f0f1f6; display:flex; gap:4px 10px; flex-wrap:wrap; align-items:center; overflow-wrap:anywhere; }
    .oi-line:first-child { border-top:0; }
    .oi-line .sub { color:#6b7080; flex:1 1 100%; white-space:pre-wrap; }
    .oi-line .btn { margin-left:auto; }
    .oi-steps { list-style:none; margin:8px 0; padding:0; font-size:12.5px; }
    .oi-steps li { display:flex; gap:8px; padding:3px 0; }
    .oi-steps li .mk { width:1.4em; text-align:center; font-weight:800; color:#a3a8ba; }
    .oi-steps li[data-st="done"] .mk { color:#2f6f3a; } .oi-steps li[data-st="now"] .mk { color:#b3261e; }
    .oi-steps li[data-st="now"] .lb { font-weight:800; }
    .oi-form { border:1px solid var(--border, #e2e5ee); border-radius:10px; padding:12px; margin:0 0 12px; background:#fafbfd; }
    .oi-form h3 { font-size:15px; margin:0 0 8px; color:#1b2440; }
    .oi-form label { display:block; font-size:12.5px; color:#1b2440; margin:8px 0 2px; font-weight:700; }
    .oi-form input[type=text], .oi-form input[type=url], .oi-form input[type=date], .oi-form input[type=number], .oi-form select, .oi-form textarea {
      width:100%; box-sizing:border-box; font-family:inherit; font-size:13px; }
    .oi-form .chk { display:flex; gap:8px; align-items:flex-start; font-weight:500; }
    .oi-form .chk input { width:auto; margin-top:3px; }
    .oi-form .row2 { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:0 12px; }
    .oi-form .acts { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    .oi-form .note { font-size:11.5px; color:#6b7080; margin:6px 0 0; line-height:1.6; }
    .oi-url { font-size:12px; word-break:break-all; background:#fff; border:1px dashed #c9d6f5; padding:6px 8px; border-radius:6px; margin:6px 0; }
    @media (max-width:760px) {
      .oi-row { grid-template-columns:minmax(0, 1fr); }
      .oi-row .act { grid-column:1; grid-row:auto; }
      .oi-row .act .btn, .oi-next .btn, .oi-form .acts .btn { width:100%; justify-content:center; }
      .oi-drawer { padding:12px 16px 40px; }
      .oi-form .row2 { grid-template-columns:minmax(0, 1fr); }
      .oi-line .btn { margin-left:0; }
    }`;
  function style() {
    if ($("oi-style")) return;
    const s = document.createElement("style");
    s.id = "oi-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  // ---- 一覧 ----------------------------------------------------------------------------
  /** admin-hr.html から一度だけ呼ぶ。?intake=… があれば、その人の詳細を開く */
  OI.mount = async (el) => {
    host = el;
    style();
    await reload();
    const q = new URLSearchParams(location.search).get("intake");
    if (q && list?.enabled === true) OI.open(q);
    else if (location.hash === "#hr-intake" && list?.enabled === true) host.scrollIntoView({ block: "start" });
  };
  async function reload() {
    try { list = await API.api(API_PATH); }
    catch (e) { list = { error: e }; }
    renderQueue();
  }
  const pay = (p) => (p === "entered" ? "希望報酬：入力あり" : p === "unresolved" ? "希望報酬：未確定／Officeで確認" : "");
  function desiredText(d) {
    return [
      d.jobTitle ? `職種：${d.jobTitle}` : "",
      d.joinDate ? `希望入社日：${ymd(d.joinDate)}` : "",
      d.weeklyDays || d.weeklyHours ? `週${d.weeklyDays ?? "—"}日・${d.weeklyHours ?? "—"}時間` : "",
      d.workLocation ? `勤務地：${d.workLocation}` : "",
      pay(d.pay),
    ].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join("");
  }
  function rowHtml(it) {
    const nx = it.next || {};
    return `
      <div class="oi-row" data-intake="${esc(it.id)}" data-status="${esc(it.status.key)}">
        <div class="who"><b>${esc(it.name)}</b>${it.offerTypeLabel ? `<span class="oi-chip">${esc(it.offerTypeLabel)}</span>` : ""}
          <span class="oi-st" data-st="${esc(it.status.key)}">${esc(it.status.label)}</span></div>
        <div class="facts" data-role="desired">${desiredText(it.desired || {})}${it.unresolvedLabels?.length ? `<span class="oi-un">未確定：${esc(it.unresolvedLabels.join("・"))}</span>` : ""}</div>
        <div class="facts muted"><span>採用担当：${esc(it.recruiterName || "—")}</span><span data-role="assignee">Office担当：${esc(it.assigneeName || "未設定")}</span>
          <span>引き渡し：${esc(fmt(it.handedAt))}${it.handedByName ? `（${esc(it.handedByName)}）` : ""}</span></div>
        <div class="oi-nx" data-role="next-action"><span class="k">NEXT ACTION</span><b>${esc(nx.label || "—")}</b>
          ${it.deadline ? `<span class="muted" data-role="deadline">期限：${esc(ymd(it.deadline))}</span>` : ""}</div>
        <div class="act"><button type="button" class="btn ${nx.cta && !TERMINAL.includes(it.status.key) ? "btn-primary" : "btn-secondary"} btn-sm" data-act="open"
          onclick="OfficeHrIntake.open('${esc(it.id)}')">開く</button></div>
      </div>`;
  }
  function renderQueue() {
    if (!host) return;
    // 出すのはサーバが enabled:true を返したときだけ（フラグ OFF・古いサーバ・読めないときは何も出さない）
    if (!list || (!list.error && list.enabled !== true)) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    if (list.error) {
      const e = list.error;
      // 権限なし・この API が無い（古いサーバ）ときは出さない。表が無い・サーバの失敗は知らせる
      if (!(e.code === "not_ready" || e.status >= 500)) { host.innerHTML = ""; host.hidden = true; return; }
      host.innerHTML = `<div class="card oi-card" id="oi-queue"><div class="hd"><b>HRからの引き継ぎ</b></div>
        <div class="banner ${e.code === "not_ready" ? "info" : "err"}"><span class="material-symbols-outlined">${e.code === "not_ready" ? "build" : "error"}</span>
        <div>${esc(e.hint || e.message || "読み込めませんでした")}</div></div></div>`;
      return;
    }
    const items = list.items || [];
    const counts = list.counts || {};
    const shown = items.filter((it) => (filter === "open" ? !TERMINAL.includes(it.status.key) : it.status.key === filter));
    const chip = (key, label, n) => `<button type="button" data-filter="${esc(key)}" aria-pressed="${filter === key}" data-zero="${n ? 0 : 1}"
      onclick="OfficeHrIntake.filter('${esc(key)}')">${esc(label)}<span class="c">${n}</span></button>`;
    host.innerHTML = `
      <div class="card oi-card" id="oi-queue">
        <div class="hd"><b>HRからの引き継ぎ</b><span class="n" id="oi-open-n">${list.open || 0}件 対応中</span>
          <span class="muted">社長合格・条件ヒアリング済みで、採用HRから引き渡された人。採用条件・社労士・正式PDF・本人の同意・契約・入社準備は Office で進めます</span></div>
        <div class="oi-chips" role="group" aria-label="状態で絞り込む">
          ${chip("open", "対応中", list.open || 0)}
          ${(list.statuses || []).map((s) => chip(s.key, s.label, counts[s.key] || 0)).join("")}
        </div>
        <div id="oi-rows">${shown.length ? shown.map(rowHtml).join("") : `<div class="oi-empty">該当する引き継ぎはありません。</div>`}</div>
      </div>`;
  }
  OI.filter = (key) => { filter = key; renderQueue(); };

  // ---- 詳細（ドロワー） ---------------------------------------------------------------
  function root() {
    let r = $("oi-root");
    if (!r) { r = document.createElement("div"); r.id = "oi-root"; document.body.appendChild(r); }
    return r;
  }
  OI.open = async (id) => {
    curId = id; form = null; issued = null;
    root().innerHTML = `<div class="oi-bg" onclick="OfficeHrIntake.close()"></div>
      <aside class="oi-drawer" id="oi-drawer" role="dialog" aria-modal="true" aria-label="HRからの引き継ぎ"><div class="oi-empty">読み込み中…</div></aside>`;
    history.replaceState({}, "", `${location.pathname}?intake=${encodeURIComponent(id)}${location.hash}`);
    await refresh();
  };
  OI.close = () => {
    root().innerHTML = ""; cur = null; curId = null; form = null; issued = null;
    history.replaceState({}, "", `${location.pathname}${location.hash}`);
  };
  async function refresh() {
    try { cur = await API.api(`${API_PATH}?intake=${encodeURIComponent(curId)}`); }
    catch (e) {
      const box = $("oi-drawer");
      if (box) box.innerHTML = `<header><h2>HRからの引き継ぎ</h2><button class="oi-x" aria-label="閉じる" onclick="OfficeHrIntake.close()">×</button></header>
        <div class="banner err"><span class="material-symbols-outlined">error</span><div>${esc(e.hint || e.message || "読み込めませんでした")}</div></div>`;
      return;
    }
    renderDetail();
  }
  async function done() {
    form = null;
    await Promise.all([refresh(), reload()]);
  }
  const say = (t, err = true) => { const m = $("oi-msg"); if (m) { m.textContent = t || ""; m.className = err ? "err-text" : "muted"; } };

  /** 主ボタン（1つ）。押せない人には理由を出す。サーバの next.action と権限（can）だけで決める */
  function primaryOf(d) {
    const nx = d.intake.next || {};
    const can = d.can || {};
    const off = (label, reason) => ({ label, reason });
    switch (nx.action) {
      case "receive": return { label: nx.cta, run: "receive" };
      case "createOffer": return can.createOffer ? { label: nx.cta, run: "offer" } : off(nx.cta, "採用条件はまだ作れません（応募者の状態を確認してください）");
      case "confirmOffer": return can.decideSalary ? { label: nx.cta, run: "confirm" }
        : off(nx.cta, "採用条件（給与・報酬）を確定できるのは経営者です。条件を作ったら、経営者に確定を依頼してください（下の［条件を直す］で内容は直せます）");
      case "contract":
        if (nx.step === "markRequested") return { label: nx.cta, run: "request" };
        if (nx.step === "attach") return { label: nx.cta, run: "upload" };
        if (nx.step === "approve") return can.approve ? { label: nx.cta, run: "review" } : off(nx.cta, "照合と承認は、給与を見られる人が行います");
        if (nx.step === "legalsign") return { label: nx.cta, run: "legalsign" };
        if (nx.step === "signed") return can.signed ? { label: nx.cta, run: "signed" } : off(nx.cta, "締結の記録は、社長・管理者・人事が行います");
        return null;
      case "issueLink": return { label: nx.cta, run: "guide" };
      case "markSent": return { label: nx.cta, run: "guide" };
      case "formalHandoff": return can.formalHandoff ? { label: nx.cta, run: "formalHandoff" } : off(nx.cta, "社長・管理者・人事が行います");
      case "register": return can.register ? { label: nx.cta, run: "register" } : off(nx.cta, "社員登録は、社長・管理者・人事が行います");
      case "complete": return { label: nx.cta, run: "complete" };
      case "withdraw": return { label: nx.cta, run: "withdraw" };
      default: return null;
    }
  }

  function renderDetail() {
    const d = cur;
    const box = $("oi-drawer");
    if (!box || !d) return;
    const it = d.intake;
    const pr = primaryOf(d);
    const prHtml = pr ? (pr.reason
      ? `<button type="button" class="btn btn-primary" id="oi-primary" disabled>${esc(pr.label)}</button><p class="why" id="oi-why">${esc(pr.reason)}</p>`
      : `<button type="button" class="btn btn-primary" id="oi-primary" data-run="${esc(pr.run)}" onclick="OfficeHrIntake.run('${esc(pr.run)}', this)">${esc(pr.label)}</button>`)
      : "";
    box.setAttribute("aria-label", `HRからの引き継ぎ：${it.name}`);
    box.innerHTML = `
      <header><h2 id="oi-name">${esc(it.name)}</h2><span class="oi-st" id="oi-status" data-st="${esc(it.status.key)}">${esc(it.status.label)}</span>
        <button type="button" class="oi-x" aria-label="閉じる" onclick="OfficeHrIntake.close()">×</button></header>
      <section class="oi-next" id="oi-next">
        <div class="oi-nx" data-role="next-action"><span class="k">NEXT ACTION</span><b>${esc(it.next?.label || "—")}</b>
          ${it.deadline ? `<span class="muted">期限：${esc(ymd(it.deadline))}</span>` : ""}</div>
        ${prHtml}
      </section>
      <div id="oi-msg" class="err-text" role="status"></div>
      <div id="oi-form-box">${formHtml()}</div>
      ${sec("handoff", "引き継ぎの内容", handoffHtml(d))}
      ${sec("desired", "希望条件（候補者の希望・閲覧専用）", desiredHtml(d))}
      ${sec("interviews", `面談の結果（閲覧専用・${(d.interviews || []).length}件）`, interviewsHtml(d))}
      ${sec("docs", "応募書類（履歴書・職務経歴書・スキルシート。閲覧専用）", `<div id="oi-docs"><div class="oi-empty">開くと読み込みます</div></div>`, "OfficeHrIntake.loadDocs()")}
      ${sec("offer", "採用条件（会社の正式な提示条件）", offerHtml(d))}
      ${d.contract ? sec("contract", "契約手続き（社労士・正式PDF・LegalSign）", contractHtml(d)) : ""}
      ${sec("history", `履歴（${(d.events || []).length}件）`, historyHtml(d))}
      ${TERMINAL.includes(it.status.key) ? "" : sec("more", "その他の操作（担当の変更・辞退／不成立・差し戻し）", moreHtml(d))}`;
  }
  const sec = (key, title, body, onOpen) => `<details class="oi-sec" data-sec="${esc(key)}"${onOpen ? ` ontoggle="if(this.open)${onOpen}"` : ""}><summary>${esc(title)}</summary>${body}</details>`;

  function handoffHtml(d) {
    const it = d.intake;
    return `<dl class="oi-dl">
      <dt>引き渡し</dt><dd>${esc(fmt(it.handedAt))}${it.handedByName ? `（${esc(it.handedByName)}）` : ""}</dd>
      <dt>社長合格</dt><dd>${esc(fmt(d.decision?.decidedAt))}${d.decision?.decidedByName ? `（${esc(d.decision.decidedByName)}）` : ""}${d.decision?.note ? `\n${esc(d.decision.note)}` : ""}</dd>
      <dt>採用担当</dt><dd>${esc(it.recruiterName || "—")}</dd>
      <dt>Office担当</dt><dd id="oi-assignee">${esc(it.assigneeName || "未設定")}</dd>
      <dt>受領</dt><dd>${it.receivedAt ? `${esc(fmt(it.receivedAt))}${it.receivedByName ? `（${esc(it.receivedByName)}）` : ""}` : "まだ受領していません"}</dd>
      ${it.unresolvedLabels?.length ? `<dt>未確定の項目</dt><dd class="oi-un">${esc(it.unresolvedLabels.join("・"))}（Officeで確認）</dd>` : ""}
      ${it.exceptionReason ? `<dt>未確定のまま渡した理由</dt><dd>${esc(it.exceptionReason)}${it.exceptionApprovedByName ? `（承認：${esc(it.exceptionApprovedByName)}）` : ""}</dd>` : ""}
      ${it.closedReason ? `<dt>辞退・不成立</dt><dd>${esc(it.closedReason)}（${esc(fmt(it.closedAt))}${it.closedByName ? `・${esc(it.closedByName)}` : ""}）</dd>` : ""}
      ${d.applicant?.email ? `<dt>メール</dt><dd>${esc(d.applicant.email)}</dd>` : ""}
      ${d.applicant?.phone ? `<dt>電話</dt><dd>${esc(d.applicant.phone)}</dd>` : ""}
    </dl><p class="oi-ro">社長合格・条件ヒアリング・引き渡しは、本人の条件承諾・雇用契約の成立・社員登録ではありません。</p>`;
  }
  function desiredHtml(d) {
    const rows = (d.hearing || []).map((h) => `<dt>${esc(h.label)}</dt><dd>${h.unresolved ? `<span class="oi-un">${esc(d.unresolvedLabel)}</span>` : esc(h.value ?? "—")}</dd>`).join("");
    const p = d.pay || {};
    const payText = p.unresolved ? `<span class="oi-un">${esc(d.unresolvedLabel)}</span>`
      : p.desiredAmount !== undefined && p.desiredAmount !== null ? `候補者希望：${esc(p.desiredWageType || "")} ${esc(yen(p.desiredAmount))}${p.desiredNote ? `（${esc(p.desiredNote)}）` : ""}`
        + (p.approvedAmount != null ? `／社内承認済み：${esc(p.approvedWageType || "")} ${esc(yen(p.approvedAmount))}` : "")
      : p.entered ? "入力あり（給与は権限のある人だけが見られます）" : "—";
    return `<dl class="oi-dl" id="oi-desired">${rows}<dt>希望報酬・給与</dt><dd data-role="desired-pay">${payText}</dd></dl>
      <p class="oi-ro">HR が条件ヒアリングで聞いた候補者の希望です（会社の正式な提示条件とは別）。直すときは採用条件（下）で会社の条件を決めます。</p>`;
  }
  function interviewsHtml(d) {
    const rows = (d.interviews || []).map((i) => `<div class="oi-line" data-interview="${esc(i.id)}"><b>${esc(i.kindLabel)}</b>
      <span>${esc(fmt(i.conductedAt || i.scheduledAt))}</span>${i.interviewerName ? `<span>面談者：${esc(i.interviewerName)}</span>` : ""}${i.rank ? `<span class="oi-chip">ランク ${esc(i.rank)}</span>` : ""}
      ${i.recommendReason ? `<span class="sub">推薦理由：${esc(i.recommendReason)}</span>` : ""}${i.notes ? `<span class="sub">${esc(i.notes)}</span>` : ""}</div>`).join("");
    return rows || `<div class="oi-empty">面談の記録はありません。</div>`;
  }
  OI.loadDocs = async () => {
    const box = $("oi-docs");
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = "1";
    box.innerHTML = `<div class="oi-empty">読み込み中…</div>`;
    try {
      const r = await API.hrDocuments(cur.applicant.id);
      const rows = (r.documents || []).map((t) => `<div class="oi-line" data-doc="${esc(t.docType)}"><b>${esc(t.label)}</b>
        ${t.latest ? `<span>${esc(t.latest.filename)}・${esc(ymd(t.latest.uploadedAt))}</span>
          <button type="button" class="btn btn-secondary btn-sm" data-act="open-doc" onclick="OfficeHrIntake.openDoc('${esc(t.latest.id)}', this)">開く</button>` : `<span class="oi-chip">未登録</span>`}</div>`).join("");
      box.innerHTML = `${rows || `<div class="oi-empty">書類はありません。</div>`}
        <p class="oi-ro">採用HRで登録した原本を、そのまま見ています（閲覧専用）。再アップロードは要りません。登録・差し替えは採用HRで行います。</p>`;
    } catch (e) {
      box.innerHTML = `<div class="banner err"><span class="material-symbols-outlined">error</span><div>${esc(e.hint || e.message || "書類を読み込めませんでした")}</div></div>`;
    }
  };
  OI.openDoc = async (docId, btn) => {
    const w = window.open("", "_blank");
    if (w) w.opener = null;
    try {
      const info = await KPLayout.busy(btn, "開いています…", () => API.hrDocumentUrl(docId, false, cur.applicant.id));
      if (w) w.location.href = info.url; else location.href = info.url;
    } catch (e) { if (w) w.close(); say(e.hint || e.message || "書類を開けませんでした"); }
  };
  /** PDF（条件通知書・正式PDF）はログインの鍵が要るので、受け取って保存する */
  OI.pdf = async (q, btn) => {
    try {
      await KPLayout.busy(btn, "読み込み中…", async () => {
        const token = await API.getToken();
        const r = await fetch(`${API_PATH}?intake=${encodeURIComponent(curId)}&${q}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.hint || b.message || "PDFを開けませんでした"); }
        const blob = await r.blob();
        const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(r.headers.get("content-disposition") || "") || [])[1] || "document.pdf");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      });
    } catch (e) { say(e.message || "PDFを開けませんでした"); }
  };

  const OFFER_ST = { draft: "作成中", sent: "本人へ案内済み", viewed: "本人が閲覧", accepted: "本人が同意", declined: "辞退", revoked: "無効", expired: "期限切れ" };
  function offerHtml(d) {
    const o = (d.offers || []).find((x) => x.id === d.currentOfferId) || null;
    if (!o) {
      return `<div class="oi-empty">まだ採用条件の版がありません。${d.can?.createOffer ? "［採用条件を作る］から作ります。" : ""}</div>
        <p class="oi-ro">給与・報酬を入れて条件を確定するのは経営者です。人事は条件の作成と書類の手続きを進めます。</p>`;
    }
    const wage = o.wageAmount !== undefined && o.wageAmount !== null ? `${esc(o.wageType || "")} ${esc(yen(o.wageAmount))}` : (d.salaryVisible ? "未入力（経営者が決めます）" : "給与は権限のある人だけが見られます");
    const editable = d.applicant?.status === "offer_review_pending" && !o.sentAt;
    const others = (d.offers || []).filter((x) => x.id !== o.id);
    return `<dl class="oi-dl" id="oi-offer" data-offer="${esc(o.id)}">
        <dt>版</dt><dd>第${esc(o.version)}版・${esc(OFFER_ST[o.status] || o.status)}</dd>
        <dt>採用区分</dt><dd>${esc(o.offerTypeLabel || "—")}${o.employmentType ? `（${esc(o.employmentType)}）` : ""}</dd>
        <dt>職種</dt><dd>${esc(o.jobTitle || "—")}</dd>
        <dt>入社予定日</dt><dd>${esc(ymd(o.joinDate))}</dd>
        <dt>勤務地</dt><dd>${esc(o.workLocation || "—")}</dd>
        <dt>給与・報酬</dt><dd data-role="offer-wage">${wage}</dd>
        <dt>回答期限</dt><dd>${esc(ymd(o.respondBy))}</dd>
        <dt>正式契約</dt><dd>${o.formalRequired === false ? "不要" : o.formalSignedAt ? `締結済み（${esc(fmt(o.formalSignedAt))}）` : "必要（LegalSign など）"}</dd>
        ${o.sentAt ? `<dt>本人へ案内</dt><dd>${esc(fmt(o.sentAt))}</dd>` : ""}
        ${o.acceptedAt ? `<dt>本人の同意</dt><dd>${esc(fmt(o.acceptedAt))}</dd>` : ""}
        ${o.handoffAt ? `<dt>社員登録の準備</dt><dd>${esc(fmt(o.handoffAt))}</dd>` : ""}
      </dl>
      <div class="oi-line">
        ${editable ? `<button type="button" class="btn btn-secondary btn-sm" data-act="edit-offer" onclick="OfficeHrIntake.run('offerEdit', this)">条件を直す</button>` : ""}
        ${d.salaryVisible && o.noticePdf ? `<button type="button" class="btn btn-secondary btn-sm" data-act="notice-pdf" onclick="OfficeHrIntake.pdf('offerId=${esc(o.id)}&file=notice', this)">案内した条件のPDF</button>` : ""}
        ${d.salaryVisible && o.acceptedPdf ? `<button type="button" class="btn btn-secondary btn-sm" data-act="accepted-pdf" onclick="OfficeHrIntake.pdf('offerId=${esc(o.id)}&file=accepted', this)">同意済みPDF</button>` : ""}
      </div>
      ${others.length ? `<p class="oi-ro">前の版：${others.map((x) => `第${esc(x.version)}版（${esc(OFFER_ST[x.status] || x.status)}）`).join("・")}</p>` : ""}`;
  }
  const MARK = { done: "✓", now: "●", wait: "…", todo: "○", skip: "－", ended: "×" };
  function contractHtml(d) {
    const c = d.contract;
    const p = c.procedure || {};
    const steps = (p.steps || []).map((s) => `<li data-st="${esc(s.state)}" data-step="${esc(s.key)}"><span class="mk">${MARK[s.state] || "○"}</span>
      <span class="lb">${esc(s.label)}${s.at ? `（${esc(ymd(s.at))}）` : ""}${s.note ? `<span class="oi-ro" style="display:block;margin:0;">${esc(s.note)}</span>` : ""}</span></li>`).join("");
    const docs = (c.docs || []).map((x) => `<div class="oi-line" data-official="${esc(x.id)}"><b>${esc(x.title)}</b><span>受領第${esc(x.revision)}版</span>
      <span class="oi-chip">${esc(x.sent ? "本人へ案内した版" : ({ received: "確認待ち", approved: "承認済み", returned: "差し戻し", superseded: "使わない版" }[x.status] || x.status))}</span>
      <span class="sub">SHA-256：${esc(String(x.sha256 || "").slice(0, 16))}…・受領 ${esc(ymd(x.receivedOn))}${x.authorName ? `・${esc(x.authorName)}` : ""}</span>
      ${d.salaryVisible ? `<button type="button" class="btn btn-secondary btn-sm" data-act="official-pdf" onclick="OfficeHrIntake.pdf('docId=${esc(x.id)}', this)">PDF</button>` : ""}</div>`).join("");
    return `<p class="oi-ro" style="margin-top:8px;">状態：<b>${esc(p.statusLabel || "")}</b>・次の担当：${esc(p.owner || "—")}</p>
      <ol class="oi-steps" id="oi-steps">${steps}</ol>
      ${docs ? `<div id="oi-official">${docs}</div>` : ""}
      ${(p.secondary || []).some((b) => b.action === "reopen") ? `<div class="oi-line"><button type="button" class="btn btn-secondary btn-sm" data-act="reopen" onclick="OfficeHrIntake.run('reopen', this)">条件を直す（確定を取り消す）</button></div>` : ""}
      <p class="oi-ro">HR と同じ契約手続きの記録（版・SHA-256・締結の証跡）をそのまま使います。社労士・LegalSign へはこのシステムから送りません。</p>`;
  }
  const EV = { handed_off: "HRから引き渡し", received: "受領・着手", status_changed: "状態が変わった", assignee_changed: "Office担当を変更",
    closed: "辞退・不成立を記録", returned: "HRへ差し戻し", note: "メモ", revision_requested: "修正の依頼", revision_answered: "修正の回答" };
  function historyHtml(d) {
    return (d.events || []).map((e) => `<div class="oi-line"><b>${esc(EV[e.kind] || e.kind)}</b><span>${esc(fmt(e.at))}</span>${e.actorName ? `<span>${esc(e.actorName)}</span>` : ""}
      ${e.message ? `<span class="sub">${esc(e.message)}</span>` : ""}</div>`).join("") || `<div class="oi-empty">履歴はまだありません。</div>`;
  }
  function moreHtml(d) {
    const can = d.can || {};
    return `<div class="oi-line">
      ${can.assign ? `<button type="button" class="btn btn-secondary btn-sm" data-act="assign" onclick="OfficeHrIntake.run('assign', this)">Office担当を変える</button>` : ""}
      ${can.withdraw ? `<button type="button" class="btn btn-secondary btn-sm" data-act="withdraw" onclick="OfficeHrIntake.run('withdraw', this)">辞退・不成立を記録</button>` : ""}
      ${can.returnToHr ? `<button type="button" class="btn btn-secondary btn-sm" data-act="return" onclick="OfficeHrIntake.run('returnToHr', this)">HRへ差し戻す（誤って引き渡したとき）</button>` : ""}
    </div><p class="oi-ro">辞退・不成立・差し戻しは理由を記録します。記録は消えません（HR では「終了」、差し戻しは「選考中」に戻ります）。</p>`;
  }

  // ---- 入力（ドロワーの上に開く） ------------------------------------------------------
  const offerOf = (d) => (d.offers || []).find((x) => x.id === d.currentOfferId) || null;
  const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  function formHtml() {
    if (!form || !cur) return "";
    const d = cur;
    const c = d.contract || {};
    const o = offerOf(d);
    const close = `<button type="button" class="btn btn-secondary" onclick="OfficeHrIntake.cancel()">閉じる</button>`;
    if (form.kind === "offer") return offerFormHtml(d, form.edit ? o : null, close);
    if (form.kind === "request") {
      const r = form.draft;
      if (!r) return `<div class="oi-form" id="oi-form"><h3>社労士への依頼文</h3><div class="oi-empty">読み込み中…</div></div>`;
      return `<div class="oi-form" id="oi-form" data-form="request"><h3>${esc(c.attorneyLabel || "社労士")}への依頼文</h3>
        <p class="note">登録した条件から作った<b>下書き</b>です。確かめてコピーし、Slack などでご自身で送ってください（このシステムからは送りません）。</p>
        ${r.missing?.length ? `<p class="note oi-un">要確認：${esc(r.missing.join("・"))}（【要確認】のまま。架空の値では埋めません）</p>` : ""}
        <textarea id="oi-req-text" rows="10">${esc(r.text)}</textarea>
        <div class="acts"><button type="button" class="btn btn-secondary" onclick="OfficeHrIntake.copy('oi-req-text', this)">文章をコピー</button></div>
        <label class="chk"><input type="checkbox" id="oi-req-sent"><span>${esc(c.attorneyLabel || "社労士")}へ送りました（コピーしただけでは記録しません）</span></label>
        <label for="oi-req-note">メモ（任意）</label><input type="text" id="oi-req-note" maxlength="300" placeholder="例：#労務相談 で依頼">
        <div class="acts"><button type="button" class="btn btn-primary" id="oi-req-done" onclick="OfficeHrIntake.submit('request', this)">依頼済みにする</button>${close}</div></div>`;
    }
    if (form.kind === "upload") {
      const kinds = c.docKinds || [];
      return `<div class="oi-form" id="oi-form" data-form="upload"><h3>正式PDFを受け取る</h3>
        <p class="note">${esc(c.attorneyLabel || "社労士")}から届いたPDF（15MB まで・パスワードなし）。受け取ると版と SHA-256 を記録します。</p>
        <label for="oi-up-file">PDF ファイル</label><input type="file" id="oi-up-file" accept="application/pdf,.pdf">
        <div class="row2"><div><label for="oi-up-kind">書類の種類</label><select id="oi-up-kind">${kinds.map((k) => `<option value="${esc(k.key)}"${k.key === c.defaultDocKind ? " selected" : ""}>${esc(k.label)}</option>`).join("")}</select></div>
          <div><label for="oi-up-date">受領日</label><input type="date" id="oi-up-date" value="${esc(c.today || today())}" max="${esc(c.today || today())}"></div></div>
        <label for="oi-up-author">作成者（任意）</label><input type="text" id="oi-up-author" maxlength="100" placeholder="〇〇社労士事務所">
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('upload', this)">アップロードして受け取る</button>${close}</div></div>`;
    }
    if (form.kind === "review") {
      const doc = (c.docs || []).find((x) => x.status === "received" && x.offerId === o?.id);
      const conds = (c.conditions || []).map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.value)}</dd>`).join("");
      return `<div class="oi-form" id="oi-form" data-form="review"><h3>PDFと条件を照合して承認</h3>
        ${doc ? `<p class="note">${esc(doc.title)}（受領第${esc(doc.revision)}版）　<button type="button" class="btn btn-secondary btn-sm" onclick="OfficeHrIntake.pdf('docId=${esc(doc.id)}', this)">PDFを開く</button></p>` : ""}
        <dl class="oi-dl">${conds}</dl>
        ${(c.reviewChecks || []).map((x) => `<label class="chk"><input type="checkbox" data-oi-check="${esc(x.key)}"><span>${esc(x.label)}</span></label>`).join("")}
        <div class="acts"><button type="button" class="btn btn-primary" data-doc="${esc(doc?.id || "")}" onclick="OfficeHrIntake.submit('approve', this)">照合して承認する</button>${close}</div>
        <label for="oi-rv-reason">直してほしい点（差し戻すとき）</label><textarea id="oi-rv-reason" rows="3" maxlength="1000"></textarea>
        <div class="acts"><button type="button" class="btn btn-secondary" data-doc="${esc(doc?.id || "")}" onclick="OfficeHrIntake.submit('returnDoc', this)">差し戻す</button></div></div>`;
    }
    if (form.kind === "legalsign") {
      return `<div class="oi-form" id="oi-form" data-form="legalsign"><h3>LegalSign の登録を記録</h3>
        <p class="note">LegalSign（外部の電子契約サービス）に、承認した正式PDFを登録してから記録します。このシステムから LegalSign へは送りません。</p>
        <label for="oi-ls-route">契約ルート</label><select id="oi-ls-route">${(c.contractRoutes || [{ key: "legalsign", label: "LegalSign" }]).map((r) => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join("")}</select>
        <label for="oi-ls-url">本人が署名する LegalSign の URL</label><input type="url" id="oi-ls-url" placeholder="https://...">
        <label class="chk"><input type="checkbox" id="oi-ls-same"><span>LegalSign に登録したのは、承認した正式PDFと同じファイルです</span></label>
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('legalsign', this)">記録する</button>${close}</div></div>`;
    }
    if (form.kind === "guide") {
      const sent = Boolean(o?.sentAt);
      return `<div class="oi-form" id="oi-form" data-form="guide"><h3>本人へ案内（メールは送りません）</h3>
        <p class="note">本人専用URLを発行し、ご自身で本人へ送ってから［送付済みにする］を押します。URL は発行した直後のこの画面でだけ表示します（保存しません）。</p>
        ${issued ? `<div class="oi-url" id="oi-url">${esc(issued)}</div><div class="acts"><button type="button" class="btn btn-secondary" onclick="OfficeHrIntake.copyText(this)">URLをコピー</button></div>` : ""}
        <div class="acts">
          ${sent ? "" : `<button type="button" class="btn ${issued ? "btn-secondary" : "btn-primary"}" id="oi-issue" onclick="OfficeHrIntake.submit('issueLink', this)">${issued ? "URLを発行し直す" : "本人専用URLを発行"}</button>`}
          ${sent ? "" : `<button type="button" class="btn ${issued ? "btn-primary" : "btn-secondary"}" id="oi-marksent" onclick="OfficeHrIntake.submit('markSent', this)">送付済みにする</button>`}
          ${close}</div></div>`;
    }
    if (form.kind === "signed") {
      return `<div class="oi-form" id="oi-form" data-form="signed"><h3>締結を確かめて記録</h3>
        <p class="note">LegalSign（または例外ルート）で締結したことを、証跡で確かめてから記録します（取り消せません）。</p>
        <label for="oi-sg-evidence">確かめた証跡</label><textarea id="oi-sg-evidence" rows="3" maxlength="1000" placeholder="例：LegalSign の締結完了の通知と、締結済みPDFを確認"></textarea>
        <label for="oi-sg-ref">文書ID・契約番号（任意）</label><input type="text" id="oi-sg-ref" maxlength="200">
        <label class="chk"><input type="checkbox" id="oi-sg-same"><span>締結した書類は、本人へ案内した正式PDFと同じです</span></label>
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('signed', this)">締結を記録する</button>${close}</div></div>`;
    }
    if (form.kind === "withdraw") {
      return `<div class="oi-form" id="oi-form" data-form="withdraw"><h3>辞退・不成立を記録</h3>
        <label class="chk"><input type="radio" name="oi-wd-kind" value="declined" checked><span>辞退（本人から）</span></label>
        <label class="chk"><input type="radio" name="oi-wd-kind" value="not_concluded"><span>不成立（条件が合わない・会社の判断など）</span></label>
        <label for="oi-wd-reason">理由</label><textarea id="oi-wd-reason" rows="3" maxlength="900"></textarea>
        <p class="note">記録すると、まだ同意していない本人専用URLは使えなくなります。履歴は消えず、HR では「終了」に出ます。</p>
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('withdraw', this)">記録する</button>${close}</div></div>`;
    }
    if (form.kind === "returnToHr") {
      return `<div class="oi-form" id="oi-form" data-form="return"><h3>HRへ差し戻す</h3>
        <p class="note">誤って引き渡したときだけ使います（社長・管理者・採用条件の版を作る前だけ）。引き渡しの記録は消さずに「差し戻し」として残り、HR で条件ヒアリングを確かめ直して引き渡し直します。</p>
        <label for="oi-rt-reason">理由</label><textarea id="oi-rt-reason" rows="3" maxlength="1000"></textarea>
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('returnToHr', this)">差し戻す</button>${close}</div></div>`;
    }
    if (form.kind === "assign") {
      return `<div class="oi-form" id="oi-form" data-form="assign"><h3>Office担当を変える</h3>
        <label for="oi-as-emp">Office担当</label><select id="oi-as-emp">${(d.assignees || []).map((e) => `<option value="${esc(e.id)}"${e.id === d.intake.assigneeId ? " selected" : ""}>${esc(e.name)}</option>`).join("")}</select>
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('assign', this)">変更する</button>${close}</div></div>`;
    }
    if (form.kind === "confirmStep") {
      return `<div class="oi-form" id="oi-form" data-form="${esc(form.step)}"><h3>${esc(form.title)}</h3><p class="note">${esc(form.note)}</p>
        <div class="acts"><button type="button" class="btn btn-primary" onclick="OfficeHrIntake.submit('${esc(form.step)}', this)">${esc(form.ok)}</button>${close}</div></div>`;
    }
    return "";
  }

  /** 会社の採用条件（版）の入力。区分ごとの項目（OFFER_TYPES_PUBLIC）。給与・報酬は経営者だけが入れる */
  function offerFormHtml(d, o, close) {
    const types = d.offerTypes || [];
    // 区分：直すときは版の区分。作るときは選んだ区分 → 候補者の希望の区分 → 先頭
    const typeKey = o?.offerType || form.type || d.intake?.offerType || types[0]?.key;
    const t = types.find((x) => x.key === typeKey) || types[0];
    const h = Object.fromEntries((d.hearing || []).map((x) => [x.key, x.unresolved ? null : x.value]));
    const pre = o ? { jobTitle: o.jobTitle, joinDate: o.joinDate, workLocation: o.workLocation, weeklyHours: o.weeklyHours, contractEndDate: o.contractEndDate,
      probationMonths: o.probationMonths, employmentType: o.employmentType, wageType: o.wageType, wageAmount: o.wageAmount, ...(o.offerTerms || {}) }
      : { jobTitle: h.job_title, joinDate: h.desired_join_date, workLocation: h.work_location, weeklyHours: h.weekly_hours, duties: h.duties };
    const salaryOk = Boolean(d.can?.decideSalary);
    const fields = (t?.fields || []).filter((f) => !f.hidden && !f.auto && (salaryOk || !f.salary));
    const input = (f) => {
      const v = pre[f.key] ?? f.value ?? "";
      const id = `oi-of-${f.key}`;
      const attrs = `id="${esc(id)}" data-of-field="${esc(f.key)}" data-term="${f.term ? 1 : 0}"`;
      let el;
      if (f.kind === "select") el = `<select ${attrs}><option value="">選んでください</option>${(f.options || []).map((x) => `<option${String(v) === String(x) ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
      else if (f.kind === "textarea") el = `<textarea ${attrs} rows="3">${esc(v)}</textarea>`;
      else el = `<input type="${f.kind === "date" ? "date" : f.kind === "number" ? "number" : "text"}" ${attrs} value="${esc(v)}">`;
      return `<div><label for="${esc(id)}">${esc(f.label)}${f.required ? " *" : ""}${f.unit ? `（${esc(f.unit)}）` : ""}</label>${el}</div>`;
    };
    const basic = fields.filter((f) => f.basic || f.required).map(input).join("");
    const extra = fields.filter((f) => !(f.basic || f.required)).map(input).join("");
    const payBtns = salaryOk && t?.pay?.buttons?.length
      ? `<div><label for="oi-of-wageType">${esc(t.pay.label || "給与")}の区分</label><select id="oi-of-wageType" data-of-field="wageType" data-term="0">
          <option value="">選んでください</option>${t.pay.buttons.map((b) => `<option value="${esc(b.value)}"${b.value === pre.wageType ? " selected" : ""}>${esc(b.label)}</option>`).join("")}</select></div>` : "";
    return `<div class="oi-form" id="oi-form" data-form="offer"><h3>${o ? "採用条件を直す" : "会社の採用条件を作る"}</h3>
      <p class="note">本人へ提示する会社の正式な条件です（候補者の希望とは別）。${salaryOk ? "" : "給与・報酬は経営者が入れて確定します（ここでは入れられません）。"}</p>
      ${o ? `<input type="hidden" id="oi-of-type" value="${esc(t?.key || "")}">`
        : `<label for="oi-of-type">採用区分</label><select id="oi-of-type" onchange="OfficeHrIntake.offerType(this.value)">${types.map((x) => `<option value="${esc(x.key)}"${x.key === t?.key ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>`}
      <div class="row2">${payBtns}${basic}</div>
      ${extra ? `<details class="oi-sec" data-sec="offer-more"><summary>詳細な条件</summary><div class="row2">${extra}</div></details>` : ""}
      <div class="row2"><div><label for="oi-of-respondBy">回答期限 *</label><input type="date" id="oi-of-respondBy" value="${esc(o?.respondBy || d.defaults?.respondBy || "")}"></div>
        <div><label class="chk" style="margin-top:28px;"><input type="checkbox" id="oi-of-formal"${(o ? o.formalRequired !== false : t?.formalDefault !== false) ? " checked" : ""}><span>正式契約（LegalSign など）が必要</span></label></div></div>
      <div class="acts"><button type="button" class="btn btn-primary" id="oi-of-save" onclick="OfficeHrIntake.submit('${o ? "updateOffer" : "createOffer"}', this)">${o ? "保存する" : "作成する"}</button>${close}</div></div>`;
  }
  OI.offerType = (key) => { form = { ...form, type: key }; $("oi-form-box").innerHTML = formHtml(); };
  function offerBody() {
    const body = { offerTerms: {} };
    for (const elx of document.querySelectorAll("[data-of-field]")) {
      const v = elx.value;
      if (v === "" || v === undefined) continue;
      if (elx.dataset.term === "1") body.offerTerms[elx.dataset.ofField] = v;
      else body[elx.dataset.ofField] = elx.type === "number" ? Number(v) : v;
    }
    body.respondBy = $("oi-of-respondBy")?.value || null;
    body.formalContractRequired = Boolean($("oi-of-formal")?.checked);
    return body;
  }

  OI.cancel = () => { form = null; $("oi-form-box").innerHTML = ""; say(""); };
  OI.copy = async (id, btn) => {
    const ta = $(id);
    try { await navigator.clipboard.writeText(ta.value); btn.textContent = "コピーしました"; } catch { ta.focus(); ta.select(); }
  };
  OI.copyText = async (btn) => {
    try { await navigator.clipboard.writeText(issued || ""); btn.textContent = "コピーしました"; } catch { /* 選んでコピーしてもらう */ }
  };
  const show = (f) => { form = f; $("oi-form-box").innerHTML = formHtml(); $("oi-form")?.scrollIntoView({ block: "nearest" }); };

  /** 主ボタン・補助ボタン */
  OI.run = async (what, btn) => {
    say("");
    const d = cur;
    const o = offerOf(d);
    try {
      if (what === "receive") {
        await KPLayout.busy(btn, "記録中…", () => post({ intake: curId, action: "receive" }));
        return done();
      }
      if (what === "offer") return show({ kind: "offer" });
      if (what === "offerEdit") return show({ kind: "offer", edit: true });
      if (what === "confirm") return show({ kind: "confirmStep", step: "confirmOffer", title: "採用条件を確定", ok: "確定する",
        note: "給与・報酬を含む会社の採用条件を確定します。確定すると、社労士への依頼に進みます（本人へはまだ何も送りません）。" });
      if (what === "request") {
        show({ kind: "request", draft: null });
        const r = await API.api(`${API_PATH}?intake=${encodeURIComponent(curId)}&offerId=${encodeURIComponent(o.id)}&draft=request`);
        form.draft = r;
        $("oi-form-box").innerHTML = formHtml();
        return;
      }
      if (["upload", "review", "legalsign", "signed", "withdraw", "returnToHr", "assign"].includes(what)) return show({ kind: what });
      if (what === "guide") return show({ kind: "guide" });
      if (what === "formalHandoff") return show({ kind: "confirmStep", step: "formalHandoff", title: "社員登録へ進める準備", ok: "確かめて準備する",
        note: "本人の同意と（必要なら）締結の記録を確かめて、社員登録へ進める印を記録します（取り消せません）。社員登録はこのあと行います。" });
      if (what === "complete") return show({ kind: "confirmStep", step: "complete", title: "入社完了にする", ok: "入社完了にする",
        note: "入社書類・アカウント・端末・オリエンテーションが終わったら記録します。" });
      if (what === "reopen") return show({ kind: "confirmStep", step: "reopen", title: "条件を直す", ok: "確定を取り消す",
        note: "確定を取り消し、受け取った正式PDFは使わなくなります（直したあと、社労士へ依頼し直します）。" });
      if (what === "register") {
        await KPLayout.busy(btn, "開いています…", () => API.claimHrAdvance(d.applicant.id));
        location.href = `admin-onboard.html?applicantId=${encodeURIComponent(d.applicant.id)}`;
        return;
      }
    } catch (e) { say(e.hint || e.message || "できませんでした"); }
  };

  /** 入力の送信。サーバが権限・状態をもう一度確かめる（画面で隠しても、API が断る） */
  OI.submit = async (what, btn) => {
    say("");
    const d = cur;
    const o = offerOf(d);
    const P = (body) => KPLayout.busy(btn, "記録中…", () => post({ intake: curId, ...body }));
    const contract = (step, body = {}) => P({ action: "contract", offerId: o.id, step, ...body });
    try {
      if (what === "createOffer") { await P({ action: "createOffer", offerType: $("oi-of-type").value, ...offerBody() }); return done(); }
      if (what === "updateOffer") { await P({ action: "updateOffer", offerId: o.id, ...offerBody() }); return done(); }
      if (what === "confirmOffer") { await P({ action: "confirmOffer", offerId: o.id }); return done(); }
      if (what === "request") {
        if (!$("oi-req-sent").checked) { say("送ったことを確かめてから押してください"); return; }
        await contract("markRequested", { kind: form.draft?.kind, note: $("oi-req-note").value, missingLabels: form.draft?.missing || [] });
        return done();
      }
      if (what === "upload") {
        const file = $("oi-up-file").files?.[0];
        if (!file) { say("PDF ファイルを選んでください"); return; }
        if (!/\.pdf$/i.test(file.name)) { say("PDF（.pdf）を選んでください"); return; }
        await KPLayout.busy(btn, "アップロード中…", async () => {
          const sign = await post({ intake: curId, action: "contract", offerId: o.id, step: "uploadUrl", fileName: file.name, size: file.size });
          const put = await fetch(sign.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/pdf", "x-upsert": "false" }, body: file });
          if (!put.ok) throw new Error(`アップロードに失敗しました（${put.status}）`);
          const kind = $("oi-up-kind");
          await post({ intake: curId, action: "contract", offerId: o.id, step: "attach", path: sign.path, docKind: kind.value,
            title: kind.options[kind.selectedIndex]?.text, receivedOn: $("oi-up-date").value, authorName: $("oi-up-author").value, fileName: file.name });
        });
        return done();
      }
      if (what === "approve") {
        const checks = Object.fromEntries([...document.querySelectorAll("[data-oi-check]")].map((x) => [x.dataset.oiCheck, x.checked]));
        if (Object.values(checks).some((v) => !v)) { say("照合の項目すべてに✓を付けてください"); return; }
        await contract("approve", { docId: btn.dataset.doc, checks });
        return done();
      }
      if (what === "returnDoc") {
        const reason = $("oi-rv-reason").value.trim();
        if (!reason) { say("直してほしい点を入れてください"); return; }
        await contract("return", { docId: btn.dataset.doc, reason });
        return done();
      }
      if (what === "legalsign") {
        const route = $("oi-ls-route").value;
        const body = route === "legalsign" ? { route, url: $("oi-ls-url").value.trim(), sameDoc: $("oi-ls-same").checked } : { route };
        await contract("legalsign", body);
        return done();
      }
      if (what === "issueLink") {
        const r = await P({ action: "issueLink", offerId: o.id });
        issued = r?.token ? `${location.origin}/hr/offer.html?token=${encodeURIComponent(r.token)}` : null;
        $("oi-form-box").innerHTML = formHtml();
        return;
      }
      if (what === "markSent") { await P({ action: "markSent", offerId: o.id }); issued = null; return done(); }
      if (what === "signed") {
        await contract("signed", { evidence: $("oi-sg-evidence").value, contractRef: $("oi-sg-ref").value, sameDoc: $("oi-sg-same").checked });
        return done();
      }
      if (what === "formalHandoff") { await P({ action: "formalHandoff", offerId: o.id }); return done(); }
      if (what === "complete") { await P({ action: "complete" }); return done(); }
      if (what === "reopen") { await contract("reopen", {}); return done(); }
      if (what === "withdraw") {
        const kind = document.querySelector("input[name=oi-wd-kind]:checked")?.value;
        const reason = $("oi-wd-reason").value.trim();
        if (!reason) { say("理由を入れてください"); return; }
        await P({ action: "withdraw", kind, reason });
        return done();
      }
      if (what === "returnToHr") {
        const reason = $("oi-rt-reason").value.trim();
        if (!reason) { say("理由を入れてください"); return; }
        await P({ action: "returnToHr", reason });
        OI.close();
        return reload();
      }
      if (what === "assign") { await P({ action: "assign", assigneeId: $("oi-as-emp").value }); return done(); }
    } catch (e) { say(e.hint || e.message || "記録できませんでした"); }
  };

  window.OfficeHrIntake = OI;
})();
