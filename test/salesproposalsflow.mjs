// /sales 提案管理の決まりごと（lib/sales-proposals.js）を、DB なしで確かめる。
//
// ■ 何を守るテストか
//   1. 期限は営業時間・土日・祝日・自社休業日に合わせる（送信30分以内／その営業日中／翌営業日／n営業日後）
//   2. 自動タスク：同じものを2回作らない・終わった提案と連絡停止には作らない・返信があれば追客を片付ける
//   3. KPI の分母と分子（自社が連絡していない無回答を企業の応答に混ぜない・連絡停止は電話の分母から外す）
//   4. 値の一覧が SQL（db/138・db/140 の CHECK）と JS でずれていない
//   5. マッチング確定（db/140）：提案待ちの間は電話の期限を始めない。提案準備の期限。企業へ送ったら30分の電話（送った時刻から）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const L = await import(join(ROOT, "lib/sales-proposals.js"));
const S = { ...L.DEFAULT_SETTINGS };

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};
const J = (s) => new Date(`${s}+09:00`).toISOString();   // 日本時間で書く

console.log("sales proposals flow（期限・自動タスク・KPI）");

ok("初回電話：営業時間内は30分後／始業前はその日の9:30／終業後・土日・祝日は次の営業日9:30", () => {
  assert.equal(L.firstCallDue(J("2026-10-19T10:00"), S), J("2026-10-19T10:30"));
  assert.equal(L.firstCallDue(J("2026-10-19T08:10"), S), J("2026-10-19T09:30"));
  assert.equal(L.firstCallDue(J("2026-10-16T19:00"), S), J("2026-10-19T09:30"), "金曜の夜 → 月曜");
  assert.equal(L.firstCallDue(J("2026-10-17T11:00"), S), J("2026-10-19T09:30"), "土曜 → 月曜");
  assert.equal(L.firstCallDue(J("2026-10-09T19:00"), S), J("2026-10-13T09:30"), "10/12 は祝日");
  assert.equal(L.firstCallDue(J("2026-12-28T19:00"), S), J("2027-01-04T09:30"), "年末年始は休み");
  assert.equal(L.firstCallDue(J("2026-10-19T17:50"), S), J("2026-10-19T18:20"), "終業間際は送信から30分（すぐ電話する）");
  const s2 = { ...S, extraHolidays: ["2026-10-19"], firstCallMinutes: 60, bizStart: "10:00" };
  assert.equal(L.firstCallDue(J("2026-10-16T19:00"), s2), J("2026-10-20T11:00"), "自社休業日・始業10:00・60分");
});

ok("不通のメールはその営業日の終業まで／回答確認は翌営業日の終業／n営業日後（過ぎていればいまの営業日）", () => {
  assert.equal(L.sameBizDayEnd(J("2026-10-19T10:00"), S), J("2026-10-19T18:00"));
  assert.equal(L.sameBizDayEnd(J("2026-10-19T18:30"), S), J("2026-10-20T18:00"));
  assert.equal(L.sameBizDayEnd(J("2026-10-18T10:00"), S), J("2026-10-19T18:00"), "日曜 → 月曜");
  assert.equal(L.nextBizDayEnd(J("2026-10-16T17:00"), S), J("2026-10-19T18:00"));
  assert.equal(L.milestoneDue(J("2026-10-16T10:00"), 3, J("2026-10-19T10:00"), S), J("2026-10-21T18:00"));
  assert.equal(L.milestoneDue(J("2026-10-01T10:00"), 3, J("2026-10-19T10:00"), S), J("2026-10-19T18:00"), "もう過ぎている");
  assert.equal(L.addBizYmd("2026-10-16", 5, S), "2026-10-23");
});

const P = (over = {}) => ({ id: "p", status: "call_wait", sent_at: J("2026-10-19T10:00"), sales_owner_id: "e1", contact_stop: false, ...over });
const T = (kind, over = {}) => ({ id: `${kind}-${Math.random()}`, kind, status: "open", source_event: null, ...over });

