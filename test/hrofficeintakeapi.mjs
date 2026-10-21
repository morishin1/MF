// 採用HR → Office の早期引き渡し（新フロー。db/143・lib/hr-office-intake*.js）を、本物のハンドラで通す。
//
// ■ 何を守るテストか（HR→Office 引き継ぎ 要件定義 2026-10-21 §4・§8・§9、PR A）
//   1. 社長本人の合格だけが確定記録になる（判断者・日時・応募者ID）。採用担当・人事・他社は、状態に関係なく合格にできない
//   2. 合格前・ヒアリング前・不足あり・未確認では引き渡せない。未確定のまま渡すには社長・管理者の承認と理由が要る
//   3. 推測値を入れない（値と「未確定」の両方は断る）。給与は見られる人だけ・社内承認済みの額は経営者だけ
//   4. ［Officeへ引き渡す］は一度だけ（二度目・同時押しは 409、同じ操作の送り直しは最初の結果）。一覧は「Officeへ移動済み」へ
//   5. 引き渡しても accepted_at・formal_signed_at・handoff_at・status・employee_id は変わらない。社員登録へは進めない
//   6. 既存の「内定」（オファーの版がある・新しい合格記録が無い）は旧フローのまま
//   7. 引き渡し済みの人は、状態の変更・一括操作・オファー作成・削除ができない
//   8. 機能フラグ（HR_OFFICE_INTAKE）OFF：新タブ・ヒアリングは出ず、新しい書き込みは断る。社長以外の合格を止めるのは OFF でも同じ
//   9. 別の会社の応募者は触れない
// ※ 実在の応募者・メール送信は使わない（通知・Slack・メールは PR A では送らない）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "./_memdb.mjs";
import { MFA_AUTH } from "./_mfa.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
delete process.env.HR_PAY_SPLIT;
delete process.env.SALARY_OWNER_ONLY;
process.env.HR_OFFICE_INTAKE = "1";

// 部分一意索引（db/143）の代わり：有効な行だけが持つ鍵で一意にする
const mem = createMemDb({
  schema: {
    gw_hr_office_intakes: { unique: [["tenant_id", "applicant_id", "active_key"], ["tenant_id", "client_request_id"]],
      defaults: () => ({ active_key: "active", returned_at: null, office_status: "not_started", office_assignee_id: null,
        received_at: null, client_request_id: null, handed_at: new Date().toISOString(), created_at: new Date().toISOString() }) },
    gw_hr_hearings: { unique: [["tenant_id", "applicant_id", "open_key"]],
      defaults: () => ({ open_key: "open", locked_at: null, confirmed_at: null, confirmed_by: null, exception_reason: null,
        exception_approved_by: null, exception_approved_at: null, unresolved: [] }) },
    gw_hr_hearing_pay: { unique: [["hearing_id"]], noId: true },
    gw_hr_ceo_decisions: { defaults: () => ({ decided_at: new Date().toISOString(), created_at: new Date().toISOString() }) },
    gw_hr_office_intake_events: { defaults: () => ({ created_at: new Date().toISOString() }) },
  },
});
const logged = [];
const notified = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: {
  notify: async (rows) => { notified.push(...rows); return { created: rows.length }; }, clearNotification: async () => {},
} });
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => { throw new Error("PR A は Slack を送らない"); } } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });

