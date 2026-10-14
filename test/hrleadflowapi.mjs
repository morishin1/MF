// 無限道場リード：TimeRex 連携と採用HRの一覧・詳細・次のアクション・通知先（STEP D・E・F）。
// 偽の Supabase（test/_memdb.mjs）に、本物の API・判定を通す。
//
// ■ 何を守るテストか
//   TimeRex
//     1. 無限道場の予約枠からの予約は、無限道場リードの中だけで探す（テナント＋区分＋小文字のメール）
//     2. 同じメールの採用応募者がいても、無限道場は無限道場へ、採用は採用へ付く（ambiguous にならない）
//     3. 探す順番：applicant_id → event_id → メール。予約枠と応募者の区分が違えば止める
//     4. 予約：scheduling → interview_scheduled。キャンセル：interview_scheduled → scheduling
//     5. 別テナントの同じメールのリードには付かない。テナント未設定なら止める
//   採用HR
//     6. 一覧の既定は採用だけ（ダッシュボードに混ぜない）。?category=mugendojo / all
//     7. db/118 未実行でも一覧・詳細は落ちない（リードの欄が出ないだけ）
//     8. 詳細に LP の情報・無限道場の予約URL・次のアクションの選択肢が出る
//     9. 次のアクション：stage / status が決まった値になり、タイムライン・監査ログに残る
//    10. 通知先（運営担当）の設定：在籍者だけ・置き換え・監査ログ
//    11. 面談後の次のアクションが未選択なら、cron がそれを知らせる（評価の催促はしない）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T1 = uid(1), T2 = uid(2);
const E_ME = uid(11), E_WATCH = uid(12), E_LEFT = uid(13), E_T2 = uid(14);
const A_MD = uid(101), A_REC = uid(102), A_MD_T2 = uid(103), A_MD2 = uid(104);

const nowIso = () => new Date().toISOString();
const mem = createMemDb({
  schema: {
    gw_hr_applicants: { defaults: () => ({ created_at: nowIso(), updated_at: nowIso() }) },
    gw_hr_interviews: { defaults: () => ({ created_at: nowIso() }) },
    gw_hr_timeline: { defaults: () => ({ occurred_at: nowIso() }) },
    gw_notifications: { unique: [["employee_id", "dedupe_key"]] },
    gw_hr_lead_watchers: { unique: [["tenant_id", "lead_category", "employee_id"]] },
  },
});

// db/118 未実行の再現：lead_category などの列を select すると 42703
const ctl = { noLeadColumns: false };
const wrap = (client) => ({
  from(name) {
    const q = client.from(name);
    if (name !== "gw_hr_applicants") return q;
    const sel = q.select.bind(q);
    q.select = (c, o) => {
      if (ctl.noLeadColumns && /lead_category/.test(String(c || ""))) {
        const fail = { data: null, error: { code: "42703", message: "column gw_hr_applicants.lead_category does not exist" } };
        const r = { maybeSingle: () => r, single: () => r, order: () => r, limit: () => r, eq: () => r, neq: () => r, in: () => r,
          then: (fn, rej) => Promise.resolve(fail).then(fn, rej) };
        return r;
      }
      return sel(c, o);
    };
    return q;
  },
});

const logged = [];
mock.module(atRoot("lib/supabase.js"), {
  // userClient も書き込める偽物にする（本物の RLS は採用HRの担当に読み書きを許している）
  namedExports: { admin: () => wrap(mem.admin()), userClient: () => wrap(mem.admin()) },
});
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const RECRUITER = { tenantId: T1, isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: E_ME, display_name: "採用 花子" } };
const SALES = { tenantId: T1, isAdmin: false, isHr: false, roles: ["sales"], employee: { id: uid(15) } };

process.env.TIMEREX_WEBHOOK_SECRET = "test-secret-value-long-enough";
process.env.TIMEREX_CASUAL_INTERVIEW_URL = "https://timerex.net/s/eight_hr/c0a1b2c3";
process.env.TIMEREX_MUGENDOJO_CASUAL_URL = "https://timerex.net/s/eight_md/md00aa11";
process.env.TIMEREX_CANCEL_WEBHOOK_TYPES = "event_cancelled";
process.env.HR_LEAD_TENANT_ID = T1;