ok("電話：不通 → メール（1つだけ）／折り返し・再連絡は先方の日時／通話できた → 内容ごとの段", () => {
  const first = T("call", { source_event: "auto:first_call" });
  let r = L.planFollowUp({ proposal: P(), activity: { id: "a1", kind: "call", result: "no_answer", occurred_at: J("2026-10-19T10:10") }, tasks: [first], settings: S });
  assert.deepEqual(r.complete, [first.id]); assert.equal(r.patch.status, "mail_wait");
  assert.equal(r.create.length, 1); assert.equal(r.create[0].kind, "mail"); assert.equal(r.create[0].due_at, J("2026-10-19T18:00"));
  r = L.planFollowUp({ proposal: P(), activity: { id: "a2", kind: "call", result: "absent" }, tasks: [T("mail")], settings: S });
  assert.equal(r.create.length, 0, "開いているメールのタスクがあれば作らない");
  r = L.planFollowUp({ proposal: P(), activity: { id: "a3", kind: "call", result: "recall", next_at: J("2026-10-21T15:00") }, tasks: [], settings: S });
  assert.equal(r.create[0].due_at, J("2026-10-21T15:00")); assert.equal(r.patch.status, "call_wait");
  r = L.planFollowUp({ proposal: P(), activity: { id: "a4", kind: "call", result: "connected", outcome: "considering", occurred_at: J("2026-10-19T10:10") }, tasks: [], settings: S });
  assert.equal(r.patch.status, "considering"); assert.equal(r.patch.close_reason, "client_considering");
  assert.equal(r.create[0].kind, "reply_check"); assert.equal(r.create[0].due_at, J("2026-10-22T18:00"));
  r = L.planFollowUp({ proposal: P(), activity: { id: "a5", kind: "call", result: "connected", outcome: "declined" }, tasks: [first], settings: S });
  assert.equal(r.patch.status, "lost"); assert.equal(r.patch.close_reason, "client_declined"); assert.ok(r.patch.closed_at);
});

ok("面談まで進んだ提案は、電話・メールの記録で「回答待ち」に戻さない", () => {
  const r = L.planFollowUp({ proposal: P({ status: "meeting_adjust" }), activity: { id: "a", kind: "mail" }, tasks: [], settings: S });
  assert.equal(r.patch.status, undefined);
});

ok("終わった提案：開いているタスクは取り消し（完了にしない）。新しい自動タスクは作らない", () => {
  const open = [T("call"), T("reply_check")];
  const r = L.planFollowUp({ proposal: P(), activity: { id: "a", kind: "result", result: "closed_no_reply", outcome: "no_reply" }, tasks: open, settings: S });
  assert.equal(r.patch.status, "closed_no_reply"); assert.equal(r.complete.length, 0);
  assert.equal(r.cancel.length, 2); assert.equal(r.create.length, 0);
});

ok("連絡停止の希望がある提案には、電話・メール・再フォローの自動タスクを作らない", () => {
  const r = L.planFollowUp({ proposal: P({ contact_stop: true, status: "reply_wait" }), activity: { id: "a", kind: "decision", result: "continue", next_at: J("2026-10-21T10:00") }, tasks: [], settings: S });
  assert.equal(r.create.filter((t) => ["call", "mail", "refollow"].includes(t.kind)).length, 0);
  assert.equal(L.firstTasks(P({ contact_stop: true }), S).length, 0);
});

ok("返信があれば、電話・メール・回答確認・再フォロー・管理者確認を片付ける", () => {
  const ts = [T("call"), T("mail"), T("reply_check"), T("refollow"), T("manager_review"), T("manual")];
  const r = L.planFollowUp({ proposal: P({ status: "reply_wait" }), activity: { id: "a", kind: "reply", outcome: "meeting" }, tasks: ts, settings: S });
  assert.equal(r.complete.length, 5, "手動タスクは残す"); assert.equal(r.patch.status, "meeting_adjust");
});

