(function (root) {
  "use strict";
  // Pure presentation helpers. No API, storage, inferred completions or system receipts.
  function inherit(rows, schedule, { includeNew = true, max = 10 } = {}) {
    const items = (rows || []).map(row => ({ ...row }));
    const ids = new Set(items.map(row => row.schedule_event_id).filter(Boolean));
    let added = 0, omitted = 0;
    if (includeNew && schedule?.status === "available") {
      for (const plan of schedule.items || []) {
        if (!plan?.schedule_event_id || ids.has(plan.schedule_event_id)) continue;
        if (items.length >= max) { omitted++; continue; }
        items.push({ ...plan, actual: null, actual_minutes: null, measurement_note: "", done: false });
        ids.add(plan.schedule_event_id); added++;
      }
    }
    return { items, added, omitted, state: schedule?.status || "unavailable", quantityAvailable: schedule?.quantityAvailable };
  }
  const jst = value => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return "未確認";
    return new Date(time + 9 * 3600000).toISOString().slice(5, 16).replace("T", " ");
  };
  function timeLabel(row) {
    return row.planned_all_day === true || row.planned_all_day === "1"
      ? `終日 ${jst(row.planned_starts_at).slice(0, 5)} ～ ${jst(row.planned_ends_at).slice(0, 5)}`
      : `${jst(row.planned_starts_at)} ～ ${jst(row.planned_ends_at)}`;
  }
  function notice(result) {
    if (result.state === "unavailable") return "カレンダー予定を確認できません。0件とは扱いません。保存済みの下書きは保持します。";
    if (result.state === "incomplete") return "予定の取得上限に達しました。自動引継ぎは保留し、保存済みの入力を保持します。";
    if (result.omitted) return `日報は10行までです。${result.omitted}件の予定はまだ引き継いでいません。予定表で確認してください。`;
    return "時間・内容・設定済みの数字は本人の共有カレンダーから引継ぎ。保存後は当時の控えを保持します。"
      + (result.quantityAvailable === false ? "数字の保存はまだ準備されていません。未設定を0とは扱いません。" : "実績だけを記入してください。");
  }
  function rowHtml(row, esc) {
    const hidden = (key, value) => `<input type="hidden" data-k="${key}" value="${esc(value ?? "")}">`;
    return `<div class="t"><input data-k="task" class="task" aria-label="予定の内容" readonly value="${esc(row.task || "")}"><span class="kp-chip">予定から引継ぎ</span></div>
      <p class="muted">予定（JST）：${esc(timeLabel(row))}</p>
      <div class="np-schedule-measures">
        <label>実績時間（自己申告・分）<input data-k="actual_minutes" type="number" min="0" max="1440" step="0.1" placeholder="未計測" value="${esc(row.actual_minutes ?? "")}"></label>
        <label>数字（自己申告・任意）<span class="np-schedule-number"><input data-k="actual" type="number" min="0" max="1000000000" step="any" placeholder="未記録" value="${esc(row.actual ?? "")}"><input data-k="unit" maxlength="10" aria-label="数字の単位" placeholder="件など" value="${esc(row.unit || "")}" ${row.target != null ? "readonly" : ""}></span></label>
      </div>
      <p class="muted">予定枠 ≠ 実作業時間。空欄は未計測・未記録で、0ではありません。${row.target != null ? `目標（保存済み）：${esc(row.target)}${esc(row.unit || "")}` : "目標数字：未設定"}</p>
      <details><summary>補足（任意）</summary><input data-k="measurement_note" maxlength="500" placeholder="必要な場合だけ。割込みや作業内容の違いなど" value="${esc(row.measurement_note || "")}"></details>
      <p class="muted">システム実績：未接続・未確認。自己申告だけで完了・品質・効率は判定しません。</p>
      ${["schedule_event_id", "planned_starts_at", "planned_ends_at", "target", "done_when", "result", "undone_reason"].map(key => hidden(key, row[key])).join("")}
      ${hidden("planned_all_day", row.planned_all_day === true || row.planned_all_day === "1" ? "1" : "")}
      ${hidden("done", row.done === true || row.done === "1" ? "1" : "")}`;
  }
  root.NippoSchedule = Object.freeze({ inherit, timeLabel, notice, rowHtml });
})(window);
