// 給与の履歴の純粋な部品（lib/compensation.js）。
//
// ■ 何を守るのか
//   1. 入力の検査: 日付・種別・金額（整数の円）・手当の形・理由（必須）
//   2. 履歴が必ず残る: 新しい適用開始日の行を足す／同じ適用開始日は「訂正＝次の版」。上書き・削除に当たる計画を作らない
//   3. 「いまの給与」= 適用開始日が今日以前で最も新しい日付の、最新の版。未来の予定・訂正前の版は「いま」ではない
//   4. 変更前後の差・注意（遡及・予定・後の記録・契約との食い違い）が正しく出る
//   5. 契約上の賃金との食い違いを見つける（契約は参照であり、ここでは書き換えない）
import assert from "node:assert/strict";
import {
  WAGE_TYPES, normalizeRecordInput, toYen, isDate, monthlyOf, snapshotOf, sameContent, viewOf,
  latestRevisions, currentAt, upcomingAfter, historyGroups, diffSnapshots, planRecord, contractCheck, statusFlags,
} from "../lib/compensation.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const NOW = Date.parse("2026-09-30T03:00:00Z");
const TODAY = "2026-09-30";
const good = (o = {}) => ({ effectiveFrom: "2026-10-01", wageType: "月給", baseAmount: 300000, allowances: [{ name: "役職手当", amount: 20000 }],
  commuteAmount: 10000, reason: "定期昇給", ...o });
const norm = (o) => normalizeRecordInput(good(o), { now: NOW });
const rec = (o = {}) => ({ id: o.id || `r${Math.random()}`, effectiveFrom: "2026-04-01", revision: 1, kind: "initial", wageType: "月給", baseAmount: 300000,
  allowances: [], commuteAmount: null, ...o });

console.log("— 入力の検査 —");

ok("正しい入力は通る。手当・通勤手当・理由が整う", () => {
  const r = norm({});
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(r.value, { effectiveFrom: "2026-10-01", wageType: "月給", baseAmount: 300000, allowances: [{ name: "役職手当", amount: 20000 }],
    commuteAmount: 10000, commuteNote: null, reason: "定期昇給", source: "owner", correct: false });
});

ok("適用開始日: 実在する日付だけ。2000年〜5年先まで", () => {
  for (const d of [undefined, "", "2026-02-30", "2026/10/01", "20261001", "2026-13-01", "1999-12-31", "2032-01-01", 20261001]) {
    assert.equal(norm({ effectiveFrom: d }).field, "effectiveFrom", String(d));
  }
  assert.equal(norm({ effectiveFrom: "2025-04-01" }).error, undefined, "過去の日付（遡及）も入力としては通る");
  assert.equal(isDate("2024-02-29"), true);
  assert.equal(isDate("2025-02-29"), false);
});

ok("賃金の種別は 月給・年俸・時給・日給 だけ（その他は入れない）", () => {
  assert.deepEqual(WAGE_TYPES, ["月給", "年俸", "時給", "日給"]);
  for (const t of ["その他", "", undefined, "monthly"]) assert.equal(norm({ wageType: t }).field, "wageType", String(t));
});

ok("基本給: 整数の円。カンマ・全角・円は許す。小数・負・上限超え・数でないものは断る", () => {
  assert.equal(toYen("300,000"), 300000);
  assert.equal(toYen("３００，０００円"), 300000);
  assert.equal(toYen(""), null);
  assert.ok(Number.isNaN(toYen("1000.5")));
  assert.ok(Number.isNaN(toYen(1000.5)));
  assert.ok(Number.isNaN(toYen("-5")));
  assert.ok(Number.isNaN(toYen("abc")));
  assert.equal(norm({ baseAmount: "300,000" }).value.baseAmount, 300000);
  for (const v of [undefined, "", -1, 1.5, "12万", 100000001, "abc", {}, []]) assert.equal(norm({ baseAmount: v }).field, "baseAmount", JSON.stringify(v));
  assert.equal(norm({ baseAmount: 0 }).error, undefined, "0 円は通る（無給の時期もあり得る）");
});

