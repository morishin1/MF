// 採用HR（/hr）の値の定義・正規化を確かめる。
// db/081_hr_recruiting.sql・lib/hr.js と1対1。
//
// ■ 何を守るテストか
//
//   1. 選考ステージ（6段階）と対応ステータスは別の値の集合
//   2. 面談のランクから、次の対応ステータスが機械的に決まる
//   3. 期限超過の判定（終わっている状態は除く）
//   4. 合格通知（gw_hr_offers）の状態（下書き/送付済み/承諾/辞退/失効/無効化）
//   5. 応募者の入力チェック
//   6. admin-onboard.html へ渡す項目は、gw_hr_applicants の列名と同じ
import assert from "node:assert/strict";
import {
  STAGE_KEYS, STATUS_LABEL, isOverdue, nextStatusFromRank, offerStatus, offerResponseStatus,
  normalizeApplicant, snapshotOfferFields, shapeApplicant, shapePublicOffer, ONBOARD_PREFILL_FIELDS,
  EVAL_ITEMS, EVAL_SCALE_KEYS, nextActionOf, normalizeInterview, shapeInterview, interviewKindLabel,
  advancePrefill, isAdvanceClaimStale, schedulingUrlFor,
} from "../lib/hr.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 選考ステージ（6段階） ===\n");

ok("6段階、この順番", () => {
  assert.deepEqual(STAGE_KEYS, [
    "applied", "casual_interview", "ceo_recommend", "ceo_interview", "offer", "joining_scheduled",
  ]);
});

console.log("\n=== 面談のランク → 次の対応ステータス ===\n");

ok("A/Bは社長推薦待ちへ", () => {
  assert.equal(nextStatusFromRank("A"), "ceo_recommend_pending");
  assert.equal(nextStatusFromRank("B"), "ceo_recommend_pending");
});
ok("Cは次回調整待ちへ", () => {
  assert.equal(nextStatusFromRank("C"), "next_scheduling_pending");
});
ok("Dは見送りへ", () => {
  assert.equal(nextStatusFromRank("D"), "passed");
});

console.log("\n=== 期限超過（isOverdue） ===\n");

ok("期限を過ぎていれば超過", () => {
  assert.equal(isOverdue({ decision_due_on: "2020-01-01", status: "ceo_decision_pending" }, "2026-09-25"), true);
});
ok("期限内は超過でない", () => {
  assert.equal(isOverdue({ decision_due_on: "2099-01-01", status: "ceo_decision_pending" }, "2026-09-25"), false);
});
ok("終わっている状態（承諾済み等）は、期限が過ぎていても超過にしない", () => {
  assert.equal(isOverdue({ decision_due_on: "2020-01-01", status: "accepted" }, "2026-09-25"), false);
  assert.equal(isOverdue({ decision_due_on: "2020-01-01", status: "declined" }, "2026-09-25"), false);
});
ok("期限が無ければ超過にしない", () => {
  assert.equal(isOverdue({ decision_due_on: null, status: "todo" }, "2026-09-25"), false);
});

console.log("\n=== 合格通知の状態（offerStatus） ===\n");

const offer = (over = {}) => ({
  expires_at: "2099-01-01T00:00:00Z", revoked_at: null, sent_at: null,
  accepted_at: null, declined_at: null, ...over,
});

ok("無ければ none", () => { assert.equal(offerStatus(null), "none"); });
ok("作っただけなら draft", () => { assert.equal(offerStatus(offer()), "draft"); });
ok("送ったら sent", () => { assert.equal(offerStatus(offer({ sent_at: "2026-09-01T00:00:00Z" })), "sent"); });
ok("承諾されたら accepted（送付済みより優先）", () => {
  assert.equal(offerStatus(offer({ sent_at: "2026-09-01T00:00:00Z", accepted_at: "2026-09-02T00:00:00Z" })), "accepted");
});
ok("辞退されたら declined", () => {
  assert.equal(offerStatus(offer({ sent_at: "2026-09-01T00:00:00Z", declined_at: "2026-09-02T00:00:00Z" })), "declined");
});
ok("無効化されたら revoked（承諾・辞退が無い場合）", () => {
  assert.equal(offerStatus(offer({ revoked_at: "2026-09-02T00:00:00Z" })), "revoked");
});
ok("期限が過ぎたら expired", () => {
  assert.equal(offerStatus(offer({ sent_at: "2020-01-01T00:00:00Z", expires_at: "2020-02-01T00:00:00Z" })), "expired");
});
ok("本人が閲覧したら viewed（送付済みより優先。Stage 6）", () => {
  assert.equal(offerStatus(offer({ sent_at: "2026-09-01T00:00:00Z", viewed_at: "2026-09-02T00:00:00Z" })), "viewed");
});

