(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, code =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[code]));
  const endpoint = "/api/enger/office-daily-review";
  const dateFormat = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const date = (value) => value ? dateFormat.format(new Date(value)) : "";
  const flags = { checked: "確認済み", discuss: "打ち合わせで確認" };
  let board;
  let selected;
  let busy = false;

  function renderList() {
    const filter = $("edr-filter").value;
    const rows = board.rows.filter(row =>
      filter === "all" || (filter === "discuss" ? row.outcome === "discuss" : row.outcome !== "checked"));
    const unchecked = board.rows.filter(row => !row.outcome).length;
    const discussion = board.rows.filter(row => row.outcome === "discuss").length;
    $("edr-summary").textContent = `未確認 ${unchecked}件 ／ 打ち合わせで確認 ${discussion}件 ／ 確認済み ${board.rows.length - unchecked - discussion}件`
      + (board.truncated ? "（表示上限500件）" : "");
    $("edr-list").innerHTML = rows.map(row => `<article class="cr-section">
      <h3>${esc(row.company || "企業名未登録")} · ${esc(row.job || row.title || "提案")}</h3>
      ${row.initials ? `<p class="cr-note">人材 ${esc(row.initials)}</p>` : ""}
      <p class="cr-note">${esc(date(row.sentAt))}送信 ／ Sales ${esc(row.status)} ／ Office ${esc(flags[row.outcome] || "未確認")}</p>
      <p class="cr-note">企業側の回答 ${esc(row.companyResponse || "未記録")} ／ 人材側の回答 ${esc(row.candidateResponse || "未記録")}</p>
      ${row.reason || row.fact ? `<p class="edr-note">${esc([row.reason, row.fact].filter(Boolean).join(" ／ "))}</p>` : ""}
      <div class="edr-actions">
        ${board.roles.enger ? `<a href="https://dx.enger.jp/proposals/${encodeURIComponent(row.sourceId)}">ENGERで提案を見る</a>` : ""}
        ${board.roles.office && board.day === board.today ? `<button class="btn btn-secondary btn-sm" type="button" data-check="${esc(row.id)}">確認結果を${row.outcome ? "更新" : "記録"}</button>` : ""}
      </div>
    </article>`).join("") || '<p class="cr-note">該当する提案はありません。</p>';
  }

  function renderMeeting() {
    const m = board.meeting;
    const complete = m?.office_confirmed_at && m?.enger_confirmed_at;
    $("edr-meeting-title").textContent = board.today === board.day ? "今日の打ち合わせ" : "打ち合わせ記録";
    $("edr-meeting").innerHTML = `
      <p>Office ${m?.office_confirmed_at ? "確認済み" : "未確認"} ／ ENGER ${m?.enger_confirmed_at ? "確認済み" : "未確認"}</p>
      ${m?.agenda?.length ? `<details><summary>記録時点の確認事項 ${m.agenda.length}件</summary>
        <ul class="edr-reasons">${m.agenda.map(item => `<li><b>${esc(item.company || item.title || "提案")}</b> ${esc(item.reason)}<div class="edr-note">${esc(item.fact)}</div></li>`).join("")}</ul></details>` : ""}
      ${complete || board.day !== board.today ? (m
        ? `<p class="edr-note">${esc(m.note)}</p><p class="edr-note">${esc(m.next_step)}</p>`
        : '<p class="cr-note">この日の記録はありません。</p>') : `
      <form id="edr-meeting-form" class="edr-form">
        <label>双方で確認したこと <textarea name="note" rows="3" maxlength="1500" required>${esc(m?.note)}</textarea></label>
        <label>次にやること・担当・期限 <textarea name="nextStep" rows="2" maxlength="1000" placeholder="例：ENGERが明日までに候補者の開始日を再確認">${esc(m?.next_step)}</textarea></label>
        <div><button class="btn btn-primary btn-sm" type="submit">打ち合わせを記録</button></div>
      </form>`}
      ${m && !complete ? `<p class="edr-actions">
        ${board.canConfirm.office && !m.office_confirmed_at ? '<button type="button" class="btn btn-secondary btn-sm" data-side="office">Officeとして確認した</button>' : ""}
        ${board.canConfirm.enger && !m.enger_confirmed_at ? '<button type="button" class="btn btn-secondary btn-sm" data-side="enger">ENGERとして確認した</button>' : ""}
      </p>` : ""}`;
  }

  function render() {
    if (board.firstDay) $("edr-day").min = board.firstDay;
    $("edr-day").max = board.today;
    $("edr-day").value = board.day;
    $("edr-board").hidden = false;
    renderList();
    renderMeeting();
  }

  async function load(day) {
    board = await API.api(day ? `${endpoint}?day=${encodeURIComponent(day)}` : endpoint);
    render();
  }

  async function run(fn, status = $("edr-status")) {
    if (busy) return;
    busy = true;
    status.textContent = "";
    try { await fn(); }
    catch (error) { status.textContent = error.hint || "読み込みまたは保存ができませんでした。最新表示して再度お試しください。"; }
    finally { busy = false; }
  }

  async function save(body) {
    const day = board.day;
    await API.api(endpoint, { method: "POST", body: { day, ...body }, invalidates: [] });
    $("edr-status").textContent = "保存しました。";
    if (body.action === "check") $("edr-dialog").close();
    try { await load(day); }
    catch { $("edr-status").textContent = "保存しました。最新表示を押して結果を確認してください。"; }
  }

  $("edr-filter").addEventListener("change", renderList);
  $("edr-day").addEventListener("change", (event) => run(() => load(event.target.value)));
  $("edr-refresh").addEventListener("click", () => run(() => load(board?.day)));
  $("edr-close").addEventListener("click", () => $("edr-dialog").close());
  $("edr-list").addEventListener("click", event => {
    const button = event.target.closest("[data-check]");
    if (!button) return;
    selected = board.rows.find(row => row.id === button.dataset.check);
    if (!selected) return;
    const fields = $("edr-check").elements;
    $("edr-selected").textContent = [selected.company, selected.title].filter(Boolean).join(" · ");
    $("edr-dialog-status").textContent = "";
    fields.reason.innerHTML = '<option value="">選択してください</option>'
      + Object.entries(board.reasons).map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`).join("");
    fields.outcome.value = selected.outcome || "checked";
    fields.reason.value = selected.reasonCode || "";
    fields.fact.value = selected.fact || "";
    $("edr-dialog").showModal();
  });
  $("edr-check").addEventListener("submit", event => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.target));
    run(() => save({ ...input, id: selected.id, revision: selected.revision, action: "check" }), $("edr-dialog-status"));
  });
  $("edr-meeting").addEventListener("submit", event => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.target));
    run(() => save({ ...input, revision: board.meeting?.revision || 0, action: "save_meeting" }));
  });
  $("edr-meeting").addEventListener("click", event => {
    const button = event.target.closest("[data-side]");
    if (!button) return;
    const form = $("edr-meeting-form");
    if (form && (form.elements.note.value !== board.meeting.note || form.elements.nextStep.value !== board.meeting.next_step)) {
      $("edr-status").textContent = "入力内容を保存してから確認してください。";
      return;
    }
    run(() => save({ side: button.dataset.side, revision: board.meeting.revision, action: "confirm_meeting" }));
  });

  run(async () => {
    if (!await KPLayout.init({ active: "home" })) return;
    await load();
  });
})();