ok("手当: 空行は捨てる。名前だけ・金額だけ・重複・負・21件は断る", () => {
  const r = norm({ allowances: [{ name: "", amount: "" }, { name: "住宅手当", amount: "15,000" }, {}] });
  assert.deepEqual(r.value.allowances, [{ name: "住宅手当", amount: 15000 }]);
  assert.equal(norm({ allowances: [{ name: "住宅手当", amount: "" }] }).field, "allowances");
  assert.equal(norm({ allowances: [{ name: "", amount: 5 }] }).field, "allowances");
  assert.equal(norm({ allowances: [{ name: "住宅手当", amount: -5 }] }).field, "allowances");
  assert.equal(norm({ allowances: [{ name: "住宅手当", amount: 1.5 }] }).field, "allowances");
  assert.equal(norm({ allowances: [{ name: "住宅手当", amount: 1 }, { name: " 住宅手当 ", amount: 2 }] }).field, "allowances");
  assert.equal(norm({ allowances: "手当" }).field, "allowances");
  assert.equal(norm({ allowances: [1] }).field, "allowances");
  assert.equal(norm({ allowances: Array.from({ length: 21 }, (_, i) => ({ name: `手当${i}`, amount: 1 })) }).field, "allowances");
  assert.deepEqual(norm({ allowances: undefined }).value.allowances, []);
});

ok("通勤手当: 空なら null（未設定）。負・小数は断る", () => {
  assert.equal(norm({ commuteAmount: "" }).value.commuteAmount, null);
  assert.equal(norm({ commuteAmount: undefined }).value.commuteAmount, null);
  assert.equal(norm({ commuteAmount: 0 }).value.commuteAmount, 0);
  for (const v of [-1, 1.5, "abc", 10000001]) assert.equal(norm({ commuteAmount: v }).field, "commuteAmount", String(v));
});

ok("変更理由は必須（空・空白だけは断る）。長すぎれば切る。制御文字は除く", () => {
  for (const v of [undefined, "", "   ", "\n\t"]) assert.equal(norm({ reason: v }).field, "reason", JSON.stringify(v));
  assert.equal(norm({ reason: "a".repeat(700) }).value.reason.length, 500);
  assert.equal(norm({ reason: "理由\u0000あり" }).value.reason, "理由あり");
});

ok("取り込み元は owner / contract_import / offer_import だけ。訂正は correct:true のときだけ", () => {
  assert.equal(norm({ source: "csv" }).field, "source");
  assert.equal(norm({ source: "contract_import" }).value.source, "contract_import");
  assert.equal(norm({}).value.correct, false);
  assert.equal(norm({ correct: "true" }).value.correct, false, "文字列の true は訂正にしない");
  assert.equal(norm({ correct: true }).value.correct, true);
});

ok("知らないキー（社員ID・版・作成者など）は、値に入らない", () => {
  const v = norm({ employeeId: "x", revision: 9, kind: "correction", createdBy: "y", tenantId: "t", unitPrice: 700000 }).value;
  for (const k of ["employeeId", "revision", "kind", "createdBy", "tenantId", "unitPrice"]) assert.ok(!(k in v), k);
});

console.log("— 月額・比較 —");

ok("月額: 月給はそのまま、年俸は12で割る（四捨五入）、時給・日給は合計を出さない", () => {
  assert.deepEqual(monthlyOf({ wageType: "月給", baseAmount: 300000, allowances: [{ name: "a", amount: 20000 }], commuteAmount: 10000 }),
    { base: 300000, allowanceTotal: 20000, commute: 10000, total: 330000 });
  assert.equal(monthlyOf({ wageType: "年俸", baseAmount: 6000000, allowances: [], commuteAmount: null }).total, 500000);
  assert.equal(monthlyOf({ wageType: "年俸", baseAmount: 5000000, allowances: [], commuteAmount: null }).base, 416667);
  const h = monthlyOf({ wageType: "時給", baseAmount: 2000, allowances: [{ name: "a", amount: 3000 }], commuteAmount: 5000 });
  assert.equal(h.total, null, "実稼働が未確定なので合計は出さない");
  assert.equal(h.allowanceTotal, 3000);
  assert.equal(h.commute, 5000);
});

ok("同じ内容か: 手当の並び順は問わない。版・日付・理由は見ない", () => {
  const a = rec({ allowances: [{ name: "住宅", amount: 1 }, { name: "役職", amount: 2 }], commuteAmount: 5 });
  const b = rec({ id: "x", revision: 3, effectiveFrom: "2027-01-01", allowances: [{ name: "役職", amount: 2 }, { name: "住宅", amount: 1 }], commuteAmount: 5 });
  assert.equal(sameContent(a, b), true);
  assert.equal(sameContent(a, { ...b, commuteAmount: 6 }), false);
  assert.equal(sameContent(a, { ...b, baseAmount: 1 }), false);
  assert.equal(sameContent(a, null), false);
});

