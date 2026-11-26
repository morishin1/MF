/* 通勤費の本人申告・Office月締め・社労士CSV。給与データはブラウザに保存しない。 */
window.TimecardCommute = (() => {
  const panel = document.getElementById("commute-panel");
  const scope = panel.dataset.scope;
  const office = scope === "office";
  const content = panel.querySelector("[data-content]");
  const feedback = panel.querySelector("[role=status]");
  const monthInput = document.getElementById(scope === "advisor" ? "payroll-month" : "m-month");
  const esc = KPLayout.esc;
  const methods = { pass: "定期代", actual: "実費", none: "支給なし" };
  const yen = value => value == null ? "—" : Number(value).toLocaleString("ja-JP") + "円";
  const status = r => r.locked ? (r.reviewed ? "締め済み" : "勤怠のみ締め済み")
    : r.reviewed ? "確認済み" : r.applied ? "申告済・未確認" : "未確認";
  let rows = [], advisors = [], shownMonth = "", generation = 0, editing = null;
  const dialog = panel.querySelector("dialog");
  const endpoint = month => "/api/timecard/commute?" + new URLSearchParams({ scope, month });
  const downloadButton = panel.querySelector("[data-download]");

  function render(closed) {
    if (downloadButton) downloadButton.disabled = !closed;
    if (!rows.length) {
      content.textContent = "この月の対象者はいません。";
      return;
    }
    const editButton = r => r.locked ? "" : `<button type="button" class="btn btn-secondary btn-sm" data-edit="${esc(r.employee_id)}">${
      office ? (r.reviewed ? "変更" : "確認する") : (r.applied || r.reviewed ? "変更を申告" : "通勤費を申告")}</button>`;
    if (!office) {
      const r = rows[0];
      content.innerHTML = `<div class="commute-summary"><span>${esc(methods[r.method] || "支給方法未登録")}</span>
        <strong>${yen(r.amount)}</strong><span class="kp-chip">${status(r)}</span>${editButton(r)}</div>`;
      return;
    }
    const pending = rows.filter(r => !r.reviewed).length;
    const attendanceNotes = r => [
      r.incomplete && "未完了の打刻あり", r.pending_fix && "打刻の修正申請あり",
      r.dates.some(d => !r.work_dates.includes(d)) && "通勤日を再確認",
    ].filter(Boolean).join("・");
    content.innerHTML = `<p class="commute-count">${rows.length}名のうち未確認 <strong>${pending}名</strong></p>
      <div class="table-scroll"><table class="kp-items"><thead><tr><th>社員</th><th>勤務日数</th><th>通勤日数</th>
      <th>支給方法</th><th>当月の支給額</th><th>確認状況</th><th>共有先</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><th scope="row">${esc(r.name)}</th><td>${r.work_dates.length}日</td>
        <td>${r.method === "actual" && r.applied ? r.dates.length + "日" : r.method === "none" ? "0日" : "—"}</td>
        <td>${methods[r.method] || "未登録"}</td><td>${yen(r.amount)}</td><td>${status(r)}${attendanceNotes(r) ? `<br><small>${attendanceNotes(r)}</small>` : ""}</td>
        <td>${esc(advisors.find(a => a.id === r.advisor_id)?.name || (r.advisor_id ? "担当者を再選択" : "共有なし"))}</td>
        <td>${editButton(r)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  async function refresh(message = "") {
    if (scope === "advisor") return;
    const month = monthInput.value;
    const current = ++generation;
    if (!office && /^\d{4}-\d{2}$/.test(month)) {
      panel.querySelector("[data-month-title]").textContent = month.replace("-", "年") + "月の通勤費";
    }
    if (shownMonth !== month && dialog?.open) dialog.close();
    shownMonth = month;
    rows = [];
    if (downloadButton) downloadButton.disabled = true;
    feedback.textContent = message;
    content.textContent = "読み込み中…";
    if (!month) { content.textContent = "対象月を選択してください。"; return; }
    try {
      const data = await API.api(endpoint(month));
      if (generation !== current || monthInput.value !== month) return;
      rows = data.rows;
      advisors = data.advisors;
      render(data.closed);
    } catch (err) {
      if (generation !== current) return;
      content.textContent = err.hint || err.message || "通勤費を読み込めませんでした。";
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "btn btn-secondary btn-sm"; retry.textContent = "再読み込み";
      retry.addEventListener("click", () => refresh());
      content.append(" ", retry);
    }
  }

  function openEditor(row) {
    editing = { row, month: shownMonth };
    const removed = row.dates.filter(d => !row.work_dates.includes(d));
    dialog.innerHTML = `<form class="commute-form">
      <header><h3>${esc(row.name)}さんの通勤費</h3>
        <button type="button" class="commute-x" data-close aria-label="閉じる">×</button></header>
      <p class="muted">${esc(shownMonth)}・勤務 ${row.work_dates.length}日</p>
      <label>支給方法<select name="method" required><option value="">選択してください</option>
        ${Object.entries(methods).map(([k, v]) => `<option value="${k}" ${row.method === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label data-route>通勤経路<input name="route" maxlength="500" value="${esc(row.route || "")}" placeholder="例　新宿 → 東京"></label>
      <label data-rate><span></span><input name="rate" type="number" min="1" max="2147483647" step="1" inputmode="numeric"></label>
      <fieldset data-dates><legend>実際に通勤した日</legend>
        <p class="muted">在宅勤務日は選択から外してください。</p>
        ${removed.length ? `<p>打刻の変更で対象外になった日（${removed.map(esc).join("、")}）は、保存時に除きます。</p>` : ""}
        <div class="commute-days">${row.work_dates.map(d => `<label><input type="checkbox" name="day" value="${esc(d)}" ${row.dates.includes(d) ? "checked" : ""}>${Number(d.slice(5,7))}/${Number(d.slice(8))}</label>`).join("") || "退勤まで記録された勤務日はありません。"}</div>
        <label><input type="checkbox" name="zero" ${row.applied && row.method === "actual" && !row.dates.length ? "checked" : ""}>この月の通勤日は0日</label>
      </fieldset>
      ${office ? `<label>共有先の社労士<select name="advisor"><option value="">共有なし</option>
          ${advisors.map(a => `<option value="${esc(a.id)}" ${a.id === row.advisor_id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>` : ""}
      <div class="commute-total">当月の支給額 <strong data-total></strong></div>
      <p class="err-text" role="alert"></p><div class="commute-actions">
        <button type="submit" class="btn btn-primary">${office ? "内容を確認して保存" : "申告する"}</button></div>
    </form>`;
    const form = dialog.querySelector("form");
    const rate = form.elements.rate;
    rate.value = row.rate > 0 ? row.rate : "";
    // 月額と往復運賃は別の金額。支給方法を変えても月額を1日分として適用しない。
    const rates = { [row.method]: rate.value };
    let previousMethod = row.method;
    const selected = () => Array.from(form.querySelectorAll('[name="day"]:checked'), i => i.value);
    function sync() {
      const method = form.elements.method.value;
      if (method !== previousMethod) {
        rates[previousMethod] = rate.value;
        rate.value = rates[method] || "";
        previousMethod = method;
      }
      const paid = method === "actual" || method === "pass";
      form.querySelector("[data-route]").hidden = !paid;
      form.querySelector("[data-rate]").hidden = !paid;
      form.querySelector("[data-rate] span").textContent = method === "actual" ? "1日分の往復運賃（円）" : "1か月の定期代（円）";
      rate.disabled = !paid;
      rate.required = paid;
      form.querySelector("[data-dates]").hidden = method !== "actual";
      const amount = method === "none" ? 0 : rate.value && (method !== "actual" || selected().length || form.elements.zero.checked)
        ? Number(rate.value) * (method === "actual" ? selected().length : 1) : null;
      form.querySelector("[data-total]").textContent = yen(amount);
    }
    form.addEventListener("input", event => {
      if (event.target.name === "day" && event.target.checked) form.elements.zero.checked = false;
      if (event.target.name === "zero" && event.target.checked) {
        form.querySelectorAll('[name="day"]').forEach(i => { i.checked = false; });
      }
      sync();
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const { row: original, month } = editing;
      const method = form.elements.method.value;
      const dates = method === "actual" ? selected() : [];
      const alert = form.querySelector('[role="alert"]');
      if (method === "actual" && !dates.length && !form.elements.zero.checked) {
        alert.textContent = "通勤した日、または「この月の通勤日は0日」を選択してください。"; return;
      }
      const button = form.querySelector('[type="submit"]');
      button.disabled = true; alert.textContent = "";
      try {
        const body = { version: original.version, method, rate: method === "none" ? 0 : Number(rate.value),
          route: method === "none" ? "" : form.elements.route.value, dates };
        if (office) Object.assign(body, { employeeId: original.employee_id, advisorId: form.elements.advisor.value || null });
        await API.api(endpoint(month), { method: "PATCH", body });
        if (editing?.row !== original || monthInput.value !== month) return;
        dialog.close();
        await refresh(office ? "通勤費を確認しました。" : "通勤費を申告しました。");
      } catch (err) {
        if (editing?.row !== original || monthInput.value !== month) return;
        if (["commute_stale","commute_locked"].includes(err.code)) {
          dialog.close(); await refresh(err.hint || err.message);
        } else {
          alert.textContent = err.hint || err.message || "保存できませんでした。"; button.disabled = false;
        }
      }
    });
    sync();
    dialog.showModal();
  }

  content?.addEventListener("click", event => {
    const id = event.target.closest("[data-edit]")?.dataset.edit;
    const r = rows.find(row => row.employee_id === id);
    if (r && !r.locked) openEditor(r);
  });
  dialog?.addEventListener("click", event => { if (event.target.closest("[data-close]")) dialog.close(); });
  dialog?.addEventListener("close", () => { editing = null; });
  downloadButton?.addEventListener("click", async () => {
    const month = monthInput.value;
    if (!month) { feedback.textContent = "対象月を選択してください。"; return; }
    try {
      await KPLayout.busy(downloadButton, "作成中…", async () => {
        const token = await API.getToken();
        if (!token) throw new Error("ログインしてください。");
        const response = await fetch(endpoint(month) + "&format=csv", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
        if (!response.ok) throw new Error((await response.json()).hint || "月次CSVを作成できませんでした。");
        const url = URL.createObjectURL(await response.blob());
        const a = document.createElement("a");
        a.href = url; a.download = "勤怠・通勤費_" + month + ".csv"; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      feedback.textContent = month + "の月次CSVを出力しました。";
    } catch (err) { feedback.textContent = err.message; }
  });
  if (scope === "advisor") monthInput.value = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
  return { refresh };
})();
