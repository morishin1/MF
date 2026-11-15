import assert from "node:assert/strict";
import { summarizeHeadcount, headcountLabel } from "../lib/headcount.js";
import { buildHub } from "../lib/keiei-hub.js";

const employees = [];
function add(type, n, extra = {}) {
  for (let i = 0; i < n; i++) employees.push({ id: `e${employees.length + 1}`, status: "active", employment_type: type, employee_kind: "proper", ...extra });
}
add("正社員", 8); add("育成枠", 3); add(null, 1); // 12人目は紐付け済みの育成枠
add("パート", 2); add("アルバイト", 1); add("業務委託", 2); add("契約社員", 1, { status: "leaving" });
add("役員", 1); add("正社員", 1, { employee_kind: "bp" }); add("スポット", 1); add(null, 1);
add("正社員", 1, { status: "invited" }); add("正社員", 1, { status: "left" });
const applicants = [
  { employee_id: "e12", offer_type: "training", status: "accepted" },
  { employee_id: "e12", offer_type: "training", status: "done" },
  { employee_id: null, offer_type: "training", status: "accepted" },
  { employee_id: "e22", offer_type: "training", status: "declined" },
];
const result = summarizeHeadcount(employees, { applicants });
assert.equal(result.total, 22);
assert.equal(result.breakdown.reduce((sum, c) => sum + c.count, 0), 22);
const counts = Object.fromEntries(result.breakdown.map(c => [c.key, c.count]));
assert.deepEqual(counts, { regular: 8, contract: 1, partTime: 3, contractor: 2, officer: 1, training: 4, trial: 0, spot: 1, bp: 1, other: 0, unclassified: 1 });
assert.equal(result.invited, 1);
assert.equal(result.proper + result.bp, 22);
assert.match(headcountLabel(result), /正社員 8人/);
assert.match(headcountLabel(result), /育成枠 4人/);
assert.match(headcountLabel(result), /区分未設定 1人/);
// 雇用形態が確定済みなら採用時の区分で上書きしない。育成期間の長さから推測しない。
assert.equal(summarizeHeadcount([{ id: "e1", status: "active", employment_type: "正社員", training_months: 3 }], {
  applicants: [{ employee_id: "e1", offer_type: "training", status: "done" }],
}).breakdown.find(c => c.key === "regular").count, 1);
const conflicting = summarizeHeadcount([{ id: "x", status: "active" }], { applicants: [
  { employee_id: "x", status: "done", offer_type: "training" }, { employee_id: "x", status: "done", offer_type: "contractor" },
] });
assert.equal(conflicting.breakdown.find(c => c.key === "unclassified").count, 1);
assert.equal(summarizeHeadcount([{ status: "active", employment_type: "不明な既存区分" }]).breakdown.find(c => c.key === "other").count, 1);
assert.equal(summarizeHeadcount([{ status: "active", employment_type: "constructor" }]).breakdown.find(c => c.key === "other").count, 1);
const hub = buildHub({ today: "2026-11-15", facts: { people: result } });
assert.deepEqual(hub.people.breakdown, result.breakdown);
const tile = hub.people.tiles.find(t => t.key === "headcount");
assert.equal(tile.value, 22);
assert.equal(tile.sub, headcountLabel(result));
assert.equal(buildHub({ today: "2026-11-15", facts: {} }).people.breakdown, null);
assert.equal(headcountLabel(null), null);
for (let n = 0; n <= employees.length; n++) {
  const sample = summarizeHeadcount(employees.slice(0, n), { applicants });
  assert.equal(sample.total, sample.breakdown.reduce((sum, c) => sum + c.count, 0));
}
console.log("headcount: 22人の内訳一致・育成枠・二重計上防止・未設定・在籍対象・表示を確認");