ok("返信なし：再フォロー → 管理者確認 → それ以上は作らない（source_event で1回ずつ）", () => {
  const p = P({ status: "reply_wait", sent_at: J("2026-10-16T10:00") });
  const now = J("2026-10-19T10:00");
  let r = L.planFollowUp({ proposal: p, activity: { id: "c1", kind: "check" }, tasks: [], now, settings: S, managerId: "m1" });
  assert.equal(r.create[0].source_event, "auto:refollow"); assert.equal(r.create[0].due_at, J("2026-10-21T18:00"));
  r = L.planFollowUp({ proposal: p, activity: { id: "c2", kind: "check" }, tasks: [T("refollow", { status: "done", source_event: "auto:refollow" })], now, settings: S, managerId: "m1" });
  assert.equal(r.create[0].kind, "manager_review"); assert.equal(r.create[0].assignee_id, "m1"); assert.equal(r.create[0].due_at, J("2026-10-23T18:00"));
  r = L.planFollowUp({ proposal: p, activity: { id: "c3", kind: "check" }, now, settings: S,
    tasks: [T("refollow", { status: "done", source_event: "auto:refollow" }), T("manager_review", { source_event: "auto:review" })] });
  assert.equal(r.create.length, 0);
});

ok("入力：電話は結果が必須・通話できたら内容が必須・未来の実施日時は不可・見送りは理由が必須（無回答は不可）", () => {
  const now = J("2026-10-19T10:00");
  assert.equal(L.normalizeActivity("call", {}, { now }).field, "result");
  assert.equal(L.normalizeActivity("call", { result: "connected" }, { now }).field, "outcome");
  assert.equal(L.normalizeActivity("call", { result: "no_answer", occurredAt: "2026-10-20T10:00" }, { now }).field, "occurredAt");
  assert.equal(L.normalizeActivity("call", { result: "no_answer", occurredAt: "2026-10-19T10:00" }, { now }).value.occurred_at, now, "日本時間として読む");
  assert.equal(L.normalizeActivity("result", { status: "lost", reason: "no_reply" }, { now }).field, "reason");
  assert.equal(L.normalizeActivity("result", { status: "lost", reason: "talent_declined" }, { now }).value.outcome, "talent_declined");
  assert.equal(L.normalizeActivity("mail", {}, { now }).value.evidence, "self_report");
  assert.equal(L.normalizeActivity("nope", {}, { now }).error, "unknown_action");
});

ok("設定：始業 < 終業・再フォロー ≤ 管理者確認・休業日の形", () => {
  assert.equal(L.normalizeSettings({ bizStart: "19:00" }, S).field, "bizEnd");
  assert.equal(L.normalizeSettings({ reviewBizDays: 2 }, S).field, "reviewBizDays");
  assert.equal(L.normalizeSettings({ extraHolidays: "2026-13-01" }, S).field, "extraHolidays");
  assert.deepEqual(L.normalizeSettings({ extraHolidays: "2026-10-20, 2026-10-19\n2026-10-20" }, S).value.extra_holidays, ["2026-10-19", "2026-10-20"]);
  assert.deepEqual(L.settingsOf({ biz_start: "10:00:00", biz_end: "19:00:00", first_call_minutes: 45, refollow_biz_days: 2, review_biz_days: 4, extra_holidays: ["2026-10-19"] }),
    { bizStart: "10:00", bizEnd: "19:00", firstCallMinutes: 45, refollowBizDays: 2, reviewBizDays: 4, extraHolidays: ["2026-10-19"], slackMembers: {} });
  // Slack のメンバーID（db/140）：社員ID → U…。形の違うもの・空はその人の登録を外す
  const E = "00000000-0000-4000-8000-000000000013";
  assert.deepEqual(L.normalizeSettings({ slackMembers: { [E]: " u0123abcd " } }, S).value.slack_members, { [E]: "U0123ABCD" });
  assert.deepEqual(L.normalizeSettings({ slackMembers: { [E]: "" } }, S).value.slack_members, {});
  assert.equal(L.normalizeSettings({ slackMembers: { [E]: "@営業" } }, S).field, "slackMembers");
  assert.equal(L.normalizeSettings({ slackMembers: { "not-uuid": "U0123ABCD" } }, S).field, "slackMembers");
  assert.deepEqual(L.settingsOf({ slack_members: { [E]: "U0123ABCD", bad: "U1", x: 1 } }).slackMembers, { [E]: "U0123ABCD" }, "読むときも形の合うものだけ");
});