console.log("\n=== 本人の回答状況（offerResponseStatus） ===\n");

ok("未回答なら pending", () => { assert.equal(offerResponseStatus(offer()), "pending"); });
ok("承諾されたら accepted", () => {
  assert.equal(offerResponseStatus(offer({ accepted_at: "2026-09-02T00:00:00Z" })), "accepted");
});
ok("辞退されたら declined", () => {
  assert.equal(offerResponseStatus(offer({ declined_at: "2026-09-02T00:00:00Z" })), "declined");
});

console.log("\n=== 候補者向け公開ページの形（shapePublicOffer） ===\n");

ok("社内向け情報を含まず、offer側のスナップショットだけを返す", () => {
  const s = shapePublicOffer(
    { job_title: "エンジニア", wage_amount: 400000, respond_by: "2026-10-15", accepted_at: null, declined_at: null },
    { name: "山田 太郎" },
    { name: "株式会社エイト" },
    { display_name: "採用 花子", email: "recruit@example.com" },
  );
  assert.equal(s.candidateName, "山田 太郎");
  assert.equal(s.tenantName, "株式会社エイト");
  assert.equal(s.jobTitle, "エンジニア");
  assert.equal(s.responseStatus, "pending");
  assert.equal(s.recruiterName, "採用 花子");
  assert.equal(s.recruiterEmail, "recruit@example.com");
  assert.ok(!("rank" in s) && !("employeeId" in s) && !("tenantId" in s));
});
ok("採用担当が未定なら、連絡先はnull", () => {
  const s = shapePublicOffer(
    { job_title: "エンジニア", respond_by: "2026-10-15", accepted_at: null, declined_at: null },
    { name: "山田 太郎" }, null, null,
  );
  assert.equal(s.recruiterEmail, null);
});

console.log("\n=== 応募者の入力チェック（normalizeApplicant） ===\n");