const { default: webhook } = await import(atRoot("api/hr/timerex/webhook.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: watchersApi } = await import(atRoot("api/hr/lead-watchers.js"));
const { default: cronApi } = await import(atRoot("api/cron/hr-interviews.js"));
const { nextActionOf, shapeApplicant } = await import(atRoot("lib/hr.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (handler, req) => { const r = res(); await handler({ headers: {}, ...req }, r); return r; };
const hook = (body) => call(webhook, { method: "POST", headers: { "x-timerex-authorization": "test-secret-value-long-enough" }, body });

const confirmed = (over = {}, cal = "md00aa11") => ({
  webhook_type: "event_confirmed", calendar_url_path: cal,
  event: {
    id: "ev_md_1", start_datetime: "2026-10-10T05:00:00Z",
    google_meet_meeting: { join_url: "https://meet.google.com/abc-defg-hij" },
    form: [{ field_type: "guest_name", value: "山田 太郎" }, { field_type: "guest_email", value: "Taro@Example.jp" }],
    is_changed: false, old_event_id: null, ...over,
  },
});

const app = (id) => (mem.rows.gw_hr_applicants || []).find((a) => a.id === id);
const ivs = (id) => (mem.rows.gw_hr_interviews || []).filter((i) => i.applicant_id === id);
const tl = (id) => (mem.rows.gw_hr_timeline || []).filter((t) => t.applicant_id === id);

function setup() {
  mem.reset();
  logged.length = 0;
  ctl.noLeadColumns = false;
  who = RECRUITER;
  process.env.HR_LEAD_TENANT_ID = T1;
  mem.rows.gw_employees = [
    { id: E_ME, tenant_id: T1, display_name: "採用 花子", status: "active" },
    { id: E_WATCH, tenant_id: T1, display_name: "道場 運営", status: "active" },
    { id: E_LEFT, tenant_id: T1, display_name: "退職 済", status: "left" },
    { id: E_T2, tenant_id: T2, display_name: "別会社", status: "active" },
  ];
  mem.rows.gw_hr_applicants = [
    { id: A_MD, tenant_id: T1, name: "山田 太郎", email: "taro@example.jp", lead_category: "mugendojo",
      stage: "applied", status: "scheduling", source: "無限道場LP", job_title: "無限道場 カジュアル面談",
      utm_source: "instagram", utm_medium: "social", utm_campaign: "autumn",
      attribution: { first: { utm_source: "instagram", referrer: "https://www.instagram.com/" }, last: { utm_source: "instagram" } },
      lead_profile: { occupation: "会社員", ai_experience: "少し", it_experience: "未経験", interests: ["副業"],
        challenge_text: "AIでサービスを作りたい", diagnosis_label: "事業・サービスづくりタイプ" },
      last_contacted_at: "2026-10-01T00:00:00.000Z", lead_next_action: null, created_at: "2026-10-01T00:00:00.000Z" },
    { id: A_REC, tenant_id: T1, name: "山田 太郎", email: "Taro@Example.jp", lead_category: "recruitment",
      stage: "applied", status: "scheduling", source: "Wantedly", job_title: "エンジニア", created_at: "2026-09-30T00:00:00.000Z" },
    { id: A_MD_T2, tenant_id: T2, name: "別 会社", email: "other@example.jp", lead_category: "mugendojo",
      stage: "applied", status: "scheduling", created_at: "2026-09-29T00:00:00.000Z" },
  ];
  mem.rows.gw_hr_interviews = [];
  mem.rows.gw_hr_timeline = [];
  mem.rows.gw_hr_offers = [];
  mem.rows.gw_hr_lead_watchers = [];
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== TimeRex：無限道場の予約枠 ===\n");

await ok("無限道場の予約枠：同じメールの採用応募者がいても、無限道場リードに面談が付く", async () => {
  setup();
  const r = await hook(confirmed());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, "created");
  assert.equal(ivs(A_MD).length, 1);
  assert.equal(ivs(A_MD)[0].kind, "casual");
  assert.equal(ivs(A_REC).length, 0);
  assert.equal(app(A_MD).status, "interview_scheduled");
  assert.equal(app(A_MD).stage, "casual_interview");
  assert.equal(app(A_REC).status, "scheduling", "採用側は変えない");
  assert.ok(app(A_MD).last_contacted_at > "2026-10-01T00:00:00.000Z", "予約で最終接触日時が進む");
  assert.ok(tl(A_MD).some((t) => t.event_key === "interview_scheduled"));
});

await ok("採用の予約枠：同じメールの無限道場リードは候補から外れ、採用応募者に付く", async () => {
  setup();
  // 採用側も同じ綴りにする（外さなければ2人に当たって ambiguous になる）
  app(A_REC).email = "taro@example.jp";
  const r = await hook(confirmed({ id: "ev_rec_1", form: [{ field_type: "guest_email", value: "taro@example.jp" }] }, "c0a1b2c3"));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs(A_REC).length, 1);
  assert.equal(ivs(A_MD).length, 0);
  assert.equal(app(A_MD).status, "scheduling");
});

await ok("メールの大文字小文字が違っても、無限道場リードを見つける", async () => {
  setup();
  const r = await hook(confirmed({ form: [{ field_type: "guest_email", value: "  TARO@EXAMPLE.JP " }] }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs(A_MD).length, 1);
});

await ok("担当が「対応中（todo）」へ戻していても、予約で見つける", async () => {
  setup();
  app(A_MD).status = "todo";
  const r = await hook(confirmed());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(app(A_MD).status, "interview_scheduled");
});

await ok("探す順番：applicant_id が最優先（メールが違っても）", async () => {
  setup();
  mem.rows.gw_hr_applicants.push({ id: A_MD2, tenant_id: T1, name: "別人", email: "another@example.jp",
    lead_category: "mugendojo", stage: "applied", status: "scheduling" });
  const r = await hook({ ...confirmed(), applicant_id: A_MD2 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ivs(A_MD2).length, 1);
  assert.equal(ivs(A_MD).length, 0);
});

await ok("探す順番：同じ event_id の再送は、状態が進んだあとでも同じリードへ（増やさない）", async () => {
  setup();
  await hook(confirmed());
  const again = await hook(confirmed());
  assert.equal(again.statusCode, 200, JSON.stringify(again.body));
  assert.equal(again.body.action, "resynced");
  assert.equal(ivs(A_MD).length, 1);
});

await ok("無限道場の予約枠に採用応募者の applicant_id → 409 category_mismatch（反映しない）", async () => {
  setup();
  const r = await hook({ ...confirmed(), applicant_id: A_REC });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "category_mismatch");
  assert.equal(ivs(A_REC).length, 0);
});

await ok("採用の予約枠に無限道場リードの applicant_id → 409 category_mismatch", async () => {
  setup();
  const r = await hook({ ...confirmed({}, "c0a1b2c3"), applicant_id: A_MD });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "category_mismatch");
});

await ok("別テナントの同じメールのリードには付かない（404）", async () => {
  setup();
  const r = await hook(confirmed({ form: [{ field_type: "guest_email", value: "other@example.jp" }] }));
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "applicant_not_found");
  assert.equal(ivs(A_MD_T2).length, 0);
});

await ok("無限道場で同じメールが2人（データの食い違い）なら自動で決めない（409）", async () => {
  setup();
  mem.rows.gw_hr_applicants.push({ id: A_MD2, tenant_id: T1, name: "重複", email: "taro@example.jp",
    lead_category: "mugendojo", stage: "applied", status: "scheduling" });
  const r = await hook(confirmed());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "ambiguous_applicant");
});

await ok("HR_LEAD_TENANT_ID が未設定なら、無限道場の予約はメールで探さず 503", async () => {
  setup();
  process.env.HR_LEAD_TENANT_ID = "";
  const r = await hook(confirmed());
  process.env.HR_LEAD_TENANT_ID = T1;
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "lead_tenant_not_configured");
});