console.log("— 履歴・いまの給与 —");

const H = [
  rec({ id: "a", effectiveFrom: "2026-04-01", revision: 1, kind: "initial", baseAmount: 300000 }),
  rec({ id: "b", effectiveFrom: "2026-10-01", revision: 1, kind: "change", baseAmount: 320000 }),
  rec({ id: "c", effectiveFrom: "2026-10-01", revision: 2, kind: "correction", baseAmount: 330000 }),
  rec({ id: "d", effectiveFrom: "2027-04-01", revision: 1, kind: "change", baseAmount: 350000 }),
];

ok("適用開始日ごとに最新の版だけ。新しい日付が先", () => {
  assert.deepEqual(latestRevisions(H).map((r) => r.id), ["d", "c", "a"]);
});

ok("いまの給与 = 今日以前で最も新しい日付の、最新の版。未来の予定・訂正前の版は「いま」ではない", () => {
  assert.equal(currentAt(H, "2026-09-30").id, "a");
  assert.equal(currentAt(H, "2026-10-01").id, "c", "同じ日付に訂正があれば、訂正後の版");
  assert.equal(currentAt(H, "2027-03-31").id, "c");
  assert.equal(currentAt(H, "2027-04-01").id, "d");
  assert.equal(currentAt(H, "2026-03-31"), null, "最初の記録より前は、まだ給与の記録が無い");
  assert.equal(currentAt([], "2026-09-30"), null);
});

ok("これからの予定は、近い順。訂正前の版は出ない", () => {
  assert.deepEqual(upcomingAfter(H, "2026-09-30").map((r) => r.id), ["c", "d"]);
  assert.deepEqual(upcomingAfter(H, "2027-04-01"), []);
});

ok("履歴は適用開始日ごとにまとまり、同じ日の版は新しい順。訂正前の版も消えない", () => {
  const g = historyGroups(H);
  assert.deepEqual(g.map((x) => x.effectiveFrom), ["2027-04-01", "2026-10-01", "2026-04-01"]);
  assert.deepEqual(g[1].revisions.map((r) => r.id), ["c", "b"]);
  assert.equal(g[1].latest.id, "c");
  assert.equal(g.reduce((n, x) => n + x.revisions.length, 0), H.length, "1件も減らない");
});

console.log("— 差 —");

ok("変更前後の差: 基本給・手当の追加/削除/金額・通勤手当。同じ項目は出ない", () => {
  const before = snapshotOf(rec({ wageType: "月給", baseAmount: 300000, allowances: [{ name: "役職手当", amount: 20000 }, { name: "住宅手当", amount: 10000 }], commuteAmount: 8000 }));
  const after = { wageType: "月給", baseAmount: 320000, allowances: [{ name: "役職手当", amount: 30000 }, { name: "資格手当", amount: 5000 }], commuteAmount: 8000 };
  const d = Object.fromEntries(diffSnapshots(before, after).map((x) => [x.key, x]));
  assert.deepEqual(Object.keys(d).sort(), ["allowance:住宅手当", "allowance:役職手当", "allowance:資格手当", "baseAmount"]);
  assert.deepEqual([d.baseAmount.from, d.baseAmount.to, d.baseAmount.change], [300000, 320000, "changed"]);
  assert.equal(d["allowance:住宅手当"].change, "removed");
  assert.equal(d["allowance:資格手当"].change, "added");
  assert.deepEqual([d["allowance:役職手当"].from, d["allowance:役職手当"].to], [20000, 30000]);
});

ok("初回は、すべて「追加」", () => {
  const d = diffSnapshots(null, { wageType: "月給", baseAmount: 300000, allowances: [{ name: "役職手当", amount: 1 }], commuteAmount: 2 });
  assert.deepEqual(d.map((x) => [x.key, x.change]), [["wageType", "added"], ["baseAmount", "added"], ["allowance:役職手当", "added"], ["commuteAmount", "added"]]);
});

console.log("— 記録の計画 —");

const inp = (o = {}) => normalizeRecordInput(good(o), { now: NOW }).value;

ok("最初の記録は initial・版1・変更前なし", () => {
  const { plan } = planRecord([], inp(), { today: TODAY });
  assert.equal(plan.kind, "initial");
  assert.equal(plan.revision, 1);
  assert.equal(plan.before, null);
  assert.ok(plan.changes.length >= 3);
});

