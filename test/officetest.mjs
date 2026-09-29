// 月末月初業務（/office）：「今月、何が止まっているか」の導き方（lib/office.js）。
//
// ■ 何を守るテストか
//
//   1. 勤務表の提出期限は「翌月の第3営業日」（祝日・年末年始を数えない）
//   2. 現在工程は「最初に済んでいない工程」。売上のみ（PP）は仕入・支払が対象外で、
//      売上請求を送れば完了。BP は仕入請求・支払まで。支払の記録が無いうちは完了にしない
//   3. 期限超過は、勤務表が未提出で期限を過ぎたものだけ（他の工程は期限を持たない）
//   4. 印が順番どおりでない・BP会社が特定できない、などは、その行だけ「要確認」にする
//      （他の行の処理を止めない）
//   5. 集計（対象・勤務表待ち・請求未送付・完了…）と、絞り込みの印（tags）が一致する
//   6. 単価（unit_price）に触れない。意味が確認できるまで、読まない・出さない
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const O = await import(join(ROOT, "lib/office.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const NONE = { timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false };
const row = (marks = {}, extra = {}) => ({
  siteContractId: "sc-1", employeeId: "e-1", employeeName: "田中 太郎", department: "常駐部",
  employeeKind: "proper", partnerName: null,
  engagementKind: "pp", siteCompany: "顧客A社", primeCompany: null,
  periodFrom: "2026-04-01", periodTo: null, renewalStatus: "confirmed",
  marks: { ...NONE, ...marks }, submissions: [],
  ...extra,
});
const BP = { engagementKind: "bp", employeeKind: "bp", partnerName: "株式会社ビーピー" };
const D = "2026-10-05";          // 2026-09 分の提出期限
const derive = (marks, extra, today = "2026-09-29") => O.deriveRow(row(marks, extra), { today, deadline: D });

console.log("— 勤務表の提出期限（翌月の第3営業日） —");

await ok("2026-09 分 → 2026-10-05（10/1 木・10/2 金・10/5 月）", async () => {
  assert.equal(O.timesheetDeadline("2026-09"), "2026-10-05");
});
await ok("2026-04 分 → 2026-05-08（5/1 金のあと、5/3〜5/6 は連休で、5/7・5/8 が2・3番目）", async () => {
  assert.equal(O.timesheetDeadline("2026-04"), "2026-05-08");
});
await ok("2026-12 分 → 2027-01-06（1/1・1/2 は年始で休み、1/4・1/5・1/6）", async () => {
  assert.equal(O.timesheetDeadline("2026-12"), "2027-01-06");
});
await ok("2027-01 分 → 2027-02-03（年をまたがない月）", async () => {
  assert.equal(O.timesheetDeadline("2027-01"), "2027-02-03");
});
await ok("何営業日目かは変えられる（第1営業日）", async () => {
  assert.equal(O.timesheetDeadline("2026-09", 1), "2026-10-01");
});

console.log("— 現在工程：最初に済んでいない工程 —");

const PP_FLOW = [
  [{}, "timesheet", "勤務表待ち"],
  [{ timesheet_received: true }, "work", "稼働確認待ち"],
  [{ timesheet_received: true, work_confirmed: true }, "invoice_create", "請求作成待ち"],
  [{ timesheet_received: true, work_confirmed: true, board_created: true }, "invoice_send", "請求送付待ち"],
  [{ timesheet_received: true, work_confirmed: true, board_created: true, sent: true }, "done", "完了"],
];
for (const [marks, stage, label] of PP_FLOW) {
  await ok(`PP（売上のみ）：${label}`, async () => {
    const r = derive(marks);
    assert.equal(r.stage, stage);
    assert.equal(r.stageLabel, label);
    assert.equal(r.done, stage === "done");
    assert.equal(r.usesVendor, false);
  });
}
await ok("PP は仕入請求・支払が「対象外」で、未完了の判定に含めない", async () => {
  const r = derive({ timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: false });
  assert.equal(r.cols.vendorInvoice.state, "not_applicable");
  assert.equal(r.cols.payment.state, "not_applicable");
  assert.equal(r.done, true, "BP請求書が来ていなくても、売上のみなら完了");
  assert.equal(r.action, null);
});

const ALL_SALES = { timesheet_received: true, work_confirmed: true, board_created: true, sent: true };
await ok("BP：売上を送ったあと、仕入請求待ち → 支払準備", async () => {
  const a = derive(ALL_SALES, BP);
  assert.equal(a.stage, "vendor");
  assert.equal(a.usesVendor, true);
  assert.match(a.action.text, /株式会社ビーピー/);
  const b = derive({ ...ALL_SALES, bp_invoice_received: true }, BP);
  assert.equal(b.stage, "payment");
  assert.equal(b.stageLabel, "支払準備");
});
await ok("BP は、仕入請求が届いても支払の記録が無いうちは完了にしない（支払は「未管理」）", async () => {
  const r = derive({ ...ALL_SALES, bp_invoice_received: true }, BP);
  assert.equal(r.done, false);
  assert.equal(r.cols.payment.state, "unmanaged");
  assert.equal(r.cols.payment.label, "未管理");
});
await ok("BP の仕入請求が、売上より先に届いていても、現在工程は売上側の未完了工程", async () => {
  const r = derive({ timesheet_received: true, work_confirmed: true, bp_invoice_received: true }, BP);
  assert.equal(r.stage, "invoice_create");
  assert.equal(r.cols.vendorInvoice.state, "received");
  assert.equal(r.check, false, "順序の異常ではない（仕入請求はいつ届いてもよい）");
});

console.log("— 各列の状態 —");

await ok("勤務表・稼働・売上請求の状態", async () => {
  const r = derive({ timesheet_received: true, work_confirmed: true, board_created: true });
  assert.deepEqual([r.cols.timesheet.label, r.cols.work.label, r.cols.salesInvoice.label], ["提出済", "確認済", "作成済"]);
  const s = derive({ ...ALL_SALES });
  assert.equal(s.cols.salesInvoice.label, "送付済");
  const n = derive({});
  assert.deepEqual([n.cols.timesheet.label, n.cols.work.label, n.cols.salesInvoice.label], ["未提出", "未確認", "未作成"]);
});

console.log("— 期限超過 —");

await ok("勤務表が未提出で、期限（10/5）を過ぎたら期限超過", async () => {
  assert.equal(derive({}, {}, "2026-10-06").overdue, true);
  assert.match(derive({}, {}, "2026-10-06").action.text, /10\/5.*過ぎて/);
});
await ok("期限の当日・前は、期限超過ではない（待っている）", async () => {
  assert.equal(derive({}, {}, "2026-10-05").overdue, false);
  const r = derive({}, {}, "2026-09-29");
  assert.equal(r.overdue, false);
  assert.match(r.action.text, /待っています.*10\/5/);
});
await ok("勤務表が届いていれば、期限を過ぎていても期限超過ではない（他の工程は期限を持たない）", async () => {
  assert.equal(derive({ timesheet_received: true }, {}, "2026-12-31").overdue, false);
});
await ok("期限が分からない月は、期限超過にしない", async () => {
  const r = O.deriveRow(row({}), { today: "2030-01-01", deadline: null });
  assert.equal(r.overdue, false);
});

console.log("— 要確認：その行だけ印をつける —");

await ok("印が順番どおりでない（勤務表が未受領なのに、送付済み）→ 要確認。現在工程は最初の未完了", async () => {
  const r = derive({ sent: true });
  assert.equal(r.check, true);
  assert.match(r.warnings[0], /順番/);
  assert.equal(r.stage, "timesheet");
  assert.ok(r.tags.includes("check"));
});
await ok("勤務表のファイルが届いているのに、受領の印が無い → 要確認", async () => {
  const r = derive({}, { submissions: [{ id: "s1", kind: "timesheet", fileName: "a.pdf", submittedAt: "2026-09-30T01:00:00Z" }] });
  assert.equal(r.check, true);
  assert.match(r.warnings.join(), /受領の印/);
});
await ok("契約はBPだが、要員がBP区分でない → 要確認（BP会社が特定できない）", async () => {
  const r = derive({}, { engagementKind: "bp", employeeKind: "proper", partnerName: null });
  assert.equal(r.check, true);
  assert.match(r.warnings.join(), /BP区分ではありません/);
});
await ok("BP区分だがBP会社が空 → 要確認", async () => {
  const r = derive({}, { engagementKind: "bp", employeeKind: "bp", partnerName: null });
  assert.match(r.warnings.join(), /BP会社が登録されていません/);
});
await ok("退職済みの要員の契約 → 要確認（隠さない。当月に退職した人の最後の月次を見落とさない）", async () => {
  const r = derive({}, { employeeStatus: "left" });
  assert.equal(r.check, true);
  assert.match(r.warnings.join(), /退職済み/);
  assert.equal(r.stage, "timesheet", "工程の判定は変えない");
  // 在籍中・退職手続き中は印をつけない
  for (const st of ["active", "leaving", "invited", null, undefined]) {
    assert.equal(derive({}, { employeeStatus: st }).check, false, String(st));
  }
});
await ok("正常な行は要確認にならない", async () => {
  assert.equal(derive({ timesheet_received: true }).check, false);
  assert.equal(derive({}, BP).check, false);
});

console.log("— 要対応（次にやること） —");

await ok("工程ごとに、次にやることと、詳細で開く場所が決まっている", async () => {
  const want = [
    [{}, "timesheet"],
    [{ timesheet_received: true }, "timesheet"],
    [{ timesheet_received: true, work_confirmed: true }, "sales"],
    [{ timesheet_received: true, work_confirmed: true, board_created: true }, "sales"],
  ];
  for (const [marks, section] of want) {
    const r = derive(marks);
    assert.equal(r.action.section, section);
    assert.ok(r.action.text && r.action.cta);
  }
  assert.equal(derive({ ...ALL_SALES }, BP).action.section, "vendor");
});

console.log("— 検索・絞り込みの印 —");

await ok("検索の材料に、氏名・客先・上位会社・BP会社・区分が入る", async () => {
  const r = derive({}, { ...BP, primeCompany: "上位商事" });
  for (const w of ["田中", "顧客a社", "上位商事", "ビーピー", "bp", "常駐部"]) {
    assert.ok(r.searchText.includes(w.toLowerCase()), w);
  }
});
await ok("tags が、絞り込みの選択肢と一致する", async () => {
  assert.deepEqual(derive({}, {}, "2026-10-06").tags.sort(), ["overdue", "timesheet"]);
  assert.deepEqual(derive({ timesheet_received: true }).tags, ["work"]);
  assert.deepEqual(derive({ timesheet_received: true, work_confirmed: true }).tags, ["invoice"]);
  assert.deepEqual(derive({ ...ALL_SALES }, BP).tags, ["vendor"]);
  assert.deepEqual(derive({ ...ALL_SALES, bp_invoice_received: true }, BP).tags, ["payment"]);
  assert.deepEqual(derive({ ...ALL_SALES }).tags, ["done"]);
  const keys = new Set(O.FILTERS.map((f) => f.key));
  for (const t of derive({}, {}, "2026-10-06").tags) assert.ok(keys.has(t), t);
});

console.log("— 並び —");

await ok("期限超過 → 未完了（上流の工程から）→ 完了。同じなら氏名順", async () => {
  const mk = (name, marks, today) => derive(marks, { employeeName: name }, today);
  const rows = [
    mk("う 完了", { ...ALL_SALES }),
    mk("い 稼働待ち", { timesheet_received: true }),
    mk("あ 超過", {}, "2026-10-06"),
    mk("え 勤務表待ち", {}, "2026-09-29"),
    mk("お 請求待ち", { timesheet_received: true, work_confirmed: true }),
  ];
  assert.deepEqual(O.sortRows(rows).map((r) => r.employeeName),
    ["あ 超過", "え 勤務表待ち", "い 稼働待ち", "お 請求待ち", "う 完了"]);
});

console.log("— 集計 —");

const SAMPLE = () => [
  derive({}, { employeeName: "a", siteContractId: "1" }, "2026-10-06"),                                     // 勤務表待ち（超過）
  derive({}, { employeeName: "b", siteContractId: "2" }),                                                    // 勤務表待ち
  derive({ timesheet_received: true }, { employeeName: "c", siteContractId: "3" }),                          // 稼働確認待ち
  derive({ timesheet_received: true, work_confirmed: true }, { employeeName: "d", siteContractId: "4" }),   // 請求作成待ち
  derive({ timesheet_received: true, work_confirmed: true, board_created: true }, { employeeName: "e", siteContractId: "5" }), // 請求送付待ち
  derive({ ...ALL_SALES }, { employeeName: "f", siteContractId: "6" }),                                     // 完了（PP）
  derive({ ...ALL_SALES }, { ...BP, employeeName: "g", siteContractId: "7" }),                               // 仕入請求待ち
  derive({ ...ALL_SALES, bp_invoice_received: true }, { ...BP, employeeName: "h", siteContractId: "8" }),   // 支払準備
];
await ok("ダッシュボードの数字", async () => {
  const s = O.summarize(SAMPLE());
  const c = Object.fromEntries(s.cards.map((x) => [x.key, x]));
  assert.equal(c.all.value, 8);
  assert.equal(c.timesheet.value, 2);
  assert.equal(c.timesheet.alert, true, "期限超過があれば警告色");
  assert.equal(c.work.value, 1);
  assert.equal(c.invoice.value, 2, "請求作成待ち＋請求送付待ち");
  assert.equal(c.vendor.value, 1);
  assert.equal(c.done.value, 1);
  assert.equal(c.done.of, 8);
  assert.equal(s.cards.length, 6, "カードを増やしすぎない");
});
await ok("月次進捗（BP は仕入請求の分母がBPの件数）", async () => {
  const p = Object.fromEntries(O.summarize(SAMPLE()).progress.map((x) => [x.key, x]));
  assert.deepEqual([p.timesheet.done, p.timesheet.of], [6, 8]);
  assert.deepEqual([p.work.done, p.work.of], [5, 8]);
  assert.deepEqual([p.invoice.done, p.invoice.of], [3, 8]);
  assert.deepEqual([p.vendor.done, p.vendor.of], [1, 2]);
  assert.deepEqual([p.done.done, p.done.of], [1, 8]);
});
await ok("今日やること：件数のあるものだけ。期限超過は未提出の内訳", async () => {
  const t = O.summarize(SAMPLE()).today;
  const byKey = Object.fromEntries(t.map((x) => [x.key, x]));
  assert.equal(byKey.timesheet.count, 2);
  assert.equal(byKey.timesheet.note, "うち期限超過 1件");
  assert.equal(byKey.work.count, 1);
  assert.equal(byKey.invoice.count, 2);
  assert.equal(byKey.vendor.count, 1);
  assert.equal(byKey.check, undefined, "要確認が無ければ出さない");
  assert.ok(!t.some((x) => x.count === 0));
});
await ok("対象が無い月でも壊れない（0 件）", async () => {
  const s = O.summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.cards[0].value, 0);
  assert.deepEqual(s.today, []);
});
await ok("集計と、行の tags が一致する（数字と一覧の絞り込みで食い違わない）", async () => {
  const rows = SAMPLE();
  const s = O.summarize(rows);
  const c = Object.fromEntries(s.cards.map((x) => [x.key, x.value]));
  assert.equal(rows.filter((r) => r.tags.includes("timesheet")).length, c.timesheet);
  assert.equal(rows.filter((r) => r.tags.includes("work")).length, c.work);
  assert.equal(rows.filter((r) => r.tags.includes("invoice")).length, c.invoice);
  assert.equal(rows.filter((r) => r.tags.includes("vendor")).length, c.vendor);
  assert.equal(rows.filter((r) => r.tags.includes("done")).length, c.done);
});

console.log("— 請求書と1対1にしない／単価に触れない —");

await ok("1人・1契約の行が、請求書の状態を「請求書1枚」として持たない（明細が指す設計）", async () => {
  const src = readFileSync(join(ROOT, "lib/office.js"), "utf8");
  // 行の状態は「この行の印から見た状態」。請求書番号・請求書IDを行に持たせていない
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /invoice_?no|invoiceId|invoice_id/i);
});
await ok("単価（unit_price）を読まない・出さない（意味が確認できるまで）", async () => {
  const src = readFileSync(join(ROOT, "lib/office.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /unit_?price|単価/i);
  const r = derive({}, { unit_price: 700000, unitPrice: 700000 });
  // 材料に紛れ込んでも、検索の材料・状態の導出には使わない
  assert.ok(!r.searchText.includes("700000"));
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
