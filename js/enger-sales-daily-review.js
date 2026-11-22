(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, code =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[code]));
  const endpoint = "/api/sales/proposals/daily-review";
  const dateFormat = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const sides = { sales: "Sales", enger: "ENGER" };
  const flags = { checked: "確認済み", discuss: "議題に追加済み" };
  let board;
  let selected;
  let editing = false;
  let busy = false;

  const responses = row => `企業の回答 ${row.companyResponse || "未記録"} ／ 人材の回答 ${row.candidateResponse || "未記録"}`;
  const title = row => [row.company || "企業名未登録", row.job || row.title].filter(Boolean).join(" ／ ");
  const agendaForToday = () => board.rows.filter(row => row.outcome === "discuss");
  const proposalLink = row => board.roles.enger && row.sourceId
    ? `<a class="cr-link" href="https://dx.enger.jp/proposals/${encodeURIComponent(row.sourceId)}">ENGERで提案を見る</a>` : "";

  function renderList() {
    const filter = $("edr-filter").value;
    const rows = board.rows.filter(row =>
      filter === "all" || (filter === "discuss" ? row.outcome === "discuss" : row.outcome !== "checked"));
    const unchecked = board.rows.filter(row => !row.outcome).length;
    const discussion = agendaForToday().length;
    const canCheck = board.roles.sales && board.day === board.today;
    $("edr-summary").textContent = `未確認 ${unchecked}件 ／ 議題 ${discussion}件 ／ 確認済み ${board.rows.length - unchecked - discussion}件`
      + (board.truncated ? "（表示上限500件）" : "");
    $("edr-list").innerHTML = rows.map(row => `<article class="edr-case" data-row="${esc(row.id)}">
      <h3>${esc(title(row))}</h3>
      <p class="cr-note">${esc(row.sentAt ? dateFormat.format(new Date(row.sentAt)) : "")}送信
        ${row.initials ? `／ 人材 ${esc(row.initials)}` : ""} ／ Sales ${esc(row.status)} ／ 事前確認 ${esc(flags[row.outcome] || "未確認")}</p>
      <p class="cr-note">${esc(responses(row))}</p>
      ${row.checkedSide === "office" ? '<p class="cr-note">Officeの事前確認記録あり</p>' : ""}
      ${row.reason || row.fact ? `<p class="edr-note">${esc([row.reason, row.fact].filter(Boolean).join(" ／ "))}</p>` : ""}
      <div class="edr-actions">
        ${canCheck && row.outcome !== "checked" ? `<button class="btn ${row.outcome ? "btn-secondary" : "btn-primary"}" type="button" data-done="${esc(row.id)}">確認済みにする</button>` : ""}
        ${canCheck ? `<button class="btn btn-secondary" type="button" data-discuss="${esc(row.id)}">${row.outcome === "discuss" ? "議題を編集" : "議題に追加"}</button>` : ""}
        ${proposalLink(row)}
      </div>
    </article>`).join("") || '<p class="cr-note">該当する提案はありません。</p>';
  }

  function renderAgenda(agenda) {
    if (!agenda.length) return '<p class="cr-note">打ち合わせに上がっている提案はありません。</p>';
    return `<ul class="edr-agenda">${agenda.map(item => `<li>
      <strong>${esc(title(item))}</strong>
      ${item.reason ? `<span class="cr-status" data-status="review">${esc(item.reason)}</span>` : ""}
      ${item.fact ? `<p class="edr-note">${esc(item.fact)}</p>` : ""}
      ${proposalLink(item)}
    </li>`).join("")}</ul>`;
  }

  function renderMeeting(draft) {
    const m = board.meeting;
    const isToday = board.day === board.today;
    const complete = Boolean(m?.sales_confirmed_at && m?.enger_confirmed_at);
    const showForm = isToday && !complete && (!m || editing || board.agendaChanged);
    const agenda = isToday && !complete ? agendaForToday() : m?.agenda || [];
    const available = Object.keys(sides).filter(side =>
      (m ? board.canConfirm[side] : board.roles[side]) && (showForm || !m?.[side + "_confirmed_at"]));
    const status = Object.entries(sides).map(([side, label]) => {
      const confirmed = Boolean(m?.[side + "_confirmed_at"]);
      return `<span class="cr-status" data-status="${confirmed ? "completed" : "review"}">${label} ${confirmed ? "確認済み" : "未確認"}</span>`;
    }).join("");
    $("edr-meeting-title").textContent = isToday ? "今日の打ち合わせ" : "打ち合わせ記録";
    $("edr-sales-jump").hidden = !board.roles.sales;
    $("edr-sales-home").hidden = !board.roles.sales;
    const buttons = available.map((side, index) => `<button class="btn ${index ? "btn-secondary" : "btn-primary"}" type="${showForm ? "submit" : "button"}"
      ${showForm ? `name="side" value="${side}"` : `data-confirm="${side}"`}>${showForm ? "記録して" : ""}${sides[side]}の確認を完了</button>`).join("");
    const record = m ? `<dl class="edr-record">
      <dt>決まったこと</dt><dd class="edr-note">${esc(m.note)}</dd>
      <dt>次の対応・担当・期限</dt><dd class="edr-note">${esc(m.next_step || "登録なし")}</dd>
    </dl>` : "";
    $("edr-meeting").innerHTML = `
      <div class="edr-state" aria-label="双方の確認状況">${status}</div>
      ${m?.office_confirmed_at ? '<p class="cr-note">引き継ぎ前のOffice確認記録あり</p>' : ""}
      <h3>${complete || !isToday ? "記録した議題" : "今日の議題"} ${agenda.length}件</h3>
      ${renderAgenda(agenda)}
      ${board.agendaChanged ? '<p class="cr-message warn">議題が更新されました。最新の内容で記録すると、双方の確認を取り直します。</p>' : ""}
      ${showForm ? `
        <form id="edr-meeting-form" class="edr-form" data-revision="${draft?.revision ?? m?.revision ?? 0}">
          <label class="cr-field">決まったこと<textarea name="note" rows="2" maxlength="1500" required>${esc(draft?.note ?? m?.note)}</textarea></label>
          <label class="cr-field">次の対応・担当・期限<textarea name="nextStep" rows="2" maxlength="1000" placeholder="例：ENGERが明日までに候補者の開始日を再確認">${esc(draft?.nextStep ?? m?.next_step)}</textarea></label>
          <div class="edr-actions">${buttons || '<button class="btn btn-primary" type="submit">保存</button>'}
            ${m && !board.agendaChanged ? '<button type="button" class="btn btn-secondary" data-cancel-edit>編集をやめる</button>' : ""}
          </div>
        </form>` : `
        ${record || '<p class="cr-note">この日の打ち合わせ記録はありません。</p>'}
        ${m && !complete ? `<div class="edr-actions">${buttons}
          ${isToday ? '<button class="btn btn-secondary" type="button" data-edit>記録を編集</button>' : ""}
        </div>` : ""}`}`;
  }

  function currentDraft() {
    const form = $("edr-meeting-form");
    if (!form) return null;
    return { ...Object.fromEntries(new FormData(form)), revision: Number(form.dataset.revision) };
  }

  async function load(day, draft) {
    board = await API.api(day ? `${endpoint}?day=${encodeURIComponent(day)}` : endpoint);
    if (board.firstDay) $("edr-day").min = board.firstDay;
    $("edr-day").max = board.today;
    $("edr-day").value = board.day;
    $("edr-board").hidden = false;
    renderList();
    renderMeeting(draft);
  }

  function message(node, value, state = "") {
    node.textContent = value;
    node.className = `cr-message ${state}`;
  }

  async function run(fn, status = $("edr-status"), button) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    message(status, "");
    try { await fn(); }
    catch (error) { message(status, error.hint || "処理できませんでした。最新表示してから再度お試しください。", "error"); }
    finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }

  async function save(body, status, success) {
    const day = board.day;
    const draft = body.action === "check" ? currentDraft() : null;
    await API.api(endpoint, { method: "POST", body: { day, ...body }, invalidates: [] });
    if (body.action === "check" && $("edr-dialog").open) $("edr-dialog").close();
    if (body.action !== "check") editing = false;
    try {
      await load(day, draft);
      if (body.action === "check") {
        const targetRow = [...$("edr-list").querySelectorAll("[data-row]")].find(row => row.dataset.row === body.id);
        (targetRow?.querySelector("button") || $("edr-list-title")).focus({ preventScroll: true });
      }
      message(status, success, "success");
    } catch {
      message(status, "保存しました。最新表示を押して結果を確認してください。", "warn");
    }
  }

  $("edr-filter").addEventListener("change", renderList);
  $("edr-day").addEventListener("change", event => run(() => {
    editing = false;
    message($("edr-list-status"), "");
    message($("edr-meeting-status"), "");
    return load(event.target.value);
  }));
  $("edr-refresh").addEventListener("click", event => run(
    () => load(board?.day, currentDraft()), $("edr-status"), event.currentTarget));
  $("edr-close").addEventListener("click", () => $("edr-dialog").close());

  $("edr-list").addEventListener("click", event => {
    const button = event.target.closest("[data-done],[data-discuss]");
    if (!button || busy) return;
    const row = board.rows.find(item => item.id === (button.dataset.done || button.dataset.discuss));
    if (!row) return;
    if (button.hasAttribute("data-done")) {
      const status = $("edr-list-status");
      run(() => save({ id: row.id, revision: row.revision, action: "check",
        outcome: "checked", reason: row.reasonCode, fact: row.fact }, status, "提案を確認済みにしました。"), status, button);
      return;
    }
    selected = row;
    const fields = $("edr-check").elements;
    const label = row.outcome === "discuss" ? "議題を更新" : "議題に追加";
    $("edr-dialog-title").textContent = label;
    $("edr-add-agenda").textContent = label;
    $("edr-selected").textContent = title(row);
    $("edr-selected-responses").textContent = responses(row);
    message($("edr-dialog-status"), "");
    fields.reason.innerHTML = '<option value="">選択してください</option>'
      + Object.entries(board.reasons).map(([code, text]) => `<option value="${esc(code)}">${esc(text)}</option>`).join("");
    fields.reason.value = row.reasonCode || "";
    fields.fact.value = row.fact || "";
    $("edr-dialog").showModal();
  });

  $("edr-check").addEventListener("submit", event => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.target));
    run(() => save({ ...input, id: selected.id, revision: selected.revision, outcome: "discuss", action: "check" },
      $("edr-list-status"), "今日の議題に反映しました。"), $("edr-dialog-status"), event.submitter);
  });

  $("edr-meeting").addEventListener("submit", event => {
    event.preventDefault();
    const input = currentDraft();
    const side = event.submitter?.value || undefined;
    const agenda = agendaForToday().map(({ id, reason, fact }) => ({ id, reason, fact }));
    const status = $("edr-meeting-status");
    run(() => save({ ...input, side, agenda, action: "save_meeting" }, status,
      side ? `${sides[side]}の確認を完了しました。` : "下書きを保存しました。"), status, event.submitter);
  });
  $("edr-meeting").addEventListener("click", event => {
    const button = event.target.closest("[data-confirm],[data-edit],[data-cancel-edit]");
    if (!button || busy) return;
    const status = $("edr-meeting-status");
    if (button.dataset.confirm) {
      const side = button.dataset.confirm;
      run(() => save({ side, revision: board.meeting.revision, action: "confirm_meeting" },
        status, `${sides[side]}の確認を完了しました。`), status, button);
      return;
    }
    editing = button.hasAttribute("data-edit");
    message(status, "");
    renderMeeting();
    $("edr-meeting-form")?.elements.note.focus();
  });

  run(async () => {
    if (!API.isLoggedIn()) {
      await KPLayout.init({ active: "home" });
      return;
    }
    const sourceId = new URLSearchParams(location.search).get("proposal");
    if (sourceId) {
      document.querySelector(".edr-title").textContent = "Sales・ENGER 提案の認識合わせ";
      document.title = "提案の認識合わせ - ENGER・Sales";
      $("edr-board-nav").hidden = true;
      const root = $("edr-proposal-coordination");
      root.hidden = false;
      root.textContent = "ENGERの情報を取得しています…";
      await KPLayout.init({ active: "home" });
      await window.EngerProposalCoordination.mount(root, { sourceId }, { standalone: true });
      return;
    }
    try {
      await load();
    } catch (error) {
      await KPLayout.init({ active: "home" });
      throw error;
    }
    if (board.roles.sales) await SalesLayout.init({ active: "proposals" });
    else await KPLayout.init({ active: "home" });
  });
})();