ok("別の適用開始日は change・版1。変更前は、その日に有効だった給与", () => {
  const { plan } = planRecord(H, inp({ effectiveFrom: "2027-10-01", baseAmount: 400000 }), { today: TODAY });
  assert.equal(plan.kind, "change");
  assert.equal(plan.revision, 1);
  assert.equal(plan.before.baseAmount, 350000);
  assert.deepEqual(plan.changes.find((x) => x.key === "baseAmount") && [plan.changes.find((x) => x.key === "baseAmount").from, plan.changes.find((x) => x.key === "baseAmount").to], [350000, 400000]);
});

ok("同じ適用開始日に、訂正の指定なしで記録しようとしたら断る（黙って上書き・重複させない）", () => {
  const r = planRecord(H, inp({ effectiveFrom: "2026-10-01", baseAmount: 999999 }), { today: TODAY });
  assert.equal(r.error, "exists_at_date");
});

ok("訂正は、同じ適用開始日の次の版。変更前は、その日の最新の版（訂正前の値）", () => {
  const { plan } = planRecord(H, inp({ effectiveFrom: "2026-10-01", baseAmount: 335000, correct: true }), { today: TODAY });
  assert.equal(plan.kind, "correction");
  assert.equal(plan.revision, 3);
  assert.equal(plan.before.baseAmount, 330000);
  assert.equal(plan.before.revision, 2);
  assert.ok(plan.warnings.some((w) => /訂正/.test(w)));
});

ok("記録が無い日付を「訂正」とは言えない", () => {
  assert.equal(planRecord(H, inp({ effectiveFrom: "2026-11-01", correct: true }), { today: TODAY }).error, "nothing_to_correct");
  assert.equal(planRecord([], inp({ correct: true }), { today: TODAY }).error, "nothing_to_correct");
});

ok("変更前と同じ内容は、記録しない（履歴を意味なく増やさない）", () => {
  const same = inp({ effectiveFrom: "2028-01-01", baseAmount: 350000, allowances: [], commuteAmount: null });
  assert.equal(planRecord(H, same, { today: TODAY }).error, "no_change");
  const corrSame = inp({ effectiveFrom: "2026-10-01", baseAmount: 330000, allowances: [], commuteAmount: null, correct: true });
  assert.equal(planRecord(H, corrSame, { today: TODAY }).error, "no_change");
});

ok("注意: 遡及・予定・後の記録・最初の記録より前", () => {
  const retro = planRecord(H, inp({ effectiveFrom: "2026-06-01", baseAmount: 310000 }), { today: TODAY }).plan;
  assert.ok(retro.warnings.some((w) => /遡及/.test(w)));
  assert.ok(retro.warnings.some((w) => /後の記録/.test(w)), "2026-10-01・2027-04-01 が後にある");
  const fut = planRecord(H, inp({ effectiveFrom: "2028-01-01", baseAmount: 360000 }), { today: TODAY }).plan;
  assert.ok(fut.warnings.some((w) => /これから適用/.test(w)));
  const first = planRecord(H, inp({ effectiveFrom: "2026-01-01", baseAmount: 250000 }), { today: TODAY }).plan;
  assert.equal(first.kind, "change");
  assert.equal(first.before, null);
  assert.ok(first.warnings.some((w) => /より前の日付/.test(w)));
});

ok("注意: 契約の賃金と食い違うときに出す（契約は変わらないことも伝える）", () => {
  const { plan } = planRecord(H, inp({ effectiveFrom: "2028-01-01", baseAmount: 360000 }), { today: TODAY, contract: { wage_type: "月給", wage_amount: 300000 } });
  assert.ok(plan.warnings.some((w) => /契約の賃金と食い違います/.test(w) && /契約は、ここでは変わりません/.test(w)));
  const same = planRecord(H, inp({ effectiveFrom: "2028-01-01", baseAmount: 360000 }), { today: TODAY, contract: { wage_type: "月給", wage_amount: 360000 } }).plan;
  assert.ok(!same.warnings.some((w) => /契約/.test(w)));
});

