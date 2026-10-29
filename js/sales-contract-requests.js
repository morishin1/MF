// ENGER合格の確認 → Officeへの明示的な書類作成依頼。
// 提案のstatus/handoff/task/成約・署名は変更しない。既存一覧やPR205ブラストとは独立。
(function () {
  "use strict";
  const ENDPOINT = "/api/sales/proposals/contract-requests";
  const TYPES = [
    ["", "契約種別を選択してください"], ["client_ses", "顧客向けSES契約"],
    ["bp_order", "BP向け注文書"], ["employment", "本人向け雇用契約"],
    ["contractor", "本人向け業務委託契約"], ["needs_confirmation", "要確認（Officeへ相談）"],
  ];
  const LABELS = { requested: "Office未着手", in_progress: "作成中", review: "確認待ち", completed: "作成完了", cancelled: "取り消し" };
  const ACTIONS = { create: "作成依頼", update: "Office更新", cancel: "取り消し", resubmit: "Salesから再依頼", reopen: "Officeで再開" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const typeName = (v) => TYPES.find((t) => t[0] === v)?.[1] || "要確認";
  const statusName = (r) => r ? LABELS[r.status] || "状態を確認" : "Office未依頼";
  const selectedRows = (rows, filter) => rows.filter((r) => {
    if (filter === "accepted") return r.accepted;
    if (filter === "unrequested") return r.accepted && !r.request;
    if (filter === "working") return r.request && ["requested", "in_progress", "review"].includes(r.request.status);
    if (filter === "completed") return r.request?.status === "completed";
    return true;
  });
  const message = (e) => e?.hint || (e?.code === "not_ready"
    ? "契約書作成依頼のDB設定がまだです。管理者によるSQL適用後に利用できます。"
    : e?.status === 409 ? "別の更新がありました。最新状態を確認し、もう一度操作してください。" : e?.message || "取得できませんでした。");
  let root, dialog, rows = [], ready = false, filter = null, query = "", listSeq = 0, dialogSeq = 0;
  let canOffice = false, submitting = false, detailStale = false, returnFocus = null, current = null, latestNotice = "", truncated = false;

  function listMarkup() {
    const subset = selectedRows(rows, filter).filter((r) => !query || [r.companyName, r.title, r.talentInitials].join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return `<div class="cr-toolbar"><label>合格・契約依頼を検索 <input data-cr-search type="search" value="${esc(query)}" placeholder="企業・案件・人材"></label>
      <button type="button" class="btn btn-secondary btn-sm" data-cr-filter="all">すべて</button>
      <button type="button" class="btn btn-secondary btn-sm" data-cr-collapse>閉じる</button></div>
      <p class="cr-note">${subset.length}件。上の営業一覧の担当・サービス条件とは独立した一覧です。</p>
      <div class="cr-list">${subset.length ? subset.map((r) => `<article class="cr-row">
        <div class="cr-row-main"><strong>${esc(r.companyName)}</strong><div>${esc(r.title)}</div>
          <div class="cr-meta">${esc(r.talentInitials || "人材情報なし")} ・ ${r.accepted ? "ENGER合格記録あり" : "現在の合格根拠は未確認"}${r.archived ? " ・ アーカイブ済み" : ""}</div><div class="cr-meta">ENGERの現在ステージ：${esc(r.sourceStage || "未確認")}</div></div>
        <div><span class="cr-status" data-status="${esc(r.request?.status || '')}">${esc(statusName(r.request))}</span>
          <div class="cr-meta">${r.request?.requestedDueOn ? "作成希望日 " + esc(r.request.requestedDueOn) : ""}</div>
          <div class="cr-meta">${r.request?.assigneeName ? "Office担当 " + esc(r.request.assigneeName) : ""}</div></div>
        <div class="cr-actions"><button type="button" class="btn btn-secondary btn-sm" data-cr-open="${esc(r.proposalId)}">${!r.request && r.canRequest ? "Officeへ作成依頼" : "詳細・進捗"}</button>
          <a class="btn btn-secondary btn-sm" href="/sales/proposals.html?id=${encodeURIComponent(r.proposalId)}">提案を開く</a></div></article>`).join("") : '<p class="cr-note">この条件の記録はありません。</p>'}</div>`;
  }
  function render() {
    if (!root) return;
    const cards = [["accepted", "合格（ENGER記録）"], ["unrequested", "Office未依頼"], ["working", "Office対応中"], ["completed", "作成完了"]];
    root.className = "cr-section";
    root.innerHTML = `<div class="cr-heading"><h2>合格後の契約書作成</h2>
      <button type="button" class="btn btn-secondary btn-sm" data-cr-refresh>更新</button></div>
      <p class="cr-note">合格は成約・稼働と別の記録です。Officeへの作成依頼は内容を確認して登録します。作成完了は送付・署名・締結を意味しません。</p>
      ${latestNotice ? `<p class="cr-message ${ready ? "" : "warn"}" role="status">${esc(latestNotice)}</p>` : ""}
      <div class="cr-cards">${cards.map(([key, label]) => `<button type="button" class="cr-card ${filter === key ? "on" : ""}" data-cr-filter="${key}" aria-expanded="${filter === key}" aria-controls="sales-contract-results" ${ready ? "" : "disabled"}>
        <span>${label}</span><strong>${ready ? selectedRows(rows, key).length + "件" : "—"}</strong></button>`).join("")}</div>
      ${truncated ? '<p class="cr-message warn">取得上限に達しています。件数は取得できた範囲のみです。</p>' : ""}
      <div id="sales-contract-results" ${filter && ready ? "" : "hidden"}>${filter && ready ? listMarkup() : ""}</div>`;
  }
  async function load() {
    const token = ++listSeq;
    latestNotice = "合格・契約依頼を読み込み中…";
    ready = false;
    render();
    try {
      const result = await API.api(ENDPOINT);
      if (token !== listSeq) return;
      if (result.ready !== true || !Array.isArray(result.rows)) throw new Error("契約依頼の利用状態を確認できませんでした。");
      rows = result.rows; ready = true; truncated = Boolean(result.truncated); latestNotice = "";
      render();
    } catch (e) {
      if (token !== listSeq) return;
      rows = []; ready = false; truncated = false; latestNotice = message(e); render();
    }
  }
  function close() {
    ++dialogSeq;
    current = null;
    if (dialog?.open) dialog.close();
    const target = returnFocus;
    if (target?.isConnected) target.focus();
    else root?.querySelector("[data-cr-refresh]")?.focus();
  }
  function detailBody(row) {
    const r = row.request;
    const accepted = row.accepted ? "ENGERから受信した合格記録を確認しています。" : "現在の合格根拠が確認できません。新規依頼・再依頼はできません。";
    return `<div class="cr-meta">${esc(row.title)}${row.talentInitials ? " ・ " + esc(row.talentInitials) : ""}</div>
      <p class="cr-note">${accepted}</p>
      <p class="cr-note">ENGERの現在ステージ：${esc(row.sourceStage || "未確認")}<br>合格の根拠：${esc(row.acceptedEvidence || (row.accepted ? "保存済みの合格記録" : "未確認"))}</p>
      <p><span class="cr-status" data-status="${esc(r?.status || '')}">${esc(statusName(r))}</span></p>
      ${r ? `<dl class="cr-fields"><div class="cr-field"><dt>契約種別</dt><dd>${esc(typeName(r.contractType))}</dd></div>
        <div class="cr-field"><dt>Office担当</dt><dd>${esc(r.assigneeName || "未設定")}</dd></div>
        <div class="cr-field"><dt>作成希望日</dt><dd>${esc(r.requestedDueOn || "未設定")}</dd></div>
        <div class="cr-field"><dt>稼働開始予定日</dt><dd>${esc(r.plannedStartOn || "未設定")}</dd></div>
        <div class="cr-field full"><dt>依頼内容</dt><dd style="white-space:pre-wrap">${esc(r.note || "—")}</dd></div>
        <div class="cr-field full"><dt>作成書類の管理場所・参照番号</dt><dd style="white-space:pre-wrap">${esc(r.artifactReference || "未登録")}</dd></div></dl>` : ""}
      <p class="cr-note">依頼登録では契約書の自動生成・外部送信・署名依頼を行いません。</p>
      ${canOffice && r ? `<p><a href="/office/contract-requests.html?proposalId=${encodeURIComponent(row.proposalId)}">Officeで作成依頼を確認</a></p>` : ""}
      ${r ? historyMarkup(r.history, r.historyTruncated) : ""}`;
  }
  function historyMarkup(events, isTruncated) {
    if (!Array.isArray(events) || !events.length) return '<p class="cr-note">更新履歴はまだありません。</p>';
    return `<details><summary>更新履歴（${events.length}件）</summary>${isTruncated ? '<p class="cr-note">最新100件の履歴を表示しています。</p>' : ''}<div class="cr-history">${events.map((h) => `<div class="cr-history-item">
      <strong>${esc(h.actionLabel || ACTIONS[h.action] || h.action || "更新")}</strong> <span>${esc(h.createdAt || h.at || "")}</span>
      <div>${esc(h.actorName || "")}</div><div style="white-space:pre-wrap">${esc(h.reason || "")}</div></div>`).join("")}</div></details>`;
  }
  function requestForm(row, resubmit) {
    const r = row.request || {};
    return `<form data-cr-form>
      <div class="cr-fields">
        <label class="cr-field full">契約種別<select name="contractType" required>${TYPES.map(([value, label]) => `<option value="${value}" ${value === (r.contractType || "") ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label class="cr-field">作成希望日<input name="requestedDueOn" type="date" required value="${esc(r.requestedDueOn || "")}"></label>
        <label class="cr-field">稼働開始予定日（任意）<input name="plannedStartOn" type="date" value="${esc(r.plannedStartOn || "")}"></label>
        <label class="cr-field full">依頼内容・確認したい条件<textarea name="note" maxlength="2000" rows="3" required>${esc(r.note || "")}</textarea></label>
        ${resubmit ? '<label class="cr-field full">再依頼の理由（3文字以上）<textarea name="reason" minlength="3" maxlength="1000" rows="2" required></textarea></label>' : ""}
      </div>
      <label class="cr-note"><input type="checkbox" name="confirm" required> この内容でOfficeに作成を依頼します（送付・署名依頼はしません）。</label>
      <div class="cr-dialog-foot"><button type="button" class="btn btn-secondary btn-sm" data-cr-close>閉じる</button>
        <button type="submit" class="btn btn-primary btn-sm">${resubmit ? "同じ依頼を再開してOfficeへ再依頼" : "Officeへ契約書作成を依頼"}</button></div>
    </form>`;
  }
  function renderDialog(row) {
    current = row;
    detailStale = false;
    const r = row.request;
    const resubmit = r && ["cancelled", "completed"].includes(r.status);
    dialog.innerHTML = `<div class="cr-dialog-head"><h2>${esc(row.companyName)}｜契約書作成</h2>
      <button type="button" class="btn btn-secondary btn-sm" data-cr-close aria-label="契約書作成依頼を閉じる">閉じる</button></div>
      <div class="cr-dialog-body">${detailBody(row)}
        <div data-cr-feedback role="status"></div>
        ${row.canRequest && (!r || resubmit) ? requestForm(row, resubmit) : `<p class="cr-note">${!row.canRequest ? "作成依頼は合格を確認できる提案の現在の営業担当または管理者が登録します。取り消し・営業終了・アーカイブされた提案はOfficeで状況を確認してください。" : "依頼済みです。Officeの作成状況をここで確認できます。"}</p>`}
        ${row.canCancelRequest && r && !["completed", "cancelled"].includes(r.status) ? '<details><summary>作成依頼を取り消す</summary><form data-cr-cancel-form><label class="cr-field">取り消す理由（3文字以上）<textarea name="reason" rows="2" minlength="3" maxlength="1000" required></textarea></label><label class="cr-note"><input type="checkbox" name="confirm" required> Officeへの作成依頼を取り消します。既存の書類・契約は削除しません。</label><button class="btn btn-secondary btn-sm" type="submit">依頼を取り消す</button></form></details>' : ""}
      </div>`;
  }
  async function open(id, trigger) {
    if (submitting) return;
    const token = ++dialogSeq;
    current = null; detailStale = false; returnFocus = trigger || document.activeElement;
    dialog.innerHTML = '<div class="cr-dialog-head"><h2>契約書作成依頼</h2><button type="button" class="btn btn-secondary btn-sm" data-cr-close>閉じる</button></div><div class="cr-dialog-body" role="status">最新状態を読み込み中…</div>';
    if (!dialog.open) dialog.showModal();
    try {
      const result = await API.api(ENDPOINT + "?proposalId=" + encodeURIComponent(id));
      if (token !== dialogSeq || !dialog.open) return;
      const row = result.rows?.find((r) => r.proposalId === id);
      if (!result.ready || !row) throw new Error("この提案は表示できないか、合格の記録がありません。");
      renderDialog(row);
    } catch (e) {
      if (token !== dialogSeq || !dialog.open) return;
      dialog.innerHTML = `<div class="cr-dialog-head"><h2>契約書作成依頼</h2><button type="button" class="btn btn-secondary btn-sm" data-cr-close>閉じる</button></div><div class="cr-dialog-body"><p class="cr-message error" role="alert">${esc(message(e))}</p></div>`;
    }
  }
  async function submit(event) {
    const form = event.target;
    if (!form.matches("[data-cr-form], [data-cr-cancel-form]")) return;
    event.preventDefault();
    if (!current || submitting || detailStale || !form.reportValidity()) return;
    const value = new FormData(form);
    if (!value.has("confirm")) return;
    const row = current, r = row.request;
    const action = form.matches("[data-cr-cancel-form]") ? "cancel" : r ? "resubmit" : "create";
    const body = { action, proposalId: row.proposalId, ...(r ? { expectedVersion: r.version } : {}) };
    if (action !== "cancel") Object.assign(body, {
      contractType: value.get("contractType"), requestedDueOn: value.get("requestedDueOn"),
      plannedStartOn: value.get("plannedStartOn") || null, note: String(value.get("note") || "").trim(),
    });
    if (action !== "create") body.reason = String(value.get("reason") || "").trim();
    if ((action !== "cancel" && !body.note) || (action !== "create" && body.reason.length < 3)) {
      const feedback = dialog.querySelector("[data-cr-feedback]");
      feedback.innerHTML = '<p class="cr-message error">依頼内容は空白以外、変更・取消理由は3文字以上で入力してください。</p>';
      return;
    }
    submitting = true;
    for (const control of dialog.querySelectorAll("button,input,select,textarea")) control.disabled = true;
    const feedback = dialog.querySelector("[data-cr-feedback]");
    feedback.textContent = "保存しています…";
    try {
      await API.api(ENDPOINT, { method: "POST", body });
      submitting = false;
      close();
      await load();
      const savedMessage = action === "cancel" ? "Officeへの作成依頼を取り消しました。書類・契約は削除していません。" : "Officeに作成を依頼しました。送付・署名依頼は行っていません。";
      latestNotice = savedMessage + (ready ? "" : " 一覧の再取得には失敗しました：" + latestNotice);
      filter = "all"; render();
    } catch (e) {
      submitting = false;
      for (const control of dialog.querySelectorAll("button,input,select,textarea")) control.disabled = false;
      if (e?.status === 409 || e?.code === "outcome_unconfirmed") {
        detailStale = true;
        for (const control of dialog.querySelectorAll('button[type="submit"]')) control.disabled = true;
      }
      feedback.innerHTML = `<p class="cr-message error" role="alert">${esc(message(e))}</p>${detailStale ? '<button class="btn btn-secondary btn-sm" type="button" data-cr-reload-detail>最新状態を読み直す（入力は破棄されます）</button>' : ""}`;
    }
  }
  function init(options) {
    if (root || !options?.root) return;
    root = options.root; canOffice = Boolean(options.canOffice);
    dialog = document.createElement("dialog"); dialog.className = "cr-dialog"; dialog.setAttribute("aria-label", "契約書作成依頼");
    document.body.appendChild(dialog);
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!submitting) close(); });
    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-cr-close]")) { if (!submitting) close(); }
      if (event.target.closest("[data-cr-reload-detail]") && current) open(current.proposalId);
    });
    dialog.addEventListener("submit", submit);
    root.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target) return;
      if (target.hasAttribute("data-cr-refresh")) load();
      if (target.hasAttribute("data-cr-collapse")) { filter = null; query = ""; render(); }
      if (target.hasAttribute("data-cr-filter")) { filter = target.dataset.crFilter; query = ""; render(); }
      if (target.hasAttribute("data-cr-open")) open(target.dataset.crOpen, target);
    });
    root.addEventListener("input", (event) => {
      if (!event.target.matches("[data-cr-search]")) return;
      query = event.target.value;
      const box = root.querySelector("#sales-contract-results");
      const at = event.target.selectionStart;
      box.innerHTML = listMarkup();
      const input = box.querySelector("[data-cr-search]"); input.focus(); input.setSelectionRange(at, at);
    });
    load();
  }
  window.SalesContractRequests = Object.freeze({ init, refresh: load });
})();