ok("KPI：電話実施率は連絡停止（電話の前）を分母から外す。期限内・不通時メール・面談化・成約・初回電話の中央値", () => {
  const now = J("2026-10-20T12:00");
  const ps = [
    { id: "a", status: "won", sent_at: J("2026-10-19T10:00"), sales_owner_id: "e1" },
    { id: "b", status: "reply_wait", sent_at: J("2026-10-19T10:00"), sales_owner_id: "e1" },
    { id: "c", status: "call_wait", sent_at: J("2026-10-19T10:00"), sales_owner_id: "e2" },
    { id: "d", status: "stopped", sent_at: J("2026-10-19T10:00"), sales_owner_id: "e2", contact_stop: true },
  ];
  const acts = [
    { proposal_id: "a", kind: "call", result: "connected", outcome: "meeting", occurred_at: J("2026-10-19T10:20") },
    { proposal_id: "b", kind: "call", result: "no_answer", occurred_at: J("2026-10-19T11:00") },
    { proposal_id: "b", kind: "mail", occurred_at: J("2026-10-19T12:00") },
  ];
  const tasks = [
    { proposal_id: "a", kind: "call", source_event: "auto:first_call", status: "done", due_at: J("2026-10-19T10:30"), done_at: J("2026-10-19T10:20") },
    { proposal_id: "b", kind: "call", source_event: "auto:first_call", status: "done", due_at: J("2026-10-19T10:30"), done_at: J("2026-10-19T11:00") },
    { proposal_id: "c", kind: "call", source_event: "auto:first_call", status: "open", due_at: J("2026-10-19T10:30") },
    { proposal_id: "d", kind: "call", source_event: "auto:first_call", status: "canceled", due_at: J("2026-10-19T10:30") },
    { proposal_id: "b", kind: "mail", auto: true, status: "done", due_at: J("2026-10-19T18:00"), done_at: J("2026-10-19T12:00") },
  ];
  const k = L.computeKpis(ps, acts, tasks, { now }).total;
  assert.equal(k.callBase, 3, "連絡停止（電話の前）は分母から外す"); assert.equal(k.called, 2); assert.equal(k.callRate, 66.7);
  assert.equal(k.onTimeBase, 3, "取り消しは外す。期限を過ぎて開いている電話は数える"); assert.equal(k.onTime, 1);
  assert.equal(k.firstCallMedianMin, 40, "20分と60分の中央値"); assert.equal(k.mailRate, 100);
  assert.equal(k.meetings, 1); assert.equal(k.meetingRate, 25); assert.equal(k.won, 1); assert.equal(k.wonRate, 100);
  assert.equal(k.overdueTasks, 1);
  const by = L.computeKpis(ps, acts, tasks, { now }).byOwner;
  assert.deepEqual(by.map((r) => [r.ownerId, r.proposals]), [["e1", 2], ["e2", 2]]);
});

