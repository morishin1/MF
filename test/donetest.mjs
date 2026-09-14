import assert from "node:assert/strict";
import { isDone, normalizeNippo, hasContent } from "../lib/nippo.js";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };

console.log("— できた の判定 —");
ok("一言を書かなくても、できた", () => {
  assert.equal(isDone({ task: "電話", done: true, result: "" }), true);
});
ok("一言があれば、できた（古い日報も読める）", () => {
  assert.equal(isDone({ task: "電話", result: "3件かけた" }), true);
});
ok("何も無ければ、まだ", () => {
  assert.equal(isDone({ task: "電話" }), false);
  assert.equal(isDone(null), false);
});
ok("できなかったものは、できたにしない", () => {
  assert.equal(isDone({ task: "電話", undone_reason: "1件まで" }), false);
});

console.log("— 保存の形 —");
const save = (rows) => normalizeNippo({ workItems: rows }).work_items;

ok("画面の \"1\" を done として受ける", () => {
  const r = save([{ task: "電話", done: "1", result: "" }]);
  assert.equal(r[0].done, true);
  assert.equal(r[0].result, "");
});
ok("一言だけでも done になる", () => {
  assert.equal(save([{ task: "電話", result: "3件" }])[0].done, true);
});
ok("できなかった行は done にしない", () => {
  const r = save([{ task: "電話", done: "1", undone_reason: "1件まで" }]);
  assert.equal(r[0].done, false);
  assert.equal(r[0].result, "");
});
ok("何も押していない行は done でない", () => {
  assert.equal(save([{ task: "電話" }])[0].done, false);
});
ok("「完了」で埋めない（画面が送ってこない限り result は空のまま）", () => {
  assert.equal(save([{ task: "電話", done: "1" }])[0].result, "");
});
ok("夜は10件まで残る（やることが流れ込んでも消えない）", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ task: `件${i}`, done: "1" }));
  assert.equal(save(many).length, 10);
});

console.log("— 提出できるか —");
ok("一言なしの できた だけでも、日報として成り立つ", () => {
  assert.equal(hasContent(normalizeNippo({ workItems: [{ task: "電話", done: "1" }] })), true);
});
ok("何も無ければ成り立たない", () => {
  assert.equal(hasContent(normalizeNippo({ workItems: [{ task: "電話" }] })), false);
});
ok("できなかった理由だけでも成り立つ", () => {
  assert.equal(hasContent(normalizeNippo({ workItems: [{ task: "電話", undone_reason: "先方不在" }] })), true);
});

console.log(`\n${n} 件 すべて通りました`);
