// 月次請求進捗（勤務表受領 → 稼働確認 → Board作成 → 送付 → BP請求書受領）。
// db/077_billing_progress.sql と1対1。api/billing-progress/index.js から使う。
//
// 請求書そのものは作らない。ここは「どこまで進んだか」の5つの印だけ

export const STAGES = [
  { key: "timesheet_received", label: "勤務表受領" },
  { key: "work_confirmed", label: "稼働確認" },
  { key: "board_created", label: "Board作成" },
  { key: "sent", label: "送付" },
  { key: "bp_invoice_received", label: "BP請求書受領" },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);

/** 'YYYY-MM' の形か */
export const isBillingMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));

/** 何段目まで済んだか（0〜5） */
export const doneCount = (row) => STAGE_KEYS.filter((k) => row?.[k]).length;

/** 進み具合（%） */
export const progressPct = (row) => Math.round((doneCount(row) / STAGE_KEYS.length) * 100);
