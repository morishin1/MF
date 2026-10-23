/* KEIEI｜休暇・稟議の最終承認。API は role=owner を再検証する。 */
(function () {
  "use strict";
  const esc = (s) => window.KeieiLayout.esc(s);
  const fmt = (v) => v ? new Date(v + "T00:00:00+09:00").toLocaleDateString("ja-JP",{month:"long",day:"numeric",timeZone:"Asia/Tokyo"}) : "";
  const typeNames = {paid:"有給",am:"午前半休",pm:"午後半休",special:"特別休暇",absence:"欠勤"};
  const states = {approved:"承認済み",rejected:"却下",cancelled:"取消"};
  let generation = 0, working = false;
  let requests = [];
  let root = null, stale = () => true;

  function summary(r) {
    return r.kind === "leave"
      ? (r.starts_on === r.ends_on ? fmt(r.starts_on) : fmt(r.starts_on) + "〜" + fmt(r.ends_on))
        + " · " + esc(r.days) + "日 · " + esc(typeNames[r.leave_type] || "休暇")
      : (r.amount != null ? Number(r.amount).toLocaleString("ja-JP") + "円" : "金額指定なし");
  }
  function card(r, action) {
    return '<article class="kei-approval-row">'
      + '<div class="kei-approval-line"><span class="kei-pill '+ (action ? "mid":"ok")+'">'
      + (action ? "最終承認待ち" : esc(states[r.status] || r.status)) + '</span>'
      + '<span class="kei-approval-kind">'+(r.kind === "leave" ? "休暇" : "稟議")+'</span>'
      + '<span class="kei-approval-date">'+esc(summary(r))+'</span></div>'
      + '<div class="kei-approval-title">'+esc(r.title)+'</div>'
      + '<div class="kei-approval-sub">申請者：'+esc(r.applicant?.display_name || "不明")
      + ' ／ '+esc(r.created_at ? new Date(r.created_at).toLocaleDateString("ja-JP") : "")+'</div>'
      + (r.body ? '<div class="kei-approval-body">'+esc(r.body)+'</div>' : "")
      + (r.gcal_error && r.status === "approved" ? '<div class="kei-approval-warn">承認は完了しています。Googleカレンダーのみ未反映です。<button type="button" class="kei-btn sm sec" data-action="retry" data-id="'+esc(r.id)+'">再同期する</button></div>' : "")
      + (action ? '<div class="kei-approval-actions"><input type="text" class="kei-approval-note" data-note="'+esc(r.id)+'" placeholder="コメント（任意）" maxlength="500">'
      + '<button class="kei-btn sm" type="button" data-action="approve" data-id="'+esc(r.id)+'">最終承認</button>'
      + '<button class="kei-btn sm sec" type="button" data-action="reject" data-id="'+esc(r.id)+'">却下</button></div>' : "")
      + '</article>';
  }
  function render(message = "", warning = false) {
    if (!root || stale()) return;
    const pending = requests.filter(r => r.status === "pending_owner");
    const done = requests.filter(r => ["approved","rejected","cancelled"].includes(r.status)).slice(0,10);
    root.innerHTML =
      '<h1 class="kei-title">休暇・稟議の最終承認</h1>'
      + '<p class="kei-sub">メンバーから申請 → Officeが一次承認 → KEIEIで最終承認。最終承認まで休暇は確定しません。</p>'
      + '<div role="status" class="kei-approval-feedback'+(warning ? " warn" : "")+'">'+esc(message)+'</div>'
      + '<section class="kei-sec"><h2 class="kei-sec-h">経営の承認待ち <span class="kei-count">'+pending.length+'件</span></h2>'
      + '<div class="kei-approval-list">'+(pending.length ? pending.map(r=>card(r,true)).join("") : '<div class="kei-none">現在、最終承認待ちはありません。</div>')+'</div></section>'
      + '<section class="kei-sec"><h2 class="kei-sec-h">最近の処理</h2>'
      + '<div class="kei-approval-list">'+(done.length ? done.map(r=>card(r,false)).join("") : '<div class="kei-none">処理履歴はまだありません。</div>')+'</div></section>';
  }
  async function reload(message = "", warning = false) {
    const res = await API.listRequests("all");
    if (stale()) return;
    requests = res.requests || [];
    render(message, warning);
  }
  async function onClick(event) {
    const btn = event.target.closest("button[data-action]");
    if (!btn || working || stale()) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const row = requests.find(r => r.id === id && (r.status === "pending_owner" || (action === "retry" && r.status === "approved" && r.kind === "leave")));
    if (!row) { render("この申請はすでに処理されています。再読み込みしてください。", true); return; }
    if (action === "reject" && !confirm("この申請を却下しますか？")) return;
    const note = action === "retry" ? null : root.querySelector('[data-note="'+CSS.escape(id)+'"]')?.value.trim() || null;
    working = true;
    btn.disabled = true;
    try {
      const result = await API.decideRequest(id, action === "retry" ? "approve" : action, note);
      const calendarWarn = !!result.calendar?.error;
      await reload(calendarWarn
        ? "最終承認は保存されました。Googleカレンダーへの反映だけ失敗しています（管理者による再同期が必要）。"
        : (action === "retry" ? "Googleカレンダーへの再同期が完了しました。" : action === "approve" ? "最終承認が完了しました。申請者へ通知します。" : "却下しました。"),
        calendarWarn);
    } catch (e) {
      try { await reload(e.hint || e.message || "処理に失敗しました。", true); }
      catch { render("処理結果を確認できません。画面を開き直してください。", true); }
    } finally { working = false; if (btn.isConnected) btn.disabled = false; }
  }
  async function open(container, isStale) {
    generation++;
    root = container;
    stale = isStale;
    root.innerHTML = '<div class="kei-empty">最終承認待ちを読み込み中…</div>';
    // CSS はこのビューだけ。KEIEI全体の見た目にそろえる。
    if (!document.getElementById("kei-approval-style")) {
      const style = document.createElement("style");
      style.id = "kei-approval-style";
      style.textContent =
        '.kei-approval-list{display:grid;gap:9px}.kei-approval-row{background:#fff;border:1px solid #e2e2dc;border-radius:11px;padding:15px 17px}'
        + '.kei-approval-line{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px}'
        + '.kei-approval-kind{font-weight:700;color:#4a5068}.kei-approval-date{margin-left:auto;color:#6b7080}'
        + '.kei-approval-title{margin-top:8px;font-size:15px;font-weight:700;color:#1b2440}'
        + '.kei-approval-sub{margin-top:5px;font-size:12px;color:#6b7080}'
        + '.kei-approval-body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font-size:12.5px;line-height:1.7;margin-top:9px;padding:9px;background:#f8f9fa;border-radius:7px}'
        + '.kei-approval-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}'
        + '.kei-approval-note{flex:1;min-width:180px;max-width:320px;padding:8px;border:1px solid #c7cad4;border-radius:8px;font:inherit;font-size:13px}'
        + '.kei-approval-feedback:not(:empty){margin:0 0 12px;padding:10px 12px;color:#256b36;background:#f3faf5;border-radius:8px;font-size:13px}'
        + '.kei-approval-feedback.warn{color:#9d5710;background:#fffaf0}'
        + '.kei-approval-warn{font-size:12px;color:#9d5710;margin-top:8px}'
        + '@media(max-width:600px){.kei-approval-date{margin-left:0;width:100%}.kei-approval-note{max-width:none;width:100%}.kei-approval-actions .kei-btn{flex:1;justify-content:center}}';
      document.head.appendChild(style);
    }
    root.removeEventListener("click", onClick);
    root.addEventListener("click", onClick);
    try { await reload(); } catch (e) {
      if (!stale()) root.textContent = "承認待ちを取得できませんでした：" + (e.hint || e.message || "読み込みエラー");
    }
  }
  window.KeieiRequests = { open };
})();