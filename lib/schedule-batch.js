// 複数の社内予定を1リクエストで登録するための入力検証。DBへの書込は呼び出し側が一度だけ行う。
export const MAX_CALENDAR_BATCH = 30;

export function prepareCalendarBatch(items, normalize) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CALENDAR_BATCH) {
    return { error: "invalid_batch", hint: "1〜30件の予定を指定してください" };
  }
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const input = items[i];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { error: "invalid_batch", hint: (i + 1) + "行目の予定を確認してください" };
    }
    // 既存の単件作成と同じ必須項目・公開範囲の検査を通す。
    const result = normalize(input);
    if (result.error) return { error: result.error, hint: (i + 1) + "行目：" + (result.hint || result.detail || "入力内容を確認してください") };
    const row = result.value;
    if (Date.parse(row.ends_at) <= Date.parse(row.starts_at)) {
      return { error: "invalid_time", hint: (i + 1) + "行目：終了時間は開始時間より後にしてください" };
    }
    const key = [row.starts_at, row.ends_at, row.title, row.location || ""].join("|");
    if (seen.has(key)) return { error: "duplicate_in_batch", hint: (i + 1) + "行目：同じ予定が入力されています" };
    seen.add(key);
    rows.push(row);
  }
  return { rows };
}