// 呼ぶ人：社長（owner）／管理者（会計側の管理者・採用HR）／人事（給与は見える・判断はできない）／採用担当／一般／他社の社長
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], apps: ["hr", "office"], employee: { id: "e-owner" } };
const ADMIN = { userId: "u-adm", tenantId: "t1", isAdmin: true, isHr: true, roles: [], apps: ["hr", "office"], employee: { id: "e-adm" } };
const HRP = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"], employee: { id: "e-hr" } };
const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], apps: ["hr"], employee: { id: "e-rec" } };
const MEMBER = { userId: "u-mem", tenantId: "t1", isAdmin: false, isHr: false, roles: [], apps: [], employee: { id: "e-mem" } };
const OTHER = { userId: "u-oth", tenantId: "t2", isAdmin: false, isHr: true, roles: ["owner"], apps: ["hr", "office"], employee: { id: "e-oth" } };
let who = OWNER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: bulkApi } = await import(atRoot("api/hr/applicants/bulk.js"));
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { default: advanceApi } = await import(atRoot("api/hr/applicants/advance.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (fn, req) => { const r = res(); await fn({ headers: { authorization: MFA_AUTH }, ...req }, r); return r; };
const as = (p) => { who = p; };
const get = (id = "a1") => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const patch = (body) => call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const list = () => call(listApi, { method: "GET", url: "/api/hr/applicants?category=all" });
const bulk = (body) => call(bulkApi, { method: "POST", url: "/api/hr/applicants/bulk", body });
const pass = (id = "a1") => patch({ id, decision: "hired", stage: "offer", status: "offer_draft_pending", decisionNote: "ぜひ" });

let okN = 0, ngN = 0;
const ok = async (name, fn) => {
  try { await fn(); okN++; console.log("  ok", name); }
  catch (e) { ngN++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

const FULL = {
  offer_type: "part_time", job_title: "エンジニア", duties: "社内システムの開発", desired_join_date: "2026-12-01",
  work_location: "東京本社", remote_policy: "週2日リモート", weekly_days: 3, weekly_hours: 24, contract_period: "期間の定めなし",
};
const applicant = (id) => mem.rows.gw_hr_applicants.find((a) => a.id === id);

function setup() {
  mem.reset(); logged.length = 0; notified.length = 0; who = OWNER;
  process.env.HR_OFFICE_INTAKE = "1";
  mem.rows.tenants = [{ id: "t1", name: "テスト会社" }, { id: "t2", name: "別会社" }];
  mem.rows.gw_employees = [
    { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
    { id: "e-hr", tenant_id: "t1", user_id: "u-hr", display_name: "人事 次郎", status: "active" },
    { id: "e-rec", tenant_id: "t1", user_id: "u-rec", display_name: "採用 花子", status: "active" },
    { id: "e-oth", tenant_id: "t2", user_id: "u-oth", display_name: "他社 社長", status: "active" },
  ];
  const base = { tenant_id: "t1", email: "x@example.test", source: "テスト", rank: "A", recruiter_id: "e-rec", lead_category: "recruitment",
    employee_id: null, offer_type: null, decision: null, job_title: "エンジニア" };
  mem.rows.gw_hr_applicants = [
    // 新フローになる人（これから社長が判断する）
    { ...base, id: "a1", name: "新 一郎", stage: "ceo_interview", status: "ceo_decision_pending" },
    // 社長面談の設定待ち（ceo_decision_pending 以外の状態からの合格を試す）
    { ...base, id: "a2", name: "新 二郎", stage: "ceo_interview", status: "ceo_interview_pending" },
    // 既存の「内定」：オファーの版がある（旧フロー）
    { ...base, id: "old1", name: "旧 三郎", stage: "offer", status: "offer_review_pending", decision: "hired", offer_type: "part_time" },
    // 既存の「内定」：オファーの版は無いが、新しい合格記録も無い（旧フロー）
    { ...base, id: "old2", name: "旧 四郎", stage: "offer", status: "offer_draft_pending", decision: "hired", offer_type: "part_time" },
    // 社員登録まで済んだ人
    { ...base, id: "done1", name: "済 五郎", stage: "joining_scheduled", status: "done", decision: "hired", employee_id: "e-hr" },
    // 履歴の無い応募者
    { ...base, id: "plain", name: "誤 登録", stage: "applied", status: "todo", recruiter_id: null },
    // 別の会社
    { ...base, id: "x1", tenant_id: "t2", name: "他社 六郎", stage: "ceo_interview", status: "ceo_decision_pending" },
  ];
  mem.rows.gw_hr_offers = [{ id: "o-old1", tenant_id: "t1", applicant_id: "old1", version: 1, offer_type: "part_time",
    created_at: "2026-10-01T00:00:00Z", accepted_at: null, revoked_at: null, handoff_at: null }];
  for (const t of ["gw_hr_timeline", "gw_hr_interviews", "gw_hr_ceo_decisions", "gw_hr_hearings", "gw_hr_hearing_pay",
    "gw_hr_office_intakes", "gw_hr_office_intake_events", "memberships", "gw_hr_documents"]) mem.rows[t] = mem.rows[t] || [];
}
/** a1 を社長合格 → ヒアリング（全部そろう）→ 確認 まで進める */
async function readyA1({ unresolved = [], values = FULL } = {}) {
  as(OWNER); assert.equal((await pass()).statusCode, 200);
  as(HRP);
  const v = { ...values };
  for (const k of unresolved) v[k] = null;
  const r = await patch({ id: "a1", action: "saveHearing", hearing: v, unresolved,
    ...(unresolved.includes("desired_pay") ? {} : { pay: { desired_wage_type: "時給", desired_amount: 1800 } }) });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = await patch({ id: "a1", action: "confirmHearing" });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
}

console.log("\n=== 1. 社長本人の合格だけが確定記録になる ===\n");

await ok("採用担当は、社長判断待ちの人を合格にできない（403・記録なし）", async () => {
  setup(); as(RECRUITER);
  const r = await pass("a1");
  assert.equal(r.statusCode, 403);
  assert.equal(mem.rows.gw_hr_ceo_decisions.length, 0);
  assert.equal(applicant("a1").decision, null);
});
await ok("採用担当は、社長判断待ち以外の状態からでも合格にできない（以前は通っていた穴）", async () => {
  setup(); as(RECRUITER);
  const r = await pass("a2");
  assert.equal(r.statusCode, 403, JSON.stringify(r.body));
  assert.equal(applicant("a2").decision, null);
});
await ok("人事（判断の権限なし）も合格にできない", async () => {
  setup(); as(HRP);
  assert.equal((await pass("a2")).statusCode, 403);
});
await ok("一般メンバーは採用HRに入れない（403）", async () => {
  setup(); as(MEMBER);
  assert.equal((await pass("a1")).statusCode, 403);
  assert.equal((await get()).statusCode, 403);
});
await ok("社長の合格は、判断者・日時・応募者ID つきで記録される", async () => {
  setup(); as(OWNER);
  const r = await pass("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = mem.rows.gw_hr_ceo_decisions;
  assert.equal(d.length, 1);
  assert.equal(d[0].decision, "pass");
  assert.equal(d[0].decided_by, "u-owner");
  assert.equal(d[0].applicant_id, "a1");
  assert.equal(d[0].tenant_id, "t1");
  assert.ok(d[0].decided_at);
});
await ok("管理者も合格を記録できる。保留・見送りも記録される（採用担当の早期見送りは記録しない）", async () => {
  setup(); as(ADMIN);
  assert.equal((await pass("a2")).statusCode, 200);
  assert.equal((await patch({ id: "a1", decision: "hold", holdReason: "比較中", holdNextStep: "もう一度話す", decisionDueOn: "2026-11-01" })).statusCode, 200);
  assert.deepEqual(mem.rows.gw_hr_ceo_decisions.map((d) => d.decision).sort(), ["hold", "pass"]);
  as(RECRUITER);
  assert.equal((await patch({ id: "plain", decision: "rejected", status: "passed" })).statusCode, 200);
  assert.equal(mem.rows.gw_hr_ceo_decisions.length, 2, "採用担当の見送りは社長判断ではない");
});
await ok("別の会社の人は、この会社の応募者を合格にできない（404）", async () => {
  setup(); as(OTHER);
  assert.equal((await pass("a1")).statusCode, 404);
  assert.equal(mem.rows.gw_hr_ceo_decisions.length, 0);
});

console.log("\n=== 2. 合格 → ヒアリング → 確認 → 引き渡し の条件 ===\n");

await ok("合格直後は「社長合格／条件ヒアリング待ち」・NEXT は条件ヒアリング（ボタン1つ）", async () => {
  setup(); as(OWNER); await pass("a1");
  const r = await get();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applicant.statusLabel, "社長合格／条件ヒアリング待ち");
  assert.equal(r.body.applicant.nextActionKey, "hearing");
  assert.equal(r.body.officeIntake.phase, "awaiting_hearing");
  assert.equal(r.body.officeIntake.newFlow, true);
});
await ok("合格していない人は、ヒアリングも引き渡しもできない", async () => {
  setup(); as(HRP);
  assert.equal((await patch({ id: "a2", action: "saveHearing", hearing: FULL })).body.error, "not_new_flow");
  assert.equal((await patch({ id: "a2", action: "officeHandoff", confirm: true })).body.error, "not_new_flow");
});
await ok("ヒアリング前は引き渡せない", async () => {
  setup(); as(OWNER); await pass("a1");
  const r = await patch({ id: "a1", action: "officeHandoff", confirm: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "hearing_missing");
});
await ok("推測値を入れない：値と「未確定」が両方ある項目は断る", async () => {
  setup(); as(OWNER); await pass("a1"); as(HRP);
  const r = await patch({ id: "a1", action: "saveHearing", hearing: FULL, unresolved: ["desired_join_date"] });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.detail, /希望入社日/);
});
await ok("必須項目が足りないと、確認も引き渡しもできない（条件ヒアリング不足・項目つき）", async () => {
  setup(); as(OWNER); await pass("a1"); as(RECRUITER);
  const s = await patch({ id: "a1", action: "saveHearing", hearing: { offer_type: "part_time", job_title: "エンジニア" } });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.ok(s.body.officeIntake.missing.includes("desired_join_date"));
  const c = await patch({ id: "a1", action: "confirmHearing" });
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, "hearing_incomplete");
  assert.match(c.body.hint, /条件ヒアリング不足/);
  const h = await patch({ id: "a1", action: "officeHandoff", confirm: true });
  assert.equal(h.body.error, "hearing_incomplete");
  assert.equal(mem.rows.gw_hr_office_intakes.length, 0);
});
await ok("給与：給与を見られない採用担当は希望額を入力できない（「未確定」にはできる）", async () => {
  setup(); as(OWNER); await pass("a1"); as(RECRUITER);
  const r = await patch({ id: "a1", action: "saveHearing", hearing: FULL, pay: { desired_amount: 1800 } });
  assert.equal(r.statusCode, 403);
  const u = await patch({ id: "a1", action: "saveHearing", hearing: FULL, unresolved: ["desired_pay"] });
  assert.equal(u.statusCode, 200, JSON.stringify(u.body));
});
await ok("給与：希望額は採用担当の詳細に値が出ない（入っているかだけ）。人事には出る", async () => {
  setup(); await readyA1();
  as(RECRUITER);
  const r = await get();
  assert.deepEqual(r.body.officeIntake.pay, { entered: true });
  assert.ok(!JSON.stringify(r.body).includes("1800"), "採用担当の応答に希望額が無い");
  as(HRP);
  assert.equal((await get()).body.officeIntake.pay.desired_amount, 1800);
});
await ok("給与：社内承認済みの額は経営者だけが入力できる（希望と分けて持つ）", async () => {
  setup(); as(OWNER); await pass("a1"); as(HRP);
  const r = await patch({ id: "a1", action: "saveHearing", hearing: FULL, pay: { desired_amount: 1800, approved_amount: 1700 } });
  assert.equal(r.statusCode, 403);
  as(OWNER);
  const o = await patch({ id: "a1", action: "saveHearing", hearing: FULL, pay: { desired_amount: 1800, approved_wage_type: "時給", approved_amount: 1700 } });
  assert.equal(o.statusCode, 200, JSON.stringify(o.body));
  const p = mem.rows.gw_hr_hearing_pay[0];
  assert.equal(p.desired_amount, 1800);
  assert.equal(p.approved_amount, 1700);
  assert.equal(p.approved_by, "u-owner");
});
await ok("未確定の項目を残すと、例外の承認が無い限り引き渡せない", async () => {
  setup(); await readyA1({ unresolved: ["desired_join_date"] });
  as(RECRUITER);
  const r = await patch({ id: "a1", action: "officeHandoff", confirm: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "exception_required");
  assert.equal(mem.rows.gw_hr_office_intakes.length, 0);
});
await ok("例外の承認は社長・管理者だけ・理由が要る", async () => {
  setup(); await readyA1({ unresolved: ["desired_join_date"] });
  as(RECRUITER);
  assert.equal((await patch({ id: "a1", action: "approveHearingException", reason: "退職交渉中" })).statusCode, 403);
  as(HRP);
  assert.equal((await patch({ id: "a1", action: "approveHearingException", reason: "退職交渉中" })).statusCode, 403);
  as(ADMIN);
  assert.equal((await patch({ id: "a1", action: "approveHearingException", reason: "  " })).statusCode, 400);
  const ok2 = await patch({ id: "a1", action: "approveHearingException", reason: "入社日は退職交渉次第。Officeで確認" });
  assert.equal(ok2.statusCode, 200, JSON.stringify(ok2.body));
  assert.equal(ok2.body.officeIntake.phase, "ready");
  as(RECRUITER);
  const h = await patch({ id: "a1", action: "officeHandoff", confirm: true });
  assert.equal(h.statusCode, 200, JSON.stringify(h.body));
  const i = mem.rows.gw_hr_office_intakes[0];
  assert.deepEqual(i.unresolved_items, ["desired_join_date"]);
  assert.equal(i.exception_approved_by, "u-adm");
  assert.match(i.exception_reason, /退職交渉/);
});
await ok("ヒアリングを直すと確認は外れる（もう一度確認が要る）。未確定の項目が変われば例外の承認も外れる", async () => {
  setup(); await readyA1({ unresolved: ["desired_join_date"] });
  as(OWNER); await patch({ id: "a1", action: "approveHearingException", reason: "理由" });
  as(HRP);
  await patch({ id: "a1", action: "saveHearing", hearing: { ...FULL, desired_join_date: null, remote_policy: null }, unresolved: ["desired_join_date", "remote_policy"] });
  const h = mem.rows.gw_hr_hearings[0];
  assert.equal(h.confirmed_at, null);
  assert.equal(h.exception_approved_at, null);
});
await ok("育成枠は Office へ引き渡さない", async () => {
  setup(); await readyA1({ values: { ...FULL, offer_type: "training" } });
  as(RECRUITER);
  const r = await patch({ id: "a1", action: "officeHandoff", confirm: true });
  assert.equal(r.body.error, "training");
});
await ok("確認画面を経ない（confirm なし）の引き渡しは断る", async () => {
  setup(); await readyA1(); as(RECRUITER);
  assert.equal((await patch({ id: "a1", action: "officeHandoff" })).statusCode, 400);
});

console.log("\n=== 3. 引き渡しは一度だけ・既存の状態は変えない ===\n");

await ok("［Officeへ引き渡す］で1件記録される（誰が・いつ・担当・履歴）。通知・メールは送らない", async () => {
  setup(); await readyA1(); as(RECRUITER);
  const r = await patch({ id: "a1", action: "officeHandoff", confirm: true, officeAssigneeId: "e-hr", clientRequestId: "req-00000001" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(mem.rows.gw_hr_office_intakes.length, 1);
  const i = mem.rows.gw_hr_office_intakes[0];
  assert.equal(i.handed_by, "u-rec");
  assert.equal(i.office_assignee_id, "e-hr");
  assert.equal(i.office_status, "not_started");
  assert.ok(!JSON.stringify(i.hearing_snapshot).includes("1800"), "引き渡しの写しに給与の値を入れない");
  assert.equal(mem.rows.gw_hr_office_intake_events.filter((e) => e.kind === "handed_off").length, 1);
  assert.ok(mem.rows.gw_hr_timeline.some((t) => t.event_key === "office_intake"));
  assert.ok(logged.some((l) => l.action === "hr.office_intake_handoff"));
  assert.equal(notified.length, 0);
  assert.equal(r.body.officeIntake.phase, "handed_off");
});
await ok("二度目の引き渡しは 409。同じ操作の送り直しは最初の結果（行は増えない）", async () => {
  setup(); await readyA1(); as(RECRUITER);
  await patch({ id: "a1", action: "officeHandoff", confirm: true, clientRequestId: "req-00000001" });
  const again = await patch({ id: "a1", action: "officeHandoff", confirm: true });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, "already_handed_off");
  const resend = await patch({ id: "a1", action: "officeHandoff", confirm: true, clientRequestId: "req-00000001" });
  assert.equal(resend.statusCode, 200);
  assert.equal(resend.body.duplicate, true);
  assert.equal(mem.rows.gw_hr_office_intakes.length, 1);
});
await ok("同時に押しても1件だけ（もう1つは 409）", async () => {
  setup(); await readyA1(); as(RECRUITER);
  const [a, b] = await Promise.all([
    patch({ id: "a1", action: "officeHandoff", confirm: true }),
    patch({ id: "a1", action: "officeHandoff", confirm: true }),
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(mem.rows.gw_hr_office_intakes.length, 1);
});
await ok("引き渡しても status・decision・offers・accepted_at・formal_signed_at・handoff_at・employee_id は変わらない", async () => {
  setup(); await readyA1(); as(RECRUITER);
  const before = JSON.stringify({ a: applicant("a1"), o: mem.rows.gw_hr_offers });
  await patch({ id: "a1", action: "officeHandoff", confirm: true });
  const a = applicant("a1");
  assert.equal(a.status, "offer_draft_pending");
  assert.equal(a.decision, "hired");
  assert.equal(a.employee_id, null);
  assert.equal(JSON.stringify({ a, o: mem.rows.gw_hr_offers }), before);
  assert.equal(mem.rows.gw_hr_offers.filter((o) => o.applicant_id === "a1").length, 0);
});
await ok("引き渡しても社員登録へは進めない（承諾・正式契約・既存の引き渡しのガードはそのまま）", async () => {
  setup(); await readyA1(); as(RECRUITER);
  await patch({ id: "a1", action: "officeHandoff", confirm: true });
  as(OWNER);
  const r = await call(advanceApi, { method: "POST", url: "/api/hr/applicants/advance", body: { applicantId: "a1" } });
  assert.notEqual(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(applicant("a1").employee_id, null);
});
await ok("一覧：引き渡した人は「Officeへ移動済み」タブ（選考中から外れる）・タブは5つ", async () => {
  setup(); await readyA1(); as(RECRUITER);
  await patch({ id: "a1", action: "officeHandoff", confirm: true });
  const r = await list();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a1 = r.body.applicants.find((a) => a.id === "a1");
  assert.equal(a1.listTab, "office");
  assert.match(a1.statusLabel, /Officeへ移動済み/);
  assert.deepEqual(r.body.listTabs.map((t) => t.label), ["選考中", "業務委託", "無限道場", "Officeへ移動済み", "終了"]);
  assert.ok(!a1.alerts.some((x) => x.key === "no_next"), "Office へ移動済みの人に「NEXT ACTION なし」を出さない");
});

console.log("\n=== 4. 既存の内定（旧フロー）は変えない ===\n");

await ok("オファーの版がある内定者・合格記録の無い内定者は旧フローのまま（ラベル・NEXT も従来どおり）", async () => {
  setup(); as(HRP);
  for (const id of ["old1", "old2"]) {
    const r = await get(id);
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.officeIntake.newFlow, false, id);
    assert.notEqual(r.body.applicant.statusLabel, "社長合格／条件ヒアリング待ち");
    assert.notEqual(r.body.applicant.nextActionKey, "hearing");
    assert.equal((await patch({ id, action: "saveHearing", hearing: FULL })).body.error, "not_new_flow");
    assert.equal((await patch({ id, action: "officeHandoff", confirm: true })).body.error, "not_new_flow");
  }
  const l = await list();
  assert.equal(l.body.applicants.find((a) => a.id === "old2").listTab, "active");
  assert.equal(mem.rows.gw_hr_ceo_decisions.length, 0, "過去の合格を記録し直さない");
});

console.log("\n=== 5. 引き渡し済みの人は、HR から状態を変えられない ===\n");

await ok("手動の状態変更・本体の更新・オファー作成・一括変更・削除はすべて断る", async () => {
  setup(); await readyA1(); as(RECRUITER);
  await patch({ id: "a1", action: "officeHandoff", confirm: true });
  as(OWNER);
  assert.equal((await patch({ id: "a1", action: "setStatus", status: "offer_review_pending" })).body.error, "moved_to_office");
  assert.equal((await patch({ id: "a1", status: "passed", decision: "rejected" })).body.error, "moved_to_office");
  const o = await call(offersApi, { method: "POST", url: "/api/hr/offers", body: { applicantId: "a1" } });
  assert.equal(o.statusCode, 409);
  assert.equal(o.body.error, "moved_to_office");
  assert.equal((await bulk({ ids: ["a1"], action: "setStatus", status: "declined" })).statusCode, 409);
  const d = await bulk({ ids: ["a1"], action: "delete" });
  assert.equal(d.statusCode, 409);
  assert.equal(d.body.error, "has_contract_history");
  assert.ok(applicant("a1"));
  assert.equal(applicant("a1").status, "offer_draft_pending");
});

console.log("\n=== 6. 一括・手動で大事な状態を飛び越えない（フラグに関係なく） ===\n");

for (const flag of ["1", ""]) {
  await ok(`一括で 承諾済み・完了・合格通知の段階 にはできない（HR_OFFICE_INTAKE=${flag || "OFF"}）`, async () => {
    setup(); process.env.HR_OFFICE_INTAKE = flag; as(OWNER);
    for (const st of ["accepted", "done", "offer_send_pending", "offer_draft_pending"]) {
      const r = await bulk({ ids: ["plain"], action: "setStatus", status: st });
      assert.equal(r.statusCode, 409, `${st}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(applicant("plain").status, "todo");
  });
}
await ok("一括：社員登録済み・承諾済みの人は動かさない。社長合格の人は「辞退」「募集終了」へだけ", async () => {
  setup(); as(OWNER);
  assert.equal((await bulk({ ids: ["done1"], action: "setStatus", status: "passed" })).statusCode, 409);
  applicant("plain").status = "accepted";
  assert.equal((await bulk({ ids: ["plain"], action: "setStatus", status: "passed" })).statusCode, 409);
  assert.equal((await bulk({ ids: ["old2"], action: "setStatus", status: "todo" })).statusCode, 409);
  const ok2 = await bulk({ ids: ["old2"], action: "setStatus", status: "declined" });
  assert.equal(ok2.statusCode, 200, JSON.stringify(ok2.body));
});
await ok("一括：1人でも変えられない人がいれば、だれも変えない", async () => {
  setup(); as(OWNER);
  const r = await bulk({ ids: ["plain", "done1"], action: "setStatus", status: "passed" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.blocked.length, 1);
  assert.equal(applicant("plain").status, "todo");
});
await ok("一括：社長判断待ちの出入りは社長・管理者だけ", async () => {
  setup(); as(RECRUITER);
  assert.equal((await bulk({ ids: ["a1"], action: "setStatus", status: "passed" })).statusCode, 403);
  assert.equal((await bulk({ ids: ["plain"], action: "setStatus", status: "ceo_decision_pending" })).statusCode, 403);
  as(OWNER);
  assert.equal((await bulk({ ids: ["plain"], action: "setStatus", status: "ceo_decision_pending" })).statusCode, 200);
});
await ok("手動（setStatus・本体の更新）でも 承諾済み・完了 にはできない。合格前に合格通知の段階へは進めない", async () => {
  setup(); process.env.HR_OFFICE_INTAKE = ""; as(OWNER);
  assert.equal((await patch({ id: "plain", action: "setStatus", status: "accepted" })).statusCode, 409);
  assert.equal((await patch({ id: "plain", action: "setStatus", status: "done" })).statusCode, 409);
  assert.equal((await patch({ id: "plain", status: "accepted" })).statusCode, 409);
  const r = await patch({ id: "plain", action: "setStatus", status: "offer_draft_pending" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "needs_ceo_pass");
  assert.equal((await patch({ id: "done1", action: "setStatus", status: "passed" })).statusCode, 409);
  assert.equal(applicant("plain").status, "todo");
});
await ok("フラグ OFF でも、採用担当は合格にできない（記録はしない）", async () => {
  setup(); process.env.HR_OFFICE_INTAKE = ""; as(RECRUITER);
  assert.equal((await pass("a2")).statusCode, 403);
  as(OWNER);
  assert.equal((await pass("a2")).statusCode, 200);
  assert.equal(mem.rows.gw_hr_ceo_decisions.length, 0, "OFF のときは確定記録を作らない（旧フロー）");
});

console.log("\n=== 7. 削除は契約の履歴があると止まる ===\n");

await ok("オファーの版がある応募者・社長判断の記録がある応募者は削除できない（409・理由つき）。無い人は消せる", async () => {
  setup(); as(OWNER); await pass("a1");
  as(RECRUITER);
  const r = await bulk({ ids: ["old1", "a1"], action: "delete" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "has_contract_history");
  const reasons = Object.fromEntries(r.body.blocked.map((b) => [b.id, b.reasons]));
  assert.ok(reasons.old1.includes("オファー・条件の版"));
  assert.ok(reasons.a1.includes("社長判断の記録"));
  assert.ok(applicant("old1") && applicant("a1"));
  assert.equal(mem.rows.gw_hr_offers.length, 1, "オファーは消えていない");
  const p = await bulk({ ids: ["plain"], action: "delete" });
  assert.equal(p.statusCode, 200);
  assert.ok(!applicant("plain"));
});

console.log("\n=== 8. 機能フラグ OFF ===\n");

await ok("OFF：詳細・一覧に新フローを出さず、新しい書き込みは断る", async () => {
  setup(); await readyA1();
  process.env.HR_OFFICE_INTAKE = "";
  as(HRP);
  const d = await get();
  assert.deepEqual(d.body.officeIntake, { enabled: false });
  assert.equal(d.body.applicant.officeIntake, null);
  assert.notEqual(d.body.applicant.statusLabel, "社長合格／条件ヒアリング待ち");
  const l = await list();
  assert.ok(!l.body.listTabs.some((t) => t.key === "office"));
  assert.equal(l.body.officeIntake.enabled, false);
  for (const action of ["saveHearing", "confirmHearing", "approveHearingException", "officeHandoff"]) {
    const r = await patch({ id: "a1", action, hearing: FULL, reason: "x", confirm: true });
    assert.equal(r.statusCode, 409, action);
    assert.equal(r.body.error, "intake_disabled", action);
  }
  assert.equal(mem.rows.gw_hr_office_intakes.length, 0);
});

console.log("\n=== 9. 別の会社 ===\n");

await ok("別の会社の人は、ヒアリング・確認・例外承認・引き渡しのどれもできない（404）", async () => {
  setup(); await readyA1();
  as(OTHER);
  for (const action of ["saveHearing", "confirmHearing", "approveHearingException", "officeHandoff"]) {
    const r = await patch({ id: "a1", action, hearing: FULL, reason: "x", confirm: true });
    assert.equal(r.statusCode, 404, `${action}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(mem.rows.gw_hr_office_intakes.length, 0);
  const g = await get("a1");
  assert.equal(g.statusCode, 404);
});
await ok("Office 担当は同じ会社の在籍者だけ", async () => {
  setup(); await readyA1(); as(RECRUITER);
  const r = await patch({ id: "a1", action: "officeHandoff", confirm: true, officeAssigneeId: "e-oth" });
  assert.equal(r.statusCode, 400);
  assert.equal(mem.rows.gw_hr_office_intakes.length, 0);
});

console.log(`\n合計 ${okN + ngN} 件中 ${okN} 件 通過`);
process.exit(ngN ? 1 : 0);
