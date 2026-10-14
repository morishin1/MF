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

// ---- 朝に決めた件数と、成果の行数を1対1にする（「今日やること3件 → 成果2件」の不具合）----------------
// 朝の「今日の最優先」は work_items と別（top_priority）に持っている。足さないと1件減っていた
ok("今日やること3件（最優先＋ほか2件）→ 成果3件", () => {
  const r = merge([{ task: "B社へ電話する" }, { task: "商品登録を20件行う" }], [], { top: "A社へ提案書を送る" });
  assert.equal(r.length, 3);
  assert.equal(r.map((x) => x.task).join("|"), ["A社へ提案書を送る", "B社へ電話する", "商品登録を20件行う"].join("|"));
  assert.equal(r[0].from_label, "今日の最優先");
});
ok("今日やること2件 → 成果2件", () => {
  const r = merge([{ task: "B社へ電話する" }], [], { top: "A社へ提案書を送る" });
  assert.equal(r.length, 2);
});
ok("今日やること1件（最優先だけ）→ 成果1件", () => {
  const r = merge(null, [], { top: "A社へ提案書を送る" });
  assert.equal(r.length, 1);
  assert.equal(r[0].task, "A社へ提案書を送る");
});
ok("夜に一度保存したあと（最優先も work_items に入っている）でも増えない", () => {
  const saved = [{ task: "A社へ提案書を送る", done: true }, { task: "B社へ電話する" }, { task: "商品登録を20件行う" }];
  const r = merge(saved, [], { top: "A社へ提案書を送る" });
  assert.equal(r.length, 3);
  assert.equal(r[0].done, true);
});
ok("全角・半角・空白の違いでは2行にしない（題名の突き合わせ）", () => {
  const r = merge([{ task: "Ａ社へ　提案書" }], [], { top: "A社へ 提案書" });
  assert.equal(r.length, 1);
});
ok("明日の重要タスク（今日の3つ）は、タスクのIDつきで1件ずつ並ぶ", () => {
  const focus = [
    { id: "11111111-1111-4111-8111-111111111111", title: "A社へ提案書を送る", status: "todo", doneCondition: "送付済み" },
    { id: "22222222-2222-4222-8222-222222222222", title: "B社へ電話する", status: "done", result: "担当者と話せた" },
    { id: "33333333-3333-4333-8333-333333333333", title: "商品登録を20件行う", status: "doing" },
  ];
  const r = merge(null, [], { focusToday: focus });
  assert.equal(r.length, 3);
  assert.equal(r.map((x) => x.task_id).join("|"), focus.map((t) => t.id).join("|"));
  assert.equal(r[0].done_when, "送付済み");
  assert.equal(r[1].done, true);
  assert.equal(r[1].result, "担当者と話せた");
});
ok("保存した行とタスクは ID で結び付く（題名を直しても2行にならない）", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const r = merge([{ task: "A社 提案（修正）", task_id: id }], [], { focusToday: [{ id, title: "A社へ提案書を送る", status: "todo" }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].task, "A社 提案（修正）");
});
ok("取りやめた重要タスクは出さない", () => {
  const r = merge(null, [], { focusToday: [{ id: "x", title: "やめた", status: "cancelled" }] });
  assert.equal(r.length, 0);
});
ok("朝の3件と重要タスクが同じものなら、3行のまま", () => {
  const r = merge([{ task: "B社へ電話する" }, { task: "商品登録を20件行う" }], [], {
    top: "A社へ提案書を送る",
    focusToday: [{ id: "f1", title: "A社へ提案書を送る", status: "todo" }, { id: "f2", title: "B社へ電話する", status: "todo" }],
  });
  assert.equal(r.length, 3);
  assert.equal(r[0].task_id, "f1");
  assert.equal(r[1].task_id, "f2");
});

console.log(`\n${n} 件 すべて通りました`);