ok("マッチング確定：提案準備は当日の終業まで（終業まで1時間を切った・営業時間外・休日は次の営業日の終業）", () => {
  assert.equal(L.prepareDue(J("2026-10-19T10:00"), S), J("2026-10-19T18:00"));
  assert.equal(L.prepareDue(J("2026-10-19T16:59"), S), J("2026-10-19T18:00"));
  assert.equal(L.prepareDue(J("2026-10-19T17:00"), S), J("2026-10-20T18:00"), "終業まで1時間を切ったら翌営業日");
  assert.equal(L.prepareDue(J("2026-10-19T07:30"), S), J("2026-10-19T18:00"), "始業前はその日");
  assert.equal(L.prepareDue(J("2026-10-16T20:00"), S), J("2026-10-19T18:00"), "金曜の夜 → 月曜");
  assert.equal(L.prepareDue(J("2026-10-11T10:00"), S), J("2026-10-13T18:00"), "日曜 → 祝日（10/12）を飛ばす");
  const p = { status: "proposal_wait", matched_at: J("2026-10-19T10:00"), sales_owner_id: "e1", contact_stop: false };
  const [t] = L.matchedTasks(p, S);
  assert.equal(t.kind, "prepare"); assert.equal(t.source_event, "auto:prepare"); assert.equal(t.assignee_id, "e1"); assert.equal(t.due_at, J("2026-10-19T18:00"));
  assert.deepEqual(L.matchedTasks({ ...p, contact_stop: true }, S), [], "連絡停止には作らない");
  assert.deepEqual(L.matchedTasks({ ...p, status: "call_wait", sent_at: J("2026-10-19T10:00") }, S), [], "送った提案には作らない");
  assert.deepEqual(L.firstTasks({ ...p, sent_at: null }, S), [], "送っていない提案に電話のタスクを作らない（30分を始めない）");
});

ok("企業へ送った（sent）：提案待ち → 電話待ち・提案準備を完了・電話は送った時刻から30分（確定の時刻からではない）", () => {
  const prep = { id: "t1", kind: "prepare", status: "open", source_event: "auto:prepare" };
  const p = { status: "proposal_wait", matched_at: J("2026-10-19T09:10"), sent_at: null, sales_owner_id: "e1", contact_stop: false };
  const a = { id: "a1", kind: "sent", occurred_at: J("2026-10-19T14:00") };
  const r = L.planFollowUp({ proposal: p, activity: a, tasks: [prep], now: J("2026-10-19T14:01"), settings: S });
  assert.equal(r.patch.status, "call_wait"); assert.equal(r.patch.sent_at, J("2026-10-19T14:00"));
  assert.deepEqual(r.complete, ["t1"], "提案準備は送った記録で完了");
  assert.equal(r.create.length, 1); assert.equal(r.create[0].kind, "call"); assert.equal(r.create[0].source_event, "auto:first_call");
  assert.equal(r.create[0].due_at, J("2026-10-19T14:30"), "送った 14:00 から30分");
  // 2回目の送信（送り直し）：状態も送信日時も変えない・電話は増やさない
  const again = L.planFollowUp({ proposal: { ...p, status: "call_wait", sent_at: J("2026-10-19T14:00") }, activity: { ...a, id: "a2" },
    tasks: [{ id: "c1", kind: "call", status: "open", source_event: "auto:first_call" }], now: J("2026-10-19T15:00"), settings: S });
  assert.deepEqual(again.patch, {}); assert.deepEqual(again.create, []);
  // 連絡停止の希望がある提案：送っても電話は作らない
  const stop = L.planFollowUp({ proposal: { ...p, contact_stop: true }, activity: a, tasks: [prep], now: J("2026-10-19T14:01"), settings: S });
  assert.equal(stop.patch.status, "call_wait"); assert.deepEqual(stop.create, []);
  // 入力：Sales で「企業へ提案した」（自己申告）
  const n = L.normalizeActivity("sent", { occurredAt: "2026-10-19T14:00", channel: "phone" }, { now: J("2026-10-19T14:05") }).value;
  assert.equal(n.kind, "sent"); assert.equal(n.channel, "phone"); assert.equal(n.evidence, "self_report"); assert.equal(n.occurred_at, J("2026-10-19T14:00"));
  assert.equal(L.normalizeActivity("sent", { occurredAt: "2026-10-19T16:00" }, { now: J("2026-10-19T14:05") }).field, "occurredAt", "未来の提案日時は不可");
  assert.equal(L.activityLabel({ kind: "sent", result: "sent", evidence: "self_report" }), "提案送信（Sales で記録）");
  assert.equal(L.activityLabel({ kind: "matched", result: "matched" }), "マッチング確定");
});

