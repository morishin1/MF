import assert from "node:assert/strict";
import { rankToday } from "../lib/actions.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const T = "2026-09-09";
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };
const it = (id, o = {}) => ({ id, title: id, priority: 5, createdAt: `${T}T00:00:00Z`, ...o });
const order = (list) => rankToday(list, T).map((x) => x.id).join(",");

ok("期限切れ → 今日 → 明日 の順", () => {
  assert.equal(order([
    it("明日", { dueDate: "2026-09-10" }),
    it("今日", { dueDate: T }),
    it("切れ", { dueDate: "2026-09-07" }),
  ]), "切れ,今日,明日");
});

ok("ピン留めは何より上", () => {
  assert.equal(order([
    it("切れ", { dueDate: "2026-09-01" }),
    it("ピン", { dueDate: "2026-12-31", pinnedAt: `${T}T01:00:00Z` }),
  ]), "ピン,切れ");
});

ok("あとから留めたピンが上（いま決めたことが最新の判断）", () => {
  assert.equal(order([
    it("先", { pinnedAt: `${T}T01:00:00Z` }),
    it("後", { pinnedAt: `${T}T05:00:00Z` }),
  ]), "後,先");
});

ok("時間がかかるものは、期限より前に上がってくる", () => {
  const r = rankToday([
    it("軽い明日", { dueDate: "2026-09-10", estimateMin: 30 }),
    it("重い明後日", { dueDate: "2026-09-11", estimateMin: 300 }),   // 5時間 → 2日前から
  ], T);
  assert.equal(r[0].id, "重い明後日");
  assert.match(r[0].reason, /5時間かかる見込みなので、今日から/);
});

ok("見積りが無ければ、期限の近い順のまま", () => {
  assert.equal(order([
    it("明後日", { dueDate: "2026-09-11" }),
    it("明日", { dueDate: "2026-09-10" }),
  ]), "明日,明後日");
});

ok("期限なしの持ち越しは、期限が先のものより上", () => {
  assert.equal(order([
    it("先の期限", { dueDate: "2026-09-30" }),
    it("持ち越し", { createdAt: "2026-09-05T00:00:00Z" }),
  ]), "持ち越し,先の期限");
});

ok("今日作った期限なしは、いちばん下でよい", () => {
  const r = rankToday([
    it("今日つくった"),
    it("明日", { dueDate: "2026-09-10" }),
  ], T);
  assert.equal(r[0].id, "明日");
});

console.log("— 理由の文言 —");
ok("なぜ上なのかが必ず付く", () => {
  const r = rankToday([
    it("a", { dueDate: "2026-09-06" }),
    it("b", { dueDate: T }),
    it("c", { dueDate: "2026-09-10" }),
    it("d", { pinnedAt: `${T}T01:00:00Z` }),
  ], T);
  for (const x of r) assert.ok(x.reason && x.reasonLevel, `理由が無い: ${x.id}`);
  assert.equal(r.find((x) => x.id === "a").reason, "期限を 3 日過ぎています");
  assert.equal(r.find((x) => x.id === "b").reason, "今日が期限です");
  assert.equal(r.find((x) => x.id === "c").reason, "期限は明日");
  assert.equal(r.find((x) => x.id === "d").reasonLevel, "pin");
});

console.log("— 壊れた値 —");
ok("空でも落ちない", () => {
  assert.equal(rankToday(null, T).length, 0);
  assert.equal(rankToday([], T).length, 0);
});
ok("期限が無いものだけでも落ちない", () => {
  assert.equal(rankToday([it("x"), it("y")], T).length, 2);
});

console.log(`\n${n} 件 すべて通りました`);