ok("追記だけ: どんな順番で記録しても、前の行は1件も変わらず、版と種別が規則どおり", () => {
  let records = [];
  const seen = [];
  let n = 0;
  const dates = ["2026-04-01", "2026-10-01", "2026-07-01", "2027-01-01", "2026-10-01", "2026-04-01", "2027-01-01", "2026-07-01"];
  for (const d of dates) {
    n += 1;
    const exists = records.some((r) => r.effectiveFrom === d);
    const r = planRecord(records, inp({ effectiveFrom: d, baseAmount: 200000 + n * 1000, correct: exists }), { today: TODAY });
    assert.equal(r.error, undefined, `${d}: ${JSON.stringify(r)}`);
    const before = JSON.stringify(records);
    records = [...records, rec({ id: `n${n}`, effectiveFrom: d, revision: r.plan.revision, kind: r.plan.kind, baseAmount: r.plan.after.baseAmount })];
    // 前の行は、そのまま
    assert.equal(JSON.stringify(records.slice(0, -1)), before);
    seen.push(records.length);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8], "1回ごとに1件だけ増える");
  // 規則: (日付, 版) は一意・版は1から連番・版1は initial か change・版2以降は correction
  const by = new Map();
  for (const r of records) { by.set(r.effectiveFrom, [...(by.get(r.effectiveFrom) || []), r]); }
  for (const [, list] of by) {
    const revs = list.map((r) => r.revision).sort((a, b) => a - b);
    assert.deepEqual(revs, revs.map((_, i) => i + 1));
    for (const r of list) assert.equal(r.revision === 1 ? ["initial", "change"].includes(r.kind) : r.kind === "correction", true);
  }
  assert.equal(records.filter((r) => r.kind === "initial").length, 1, "初回は1件だけ");
});

console.log("— 契約との食い違い・一覧の状態 —");

ok("契約の賃金との比較: 一致・種別違い・金額違い・契約なし・取り込めない種別", () => {
  const cur = rec({ wageType: "月給", baseAmount: 300000 });
  assert.equal(contractCheck(cur, { wage_type: "月給", wage_amount: 300000 }).state, "match");
  assert.equal(contractCheck(cur, { wage_type: "年俸", wage_amount: 300000 }).state, "type");
  assert.equal(contractCheck(cur, { wage_type: "月給", wage_amount: 310000 }).state, "amount");
  assert.equal(contractCheck(cur, null).state, "none");
  assert.equal(contractCheck(cur, { wage_type: "月給", wage_amount: null }).state, "none");
  assert.equal(contractCheck(cur, { wage_type: "その他", wage_amount: 5 }).state, "unsupported");
  assert.equal(contractCheck(null, { wage_type: "月給", wage_amount: 300000 }).state, "unregistered");
  assert.equal(contractCheck(cur, { wageType: "月給", wageAmount: "300000" }).state, "match", "camelCase・文字列の金額も比べられる");
});

ok("一覧の状態: 未登録・適用前・予定あり・契約と不一致", () => {
  const c = { wage_type: "月給", wage_amount: 300000 };
  assert.deepEqual(statusFlags([], c, TODAY), ["unregistered"]);
  assert.deepEqual(statusFlags([rec({ effectiveFrom: "2026-12-01" })], c, TODAY), ["future_only"]);
  assert.deepEqual(statusFlags([rec({ effectiveFrom: "2026-04-01" })], c, TODAY), []);
  assert.deepEqual(statusFlags([rec({ effectiveFrom: "2026-04-01" }), rec({ effectiveFrom: "2027-04-01" })], c, TODAY), ["upcoming"]);
  assert.deepEqual(statusFlags([rec({ effectiveFrom: "2026-04-01", baseAmount: 310000 })], c, TODAY), ["mismatch"]);
});

ok("表の行 → 画面の形。数は数として返り、契約の写しがまとまる", () => {
  const v = viewOf({ id: "1", employee_id: "e", effective_from: "2026-04-01", revision: 1, kind: "initial", source: "contract_import", wage_type: "月給",
    base_amount: "300000", allowances: [{ name: "役職手当", amount: 20000 }], commute_amount: "10000", commute_note: null,
    contract_id: "k1", contract_wage_type: "月給", contract_wage_amount: "300000", reason: "初回", before: null, created_by_name: "経営者", created_at: "2026-09-30T00:00:00Z" });
  assert.equal(v.baseAmount, 300000);
  assert.equal(v.commuteAmount, 10000);
  assert.deepEqual(v.contract, { id: "k1", wageType: "月給", wageAmount: 300000 });
  assert.equal(v.monthly.total, 330000);
  assert.equal(viewOf({ ...{ id: "1", wage_type: "月給", base_amount: 1, allowances: [] } }).contract, null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
