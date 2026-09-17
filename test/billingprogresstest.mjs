// 月次請求進捗の定義・純粋関数だけを見る。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const B = await import(join(ROOT, "lib/billing-progress.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 月次請求進捗（純粋関数） ===\n");

ok("5段、この順", () => {
  assert.deepEqual(B.STAGE_KEYS,
    ["timesheet_received", "work_confirmed", "board_created", "sent", "bp_invoice_received"]);
});

ok("YYYY-MM の形だけ通す", () => {
  assert.equal(B.isBillingMonth("2026-09"), true);
  assert.equal(B.isBillingMonth("2026-9"), false);
  assert.equal(B.isBillingMonth("2026/09"), false);
  assert.equal(B.isBillingMonth(""), false);
  assert.equal(B.isBillingMonth("2026-13"), false);
});

ok("済んだ段の数を数える", () => {
  assert.equal(B.doneCount({}), 0);
  assert.equal(B.doneCount({ timesheet_received: true, work_confirmed: true }), 2);
  assert.equal(B.doneCount({
    timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true,
  }), 5);
});

ok("進み具合は%で出す", () => {
  assert.equal(B.progressPct({}), 0);
  assert.equal(B.progressPct({ timesheet_received: true }), 20);
  assert.equal(B.progressPct({
    timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true,
  }), 100);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
