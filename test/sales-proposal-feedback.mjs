// Sales: 操作失敗を黙って止めず、原因と修正先を表示する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const code = read("js/sales-proposal-feedback.js");
new Script(code, { filename: "js/sales-proposal-feedback.js" });
const w = {};
runInNewContext(code, { window: w });
const { validate, formatError } = w.SalesProposalFeedback;

const cases = [
  ["企業名未入力", "new", { companyName:"", title:"提案" }, {}, "n-company"],
  ["提案内容未入力", "new", { companyName:"株式会社A", title:" " }, {}, "n-title"],
  ["提案のメール形式不正", "new", { companyName:"A", title:"B", contactEmail:"x@" }, {}, "n-cmail"],
  ["電話実施日時なし", "call", { occurredAt:"" }, {}, "m-at"],
  ["電話結果未選択", "call", { occurredAt:"2026-10-21T09:30" }, {}, "m-result"],
  ["通話できた後の回答未選択", "call", { occurredAt:"2026-10-21T09:30", result:"connected" }, {}, "m-out"],
  ["折返し期限未登録", "call", { occurredAt:"2026-10-21T09:30", result:"callback" }, { callNeedsAt:true }, "m-nextat"],
  ["返信内容未選択", "reply", { occurredAt:"2026-10-21T09:30" }, {}, "m-out"],
  ["面談結果未選択", "meeting", {}, {}, "m-result"],
  ["面談日程なし", "meeting", { result:"scheduled" }, {}, "m-nextat"],
  ["結果未選択", "result", {}, {}, "m-st"],
  ["管理判断未選択", "decision", {}, {}, "m-result"],
  ["継続時期未登録", "decision", { result:"continue" }, {}, "m-nextat"],
  ["タスク名未入力", "task_add", { title:"", dueAt:"2026-10-21T15:00" }, {}, "m-title"],
  ["タスク期限なし", "task_add", { title:"連絡" }, {}, "m-due"],
  ["期限変更理由なし", "task_due", { dueAt:"2026-10-21T15:00" }, {}, "m-note"],
  ["完了内容なし", "task_done", {}, {}, "m-note"],
  ["メモなし", "memo", {}, {}, "m-note"],
  ["引継ぎ先なし", "transfer", { reason:"A", nextAction:"B" }, {}, "m-howner"],
  ["引継ぎ判断なし", "transfer", { ownerId:"x",reason:"A",nextAction:"B" }, {}, "m-hdecision"],
  ["引継ぎ理由なし", "transfer", { ownerId:"x", decision:"advance", nextAction:"B" }, {}, "m-hreason"],
  ["引継ぎ次の対応なし", "transfer", { ownerId:"x",decision:"advance",reason:"A" }, {}, "m-hnext"],
  ["CS判断理由なし", "cs_decision", { decision:"advance", nextAction:"電話" }, {}, "m-creason"],
  ["CS次の対応なし", "cs_decision", { decision:"advance", reason:"接続" }, {}, "m-cnext"],
];
for (const [label,action,body,ctx,expected] of cases) {
  assert.equal(validate(action,body,ctx)?.field, expected, label);
}
assert.equal(validate("call",{result:"not_connected",occurredAt:"2026-10-21T09:00"},{}),null,
  "必要条件を満たした電話記録は進める");
assert.equal(validate("transfer",{ownerId:"x",decision:"advance",reason:"面談希望",nextAction:"連絡"},{}),null,
  "必要条件を満たした引継ぎは進める");
assert.equal(validate("new",{companyName:"A",title:"提案"},{}),null,"正しい新規提案は進める");

for (const raw of ["cs_contact_required","cs_approval_required","invalid_handoff_transition",
  "target_not_in_configured_team","proposal_not_active"]) {
  const result = formatError({ code:"handoff_blocked", hint:raw });
  assert.ok(/[ぁ-んァ-ン一-龯]/.test(result) && !result.includes(raw),"DBエラーを日本語へ: "+raw);
}
assert.ok(formatError({code:"forbidden", hint:"forbidden"}).includes("権限"),
  "他人の案件を編集できない理由");
assert.ok(formatError({code:"not_connected"}).includes("電話結果"),
  "CS判断が進めない理由");

const html=read("sales/proposals.html");
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
for (let i=0;i<scripts.length;i++) if (scripts[i][1].trim())
  new Script(scripts[i][1], {filename:"sales/proposals.html script "+i});
assert.ok(html.includes('src="../js/action-feedback.js?v=20261024nav1"'),
  "共通アラートコンポーネントを読み込む");
assert.ok(html.includes('src="../js/sales-proposal-feedback.js?v=20261024nav1"'),
  "Sales用の入力チェックを読み込む");
assert.ok(html.includes("function ppFlowBlocked(key)"),"操作できない理由を表示");
assert.ok(html.includes('SalesProposalFeedback.validate("transfer"') && html.includes('ppShowIssue(blocked)'),
  "引継ぎ前に必須項目を確認");
assert.ok(html.includes('SalesProposalFeedback.validate("cs_decision"') && html.includes('ppShowIssue(blocked)'),
  "CS判断の必須項目を確認");
assert.ok(html.includes('ppShowIssue(SalesProposalFeedback.validate("new"'),
  "提案新規登録の必須項目を確認");
assert.ok(html.includes('(enabled ? action : "ppFlowBlocked('),
  "引継ぎできない場合もボタンを消さず、クリックで理由を表示");
assert.ok(!html.includes('disabled aria-disabled="true"'),
  "引継ぎボタンを無説明で無効化しない");

console.log("PASS Sales proposal actionable feedback: "+(cases.length+9)+" cases + UI syntax");