ok("一覧：提案待ちは「提案待ち」に出て「電話未実施」には出ない。経過は確定から・並びは確定日。KPI は確定→提案の中央値", () => {
  const now = J("2026-10-21T12:00");
  const wait = L.shapeProposal({ id: "w", status: "proposal_wait", matched_at: J("2026-10-19T10:00"), sent_at: null, company_name: "A", title: "x" }, { now });
  const sent = L.shapeProposal({ id: "s", status: "call_wait", matched_at: J("2026-10-20T10:00"), sent_at: J("2026-10-20T11:00"), company_name: "B", title: "y" }, { now });
  assert.equal(wait.sentAt, null); assert.equal(wait.waiting, true); assert.equal(wait.elapsedDays, 2, "確定から数える");
  assert.equal(L.filterRows([wait, sent], { filter: "proposal_wait", now }).map((r) => r.id).join(), "w");
  assert.equal(L.filterRows([wait, sent], { filter: "no_call", now }).map((r) => r.id).join(), "s", "提案待ちは電話未実施に数えない");
  assert.equal([wait, sent].sort(L.SORTS.sent).map((r) => r.id).join(), "s,w", "提案日の新しい順（提案待ちは確定日）");
  const k = L.computeKpis([
    { id: "s", status: "call_wait", matched_at: J("2026-10-20T10:00"), sent_at: J("2026-10-20T11:00") },
    { id: "t", status: "call_wait", matched_at: J("2026-10-20T10:00"), sent_at: J("2026-10-20T10:20") },
    { id: "u", status: "call_wait", matched_at: null, sent_at: J("2026-10-20T10:20") },
  ], [], [], { now }).total;
  assert.equal(k.prepareMedianMin, 40, "60分と20分の中央値（確定の無い提案は数えない）"); assert.equal(k.prepareMeasured, 2);
});

ok("値の一覧が SQL（db/138・db/140 の CHECK）と同じ：状態・理由・タスクの種類・記録の種類", () => {
  const sql = readFileSync(join(ROOT, "db/138_sales_proposals.sql"), "utf8");
  // 列の CHECK（in (…) の値）をすべて拾う。kind は「記録」と「タスク」の2つの表にある（出てくる順）
  const listsOf = (col) => [...sql.matchAll(new RegExp(`${col} text[^\\n]*check \\(${col} (?:is null or ${col} )?in \\(([\\s\\S]*?)\\)\\)`, "g"))]
    .map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort());
  assert.deepEqual(listsOf("close_reason")[0], L.CLOSE_REASONS.map((r) => r.key).sort(), "理由コード");
  // 状態・記録の種類・タスクの種類は db/140 が付け直した名前つきの CHECK が正（提案待ち・マッチング確定・提案準備）
  const sql140 = readFileSync(join(ROOT, "db/140_sales_proposal_matching.sql"), "utf8");
  const named = (name, col) => {
    const m = new RegExp(`add constraint ${name} check \\(${col} in \\(([\\s\\S]*?)\\)\\);`).exec(sql140);
    assert.ok(m, name);
    return [...m[1].replace(/--[^\n]*/g, "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(named("gw_sales_proposals_status_chk", "status"), [...L.STATUS_KEYS].sort(), "提案の状態");
  assert.deepEqual(named("gw_sales_proposal_activities_kind_chk", "kind"), Object.keys(L.ACTIVITY_LABEL).sort(), "記録の種類");
  assert.deepEqual(named("gw_sales_proposal_tasks_kind_chk", "kind"), L.TASK_KINDS.map((t) => t.key).sort(), "タスクの種類");
  // db/138 の一覧に、db/140 で足したものだけが増えている（消した値が無い）
  const [old138] = listsOf("status");
  assert.deepEqual(L.STATUS_KEYS.filter((k) => !old138.includes(k)), ["proposal_wait"]);
  // 理由コードの組み合わせ（どの状態にどの理由）も、SQL の値の中に収まる
  for (const [st, list] of Object.entries(L.REASONS_FOR)) {
    assert.ok(L.STATUS_KEYS.includes(st), st);
    for (const r of list) if (r) assert.ok(L.CLOSE_REASONS.some((x) => x.key === r), `${st}: ${r}`);
  }
});

console.log(`\nsales proposals flow: 合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