await ok("キャンセル：interview_scheduled → scheduling に戻る（面談は消さず canceled_at）", async () => {
  setup();
  await hook(confirmed());
  assert.equal(app(A_MD).status, "interview_scheduled");
  const r = await hook({ ...confirmed(), webhook_type: "event_cancelled" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, "canceled");
  assert.equal(app(A_MD).status, "scheduling");
  assert.ok(ivs(A_MD)[0].canceled_at);
  assert.ok(tl(A_MD).some((t) => t.event_key === "interview_canceled"));
});

await ok("予約枠の設定：TIMEREX_HR_CALENDARS の mugendojo_casual も無限道場として扱う", async () => {
  const { calendarProfile, kindForCalendar } = await import(atRoot("lib/hr-timerex-calendars.js"));
  const env = { TIMEREX_HR_CALENDARS: '{"zz11":"mugendojo_casual"}' };
  assert.deepEqual(calendarProfile("zz11", env), { kind: "casual", category: "mugendojo" });
  assert.equal(kindForCalendar("zz11", env), "casual");
  assert.deepEqual(calendarProfile("https://timerex.net/s/eight_md/md00aa11"), { kind: "casual", category: "mugendojo" });
  assert.deepEqual(calendarProfile("c0a1b2c3"), { kind: "casual", category: null });
});

console.log("\n=== 採用HR：一覧 ===\n");

await ok("一覧の既定は採用だけ（ダッシュボード・ファネルに無限道場を混ぜない）", async () => {
  setup();
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.applicants.map((a) => a.id), [A_REC]);
  assert.equal(r.body.category, "recruitment");
  assert.equal(r.body.leadReady, true);
});

