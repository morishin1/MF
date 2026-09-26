// 月初業務D1（外部提出フォーム）の値の定義・正規化を確かめる。
// db/080_billing_submission.sql・lib/billing-submission.js と1対1。
//
// ■ 何を守るテストか
//
//   1. 窓口（gw_submission_links）の状態は、無効化・期限切れ・有効の3つ
//   2. 届いた1件の入力チェック（対象年月・区分・ファイルの大きさ・種類）
//   3. 届いた種類が、既存の進捗（gw_billing_progress）のどの印に対応するか
import assert from "node:assert/strict";
import {
  linkStatus, normalizeSubmission, isBillingMonth, PROGRESS_STAGE, KIND, MAX_BYTES,
} from "../lib/billing-submission.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 窓口の状態（linkStatus） ===\n");

ok("無ければ none", () => {
  assert.equal(linkStatus(null), "none");
});
ok("無効化されていれば revoked", () => {
  assert.equal(linkStatus({ revoked_at: "2026-09-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" }), "revoked");
});
ok("期限が過ぎていれば expired", () => {
  assert.equal(linkStatus({ revoked_at: null, expires_at: "2020-01-01T00:00:00Z" }), "expired");
});
ok("どちらでもなければ active", () => {
  assert.equal(linkStatus({ revoked_at: null, expires_at: "2099-01-01T00:00:00Z" }), "active");
});

console.log("\n=== 対象年月（isBillingMonth） ===\n");

ok("YYYY-MM の形だけ通す", () => {
  assert.equal(isBillingMonth("2026-09"), true);
  assert.equal(isBillingMonth("2026-13"), false);
  assert.equal(isBillingMonth("2026/09"), false);
  assert.equal(isBillingMonth(""), false);
});

console.log("\n=== 届いた1件の入力チェック（normalizeSubmission） ===\n");

const body = (over = {}) => ({
  targetMonth: "2026-09", kind: "timesheet", siteContractId: "sc-1",
  filename: "timesheet.pdf", mimeType: "application/pdf", sizeBytes: 1024, ...over,
});

ok("そろっていれば通る", () => {
  const r = normalizeSubmission(body());
  assert.equal(r.error, undefined);
  assert.equal(r.value.targetMonth, "2026-09");
  assert.equal(r.value.kind, "timesheet");
});

ok("対象年月がおかしければ拒否", () => {
  assert.ok(normalizeSubmission(body({ targetMonth: "9月" })).error);
});
ok("区分が timesheet/invoice 以外なら拒否", () => {
  assert.ok(normalizeSubmission(body({ kind: "other" })).error);
});
ok("現場契約IDが無ければ拒否", () => {
  assert.ok(normalizeSubmission(body({ siteContractId: "" })).error);
});
ok("ファイル名が無ければ拒否", () => {
  assert.ok(normalizeSubmission(body({ filename: "" })).error);
});
ok("対応していない形式は拒否", () => {
  const r = normalizeSubmission(body({ mimeType: "application/zip" }));
  assert.equal(r.error, "unsupported_mime");
});
ok(`${MAX_BYTES / 1024 / 1024}MBを超えたら拒否`, () => {
  const r = normalizeSubmission(body({ sizeBytes: MAX_BYTES + 1 }));
  assert.equal(r.error, "file_too_large");
});

console.log("\n=== 進捗（gw_billing_progress）への対応（PROGRESS_STAGE） ===\n");

ok("勤務表は timesheet_received、請求書は bp_invoice_received", () => {
  assert.equal(PROGRESS_STAGE.timesheet, "timesheet_received");
  assert.equal(PROGRESS_STAGE.invoice, "bp_invoice_received");
  for (const k of KIND) assert.ok(PROGRESS_STAGE[k], `${k} の対応先が無い`);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
