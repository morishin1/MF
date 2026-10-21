// Sales 3段階バトンタッチ: HTML構文・入力検証・Slackメンションの回帰テスト
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Script } from "node:vm";
import { settingsOf, normalizeSettings, shapeProposal } from "../lib/sales-proposals.js";
import { sentShareMessage, handoffShareMessage } from "../lib/sales-proposal-handoff-slack.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "sales/proposals.html"), "utf8");
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline, "Salesのインライン画面スクリプトがある");
new Script(inline[1], { filename: "sales/proposals.html" });
assert.ok(html.includes("function ppHandoff(stage)"), "引継ぎモーダル");
assert.ok(html.includes("function ppCsDecision()"), "CS判断の入力UI");
assert.ok(html.includes('data-team="cs"'), "CSチームの設定");
assert.ok(html.includes('data-team="closing"'), "クロージングチームの設定");

const CS = "00000000-0000-4000-8000-000000000011";
const CLOSER = "00000000-0000-4000-8000-000000000012";
const raw = { cs_members: [CS], closing_members: [CLOSER],
  slack_members: { [CS]: "U12345678", [CLOSER]: "U87654321" } };
const cfg = settingsOf(raw);
assert.deepEqual(cfg.csMembers, [CS]);
assert.deepEqual(cfg.closingMembers, [CLOSER]);
assert.deepEqual(normalizeSettings({ csMembers: [CS, CS], closingMembers: [CLOSER] }).value,
  { cs_members: [CS], closing_members: [CLOSER] });
assert.equal(normalizeSettings({ csMembers: ["somebody"] }).error, "invalid_body");
assert.equal(normalizeSettings({ closingMembers: Array.from({ length: 21 }, () => CS) }).error, "invalid_body");

const p = { id: "test-id", company_name: "企業<テスト>", title: "案件 & 提案",
  matching_owner_name: "藤本", sent_at: "2026-10-19T12:00:00Z",
  handoff_stage: "cs", cs_owner_id: CS, closing_owner_id: null };
const employees = [{ id: CS, display_name: "中村" }, { id: CLOSER, display_name: "池永" }];
const m = sentShareMessage({ proposal: p, settingsRow: raw, employees });
assert.ok(m.text.includes("CSフォロー開始"));
assert.ok(m.lines.some((s) => s.includes("<@U12345678>")));
assert.ok(m.lines.some((s) => s.includes("<@U87654321>")));
assert.ok(m.lines.some((s) => s.includes("企業&lt;テスト&gt;")));
assert.ok(m.lines.every((s) => !s.includes("顧客の連絡先")), "自由入力の個人情報を出さない");
assert.equal(m.link, "sales/proposals.html?id=test-id");
const h = handoffShareMessage({ proposal: p, settingsRow: raw, employees,
  handoff: { from_stage: "cs", to_stage: "closing", from_owner_id: CS,
    to_owner_id: CLOSER, reason: "秘密事項", next_action: "顧客情報", decision: "needs_detail" } });
assert.ok(h.text.includes("<@U87654321>"));
assert.ok(!JSON.stringify(h).includes("秘密事項"), "引継ぎ理由はSlackに貼らない");
assert.ok(!JSON.stringify(h).includes("顧客情報"), "詳細はSalesで見る");

const shaped = shapeProposal({ ...p, tenant_id: CS, source_system: "manual",
  matched_at: "2026-10-19T11:00:00Z", status: "call_wait", updated_at: "2026-10-19T12:00:00Z" });
assert.equal(shaped.handoffStage, "cs");
assert.equal(shaped.csOwnerId, CS);


// 電話・メール・CS判断を保存したら同じ主ボタンを出し続けない。
const begin = inline[1].indexOf("function ppStageIndex(p) {");
const end = inline[1].indexOf("function renderDetail() {", begin);
assert.ok(begin >= 0 && end > begin, "進行状況に応じた主ボタンの計算がある");
const screen = { esc: (value) => String(value) };
new Script(inline[1].slice(begin, end) + "\nthis.nextAction = ppNextAction; this.doneBadges = ppDoneBadges;")
  .runInNewContext(screen);
const state = { sentAt:"2026-10-20T06:00:00Z", handoffStage:"cs", csOwnerId:CS, closed:false };
const view = { activities:[], tasks:[], csContacted:false, csDecision:null, canHandoff:true, manager:true,
  handoffTargets:{ cs:[{id:CS}], closing:[{id:CLOSER}] } };
const checkNext = (name,p,d,label) =>
  assert.equal(screen.nextAction(p,d).label, label, name);
checkNext("未記録は電話", state, view, "電話の結果を記録");
checkNext("不通を記録したらメール", state,
  { ...view, activities:[{kind:"call",result:"no_answer",occurredAt:"2026-10-20T07:00:00Z"}], tasks:[{kind:"mail",status:"open"}] },
  "確認メールを送った");
checkNext("メールを記録したら回答確認", state,
  { ...view, activities:[{kind:"mail",occurredAt:"2026-10-20T07:30:00Z"}], tasks:[{kind:"reply_check",status:"open"}] },
  "回答を確認");
checkNext("未回答の再フォロー", state, { ...view, tasks:[{kind:"refollow",status:"open"}] }, "再連絡を記録");
checkNext("接続したらCS判断", state, { ...view, csContacted:true }, "CS判断を記録");
checkNext("CSが進行判断したらクロージング", state,
  { ...view, csContacted:true, csDecision:"advance" }, "クロージングへ引継ぐ");
checkNext("クロージングで面談", { ...state, handoffStage:"closing" }, view, "面談を記録");
checkNext("面談後は結果", { ...state, handoffStage:"closing", status:"meeting_done" }, view, "成約・見送りを記録");
checkNext("終了済みは主ボタンなし", { ...state, closed:true }, view, null);
assert.match(screen.doneBadges({ ...state, call:{label:"不通"} }, view), /電話記録済み（不通）/,
  "完了した電話はチェックで表示する");
assert.ok(html.includes('class="pp-history"') && html.includes('class="pp-box pp-collapsible"'),
  "履歴とチェックリストは折りたたむ");
assert.ok(html.includes('class="pp-next-actions"') && !html.includes("ppFlowAction(p, detail)"),
  "メイン操作を一箇所にまとめる");

console.log("PASS Sales handoff UI syntax, role validation, stages and Slack privacy");