await ok("?category=mugendojo は無限道場リードだけ（自分のテナントだけ）。流入・興味・診断・最終接触が付く", async () => {
  setup();
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants?category=mugendojo" });
  assert.deepEqual(r.body.applicants.map((a) => a.id), [A_MD]);
  const a = r.body.applicants[0];
  assert.equal(a.leadCategory, "mugendojo");
  assert.equal(a.leadCategoryLabel, "無限道場");
  assert.equal(a.utmSource, "instagram");
  assert.deepEqual(a.leadProfile.interests, ["副業"]);
  assert.equal(a.leadProfile.diagnosis_label, "事業・サービスづくりタイプ");
  assert.equal(a.lastContactedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(a.stageLabel, "新規リード");
  assert.equal(a.statusLabel, "日程調整中");
});

await ok("?category=all は両方。知らない区分は 400", async () => {
  setup();
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants?category=all" });
  assert.deepEqual(r.body.applicants.map((a) => a.id).sort(), [A_MD, A_REC].sort());
  const bad = await call(listApi, { method: "GET", url: "/api/hr/applicants?category=xx" });
  assert.equal(bad.statusCode, 400);
});

await ok("db/118 未実行：一覧は落ちない。採用・すべては全員、無限道場は0人・leadReady=false", async () => {
  setup();
  ctl.noLeadColumns = true;
  for (const a of mem.rows.gw_hr_applicants) delete a.lead_category;
  const rec = await call(listApi, { method: "GET", url: "/api/hr/applicants" });
  assert.equal(rec.statusCode, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.leadReady, false);
  assert.equal(rec.body.applicants.length, 2);
  const md = await call(listApi, { method: "GET", url: "/api/hr/applicants?category=mugendojo" });
  assert.equal(md.body.applicants.length, 0);
});

await ok("採用HRを使えない人は 403（一覧・通知先の設定）", async () => {
  setup();
  who = SALES;
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants?category=mugendojo" });
  assert.equal(r.statusCode, 403);
  const w = await call(watchersApi, { method: "GET", url: "/api/hr/lead-watchers" });
  assert.equal(w.statusCode, 403);
});

console.log("\n=== 採用HR：詳細・次のアクション ===\n");

await ok("詳細：LP の情報・無限道場の予約URL・次のアクションの選択肢", async () => {
  setup();
  const r = await call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${A_MD}` });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const a = r.body.applicant;
  assert.equal(a.leadCategory, "mugendojo");
  assert.equal(a.leadProfile.challenge_text, "AIでサービスを作りたい");
  assert.equal(a.attribution.first.referrer, "https://www.instagram.com/");
  assert.equal(r.body.schedulingUrl, `https://timerex.net/s/eight_md/md00aa11?applicant_id=${A_MD}`);
  assert.deepEqual(r.body.leadNextActions.map((x) => x.label),
    ["体験案内", "説明", "参加検討", "申込", "参加", "ENGER紹介", "別サービス紹介", "保留", "対象外"]);
  assert.equal(a.nextActionKey, "sendSchedulingLink");
});

await ok("詳細（採用）：予約URLは採用の予約枠・次のアクションは出さない", async () => {
  setup();
  const r = await call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${A_REC}` });
  assert.equal(r.body.schedulingUrl, `https://timerex.net/s/eight_hr/c0a1b2c3?applicant_id=${A_REC}`);
  assert.deepEqual(r.body.leadNextActions, []);
  assert.equal(r.body.applicant.stageLabel, "新規応募");
});

await ok("db/118 未実行でも詳細は開ける（採用として出す）", async () => {
  setup();
  ctl.noLeadColumns = true;
  const r = await call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${A_REC}` });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.leadReady, false);
});

const act = (nextAction, extra = {}) => call(detailApi, {
  method: "PATCH", url: "/api/hr/applicants/detail", body: { id: A_MD, action: "leadNextAction", nextAction, ...extra },
});

await ok("面談済 → 体験案内：stage=md_trial / status=todo、タイムライン・監査ログ", async () => {
  setup();
  app(A_MD).stage = "casual_interview"; app(A_MD).status = "eval_pending";
  const before = nextActionOf(app(A_MD));
  assert.equal(before.action, "leadNextAction");
  const r = await act("trial", { note: "来週の体験会を案内" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(app(A_MD).stage, "md_trial");
  assert.equal(app(A_MD).status, "todo");
  assert.equal(app(A_MD).lead_next_action, "trial");
  assert.equal(r.body.applicant.stageLabel, "体験案内");
  assert.equal(r.body.applicant.nextAction, "体験の案内を進めてください");
  const t = tl(A_MD).at(-1);
  assert.equal(t.event_key, "lead_next_trial");
  assert.equal(t.label, "次のアクション：体験案内");
  assert.equal(t.detail, "来週の体験会を案内");
  assert.equal(logged.at(-1).action, "hr.lead_next_action");
  assert.deepEqual(logged.at(-1).detail.to, { stage: "md_trial", status: "todo" });
});

await ok("参加検討 → 申込 → 参加 と進み、参加で完了になる", async () => {
  setup();
  for (const [k, stage, status] of [["considering", "md_considering", "todo"], ["apply", "md_applied", "todo"], ["join", "md_joined", "done"]]) {
    const r = await act(k);
    assert.equal(r.statusCode, 200, k);
    assert.equal(app(A_MD).stage, stage, k);
    assert.equal(app(A_MD).status, status, k);
  }
  assert.equal(nextActionOf(app(A_MD)).label, "対応は不要です");
});

await ok("保留：次の確認事項を残し、保留から再開したら decision を外す", async () => {
  setup();
  await act("hold", { note: "11月に再連絡" });
  assert.equal(app(A_MD).status, "next_scheduling_pending");
  assert.equal(app(A_MD).decision, "hold");
  assert.equal(app(A_MD).hold_next_step, "11月に再連絡");
  assert.equal(shapeApplicant(app(A_MD)).statusLabel, "保留");
  assert.equal(nextActionOf(app(A_MD)).label, "保留中：11月に再連絡");
  await act("explain");
  assert.equal(app(A_MD).decision, null);
  assert.equal(app(A_MD).status, "todo");
});

await ok("無限道場リードの保留・対象外は採用の判断ではない：本人への連絡状況（未連絡）は出さない", async () => {
  setup();
  await act("hold", { note: "11月に再連絡" });
  const d = await call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${A_MD}` });
  assert.equal(d.body.applicant.contact.state, "none");
  await act("not_target");
  const l = await call(listApi, { method: "GET", url: "/api/hr/applicants?category=mugendojo" });
  assert.equal(l.body.applicants[0].contact.state, "none");
});

