// Minimal no-PII projection of Office's document-creation request.
// A completed document request is NOT a signed agreement or a confirmed start.
const STATES = { requested: "未着手", in_progress: "作成中", review: "確認待ち", completed: "作成完了", cancelled: "取消" };
const ymd = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
const iso = v => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export function safeContractSnapshot(row) {
  if (!row || !Object.hasOwn(STATES,String(row.status || ""))) return null;
  return {
    status: String(row.status), label: STATES[row.status],
    requested_due_on: ymd(row.requested_due_on),
    planned_start_on: ymd(row.planned_start_on),
    updated_at: iso(row.updated_at),
    signed: null, // do not infer from status completed
  };
}
