// 採用HR 応募者ドロワー：無限道場 体験のパネルと「お礼＋無限道場体験を案内」（api/hr/applicants/lms-trial.js）。
//
// ■ 置き場所
//   hr/applicants.html の概要タブ、NEXT ACTION（.hr-next）のすぐ下。renderDetail() の最後で HrLmsTrial.mount(detail) を呼ぶ。
//   ドロワーの他の部分には触らない（ページのグローバル：API・KPLayout・HRLayout・openHrModal・closeHrModal・refreshDetail を使う）
//
// ■ 見せるもの（LMS が正本。HR には保存しない）
//   体験の段階（未招待／招待済み／期限切れ／登録済み／体験中／体験完了）・進捗・6条件・最終学習日時
//   取れないときは「最新情報を取得できません」と［再試行］（未完了・不合格とは書かない）
//   体験の完了は採用の合格ではない（合否は人が決める。ここでは決めない）
//
// ■ NEXT ACTION との関係（hr/applicants.html nextActionBox が HrLmsTrial.nextAction(a) を呼ぶ）
//   面談後・未案内（採用は「評価待ち」、無限道場リードは段階「体験案内」）なら、NEXT ACTION の主ボタンを
//   ［お礼＋無限道場体験を案内］にする（もとの操作は補助のボタンに残る）。案内後は体験の状況を1行で出す。
//   無限道場の状況を読み終えるまでは、これまでの NEXT ACTION のまま（読み終えたら描き直す）
//
// ■ 送る
//   カジュアル面談を実施済みにした後だけ。文面は画面で直せる。本人専用の URL と期限は、サーバーが送る直前に入れる（画面に出さない）
//   二度押し・通信のやり直しで2通にならない（送信の鍵）。送信済みなら［再送する］を選んだときだけもう1通
(function () {
  "use strict";
  const STYLE = `
    .hr-lms { border:1px solid #d9dce8; border-radius:10px; padding:14px 16px; margin:0 0 16px; background:#fff; }
    .hr-lms .hd { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; font-weight:700; color:#1b2440; }
    .hr-lms .hd .material-symbols-outlined { font-size:18px; color:#3b4a8f; }
    .hr-lms .hd .sp { flex:1; }
    .hr-lms-chip { border-radius:999px; padding:2px 10px; font-size:11.5px; font-weight:700; background:#eef0f6; color:#3b4a6b; }
    .hr-lms-chip[data-stage="done"] { background:#e5f1e2; color:#2f6f3a; }
    .hr-lms-chip[data-stage="active"], .hr-lms-chip[data-stage="registered"], .hr-lms-chip[data-stage="account"] { background:#e8eefc; color:#2a4a9a; }
    .hr-lms-chip[data-stage="expired"], .hr-lms-chip[data-stage="unavailable"] { background:#fbf1d6; color:#8a5a00; }
    .hr-lms .line { font-size:12.5px; color:#4a5068; margin:8px 0 0; line-height:1.7; }
    .hr-lms .bar { height:8px; border-radius:999px; background:#eef0f6; overflow:hidden; margin:10px 0 4px; }
    .hr-lms .bar > i { display:block; height:100%; background:#3b4a8f; }
    .hr-lms ul.cond { list-style:none; padding:0; margin:8px 0 0; display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:4px 12px; }
    .hr-lms ul.cond li { font-size:12.5px; color:#4a5068; display:flex; gap:4px; align-items:center; }
    .hr-lms ul.cond li .material-symbols-outlined { font-size:16px; color:#b8bccb; }
    .hr-lms ul.cond li.on { color:#1b2440; } .hr-lms ul.cond li.on .material-symbols-outlined { color:#2f6f3a; }
    .hr-lms .acts { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
    .hr-lms .acts .btn { min-height:36px; }
    .hr-lms .banner { margin:10px 0 0; }
    .hr-lms details { margin-top:10px; } .hr-lms summary { font-size:12px; cursor:pointer; color:#4a5068; }
  `;
  const URL_TAG = "{{無限道場体験URL}}";
  const OK_TAGS = ["無限道場体験URL", "体験URLの有効期限", "応募者名"];
  const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const STATUS = {
    sent: ["送信済み", "ok"], failed: ["失敗", "ng"], unknown: ["結果不明", "warn"], sending: ["結果不明", "warn"], not_sent: ["未送信", "warn"],
  };
  const LIVE = ["sent", "unknown", "sending"];

  const cache = new Map();   // 応募者ID → { data?, error?, loading? }
  let flow = null;           // 送信モーダルの状態

  const esc = (s) => (window.HRLayout ? HRLayout.esc(s) : String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`));
  const fmt = (iso) => {
    if (!iso) return "—";
    return window.JST ? JST.dateTime(iso) || "—" : new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  };
  const newKey = () => {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  };
  const icon = (n) => `<span class="material-symbols-outlined icon-inline">${n}</span>`;

  function ensureStyle() {
    if (document.getElementById("hr-lms-style")) return;
    const s = document.createElement("style");
    s.id = "hr-lms-style"; s.textContent = STYLE;
    document.head.appendChild(s);
  }

  /** ドロワーを描き直すたびに呼ばれる。概要タブのときだけパネルを置く */
  function mount(detail) {
    const a = detail?.applicant;
    const tab = document.getElementById("hr-detail-tab");
    // detailTab はページの変数（概要タブのときだけ置く）
    if (!a?.id || !tab || (typeof detailTab !== "undefined" && detailTab !== "overview")) return;
    ensureStyle();
    let box = tab.querySelector("[data-lms-trial]");
    if (!box) {
      box = document.createElement("section");
      box.className = "hr-lms"; box.setAttribute("data-lms-trial", "");
      const next = tab.querySelector(".hr-next");
      if (next) next.after(box); else tab.prepend(box);
    }
    box.dataset.applicant = a.id;
    // 開き直し・操作後の描き直しでは、1分以内に読んだものを使う（無限道場へ毎回問い合わせない。［最新にする］で読み直す）
    const c = cache.get(a.id);
    if (!c || (!c.loading && Date.now() - c.at > 60000)) load(a.id);
    else paint(box, c);
  }

  async function load(id) {
    const c = { loading: true, at: Date.now() };
    cache.set(id, c);
    paintAll(id);
    try {
      c.data = await API.api(`/api/hr/applicants/lms-trial?id=${encodeURIComponent(id)}`);
      c.error = null;
    } catch (e) {
      c.error = e.hint || e.message || "読み込めませんでした";
    }
    c.loading = false; c.at = Date.now();
    if (cache.get(id) === c) { paintAll(id); syncNextAction(id); }
  }

  function paintAll(id) {
    const box = document.querySelector(`#hr-detail-tab [data-lms-trial][data-applicant="${CSS.escape(id)}"]`);
    if (box) paint(box, cache.get(id));
  }

  function head(stage, id) {
    return `<div class="hd">${icon("school")}無限道場 体験
      ${stage ? `<span class="hr-lms-chip" data-lms-stage data-stage="${esc(stage.key)}">${esc(stage.label)}</span>` : ""}
      <span class="sp"></span>
      ${id ? `<button class="btn btn-secondary btn-sm" data-lms-refresh onclick="HrLmsTrial.reload('${esc(id)}')" title="無限道場から最新の状況を読み直す">${icon("refresh")}最新にする</button>` : ""}</div>`;
  }

  function paint(box, c) {
    const id = box.dataset.applicant;
    if (!c || c.loading && !c.data) { box.innerHTML = `${head(null)}<p class="line">読み込み中…</p>`; return; }
    if (c.error) {
      box.innerHTML = `${head({ key: "unavailable", label: "取得できません" }, id)}
        <div class="banner warn"><span class="material-symbols-outlined">error</span><div>体験の状況を読み込めませんでした（${esc(c.error)}）。</div></div>`;
      return;
    }
    const d = c.data;
    if (!d.available) { box.remove(); return; }
    if (!d.configured) {
      box.innerHTML = `${head(null)}<p class="line" data-lms-unconfigured>${esc(d.lms?.hint || "無限道場との連携の設定がありません")}。管理者に設定を依頼してください。</p>`;
      return;
    }
    const lms = d.lms || {};
    const stage = lms.ok ? lms.stage : { key: "unavailable", label: "取得できません" };
    const sends = d.sends || [];
    const live = sends.find((s) => LIVE.includes(s.status));
    const hasAccount = lms.ok && ["registered", "active", "done"].includes(stage.key);
    const canInvite = lms.ok ? !hasAccount : true;

    let status = "";
    if (!lms.ok) {
      status = `<div class="banner warn" data-lms-unavailable><span class="material-symbols-outlined">cloud_off</span>
        <div><b>最新情報を取得できません。</b>${esc(lms.hint || "")}<br>
        <button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="HrLmsTrial.reload('${esc(id)}')">再試行</button></div></div>`;
    } else if (hasAccount) {
      const p = lms.progress || {};
      status = `
        <div class="bar" aria-hidden="true"><i style="width:${Number(p.percent) || 0}%"></i></div>
        <p class="line" data-lms-progress>進捗 <b>${esc(p.percent ?? 0)}%</b>・レッスン ${esc(p.lessonsDone ?? 0)}/${esc(p.lessonsTotal ?? 0)}・最終学習 ${esc(fmt(p.lastActivityAt))}</p>
        <ul class="cond" data-lms-conditions>${(lms.conditions || []).map((x) => `<li class="${x.done ? "on" : ""}" data-done="${x.done ? 1 : 0}">
          <span class="material-symbols-outlined">${x.done ? "check_circle" : "radio_button_unchecked"}</span>${esc(x.label)}${x.detail ? `（${esc(x.detail)}）` : ""}</li>`).join("")}</ul>
        ${stage.key === "done" ? `<div class="banner ok" data-lms-done><span class="material-symbols-outlined">task_alt</span>
          <div>体験を完了しました。体験の結果で合否は決まりません。採用判断は面談・評価をもとに、NEXT ACTION から進めてください。
          <br><button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="HrLmsTrial.toDecision()">採用判断へ進む</button></div></div>` : ""}`;
    } else if (stage.key === "account") {
      status = `<p class="line" data-lms-existing>無限道場のアカウントがあります（体験版は未参加）。案内を送ると、本人はログインして［このコースに参加する］を押すだけで始められます。新しい登録は不要で、これまでの学習の記録はそのまま残ります。</p>`;
    } else if (stage.key === "account_invited") {
      status = `<p class="line" data-lms-existing>参加の案内済みです。本人がログインして体験版に参加するのを待っています（新しい登録は不要）。</p>`;
    } else if (stage.key === "invited" || stage.key === "expired") {
      status = `<p class="line">${stage.key === "expired" ? "招待URLの期限が切れています。［再送する］で新しいURLを送れます。" : "本人の登録を待っています。"}</p>`;
    }

    let sendPart = "";
    if (live) {
      const st = STATUS[live.status] || STATUS.unknown;
      sendPart = `<p class="line" data-lms-sent>案内メール：<span class="hr-mail-st ${st[1]}">${esc(st[0])}</span>　${esc(fmt(live.createdAt))}${live.sentByName ? `・${esc(live.sentByName)}` : ""}</p>`;
    }
    const acts = [];
    // NEXT ACTION の主ボタンが［お礼＋無限道場体験を案内］のときは、ここには重ねて出さない
    const inNext = typeof detail !== "undefined" && detail?.applicant?.id === id && nextAction(detail.applicant)?.primary;
    if (canInvite && d.applicant.email && d.interviewDone) {
      if (!live) { if (!inNext) acts.push(`<button class="btn btn-primary btn-sm" data-lms-invite onclick="HrLmsTrial.openSend(false)">${icon("send")}お礼＋無限道場体験を案内</button>`); }
      else if (live.status !== "sending") acts.push(`<button class="btn btn-secondary btn-sm" data-lms-resend onclick="HrLmsTrial.openSend(true)">${icon("forward_to_inbox")}再送する</button>`);
      if (live) acts.push(`<button class="btn btn-secondary btn-sm" data-lms-copy onclick="HrLmsTrial.copyLink(this)">${icon("content_copy")}URLをコピー</button>`);
    }
    let note = "";
    if (inNext) note = `<p class="line" data-lms-in-next>上の NEXT ACTION の［お礼＋無限道場体験を案内］から送れます。</p>`;
    else if (canInvite && !live) {
      if (!d.applicant.email) note = `<p class="line" data-lms-noemail>メールアドレスが未登録です。登録してから案内できます。</p>`;
      else if (!d.interviewDone) note = `<p class="line" data-lms-wait>カジュアル面談を実施済みにすると、お礼＋無限道場体験を案内できます。</p>`;
    }
    const hist = sends.length ? `<details><summary>このご案内の送信記録（${sends.length}件）</summary>
      <ul class="hr-mail-hist">${sends.map((s) => { const st = STATUS[s.status] || STATUS.unknown; return `<li><span class="hr-mail-st ${st[1]}">${esc(st[0])}</span>
        <span class="t">${esc(fmt(s.createdAt))}</span><span class="m">${esc(s.sentByName || "")}${s.error ? `・${esc(s.error)}` : ""}</span></li>`; }).join("")}</ul></details>` : "";

    box.innerHTML = `${head(stage, id)}${status}${sendPart}${note}${acts.length ? `<div class="acts">${acts.join("")}</div>` : ""}${hist}`;
  }

  function reload(id) { load(id); }

  /**
   * NEXT ACTION に出す「無限道場 体験」。読み込み済みのときだけ（まだなら null）
   * @returns {null | {key:string, primary:true, label:string, cta:string} | {key:string, primary:false, line:string}}
   *   line は HTML（エスケープ済み）。key はドロワーに描いた形（変わったときだけ描き直す）
   */
  function nextAction(a) {
    const d = a?.id ? cache.get(a.id)?.data : null;
    if (!d?.available || !d.configured || d.applicant?.id !== a.id) return null;
    const lms = d.lms || {};
    const live = (d.sends || []).find((s) => LIVE.includes(s.status));
    const stageKey = lms.ok ? lms.stage?.key : null;
    const hasAccount = ["registered", "active", "done"].includes(stageKey);
    const lead = typeof isLead === "function" && isLead(a);
    const atStep = lead ? a.stage === "md_trial" : a.status === "eval_pending";
    if (atStep && d.interviewDone && d.applicant.email && !live && !hasAccount) {
      return { key: "primary", primary: true, label: "面談のお礼と、無限道場の体験を案内してください", cta: "お礼＋無限道場体験を案内" };
    }
    if (!live && !hasAccount && !["invited", "expired", "account_invited"].includes(stageKey)) return null;
    const label = lms.ok ? lms.stage.label : "最新情報を取得できません";
    const pct = hasAccount && lms.progress ? `・${Number(lms.progress.percent) || 0}%` : "";
    const tail = stageKey === "done" ? "（体験の結果で合否は決まりません）" : "";
    return { key: `line:${label}${pct}`, primary: false,
      line: `${icon("school")}無限道場 体験：<b>${esc(label)}</b>${esc(pct)}${esc(tail)}　<a href="#" onclick="HrLmsTrial.toPanel();return false;">詳しく見る</a>` };
  }

  /** NEXT ACTION の「詳しく見る」→ 下の体験パネルへ */
  function toPanel() {
    const box = document.querySelector("#hr-detail-tab [data-lms-trial]");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 読み終えたら、NEXT ACTION の出し方が変わるときだけドロワーを描き直す */
  function syncNextAction(id) {
    if (typeof detail === "undefined" || detail?.applicant?.id !== id || typeof renderDetail !== "function") return;
    const box = document.querySelector("#hr-detail-tab .hr-next");
    if (!box) return;
    const na = nextAction(detail.applicant);
    if ((box.dataset.lmsNa || "") !== (na?.key || "")) renderDetail();
  }

  /** 体験完了 → NEXT ACTION（採用判断）へ。押すだけで判断は決まらない */
  function toDecision() {
    const n = document.querySelector("#hr-detail-tab .hr-next");
    if (!n) return;
    n.scrollIntoView({ behavior: "smooth", block: "start" });
    n.style.outline = "3px solid #3b4a8f";
    setTimeout(() => { n.style.outline = ""; }, 1600);
  }

  // ---- 送る（モーダル） --------------------------------------------------------
  function current() {
    const id = typeof detail !== "undefined" ? detail?.applicant?.id : null;   // ページの変数（開いている応募者）
    return id ? cache.get(id)?.data : null;
  }

  function openSend(resend) {
    const d = current();
    if (!d) return;
    const live = (d.sends || []).find((s) => LIVE.includes(s.status));
    flow = { id: d.applicant.id, d, resend: Boolean(resend), key: newKey(), phase: "edit", result: null, live };
    openHrModal(`<div id="lms-modal"></div>`);
    document.getElementById("hr-modal-root").querySelector(".hr-modal").classList.add("wide");
    renderSend(d.draft.subject, d.draft.body);
  }

  function renderSend(subject, body) {
    const f = flow;
    const box = document.getElementById("lms-modal");
    if (!f || !box) return;
    const d = f.d, a = d.applicant;
    const edit = f.phase === "edit";
    const missing = d.draft.missing || [];
    box.innerHTML = `
      <h2 style="font-size:17px;font-weight:700;color:#1b2440;margin:0 0 12px;">${f.resend ? "無限道場体験のご案内を再送" : "お礼＋無限道場体験を案内"}</h2>
      <div class="hr-mail-to">
        <div><span class="lb">宛先</span><b>${esc(a.name)} 様</b> &lt;${esc(a.email)}&gt;</div>
        <div class="sub"><span class="lb">送信元</span>${esc(d.mail?.from || "未設定")}</div>
      </div>
      ${f.resend && f.live ? `<div class="banner warn" style="margin:0 0 10px;"><span class="material-symbols-outlined">forward_to_inbox</span>
        <div>${esc(fmt(f.live.createdAt))} に送っています（${esc((STATUS[f.live.status] || STATUS.unknown)[0])}）。本人に届いていないこと・期限が切れたことを確かめてから送ってください。
        有効な招待があれば同じURL、期限切れなら新しいURLで送ります。</div></div>` : ""}
      <div class="banner info" style="margin:0 0 10px;"><span class="material-symbols-outlined">link</span>
        <div>本人専用の${d.draft.existing ? "参加用URL" : "登録URL"}と有効期限は、送信するときに無限道場から受け取り、${esc(URL_TAG)}・{{体験URLの有効期限}} に入れます（この画面には表示しません。送信記録にも残しません）。</div></div>
      ${d.draft.existing ? `<div class="banner info" style="margin:0 0 10px;" data-lms-existing-mail><span class="material-symbols-outlined">person_check</span>
        <div>この方は、すでに無限道場のアカウントを持っています。ログインして［このコースに参加する］を押す案内の文面です（新しいアカウントは作りません・これまでの学習の記録はそのまま）。</div></div>` : ""}
      ${missing.length ? `<div class="banner warn"><span class="material-symbols-outlined">warning</span><div>${missing.map((m) => `{{${esc(m.key)}}}：${esc(m.reason)}`).join("<br>")}</div></div>` : ""}
      <label>件名</label>
      <input id="lms-subject" type="text" maxlength="200" value="${esc(subject)}" ${edit ? "" : "readonly"}>
      <label style="margin-top:10px;">本文</label>
      <textarea id="lms-body" rows="16" ${edit ? "" : "readonly"}>${esc(body)}</textarea>
      <p class="muted" style="font-size:11.5px;margin:4px 0 0;">ここで直した内容は、このメール1通だけに使います。体験や継続受講は、採用の合否・契約とは関係ないことを本文から消さないでください。</p>
      ${d.mail?.configured ? "" : `<div class="banner warn" style="margin-top:10px;"><span class="material-symbols-outlined">mail</span><div>このシステムからはメールを送れません（${esc(d.mail?.reason || "未設定")}）。</div></div>`}
      <div id="lms-result" style="margin-top:10px;">${f.result ? `<div class="banner ${f.result.cls}" data-lms-result="${esc(f.result.status)}"><span class="material-symbols-outlined">${f.result.cls === "ok" ? "check_circle" : "help"}</span><div><b>${esc(f.result.label)}</b>　${esc(f.result.hint || "")}</div></div>` : ""}</div>
      <div id="lms-msg" class="err-text" style="margin:8px 0 0;"></div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
        ${edit ? `<button class="btn btn-primary" id="lms-send" onclick="HrLmsTrial.send(this)" ${d.mail?.configured ? "" : "disabled"}>${icon("send")}${f.resend ? "再送する" : "送信"}</button>` : ""}
        ${f.phase === "failed" ? `<button class="btn btn-primary" onclick="HrLmsTrial.retry()">内容を確かめて送り直す</button>` : ""}
        <button class="btn btn-secondary" onclick="HrLmsTrial.closeSend()">${edit ? "送らずに閉じる" : "閉じる"}</button>
      </div>`;
  }

  function closeSend() {
    const f = flow;
    if (f?.phase === "edit") {
      const s = document.getElementById("lms-subject"), b = document.getElementById("lms-body");
      if (s && b && (s.value !== f.d.draft.subject || b.value !== f.d.draft.body) && !confirm("直した内容は保存されません（このメールは送っていません）。閉じますか？")) return;
    }
    flow = null;
    closeHrModal();
  }

  function retry() {
    const f = flow;
    if (!f) return;
    f.phase = "edit"; f.key = newKey(); f.result = null;
    renderSend(f.typed?.subject ?? f.d.draft.subject, f.typed?.body ?? f.d.draft.body);
  }

  async function send(btn) {
    const f = flow;
    if (!f || f.sending) return;
    const msg = document.getElementById("lms-msg"); msg.textContent = "";
    const subject = document.getElementById("lms-subject").value, body = document.getElementById("lms-body").value;
    const n = body.split(URL_TAG).length - 1;
    if (n !== 1) { msg.textContent = n ? `${URL_TAG} は本文に1つだけにしてください` : `本文に ${URL_TAG} を入れてください（本人専用の登録URLが入る場所です）`; return; }
    const left = [...`${subject}\n${body}`.matchAll(TAG_RE)].map((m) => m[1]).filter((k) => !OK_TAGS.includes(k));
    if (left.length) { msg.textContent = `使えない差し込み項目があります：${[...new Set(left)].map((k) => `{{${k}}}`).join("・")}`; return; }
    if (/[\r\n]/.test(subject)) { msg.textContent = "件名に改行は使えません"; return; }
    const a = f.d.applicant;
    if (!confirm(`${a.name} 様（${a.email}）へ${f.resend ? "再送" : "送信"}します。無限道場で本人専用の${f.d.draft.existing ? "参加用URL" : "登録URL"}を用意して、このメールに入れます。よろしいですか？`)) return;
    f.sending = true; f.typed = { subject, body };
    let r = null, err = null;
    try {
      r = await KPLayout.busy(btn, "送信中…", () => API.api("/api/hr/applicants/lms-trial", {
        method: "POST", invalidates: [],
        body: { id: f.id, action: "send", subject, body, requestKey: f.key, variant: f.d.draft.existing ? "existing" : "new", ...(f.resend ? { resend: true } : {}) },
      }));
    } catch (e) { err = e; }
    f.sending = false;
    if (flow !== f) return;
    if (err && !err.status) {
      msg.textContent = "通信が切れました。もう一度押すと、送れたかどうかを確かめます（送れていれば2通目は送りません）";
      return;
    }
    if (err) {
      const b = err.body || {};
      if (b.status === "failed" || b.status === "not_sent") {
        f.result = { status: b.status, cls: "warn", label: b.status === "failed" ? "送れませんでした" : "送っていません", hint: err.hint };
        f.phase = "failed";
      } else {
        // 送る前に断られた（面談前・URL の差し込み位置・無限道場の失敗・送信済み など）。メールは送っていない
        msg.textContent = (b.problems || [err.hint || err.message]).join("／");
        if (b.error === "lms_variant_changed") {
          // アカウントの有無が変わった：新しい文面に入れ替えて、確かめてから送ってもらう
          await load(f.id);
          const nd = cache.get(f.id)?.data;
          if (flow === f && nd?.draft) { f.d = nd; f.key = newKey(); renderSend(nd.draft.subject, nd.draft.body); document.getElementById("lms-msg").textContent = err.hint || ""; }
          return;
        }
        if (["already_sent", "lms_already_registered", "lms_already_enrolled"].includes(b.error)) { cache.delete(f.id); load(f.id); }
        return;
      }
    } else {
      const sent = r.status === "sent";
      f.result = { status: r.status, cls: sent ? "ok" : "warn", label: sent ? "送信済み" : "結果不明",
        hint: r.duplicate ? "同じ送信の2回目なので、送り直していません" : sent ? `メールサービスが受け付けました（相手に届いた・開いた、ではありません）。URLの有効期限：${fmt(r.invite?.expiresAt)}` : r.hint };
      f.phase = sent ? "sent" : "unknown";
    }
    renderSend(subject, body);
    load(f.id);
    if (f.phase === "sent" && typeof refreshDetail === "function") refreshDetail().catch(() => {});
  }

  /** 本人専用 URL を手で渡す（クリップボードへ。画面にも記録にも残さない。コピーできない端末だけ表示） */
  async function copyLink(btn) {
    const d = current();
    if (!d) return;
    if (!confirm(`本人専用の${d.draft?.existing ? "参加用URL" : "登録URL"}をコピーします。本人以外に送らないでください。よろしいですか？`)) return;
    let r;
    try {
      r = await KPLayout.busy(btn, "準備中…", () => API.api("/api/hr/applicants/lms-trial", { method: "POST", invalidates: [], body: { id: d.applicant.id, action: "link" } }));
    } catch (e) { alert(e.hint || e.message || "URLを用意できませんでした"); return; }
    try {
      await navigator.clipboard.writeText(r.url);
      alert(`コピーしました（有効期限：${fmt(r.expiresAt)}）。本人以外に送らないでください。`);
    } catch {
      openHrModal(`<h2 style="font-size:17px;font-weight:700;color:#1b2440;margin:0 0 10px;">本人専用の${r.existing ? "参加用URL（ログインして参加）" : "登録URL"}</h2>
        <p class="hr-sub" style="margin:0 0 8px;">自動でコピーできませんでした。選択してコピーしてください（有効期限：${esc(fmt(r.expiresAt))}）。本人以外に送らないでください。</p>
        <input type="text" readonly value="${esc(r.url)}" onfocus="this.select()" data-lms-url>
        <div style="display:flex;gap:8px;margin-top:12px;"><button class="btn btn-secondary" onclick="closeHrModal()">閉じる</button></div>`);
    }
  }

  window.HrLmsTrial = { mount, reload, nextAction, toPanel, openSend, closeSend, send, retry, copyLink, toDecision, _cache: cache };
})();