await ok("対象外：status=passed（表示は「対象外」）。ENGER紹介・別サービス紹介は完了", async () => {
  setup();
  await act("not_target");
  assert.equal(app(A_MD).status, "passed");
  assert.equal(shapeApplicant(app(A_MD)).statusLabel, "対象外");
  await act("enger_referral");
  assert.equal(app(A_MD).status, "done");
  assert.equal(shapeApplicant(app(A_MD)).leadNextActionLabel, "ENGER紹介");
});

await ok("採用の応募者・知らないアクションには使えない（400）", async () => {
  setup();
  const rec = await call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail",
    body: { id: A_REC, action: "leadNextAction", nextAction: "trial" } });
  assert.equal(rec.statusCode, 400);
  assert.equal(rec.body.error, "not_lead");
  assert.equal(app(A_REC).stage, "applied");
  const bad = await act("unknown");
  assert.equal(bad.statusCode, 400);
});

await ok("別テナントのリードは動かせない（404）", async () => {
  setup();
  const r = await call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail",
    body: { id: A_MD_T2, action: "leadNextAction", nextAction: "trial" } });
  assert.equal(r.statusCode, 404);
  assert.equal(app(A_MD_T2).stage, "applied");
});

console.log("\n=== 通知先（運営担当）の設定 ===\n");

