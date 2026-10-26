// 契約書の作成依頼だけを進める。書類の生成・送付・署名・Salesの状態変更はしない。
(function () {
  "use strict";
  const ENDPOINT = "/api/office/contract-requests";
  const STATUS = { requested: "未着手", in_progress: "作成中", review: "確認待ち", completed: "作成完了", cancelled: "取消" };
  const TYPES = { client_ses: "顧客向けSES契約", bp_order: "BP向け注文書", employment: "本人向け雇用契約", contractor: "本人向け業務委託契約", needs_confirmation: "要確認（契約種別は未確定）" };
  const NEXT = { requested: ["requested", "in_progress"], in_progress: ["in_progress", "review"], review: ["review", "in_progress", "completed"] };
  const ACTION = { create: "作成依頼", update: "進捗・内容の更新", cancel: "取消", reopen: "再開", resubmit: "再依頼" };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stamp = (value) => {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const status = (value) => STATUS[value] || "状態を確認してください";
  const typeName = (value) => TYPES[value] || "契約種別を確認してください";
  const pill = (value) => `<span class="cr-status" data-status="${esc(value)}">${esc(status(value))}</span>`;
  let rows = [], members = [], canEdit = false, canLinkHrDocs = false, listReady = false, filter = "all", query = "";
  let listSeq = 0, detailSeq = 0, current = null, busy = false, stale = false, returnFocus = null, pendingAction = null;
  let initialized = false;

  function message(text, tone = "") {
    $("ocq-message").className = "cr-message" + (tone ? " " + tone : "");
    $("ocq-message").textContent = text;
  }
  function errorText(error) {
    if (error?.status === 403) return "この操作には Office の契約書作成依頼を扱う権限が必要です。";
    if (error?.code === "not_ready" || error?.body?.ready === false) return error.hint || "契約書作成依頼のデータベース設定がまだ適用されていません。管理者に確認してください。";
    if (error?.status === 409) return "別の操作で依頼が更新されたか、現在の状態では実行できません。最新の依頼を読み直して確認してください。自動では再実行しません。";
    return error?.hint || "取得または保存ができませんでした。通信状態を確認し、必要に応じて更新してください。";
  }
  function rowsForSearch() {
    const q = query.trim().toLocaleLowerCase();
    return rows.filter((r) => r.request && (!q || [r.companyName, r.title, r.talentInitials].join(" ").toLocaleLowerCase().includes(q)));
  }
  function renderList() {
    if (!listReady) return;
    const searched = rowsForSearch();
    $("ocq-cards").innerHTML = Object.keys(STATUS).map((s) => `<button type="button" class="cr-card${filter === s ? " on" : ""}" data-filter="${s}" aria-pressed="${filter === s}"><span>${STATUS[s]}</span><b>${searched.filter((r) => r.request.status === s).length}<small>件</small></b></button>`).join("");
    $("ocq-all").setAttribute("aria-pressed", String(filter === "all"));
    const visible = searched.filter((r) => filter === "all" || r.request.status === filter);
    $("ocq-count").textContent = `${filter === "all" ? "すべて" : status(filter)}：${visible.length}件`;
    $("ocq-list").innerHTML = visible.length ? visible.map((r) => {
      const req = r.request;
      return `<article class="cr-row"><div class="cr-row-main"><strong>${esc(r.companyName || "企業名未登録")}</strong><p>${esc(r.title || "提案名未登録")}</p><p>人材：${esc(r.talentInitials || "—")} ／ ${esc(typeName(req.contractType))}</p></div><div class="cr-meta">${pill(req.status)}<br>担当：${esc(req.assigneeName || "未割当")}<br>作成期限：${esc(req.requestedDueOn || "未設定")} ／ 開始予定：${esc(req.plannedStartOn || "未定")}</div><div class="cr-actions"><button type="button" class="btn btn-secondary btn-sm" data-open="${esc(r.proposalId)}">確認・更新</button></div></article>`;
    }).join("") : '<div class="cr-message">この条件に合う依頼はありません。</div>';
  }
  async function loadList() {
    const my = ++listSeq;
    listReady = false;
    $("ocq-refresh").disabled = true;
    $("ocq-list").setAttribute("aria-busy", "true");
    message("読み込み中…");
    try {
      const result = await API.api(ENDPOINT);
      if (my !== listSeq) return;
      if (result.ready !== true) throw Object.assign(new Error("not_ready"), { code: "not_ready", hint: result.hint });
      rows = Array.isArray(result.rows) ? result.rows : [];
      members = Array.isArray(result.members) ? result.members : [];
      canEdit = result.canEditOffice === true;
      canLinkHrDocs = result.canLinkHrDocs === true;
      listReady = true;
      $("ocq-scope").textContent = result.truncated ? "取得上限に達しています。カードの件数は取得できた依頼だけを数えています。全件の合計ではありません。" : "カードの件数と一覧は同じ検索条件です。契約書作成の進捗だけを表示しています。";
      message(result.truncated ? "一部の依頼だけを表示しています。" : "", result.truncated ? "warn" : "");
      renderList();
    } catch (error) {
      if (my !== listSeq) return;
      rows = [];
      canEdit = false;
      $("ocq-cards").innerHTML = "";
      $("ocq-list").innerHTML = "";
      $("ocq-count").textContent = "未取得";
      $("ocq-scope").textContent = "依頼件数は確認できていません。0件とは扱いません。";
      message(errorText(error), error?.code === "not_ready" ? "warn" : "error");
    } finally {
      if (my === listSeq) { $("ocq-refresh").disabled = false; $("ocq-list").setAttribute("aria-busy", "false"); }
    }
  }
  const options = (values, selected) => Object.entries(values).map(([key, label]) => `<option value="${esc(key)}"${key === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
  function detailError(text, tone = "error") {
    const box = $("ocq-save-message");
    if (box) { box.className = "cr-message " + tone; box.textContent = text; }
  }
  function closeDetail() {
    if (busy) return;
    detailSeq++;
    current = null;
    pendingAction = null;
    $("ocq-dialog").close();
  }
  async function openDetail(proposalId, opener) {
    if (busy) return;
    if (!$("ocq-dialog").open) { returnFocus = opener || document.activeElement; $("ocq-dialog").showModal(); }
    const my = ++detailSeq;
    current = null;
    stale = false;
    pendingAction = null;
    $("ocq-detail-title").textContent = "契約書作成依頼";
    $("ocq-detail-sub").textContent = "読み込み中…";
    $("ocq-detail").innerHTML = '<p class="cr-note" role="status">最新の依頼を確認しています。</p>';
    try {
      const result = await API.api(`${ENDPOINT}?proposalId=${encodeURIComponent(proposalId)}`);
      if (my !== detailSeq || !$("ocq-dialog").open) return;
      if (result.ready !== true) throw Object.assign(new Error("not_ready"), { code: "not_ready", hint: result.hint });
      const row = result.rows?.find((r) => r.proposalId === proposalId && r.request);
      if (!row) throw Object.assign(new Error("not_found"), { hint: "この依頼は見つからないか、表示する権限がありません。" });
      current = row;
      canEdit = result.canEditOffice === true;
      canLinkHrDocs = result.canLinkHrDocs === true;
      members = Array.isArray(result.members) ? result.members : [];
      renderDetail();
    } catch (error) {
      if (my !== detailSeq || !$("ocq-dialog").open) return;
      $("ocq-detail-sub").textContent = "取得できませんでした";
      $("ocq-detail").innerHTML = `<p class="cr-message error" role="alert">${esc(errorText(error))}</p><button type="button" class="btn btn-secondary btn-sm" data-reload="${esc(proposalId)}">最新の依頼を読み直す</button>`;
    }
  }
  function renderDetail() {
    const row = current, req = row.request;
    const terminal = ["completed", "cancelled"].includes(req.status);
    const editable = canEdit && !terminal;
    const stageOptions = Object.fromEntries((NEXT[req.status] || [req.status]).map((s) => [s, STATUS[s]]));
    const memberOptions = { "": "未割当" };
    members.forEach((m) => { memberOptions[m.id] = m.name; });
    if (req.assigneeId && !Object.hasOwn(memberOptions, req.assigneeId)) memberOptions[req.assigneeId] = `${req.assigneeName || "現在の担当"}（選択可能な担当者か確認）`;
    $("ocq-detail-title").textContent = row.companyName || "契約書作成依頼";
    $("ocq-detail-sub").textContent = `${row.title || "提案"} ／ 人材：${row.talentInitials || "—"}`;
    const protectedEmployee = !canLinkHrDocs && req.hasDocOrder === true;
    const warning = row.archived ? "元の提案がアーカイブされています。作業を進める前に Sales 担当へ確認してください。" : !row.accepted ? "現在取得できる ENGER の記録では合格を確認できません。元の依頼と Sales 担当へ確認してください。" : ["lost", "stopped", "closed_no_reply"].includes(row.salesStatus) ? "Sales 側は対応終了の状態です。契約書作成を続けてよいか確認してください。" : row.sourceStage && !["合格", "面談合格", "稼働", "稼働決定", "稼働中"].includes(row.sourceStage) ? "過去の合格履歴はありますが、ENGER の現在ステージが変わっています。作業を続けてよいか Sales 担当へ確認してください。" : "";
    const history = Array.isArray(req.history) ? req.history : [];
    $("ocq-detail").innerHTML = `${warning ? `<p class="cr-message warn">${esc(warning)}</p>` : ""}
      <p class="cr-note">${pill(req.status)}　依頼：${esc(stamp(req.requestedAt))} ／ ${esc(req.requestedByName || "依頼者未登録")}<br>最終更新：${esc(stamp(req.updatedAt))} ／ 版 ${esc(req.version)}<br>ENGER現在ステージ：${esc(row.sourceStage || "未確認")}</p>
      <p class="cr-note"><a class="cr-link" href="/sales/proposals.html?id=${encodeURIComponent(row.proposalId)}">元のSales提案を開く</a>（Salesの権限が必要です）</p>
      <div class="cr-message"><b>Sales からの申し送り</b><p style="white-space:pre-wrap;margin:5px 0 0;">${esc(req.note || "なし")}</p></div>
      <div id="ocq-save-message" class="cr-message" role="status" aria-live="polite"></div>
      <form id="ocq-form">
        <fieldset id="ocq-fields"${editable ? "" : " disabled"}><div class="cr-fields">
          <label class="cr-field">作成状況<select id="ocq-status" name="status">${options(stageOptions, req.status)}</select></label>
          <label class="cr-field">Office担当<select id="ocq-assignee" name="assigneeId">${options(memberOptions, req.assigneeId || "")}</select></label>
          <label class="cr-field full">契約種別<select name="contractType" required>${options(TYPES, req.contractType)}</select><small>「要確認」のまま作成完了にはできません。契約の当事者・種類を確認してください。</small></label>
          <label class="cr-field">作成期限<input name="requestedDueOn" type="date" value="${esc(req.requestedDueOn || "")}" required></label>
          <label class="cr-field">稼働・契約開始予定<input name="plannedStartOn" type="date" value="${esc(req.plannedStartOn || "")}"><small>予定日の記録だけです。稼働開始の処理は行いません。</small></label>
          <label class="cr-field full">作成した書類の管理番号・保管場所<textarea name="artifactReference" maxlength="2000" rows="2" placeholder="例：社内共有フォルダ「契約書／2026年／案件番号…」">${esc(req.artifactReference || "")}</textarea><small>作成完了には10文字以上の記録が必要です。入力したURL等は自動では開きません。</small></label>
        </div>
        <details><summary>既存の契約・書類のIDを紐付ける（任意）</summary><p class="cr-note">新しい契約や署名依頼は作りません。対象者・案件が一致することを元画面で確認してから入力してください。書類作成依頼の紐付けには別途HR権限が必要です。</p><div class="cr-fields">
          <label class="cr-field full">対象者の社員ID<input name="employeeId" value="${esc(req.employeeId || "")}" maxlength="36" placeholder="UUID"${protectedEmployee ? " disabled" : ""}><small>${protectedEmployee ? "HR書類と紐付いているため、HR権限のない担当者は対象者を変更できません。既存の紐付けは保存時も保持します。" : "以下のIDを紐付ける場合は必須です。"}</small></label>
          ${canLinkHrDocs ? `<label class="cr-field">既存の書類作成依頼ID<input name="docOrderId" value="${esc(req.docOrderId || "")}" maxlength="36" placeholder="UUID"></label>` : `<p class="cr-note">HR書類作成依頼：${req.hasDocOrder ? "紐付けあり（詳細・変更にはHR権限が必要です）" : "この権限では紐付けを変更できません"}</p>`}
          <label class="cr-field">既存の現場契約ID<input name="siteContractId" value="${esc(req.siteContractId || "")}" maxlength="36" placeholder="UUID"></label>
        </div></details></fieldset>
        ${canEdit ? `<label class="cr-field full" style="margin-top:14px;">変更・取消・再開の理由<textarea id="ocq-reason" name="reason" minlength="3" maxlength="1000" rows="2" placeholder="確認した内容と変更の理由（3文字以上）" required></textarea></label>` : '<p class="cr-message warn">この依頼は閲覧のみです。</p>'}
        <div id="ocq-completion-confirm" class="cr-confirm-panel" hidden><label class="cr-checkbox"><input type="checkbox" id="ocq-completion-check">書類の作成・内容確認が済んでいることを確認しました。これは送付・署名・契約締結の完了ではありません。</label></div>
        <div id="ocq-action-confirm" class="cr-confirm-panel" hidden></div>
        <div class="cr-dialog-foot" style="margin-top:18px;">${editable ? '<button type="button" class="btn btn-secondary btn-sm cr-danger" data-action="cancel">依頼を取り消す</button><button type="submit" class="btn btn-primary btn-sm" id="ocq-save">変更を保存</button>' : canEdit && terminal ? '<button type="button" class="btn btn-secondary btn-sm" data-action="reopen">依頼を再開する</button>' : ""}</div>
      </form>
      <details><summary>変更履歴（${history.length}件）</summary>${req.historyTruncated ? '<p class="cr-note">最新の履歴のみを表示しています。</p>' : ""}<div class="cr-history">${history.length ? history.map((h) => `<div class="cr-history-item"><time>${esc(stamp(h.at))}</time> ／ ${esc(h.actorName || "担当者")}<br><b>${esc(ACTION[h.action] || h.action || "更新")}</b> ${h.toStatus ? `：${h.fromStatus ? esc(status(h.fromStatus)) + " → " : ""}${esc(status(h.toStatus))}` : ""}<p>${esc(h.reason || "")}</p></div>`).join("") : '<p class="cr-note">履歴はまだありません。</p>'}</div></details>`;
    $("ocq-form").addEventListener("submit", (event) => { event.preventDefault(); save("update"); });
    $("ocq-status").addEventListener("change", () => {
      $("ocq-completion-confirm").hidden = $("ocq-status").value !== "completed";
      $("ocq-completion-check").checked = false;
    });
  }
  function confirmAction(action) {
    if (busy || stale || !canEdit || !current) return;
    pendingAction = action;
    const reopen = action === "reopen";
    $("ocq-action-confirm").hidden = false;
    $("ocq-action-confirm").innerHTML = `<p class="cr-note">${reopen ? "同じ依頼を未着手へ戻し、担当・作成書類の参照を再確認します。既存の契約・書類のIDと過去の履歴は保持します。契約書自体は削除・取消しません。" : "作成依頼を取り消します。作成済みの書類・契約・署名依頼は取り消しません。"}</p><div class="cr-actions"><button type="button" class="btn btn-primary btn-sm" data-confirm="${action}">${reopen ? "再開を確定" : "取消を確定"}</button><button type="button" class="btn btn-secondary btn-sm" data-abort>戻る</button></div>`;
    $("ocq-reason")?.focus();
  }
  async function save(action) {
    if (busy || stale || !current || !canEdit) return;
    if (action !== "update" && pendingAction !== action) return;
    const form = $("ocq-form");
    const reason = $("ocq-reason")?.value.trim() || "";
    if (reason.length < 3) { detailError("変更の理由を3文字以上で入力してください。"); $("ocq-reason")?.focus(); return; }
    if (action === "update" && !form.reportValidity()) return;
    const body = { action, proposalId: current.proposalId, expectedVersion: current.request.version, reason };
    if (action === "update") {
      const values = new FormData(form);
      for (const name of ["status", "contractType", "requestedDueOn"]) body[name] = String(values.get(name) || "");
      for (const name of ["plannedStartOn", "assigneeId", "artifactReference", "employeeId", "docOrderId", "siteContractId"]) body[name] = String(values.get(name) || "").trim() || null;
      // 非HRの応答ではdocOrderIdが非表示(null)。それを「解除」の書込みにしない。
      if (!canLinkHrDocs) {
        delete body.docOrderId;
        if (current.request.hasDocOrder) delete body.employeeId;
      }
      if (body.status === "completed" && !$("ocq-completion-check").checked) { detailError("書類の作成・確認が済んだことを確認し、チェックしてください。"); $("ocq-completion-check").focus(); return; }
      if (body.status === "completed" && (body.contractType === "needs_confirmation" || !body.assigneeId || (body.artifactReference || "").length < 10)) { detailError("作成完了には、確定した契約種別・Office担当・10文字以上の書類参照が必要です。"); return; }
    }
    busy = true;
    form.querySelectorAll("button,input,select,textarea").forEach((node) => { node.disabled = true; });
    $("ocq-close").disabled = true;
    detailError("保存中です。二重に実行しないでください。", "");
    try {
      const result = await API.api(ENDPOINT, { method: "POST", body });
      if (result.ok === true && result.refreshFailed === true) {
        stale = true;
        detailError(result.hint || "保存は完了しましたが、最新状態を取得できませんでした。再送せず、依頼を読み直してください。", "warn");
        addRefreshButton(body.proposalId);
        return;
      }
      if (!result.ok || result.ready !== true) throw Object.assign(new Error("save_failed"), { hint: result.hint });
      const updated = result.rows?.find((r) => r.proposalId === body.proposalId && r.request);
      if (!updated) throw Object.assign(new Error("unknown_result"), { status: 409 });
      current = updated;
      members = Array.isArray(result.members) ? result.members : members;
      canEdit = result.canEditOffice === true;
      canLinkHrDocs = result.canLinkHrDocs === true;
      pendingAction = null;
      busy = false;
      renderDetail();
      detailError("保存しました。送付・署名・契約締結の操作は行っていません。", "success");
      await loadList();
    } catch (error) {
      detailError(errorText(error));
      if (error?.status === 409 || error?.code === "outcome_unconfirmed") {
        stale = true;
        addRefreshButton(body.proposalId);
      }
    } finally {
      busy = false;
      $("ocq-close").disabled = false;
      if (!stale && current && $("ocq-form") === form) {
        form.querySelectorAll("button,input,select,textarea").forEach((node) => { node.disabled = false; });
        $("ocq-fields").disabled = !canEdit || ["completed", "cancelled"].includes(current.request.status);
        if (!canLinkHrDocs && current.request.hasDocOrder) form.querySelector('input[name="employeeId"]').disabled = true;
      }
    }
  }
  function addRefreshButton(proposalId) {
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "btn btn-secondary btn-sm"; retry.textContent = "入力を破棄して最新の依頼を読み直す";
    retry.dataset.reload = proposalId;
    $("ocq-save-message").append(document.createElement("br"), retry);
  }
  async function init() {
    if (initialized || !$("ocq-root")) return;
    initialized = true;
    $("ocq-search").addEventListener("input", (event) => { query = event.target.value; renderList(); });
    $("ocq-all").addEventListener("click", () => { filter = "all"; renderList(); });
    $("ocq-refresh").addEventListener("click", loadList);
    $("ocq-cards").addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) { filter = button.dataset.filter; renderList(); } });
    $("ocq-list").addEventListener("click", (event) => { const button = event.target.closest("[data-open]"); if (button) openDetail(button.dataset.open, button); });
    $("ocq-close").addEventListener("click", closeDetail);
    $("ocq-dialog").addEventListener("cancel", (event) => { if (busy) event.preventDefault(); else { detailSeq++; current = null; pendingAction = null; } });
    $("ocq-dialog").addEventListener("close", () => { if (returnFocus?.isConnected) returnFocus.focus(); });
    $("ocq-detail").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || busy) return;
      if (button.dataset.reload) openDetail(button.dataset.reload);
      else if (button.dataset.action) confirmAction(button.dataset.action);
      else if (button.dataset.confirm) save(button.dataset.confirm);
      else if (button.hasAttribute("data-abort")) { pendingAction = null; $("ocq-action-confirm").hidden = true; }
    });
    try {
      const ctx = await OfficeLayout.init({ active: "monthly" });
      if (!ctx) { message("Officeの利用権限とログイン状態を確認してください。", "warn"); return; }
      await loadList();
      const proposalId = new URLSearchParams(location.search).get("proposalId");
      if (proposalId && /^[0-9a-f-]{36}$/i.test(proposalId)) await openDetail(proposalId);
    } catch (error) { message(errorText(error), "error"); }
  }
  window.OfficeContractRequests = { init };
  init();
})();
