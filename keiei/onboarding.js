// 経営（/keiei）の「入社準備」1人ぶんの詳細。入社案内を作り、案内URLを発行し、案内メールを送る。
//
// ■ 何をここでしないか
//   ・6ステップの状態は、サーバが返したもの（/api/keiei/onboarding の six）をそのまま出す。ここで判定しない
//   ・労働条件（給与）・契約書の作成・署名は、これまでの画面で行う。ここには金額を出さない・入れさせない
//   ・メールの送信先・送信元は、ここで決めない（宛先は名簿、送信元はサーバの環境変数）
//   ・メールが未設定なら、送信ボタンは押せず、「案内URLを発行」から、URLをコピーして渡す
//
// index.html（/keiei）から window.KeieiOnb.open(employeeId, mainElement, isStale) で呼ばれる。
(function () {
  const esc = window.KeieiLayout ? window.KeieiLayout.esc
    : (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MISSING = "データ未連携";
  const GLYPH = { done: "✓", current: "△", todo: "○", na: "–", unlinked: "—" };
  const STATE = { done: "完了", current: "要対応", todo: "これから", na: "対象外", unlinked: MISSING };

  const jp = (iso) => {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const j = new Date(t + 9 * 3600000);
    return `${j.getUTCFullYear()}/${j.getUTCMonth() + 1}/${j.getUTCDate()} ${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
  };
  const jpDay = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "");

  let main = null;
  let empId = null;
  let D = null;
  // 画面に出すだけの一時の値（URL はこの応答にしか含まれない）
  let T = { url: null, expiresAt: null, preview: null, body: null, msg: null, err: null };
  const isCurrent = () => location.hash === `#onboarding/${encodeURIComponent(empId)}` || location.hash === `#onboarding/${empId}`;

  async function call(action, extra = {}) {
    return API.api("/api/keiei/onboarding", { method: "POST", body: { action, employeeId: empId, ...extra } });
  }

  // ---- 部品 ------------------------------------------------------------------
  const banner = (text, kind = "") => `<div class="kei-banner ${kind}">${esc(text)}</div>`;

  function stepHtml(s) {
    return `<div class="kei-st ${esc(s.state)}" data-step="${esc(s.key)}" data-state="${esc(s.state)}">
      <div class="t"><span class="g" title="${esc(STATE[s.state] || "")}">${GLYPH[s.state] || "○"}</span>${s.n}. ${esc(s.label)}</div>
      <div class="nt">${s.state === "unlinked" ? `<b>${MISSING}</b><br>${esc(s.note || "")}` : esc(s.note || "")}</div>
      ${s.state === "current" && s.actorLabel ? `<div class="who">担当：${esc(s.actorLabel)}</div>` : ""}</div>`;
  }

  function guideSection(d) {
    const g = d.guide;
    if (!g.linked) return `<div class="kei-panel" data-section="guide"><h3 class="kei-h3">入社案内</h3>${banner(g.hint || `${MISSING}`, "warn")}</div>`;
    const a = g.autofill;
    const auto = [["お名前", a.name], ["入社日", jpDay(a.joinOn)], ["所属", a.department], ["役職", a.position], ["担当", a.role]]
      .map(([l, v]) => `<dt>${esc(l)}</dt><dd>${v ? esc(v) : `<span class="kei-mute">未登録</span>`}</dd>`).join("");
    const inputs = g.fields.map((f) => {
      const v = g.draft[f.key] || "";
      const ctl = f.multiline
        ? `<textarea name="${esc(f.key)}" rows="3" maxlength="${f.max}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`
        : `<input type="text" name="${esc(f.key)}" maxlength="${f.max}" value="${esc(v)}" placeholder="${esc(f.placeholder || "")}">`;
      return `<label class="kei-f${f.multiline ? " wide" : ""}"><span>${esc(f.label)}</span>${ctl}</label>`;
    }).join("");

    const issued = g.version > 0;
    let status;
    if (!issued) status = `<span class="kei-pill miss">未発行</span> 発行すると、本人が確認できるようになります。`;
    else {
      const conf = g.confirmedVersion != null && g.confirmedVersion >= g.version;
      status = `<span class="kei-pill ok">発行済み 版${g.version}</span>（${esc(jp(g.issuedAt))}）　本人の確認：${conf
        ? `<b>確認済み</b>（${esc(jp(g.confirmedAt))}）`
        : `<b>確認待ち</b>${g.confirmedVersion != null ? `（前の版${g.confirmedVersion}は確認済み）` : ""}`}`;
    }
    const warn = g.missing.length ? banner(`発行前の確認：${g.missing.join("・")} が未入力です（空のまま発行もできます）`, "warn") : "";
    return `<div class="kei-panel" data-section="guide">
      <h3 class="kei-h3">入社案内（本人に見せる内容）</h3>
      <div class="kei-sub" style="margin:0 0 10px;">${status}</div>
      <dl class="kei-dl">${auto}</dl>
      <div class="kei-note">上の5つは、名簿・入社手続きから入ります（ここでは直せません）。給与・手当の金額は書けません（労働条件通知書で、本人にお伝えします）。</div>
      <form id="guide-form" class="kei-form">${inputs}</form>
      ${warn}
      <div id="guide-err" class="kei-err">${T.err && T.err.at === "guide" ? esc(T.err.text) : ""}</div>
      <button class="kei-btn sec" data-act="save">下書きを保存</button>
      <button class="kei-btn" data-act="issue" ${issued && !g.dirty ? "disabled" : ""}>${issued ? `発行し直す（版${g.version + 1}）` : "発行する"}</button>
      ${issued && !g.dirty ? `<span class="kei-mute">前回の発行から、変わっていません</span>` : ""}
      ${issued && g.dirty ? `<span class="kei-mute">前回の発行から変わっています。発行し直すと、本人は確認し直します</span>` : ""}
    </div>`;
  }

  const INV = { active: "有効", expired: "期限切れ", revoked: "失効" };
  function inviteSection(d) {
    const g = d.guide;
    if (!g.linked || !(g.version > 0)) return "";
    const url = T.url ? `<div class="kei-urlbox" data-role="invite-url">
        <input type="text" id="invite-url" readonly value="${esc(T.url)}" onclick="this.select()">
        <button class="kei-btn" data-act="copy">URLをコピー</button>
        <div class="kei-note">このURLは、いま表示しているときだけ見えます（あとから取り出せません。必要なら発行し直してください）。
          有効期限：${esc(jp(T.expiresAt))}。前のURLは使えなくなりました。パスワードの代わりにはならず、案内を読むためのURLです。</div>
      </div>` : "";
    const rows = d.invites.map((i) => `<tr>
        <td>${esc(jp(i.createdAt))}</td><td>${esc(jp(i.expiresAt))}</td>
        <td><span class="kei-pill ${i.status === "active" ? "ok" : "miss"}">${INV[i.status] || esc(i.status)}</span></td>
        <td class="n">${i.openCount ? `${i.openCount}回（最後 ${esc(jp(i.lastOpenedAt))}）` : "未開封"}</td>
        <td>${i.status === "active" ? `<button class="kei-btn sec sm" data-act="revoke" data-id="${esc(i.id)}">失効させる</button>` : ""}</td></tr>`).join("");
    return `<div class="kei-panel" data-section="invite">
      <h3 class="kei-h3">案内URL</h3>
      <div class="kei-sub" style="margin:0 0 8px;">本人がログイン前に案内を読める、期限つきのURLです。メールを使わずに、チャットなどで渡すこともできます。</div>
      <label class="kei-inline">有効期間 <select id="invite-days"><option value="7">7日</option><option value="14">14日</option><option value="30">30日</option></select></label>
      <button class="kei-btn" data-act="invite">案内URLを発行（コピー用）</button>
      ${url}
      <div id="invite-err" class="kei-err">${T.err && T.err.at === "invite" ? esc(T.err.text) : ""}</div>
      ${d.invites.length ? `<div class="kei-tw"><table class="kei-t"><thead><tr><th>発行</th><th>期限</th><th>状態</th><th>開いた</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    </div>`;
  }

  const MAILST = { sent: "送信済み", failed: "失敗", skipped: "未送信" };
  function mailSection(d) {
    const g = d.guide;
    if (!g.linked || !(g.version > 0)) return "";
    const m = d.mail;
    const cfg = m.config;
    const status = cfg.configured
      ? `<div class="kei-note">送信元：${esc(cfg.fromAddress || "")}（送信サービス：${esc(cfg.provider || "")}）。パスワードは書きません。本文には、期限つきの案内URLだけが入ります。</div>`
      : banner(`メール送信は使えません（${cfg.reason || "未設定"}）。上の「案内URLを発行」から、URLをコピーして本人へお渡しください。`, "warn");
    const canSend = cfg.configured && Boolean(m.to);
    const preview = T.preview ? `<div class="kei-mailbox" data-role="mail-preview">
        <div><span>宛先</span>${esc(T.preview.to || "（メールアドレスが未登録です）")}</div>
        <div><span>送信元</span>${esc(T.preview.from || "（未設定）")}</div>
        <div><span>件名</span>${esc(T.preview.subject)}</div>
        <pre>${esc(T.preview.body)}</pre>
        <div class="kei-note">URLは、送信するときに、この人だけの期限つきのものが入ります。</div></div>` : "";
    const hist = m.history.map((h) => `<tr>
        <td>${esc(jp(h.at))}</td><td>${esc(h.label)}</td><td>${esc(h.to)}</td>
        <td><span class="kei-pill ${h.status === "sent" ? "ok" : "miss"}">${MAILST[h.status] || esc(h.status)}</span>${h.error ? `<div class="kei-note">${esc(h.error)}</div>` : ""}</td>
        <td>${esc(h.by || "")}</td><td>${esc(h.subject)}</td>
        <td><button class="kei-btn sec sm" data-act="body" data-id="${esc(h.id)}">本文</button></td></tr>`).join("");
    const body = T.body ? `<div class="kei-mailbox" data-role="mail-body"><div><span>件名</span>${esc(T.body.subject)}</div><pre>${esc(T.body.body)}</pre>
        <div class="kei-note">送った本文の確定版です。URLのトークン部分だけは、安全のため保存していません（どのURLかは、案内URLの一覧で分かります）。</div></div>` : "";
    return `<div class="kei-panel" data-section="mail">
      <h3 class="kei-h3">案内メール</h3>
      ${status}
      <div class="kei-sub" style="margin:0 0 8px;">宛先：${m.to ? esc(m.to) : `<b>名簿にメールアドレスがありません</b>`}</div>
      <button class="kei-btn sec" data-act="preview">メールの文面を見る</button>
      <button class="kei-btn sec" data-act="test" ${cfg.configured && m.canTest ? "" : "disabled"}>テスト送信（自分あて）</button>
      <button class="kei-btn" data-act="send" ${canSend ? "" : "disabled"}>${m.history.some((h) => h.kind === "send" && h.status === "sent") ? "再送する" : "本人へ送信"}</button>
      ${preview}
      <div id="mail-err" class="kei-err">${T.err && T.err.at === "mail" ? esc(T.err.text) : ""}</div>
      ${T.msg ? `<div class="kei-okmsg" data-role="msg">${esc(T.msg)}</div>` : ""}
      ${m.history.length ? `<div class="kei-h" style="margin-top:16px;">送信履歴</div><div class="kei-tw"><table class="kei-t"><thead><tr><th>日時</th><th>種別</th><th>宛先</th><th>結果</th><th>送信者</th><th>件名</th><th></th></tr></thead><tbody>${hist}</tbody></table></div>` : ""}
      ${body}
    </div>`;
  }

  function render() {
    const d = D;
    const e = d.employee;
    const sub = [e.department, e.position].filter(Boolean).join("・") + (e.joinOn ? `　${jpDay(e.joinOn)} 入社` : "");
    main.innerHTML = `
      <a class="kei-back2" href="#onboarding">← 入社準備の一覧へ</a>
      <h1 class="kei-title" data-role="title">${esc(e.name)}</h1><p class="kei-sub">${esc(sub)}</p>
      <div class="kei-six">${d.six.steps.map(stepHtml).join("")}</div>
      <div class="kei-note" style="margin:8px 0 16px;">次にやること：<b>${esc(d.six.next.label)}</b>${d.six.next.actorLabel ? `（${esc(d.six.next.actorLabel)}）` : ""}。
        労働条件・契約・書類の確認は、これまでの画面で行います（<a href="/admin-hr.html${d.procedureId ? `?id=${encodeURIComponent(d.procedureId)}` : ""}">入退社の手続き</a>）。</div>
      ${guideSection(d)}${inviteSection(d)}${mailSection(d)}`;
    bind();
  }

  // ---- 操作 ------------------------------------------------------------------
  const fields = () => {
    const f = main.querySelector("#guide-form");
    return f ? Object.fromEntries([...new FormData(f).entries()].map(([k, v]) => [k, String(v)])) : {};
  };
  const setErr = (at, e) => { T.err = { at, text: (e && (e.hint || e.detail || e.message)) || "できませんでした" }; };

  async function run(btn, at, fn) {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = "…"; }
    T.err = null; T.msg = null;
    try { await fn(); }
    catch (e) { setErr(at, e); }
    if (!isCurrent() || !main) return;
    render();
    // 失敗を、押したボタンの近くに見せる
    const box = main.querySelector(`#${at}-err`);
    if (box && T.err) box.scrollIntoView({ block: "nearest" });
  }

  const actions = {
    save: (btn) => run(btn, "guide", async () => { D = await call("save_guide", { fields: fields() }); T.msg = null; }),
    issue: (btn) => run(btn, "guide", async () => {
      D = await call("save_guide", { fields: fields() });
      D = await call("issue_guide");
    }),
    invite: (btn) => run(btn, "invite", async () => {
      const days = Number(main.querySelector("#invite-days")?.value || 7);
      const r = await call("create_invite", { days });
      D = r; T.url = r.invite.url; T.expiresAt = r.invite.expiresAt;
    }),
    revoke: (btn) => run(btn, "invite", async () => {
      if (!confirm("このURLを使えなくします。よろしいですか。")) return;
      D = await call("revoke_invite", { inviteId: btn.dataset.id }); T.url = null;
    }),
    copy: async (btn) => {
      const input = main.querySelector("#invite-url");
      try { await navigator.clipboard.writeText(input.value); btn.textContent = "コピーしました"; }
      catch { input.select(); try { document.execCommand("copy"); btn.textContent = "コピーしました"; } catch { btn.textContent = "選択しました。コピーしてください"; } }
    },
    preview: (btn) => run(btn, "mail", async () => {
      const r = await call("preview_mail");
      T.preview = r.preview;
    }),
    test: (btn) => run(btn, "mail", async () => {
      const r = await call("test_mail"); D = r; T.msg = `テスト送信しました（宛先：${r.result.to}）`;
    }),
    send: (btn) => run(btn, "mail", async () => {
      const e = D.employee;
      if (!confirm(`${e.name} さん（${D.mail.to}）へ、入社案内のメールを送ります。よろしいですか。\n\n送った内容は、履歴に残ります。`)) return;
      const r = await call("send_mail"); D = r; T.url = null; T.msg = `${e.name} さんへ送信しました（${r.result.to}）`;
    }),
    body: (btn) => run(btn, "mail", async () => {
      const r = await API.api(`/api/keiei/onboarding?employeeId=${encodeURIComponent(empId)}&mailId=${encodeURIComponent(btn.dataset.id)}`);
      T.body = r.mail;
    }),
  };

  function bind() {
    for (const b of main.querySelectorAll("[data-act]")) {
      b.addEventListener("click", () => { const fn = actions[b.dataset.act]; if (fn) fn(b); });
    }
  }

  // ---- 入口 ------------------------------------------------------------------
  async function open(id, mount, isStale) {
    main = mount; empId = id;
    T = { url: null, expiresAt: null, preview: null, body: null, msg: null, err: null };
    try {
      D = await API.api(`/api/keiei/onboarding?employeeId=${encodeURIComponent(id)}`);
    } catch (e) {
      if (isStale && isStale()) return;
      if (e.code === "mfa_required") return;                 // api-client がマイページへ送る
      if (e.status === 403) { location.replace("/home.html"); return; }
      main.innerHTML = `<a class="kei-back2" href="#onboarding">← 入社準備の一覧へ</a>${banner(e.hint || e.message || "読み込めませんでした", "err")}`;
      return;
    }
    if (isStale && isStale()) return;
    render();
    window.scrollTo(0, 0);
  }

  window.KeieiOnb = { open };
})();