await ok("通知先を置き換える。在籍者だけ。監査ログに残る", async () => {
  setup();
  const put = await call(watchersApi, { method: "PUT", url: "/api/hr/lead-watchers",
    body: { category: "mugendojo", employeeIds: [E_WATCH, E_ME] } });
  assert.equal(put.statusCode, 200, JSON.stringify(put.body));
  const get = await call(watchersApi, { method: "GET", url: "/api/hr/lead-watchers?category=mugendojo" });
  assert.deepEqual(get.body.employeeIds.sort(), [E_ME, E_WATCH].sort());
  assert.ok(get.body.employees.some((e) => e.id === E_WATCH));
  const put2 = await call(watchersApi, { method: "PUT", url: "/api/hr/lead-watchers",
    body: { category: "mugendojo", employeeIds: [E_WATCH] } });
  assert.equal(put2.statusCode, 200);
  assert.deepEqual(mem.rows.gw_hr_lead_watchers.map((w) => w.employee_id), [E_WATCH]);
  assert.equal(logged.at(-1).action, "hr.lead_watchers_update");
});

await ok("退職者・別テナントの社員は通知先にできない（400）", async () => {
  setup();
  for (const id of [E_LEFT, E_T2]) {
    const r = await call(watchersApi, { method: "PUT", url: "/api/hr/lead-watchers",
      body: { category: "mugendojo", employeeIds: [id] } });
    assert.equal(r.statusCode, 400, id);
  }
  assert.equal(mem.rows.gw_hr_lead_watchers.length, 0);
});

console.log("\n=== cron：面談後の催促 ===\n");

await ok("無限道場：面談済で次のアクションが未選択なら「次のアクションが未選択」。選んだら送らない", async () => {
  setup();
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();
  app(A_MD).status = "eval_pending"; app(A_MD).recruiter_id = E_ME;
  mem.rows.gw_hr_interviews.push({ id: uid(201), tenant_id: T1, applicant_id: A_MD, kind: "casual",
    conducted_at: old, rank: null, interviewer_id: null });
  const r = await call(cronApi, { method: "GET", url: "/api/cron/hr-interviews" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const n = mem.rows.gw_notifications || [];
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "面談後の次のアクションが未選択です");
  assert.equal(n[0].employee_id, E_ME);

  mem.rows.gw_notifications = [];
  app(A_MD).lead_next_action = "trial"; app(A_MD).status = "todo";
  await call(cronApi, { method: "GET", url: "/api/cron/hr-interviews" });
  assert.equal((mem.rows.gw_notifications || []).length, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