const body = (over = {}) => ({ name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル", ...over });

ok("氏名・応募職種・応募媒体がそろっていれば通る", () => {
  const r = normalizeApplicant(body());
  assert.equal(r.error, undefined);
  assert.equal(r.value.name, "山田 太郎");
  assert.equal(r.value.job_title, "エンジニア");
  assert.equal(r.value.source, "リファラル");
});
ok("氏名が無ければ拒否", () => { assert.ok(normalizeApplicant(body({ name: "" })).error); });
ok("応募職種が無ければ拒否", () => { assert.ok(normalizeApplicant(body({ jobTitle: "" })).error); });
ok("応募媒体が無ければ拒否", () => { assert.ok(normalizeApplicant(body({ source: "" })).error); });
ok("stage が不正なら拒否", () => { assert.ok(normalizeApplicant(body({ stage: "unknown" })).error); });
ok("rank が不正なら拒否", () => { assert.ok(normalizeApplicant(body({ rank: "S" })).error); });
ok("partial=true では、渡した項目だけ見る", () => {
  const r = normalizeApplicant({ note: "電話で一次連絡" }, { partial: true });
  assert.equal(r.error, undefined);
  assert.equal(r.value.note, "電話で一次連絡");
  assert.equal(r.value.name, undefined);
});
ok("採用条件は admin-onboard と同じ列名で持つ", () => {
  const r = normalizeApplicant(body({
    contractType: "有期", joinDate: "2026-10-01", wageType: "月給", wageAmount: 300000, weeklyHours: 40,
  }));
  assert.equal(r.value.contract_type, "有期");
  assert.equal(r.value.join_date, "2026-10-01");
  assert.equal(r.value.wage_type, "月給");
  assert.equal(r.value.wage_amount, 300000);
  assert.equal(r.value.weekly_hours, 40);
});

console.log("\n=== 合格通知へのスナップショット（snapshotOfferFields） ===\n");

ok("応募者の採用条件をそのまま写す", () => {
  const applicant = { job_title: "エンジニア", employment_type: "正社員", contract_type: "無期",
    contract_end_date: null, join_date: "2026-10-01", probation_months: 3,
    wage_type: "月給", wage_amount: 300000, weekly_hours: 40, work_location: "リモート" };
  const s = snapshotOfferFields(applicant);
  assert.equal(s.job_title, "エンジニア");
  assert.equal(s.wage_amount, 300000);
  assert.equal(s.work_location, "リモート");
});

console.log("\n=== admin-onboard.html へ渡す項目（ONBOARD_PREFILL_FIELDS） ===\n");

ok("列名は gw_hr_applicants と同じ（変換しない）", () => {
  assert.deepEqual(ONBOARD_PREFILL_FIELDS, [
    "name", "email", "join_date", "contract_type", "contract_end_date",
    "probation_months", "wage_type", "wage_amount", "weekly_hours",
  ]);
});

console.log("\n=== 本採用への事前入力（advancePrefill・Stage 8） ===\n");

ok("admin-onboard.htmlの項目名（camelCase）に変換される", () => {
  const p = advancePrefill({
    name: "山田 太郎", email: "yamada@example.com", join_date: "2026-11-01",
    contract_type: "無期", contract_end_date: null, probation_months: 3,
    wage_type: "月給", wage_amount: 400000, weekly_hours: 40,
  });
  assert.deepEqual(p, {
    name: "山田 太郎", email: "yamada@example.com", joinDate: "2026-11-01",
    contractType: "無期", probationMonths: 3, wageType: "月給", wageAmount: 400000, weeklyHours: 40,
  });
});
ok("空・nullの項目は入れない（初期値を壊さない）", () => {
  const p = advancePrefill({ name: "山田 太郎", email: null, join_date: "" });
  assert.deepEqual(p, { name: "山田 太郎" });
});

console.log("\n=== 本採用クレームの期限切れ（isAdvanceClaimStale・Stage 8） ===\n");

ok("クレームが無ければ stale扱い", () => { assert.equal(isAdvanceClaimStale(null), true); });
ok("1時間以内なら有効", () => {
  assert.equal(isAdvanceClaimStale(new Date(Date.now() - 10 * 60000).toISOString()), false);
});
ok("1時間を過ぎたら stale", () => {
  assert.equal(isAdvanceClaimStale(new Date(Date.now() - 2 * 3600000).toISOString()), true);
});

console.log("\n=== 画面へ渡す形（shapeApplicant） ===\n");

ok("ラベル・期限超過が付く", () => {
  const shaped = shapeApplicant({
    id: "a1", name: "山田 太郎", stage: "ceo_recommend", status: "ceo_decision_pending",
    decision_due_on: "2020-01-01", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  });
  assert.equal(shaped.stageLabel, "社長推薦");
  assert.equal(shaped.statusLabel, STATUS_LABEL.ceo_decision_pending);
  assert.equal(shaped.overdue, true);
});

console.log("\n=== 面談・評価（Stage 3） ===\n");

ok("5項目評価。項目を増やしすぎない", () => {
  assert.equal(EVAL_ITEMS.length, 5);
  assert.equal(EVAL_SCALE_KEYS.length, 4);
});

ok("面談の種別ラベル", () => {
  assert.equal(interviewKindLabel("casual"), "カジュアル面談");
  assert.equal(interviewKindLabel("ceo"), "社長面談");
});

console.log("— 面談の入力チェック（normalizeInterview） —");

ok("種別が不正なら断る", () => {
  const r = normalizeInterview({ kind: "phone" });
  assert.equal(r.error, "invalid_body");
});
ok("評価の値が不正なら断る", () => {
  const r = normalizeInterview({ scores: { communication: "普通" } }, { partial: true });
  assert.equal(r.error, "invalid_body");
});
ok("ランクが不正なら断る", () => {
  const r = normalizeInterview({ rank: "S" }, { partial: true });
  assert.equal(r.error, "invalid_body");
});
ok("正しい形はそのまま通る", () => {
  const r = normalizeInterview({
    kind: "casual", scheduledAt: "2026-09-26T05:00:00Z", interviewerId: "e1",
    meetingUrl: "https://meet.example.com/x", scores: { communication: "great" }, rank: "A",
  });
  assert.equal(r.value.kind, "casual");
  assert.equal(r.value.scores.communication, "great");
  assert.equal(r.value.rank, "A");
});

console.log("— NEXT ACTION（nextActionOf） —");

ok("新規応募（未対応）は、日程調整URLを送る（TimeRex連携。README「TimeRex連携」指示書 §5）", () => {
  const n = nextActionOf({ status: "todo" });
  assert.equal(n.cta, "日程調整を送る");
  assert.equal(n.action, "sendSchedulingLink");
});
ok("日程調整URL送付後（候補者の予約待ち）は、手動設定が例外導線として残る（§21）", () => {
  const n = nextActionOf({ status: "scheduling" });
  assert.equal(n.cta, "手動で面談を設定");
  assert.equal(n.action, "schedule");
});
ok("面談予定は、実施済みにするボタン", () => {
  const n = nextActionOf({ status: "interview_scheduled" }, { scheduledAt: "2026-09-25T05:00:00Z", kind: "casual" });
  assert.equal(n.cta, "面談を実施済みにする");
  assert.match(n.label, /カジュアル面談/);
});
ok("面談終了・未評価は、評価を入力", () => {
  const n = nextActionOf({ status: "eval_pending" });
  assert.equal(n.cta, "評価を入力");
  assert.equal(n.action, "evaluate");
});
ok("Aランクは、社長推薦する", () => {
  const n = nextActionOf({ status: "ceo_recommend_pending", rank: "A" });
  assert.equal(n.cta, "社長推薦する");
  assert.equal(n.action, "recommend");
});
ok("Bランクは、次回面談を設定（同じstatusでもランクで変わる）", () => {
  const n = nextActionOf({ status: "ceo_recommend_pending", rank: "B" });
  assert.equal(n.cta, "次回面談を設定");
  assert.equal(n.action, "schedule");
});
ok("Cランクは、判断を更新", () => {
  const n = nextActionOf({ status: "next_scheduling_pending", rank: "C" });
  assert.equal(n.cta, "判断を更新");
  assert.equal(n.action, "evaluate");
});
ok("Dランクは、見送りを確定（決定前）", () => {
  const n = nextActionOf({ status: "passed", rank: "D", decision: null });
  assert.equal(n.cta, "見送りを確定");
  assert.equal(n.action, "reject");
});
ok("見送りが確定したあとは、ボタンは出ない", () => {
  const n = nextActionOf({ status: "passed", rank: "D", decision: "rejected" });
  assert.equal(n.cta, null);
});
ok("社長面談待ちは、社長面談を設定（kind: ceo）", () => {
  const n = nextActionOf({ status: "ceo_interview_pending" });
  assert.equal(n.cta, "社長面談を設定");
  assert.equal(n.kind, "ceo");
});

console.log("— NEXT ACTION：合格通知・本人専用URL（Stage 5・6） —");

ok("合格通知作成待ちは、合格通知を作成", () => {
  const n = nextActionOf({ status: "offer_draft_pending" });
  assert.equal(n.cta, "合格通知を作成");
  assert.equal(n.action, "createOffer");
});
ok("本人送付待ちは、本人へ送る", () => {
  const n = nextActionOf({ status: "offer_send_pending" });
  assert.equal(n.cta, "本人へ送る");
  assert.equal(n.action, "sendOffer");
});
ok("URL再送待ちは、本人へ再送", () => {
  const n = nextActionOf({ status: "offer_resend_pending" });
  assert.equal(n.cta, "本人へ再送");
  assert.equal(n.action, "sendOffer");
});
ok("送付済み・未閲覧は、送付日時が出て、URLを再発行できる", () => {
  const n = nextActionOf({ status: "offer_sent" }, null, { sentAt: "2026-09-25T06:00:00Z" });
  assert.match(n.label, /送付：/);
  assert.match(n.label, /閲覧：未確認/);
  assert.equal(n.cta, "URLを再発行");
  assert.equal(n.action, "reissueOffer");
});
ok("承諾待ち（閲覧済み）は、送付・閲覧の日時が出て、URLを再発行できる", () => {
  const n = nextActionOf(
    { status: "offer_response_pending" }, null,
    { sentAt: "2026-09-25T06:00:00Z", viewedAt: "2026-09-25T07:00:00Z" },
  );
  assert.equal(n.label.startsWith("本人の回答を待っています"), true);
  assert.match(n.label, /閲覧：(?!未確認)/);
  assert.equal(n.cta, "URLを再発行");
});
ok("offer_viewed（旧・後方互換）も、承諾待ちと同じ扱いになる", () => {
  const n = nextActionOf(
    { status: "offer_viewed" }, null,
    { sentAt: "2026-09-25T06:00:00Z", viewedAt: "2026-09-25T07:00:00Z" },
  );
  assert.equal(n.label.startsWith("本人の回答を待っています"), true);
  assert.equal(n.cta, "URLを再発行");
});
ok("回答期限が過ぎたら、承諾待ちでも「期限を過ぎました」に切り替わる", () => {
  const n = nextActionOf(
    { status: "offer_response_pending" }, null,
    { sentAt: "2020-01-01T00:00:00Z", viewedAt: "2020-01-01T00:00:00Z", expiresAt: "2020-02-01T00:00:00Z" },
  );
  assert.match(n.label, /期限を過ぎました/);
  assert.equal(n.cta, "URLを再発行");
});
ok("本人送付待ちでも、期限が過ぎていれば知らせる（一度も送らないまま期限切れ）", () => {
  const n = nextActionOf({ status: "offer_send_pending" }, null, { expiresAt: "2020-02-01T00:00:00Z" });
  assert.match(n.label, /期限を過ぎました/);
});

console.log("— NEXT ACTION：承諾・辞退（Stage 7） —");

ok("承諾済みは、本採用へ進めてください（Stage 8：本採用へ進めるボタン）", () => {
  const n = nextActionOf({ status: "accepted" });
  assert.equal(n.label, "本採用へ進めてください");
  assert.equal(n.cta, "本採用へ進める");
  assert.equal(n.action, "advance");
});
ok("手続き中（有効なクレームあり）なら、続きを開くボタンになる", () => {
  const n = nextActionOf({ status: "accepted", advance_claimed_at: new Date().toISOString() });
  assert.match(n.label, /手続き中/);
  assert.equal(n.cta, "続きを開く");
  assert.equal(n.action, "advance");
});
ok("クレームが古ければ（1時間超）、やり直しとして扱う", () => {
  const n = nextActionOf({ status: "accepted", advance_claimed_at: new Date(Date.now() - 2 * 3600000).toISOString() });
  assert.equal(n.cta, "本採用へ進める");
});
ok("辞退は、対応不要", () => {
  const n = nextActionOf({ status: "declined" });
  assert.equal(n.label, "対応は不要です");
  assert.equal(n.cta, null);
});

console.log("— 画面へ渡す形（shapeInterview） —");

ok("列名から、画面向けの形にする", () => {
  const s = shapeInterview({
    id: "i1", applicant_id: "a1", kind: "casual", scheduled_at: "2026-09-25T05:00:00Z",
    conducted_at: null, interviewer_id: "e1", meeting_url: "https://meet.example.com/x",
    recording_url: null, scores: {}, rank: null, recommend_reason: null, notes: null,
    next_due_on: null, created_at: "2026-09-24T00:00:00Z",
  });
  assert.equal(s.kindLabel, "カジュアル面談");
  assert.equal(s.done, false);
  assert.equal(s.meetingUrl, "https://meet.example.com/x");
});

console.log("— TimeRex日程調整URL（schedulingUrlFor） —");

ok("applicant_idをクエリパラメータで付与する（名前・メール照合に頼らない。README「TimeRex連携」指示書 §11）", () => {
  assert.equal(schedulingUrlFor("https://timerex.net/s/xxxx/casual", "a1"),
    "https://timerex.net/s/xxxx/casual?applicant_id=a1");
});
ok("すでにクエリパラメータがあるURLでも壊さない", () => {
  assert.equal(schedulingUrlFor("https://timerex.net/s/xxxx/casual?foo=bar", "a1"),
    "https://timerex.net/s/xxxx/casual?foo=bar&applicant_id=a1");
});
ok("applicant_idはURLエンコードする", () => {
  assert.equal(schedulingUrlFor("https://timerex.net/s/x/casual", "a b"),
    "https://timerex.net/s/x/casual?applicant_id=a%20b");
});
ok("環境変数が未設定（空）なら、null（フロント側は手動設定へ誘導する）", () => {
  assert.equal(schedulingUrlFor("", "a1"), null);
  assert.equal(schedulingUrlFor(undefined, "a1"), null);
});
ok("applicant_idが無ければ、null", () => {
  assert.equal(schedulingUrlFor("https://timerex.net/s/x/casual", null), null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
