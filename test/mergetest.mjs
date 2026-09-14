// 出荷する nippo.html の mergeWork をそのまま切り出して確かめる
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const src = fs.readFileSync(atRoot("nippo.html"), "utf8");
const a = src.indexOf("function mergeWork(");
const b = src.indexOf("function fillForm(", a);
assert.ok(a > 0 && b > a, "mergeWork を切り出せない");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(a, b) + "\nglobalThis.m = mergeWork;", sandbox);
const merge = sandbox.m;

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log("  ok", name); };

ok("朝だけの日は、そのまま出る", () => {
  const r = merge([{ task: "提案書" }, { task: "見積" }], []);
  assert.equal(r.map((x) => x.task).join("|"), ["提案書", "見積"].join("|"));
});

ok("やることが増える", () => {
  const r = merge([{ task: "提案書" }],
    [{ id: "a1", title: "電話", status: "open", priority: 5, sourceLabel: "自分で決めた" }]);
  assert.equal(r.map((x) => x.task).join("|"), ["提案書", "電話"].join("|"));
  assert.equal(r[1].action_id, "a1");
  assert.equal(r[1].from_label, "自分で決めた");
});

ok("最優先には印が付く", () => {
  const r = merge([], [{ id: "a1", title: "提案書", status: "open", priority: 1, sourceLabel: "自分で決めた" }]);
  assert.equal(r[0].from_label, "今日の最優先");
});

ok("できたものは、済みの状態で出る", () => {
  const r = merge([], [{ id: "a1", title: "電話", status: "done", priority: 5, doneNote: "3件かけた" }]);
  assert.equal(r[0].done, true);
  assert.equal(r[0].result, "3件かけた");
});

ok("一言が無いときは「完了」で埋めない（日報が「完了/完了」にならない）", () => {
  const r = merge([], [{ id: "a2", title: "電話", status: "done", priority: 5, doneNote: null }]);
  assert.equal(r[0].done, true);
  assert.equal(r[0].result, undefined);
});

ok("同じ題名は1行にまとまる（2行に増えない）", () => {
  const r = merge([{ task: "提案書" }],
    [{ id: "a1", title: "提案書", status: "done", priority: 1, doneNote: "出した" }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].action_id, "a1");
  assert.equal(r[0].done, true);
  assert.equal(r[0].result, "出した");
});

ok("大文字小文字・前後の空白は同じものとして扱う", () => {
  const r = merge([{ task: " Aサイト 改修 " }],
    [{ id: "a1", title: "aサイト 改修", status: "open", priority: 5 }]);
  assert.equal(r.length, 1);
});

ok("夜に書いた結果は、やること側で上書きしない", () => {
  const r = merge([{ task: "提案書", result: "17社に送付" }],
    [{ id: "a1", title: "提案書", status: "done", priority: 1, doneNote: "完了" }]);
  assert.equal(r[0].result, "17社に送付");
});

ok("できなかった理由も守る", () => {
  const r = merge([{ task: "提案書", undone_reason: "1社まで" }],
    [{ id: "a1", title: "提案書", status: "done", priority: 1 }]);
  assert.equal(r[0].result, undefined);
  assert.equal(r[0].done, undefined);
  assert.equal(r[0].undone_reason, "1社まで");
});

ok("やらないことにしたものは来ない（サーバで除いている）", () => {
  const r = merge([], []);
  assert.equal(r.length, 0);
});

ok("空の行や壊れた値で落ちない", () => {
  assert.equal(merge(null, null).length, 0);
  assert.deepEqual(merge([{}, null, { task: "" }], undefined).length, 0);
  assert.equal(merge(undefined, [{ id: "a", title: "x", status: "open" }]).length, 1);
});

ok("やること同士の重複も1行", () => {
  const r = merge([], [
    { id: "a1", title: "電話", status: "open", priority: 1 },
    { id: "a2", title: "電話", status: "done", priority: 5, doneNote: "済" },
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].action_id, "a1");
});

console.log(`\n${n} 件 すべて通りました`);
