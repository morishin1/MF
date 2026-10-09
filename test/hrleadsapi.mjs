// 無限道場リード受付：POST /api/hr/leads を、偽の Supabase（test/_memdb.mjs）と本物の署名・保存処理で通す。
//
// ■ 何を守るテストか（無限道場LP → グループウェアHR リード連携 STEP C）
//   1. 署名（HMAC-SHA256）と時刻が正しいものだけを受け付ける。ブラウザから直接は通らない
//   2. 必須（氏名・メール・送信ID）とメールの形を確かめる。メールは小文字にそろえる
//   3. 同じ人（tenant + 無限道場 + メール）は1行。再送は更新、同じ送信IDは何もしない
//   4. 採用の応募者と同じメールでも統合しない（別の行・タイムラインに注記）
//   5. テナントは設定で固定。別テナントの同じメールとは混ざらない
//   6. タイムライン・通知（設定した運営担当／いなければ採用HRの担当）・監査ログ
//   7. レート制限（同じ人10分5回・テナント全体10分60件）
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
const E_WATCH = uid(11), E_HR = uid(12), E_LEFT = uid(13), E_OTHER = uid(14), E_T2 = uid(15);

const nowIso = () => new Date().toISOString();
const inSet = (v, set) => v === null || v === undefined || set.includes(v);
const schema = {
  gw_hr_applicants: {
    required: ["tenant_id", "name", "stage", "status", "lead_category"],
    defaults: () => ({ stage: "applied", status: "todo", lead_category: "recruitment", created_at: nowIso(), updated_at: nowIso() }),
    check: (r) => (!inSet(r.lead_category, ["recruitment", "mugendojo", "internship", "other"]) ? "lead_category"
      : !inSet(r.stage, ["applied", "casual_interview", "ceo_recommend", "ceo_interview", "offer", "joining_scheduled",
        "md_trial", "md_considering", "md_applied", "md_joined"]) ? "stage" : null),
  },
  gw_hr_timeline: { required: ["tenant_id", "applicant_id", "event_key", "label"], defaults: () => ({ occurred_at: nowIso() }) },
  gw_notifications: { unique: [["employee_id", "dedupe_key"]], required: ["tenant_id", "employee_id", "title"] },
};
const mem = createMemDb({ schema });

// 一意索引に負ける「同時送信」を作るための口：次の1回だけ、既存のリードが見つからないことにする
let hideNextLookup = false;
const adminWrapped = () => {
  const c = mem.admin();
  return {
    from(name) {
      const q = c.from(name);
      if (name !== "gw_hr_applicants") return q;
      const ilike = q.ilike.bind(q);
      q.ilike = (k, v) => {
        if (hideNextLookup) { hideNextLookup = false; return ilike(k, "__none__"); }
        return ilike(k, v);
      };
      // 一意索引（tenant, lower(email)) where lead_category = 'mugendojo' の代わり
      const insert = q.insert.bind(q);
      q.insert = (row) => {
        const r = Array.isArray(row) ? row[0] : row;
        if (r.lead_category === "mugendojo" && (mem.rows.gw_hr_applicants || []).some((x) =>
          x.tenant_id === r.tenant_id && x.lead_category === "mugendojo" && String(x.email).toLowerCase() === String(r.email).toLowerCase())) {
          return { select: () => ({ single: () => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }) }) };
        }
        return insert(row);
      };
      return q;
    },
  };
};

const logged = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: adminWrapped, userClient: () => mem.userClient(null) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

const SECRET = "test-lead-secret-0123456789abcdef";
process.env.MUGENDOJO_LEAD_SECRET = SECRET;
process.env.HR_LEAD_TENANT_ID = T1;
process.env.TIMEREX_MUGENDOJO_CASUAL_URL = "https://timerex.net/s/eight/md0001";

const { default: handler } = await import(atRoot("api/hr/leads.js"));
const { signLeadRequest, canonicalJson, PER_LEAD_LIMIT, NEW_LEAD_LIMIT } = await import(atRoot("lib/hr-leads.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const sec = () => Math.floor(Date.now() / 1000);
const signed = (body, { secret = SECRET, ts = sec() } = {}) => ({
  "x-lead-timestamp": String(ts), "x-lead-signature": signLeadRequest(secret, ts, body),
});
const call = async (body, headers = signed(body), method = "POST") => {
  const r = res();
  await handler({ method, headers, body }, r);
  return r;
};

let n = 0;
const lead = (over = {}) => ({
  submission_id: `sub-${String(++n).padStart(6, "0")}`,
  name: "山田 太郎", email: "taro@example.jp", phone: "",
  prefecture: "東京都", occupation: "会社員",
  ai_experience: "少し使ったことがある", it_experience: "未経験",
  interests: ["副業", "AIを仕事で活用"], challenge_text: "AIを使ったサービスを作りたい",
  diagnosis_type: "biz", diagnosis_label: "事業・サービスづくりタイプ",
  source_url: "https://mugendojo.jp/shindan", landing_page: "https://mugendojo.jp/?utm_source=instagram",
  referrer: "https://www.instagram.com/", utm_source: "instagram", utm_medium: "social", utm_campaign: "2026autumn",
  utm_content: "reel1", utm_term: "", first_touch_at: new Date(Date.now() - 3600_000).toISOString(),
  ...over,
});

const apps = () => mem.rows.gw_hr_applicants || [];
const mdApps = (t = T1) => apps().filter((a) => a.tenant_id === t && a.lead_category === "mugendojo");
const tl = (id) => (mem.rows.gw_hr_timeline || []).filter((t) => t.applicant_id === id);
const notes = () => mem.rows.gw_notifications || [];

function setup({ watchers = true } = {}) {
  mem.reset();
  logged.length = 0;
  hideNextLookup = false;
  mem.rows.gw_employees = [
    { id: E_WATCH, tenant_id: T1, status: "active" },
    { id: E_HR, tenant_id: T1, status: "active" },
    { id: E_LEFT, tenant_id: T1, status: "left" },
    { id: E_OTHER, tenant_id: T1, status: "active" },
    { id: E_T2, tenant_id: T2, status: "active" },
  ];
  mem.rows.gw_role_grants = [
    { tenant_id: T1, employee_id: E_HR, role: "hr" },
    { tenant_id: T1, employee_id: E_LEFT, role: "recruiter" },
    { tenant_id: T1, employee_id: E_OTHER, role: "sales" },
    { tenant_id: T2, employee_id: E_T2, role: "owner" },
  ];
  mem.rows.gw_hr_lead_watchers = watchers ? [{ tenant_id: T1, lead_category: "mugendojo", employee_id: E_WATCH }] : [];
  mem.rows.gw_hr_applicants = [];
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== 正常なリード登録 ===\n");

await ok("署名つきの正しいリードで、無限道場の応募者が1件できる", async () => {
  setup();
  const r = await call(lead());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.result, "created");
  const a = mdApps();
  assert.equal(a.length, 1);
  assert.equal(r.body.applicantId, a[0].id);
  assert.equal(a[0].tenant_id, T1);
  assert.equal(a[0].lead_category, "mugendojo");
  assert.equal(a[0].stage, "applied");
  assert.equal(a[0].status, "scheduling");
  assert.equal(a[0].source, "無限道場LP");
  assert.equal(a[0].phone, null, "空の電話は null（必須にしない）");
});

await ok("UTM・流入元・診断・興味が残る", async () => {
  setup();
  await call(lead());
  const a = mdApps()[0];
  assert.equal(a.utm_source, "instagram");
  assert.equal(a.utm_medium, "social");
  assert.equal(a.utm_campaign, "2026autumn");
  assert.equal(a.attribution.first.utm_content, "reel1");
  assert.equal(a.attribution.first.referrer, "https://www.instagram.com/");
  assert.equal(a.attribution.first.landing_page, "https://mugendojo.jp/?utm_source=instagram");
  assert.equal(a.attribution.last.source_url, "https://mugendojo.jp/shindan");
  assert.equal(a.attribution.lead_type, "mugendojo_casual");
  assert.equal(a.attribution.source_type, "mugendojo");
  assert.ok(!("utm_term" in a.attribution.last), "空の UTM は残さない");
  assert.ok(Date.parse(a.attribution.first.at) < Date.now() - 3000_000, "初回接触は first_touch_at");
  assert.deepEqual(a.lead_profile.interests, ["副業", "AIを仕事で活用"]);
  assert.equal(a.lead_profile.diagnosis_type, "biz");
  assert.equal(a.lead_profile.ai_experience, "少し使ったことがある");
  assert.equal(a.lead_profile.occupation, "会社員");
  assert.ok(a.last_contacted_at);
});

await ok("タイムラインに「申込」が1件、流入の1行つき（個人情報は入れない）", async () => {
  setup();
  const r = await call(lead());
  const t = tl(r.body.applicantId);
  assert.equal(t.length, 1);
  assert.equal(t[0].event_key, "applied");
  assert.match(t[0].label, /無限道場LP/);
  assert.equal(t[0].detail, "流入: instagram / social / 2026autumn");
  assert.ok(!JSON.stringify(t).includes("taro@example.jp"));
});

await ok("監査ログ（hr.lead_intake）が残り、メール・氏名は入らない", async () => {
  setup();
  const r = await call(lead());
  assert.equal(logged.length, 1);
  assert.equal(logged[0].action, "hr.lead_intake");
  assert.equal(logged[0].tenantId, T1);
  assert.equal(logged[0].target, `hr_applicant:${r.body.applicantId}`);
  assert.equal(logged[0].detail.result, "created");
  assert.equal(logged[0].detail.utmSource, "instagram");
  const s = JSON.stringify(logged);
  assert.ok(!s.includes("taro@example.jp") && !s.includes("山田"));
});

await ok("予約URLに応募者IDが付いて返る（無限道場の予約枠）", async () => {
  setup();
  const r = await call(lead());
  assert.equal(r.body.schedulingUrl, `https://timerex.net/s/eight/md0001?applicant_id=${r.body.applicantId}`);
});

console.log("\n=== 通知 ===\n");

await ok("設定した運営担当にだけ「無限道場の新しいカジュアル面談リード」が届く", async () => {
  setup();
  const r = await call(lead());
  const ns = notes();
  assert.equal(ns.length, 1, JSON.stringify(ns));
  assert.equal(ns[0].employee_id, E_WATCH);
  assert.equal(ns[0].kind, "hr");
  assert.equal(ns[0].title, "無限道場の新しいカジュアル面談リードが入りました");
  assert.equal(ns[0].dedupe_key, `hr_lead:${r.body.applicantId}`);
  assert.match(ns[0].link, /category=mugendojo/);
});

await ok("運営担当が未設定なら、採用HRの担当（経営者・人事・採用担当）へ。退職者・他ロールには送らない", async () => {
  setup({ watchers: false });
  await call(lead());
  const to = notes().map((x) => x.employee_id).sort();
  assert.deepEqual(to, [E_HR]);
});

await ok("通知先の表（db/118）が無くても、採用HRの担当へ届く", async () => {
  setup();
  delete mem.rows.gw_hr_lead_watchers;
  mem.state.missing = "gw_hr_lead_watchers";
  const r = await call(lead());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(notes().map((x) => x.employee_id), [E_HR]);
});

console.log("\n=== 署名・時刻 ===\n");

await ok("署名が違えば 401（何も保存しない）", async () => {
  setup();
  const body = lead();
  const r = await call(body, signed(body, { secret: "other-secret" }));
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, "unauthorized");
  assert.equal(apps().length, 0);
});

await ok("署名ヘッダーが無ければ 401（ブラウザから直接送った場合）", async () => {
  setup();
  const r = await call(lead(), {});
  assert.equal(r.statusCode, 401);
  assert.equal(apps().length, 0);
});

await ok("署名のあとで本文を書き換えたら 401", async () => {
  setup();
  const body = lead();
  const h = signed(body);
  const r = await call({ ...body, email: "evil@example.jp" }, h);
  assert.equal(r.statusCode, 401);
});

await ok("時刻が5分を超えて古い・未来なら 401 timestamp_out_of_range", async () => {
  setup();
  const body = lead();
  const old = await call(body, signed(body, { ts: sec() - 301 }));
  assert.equal(old.statusCode, 401);
  assert.equal(old.body.error, "timestamp_out_of_range");
  const future = await call(body, signed(body, { ts: sec() + 301 }));
  assert.equal(future.body.error, "timestamp_out_of_range");
  assert.equal(apps().length, 0);
});

await ok("キーの順番が違っても、同じ内容なら署名は通る（canonicalJson）", async () => {
  setup();
  const body = lead();
  const h = signed(body);
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(canonicalJson(reordered), canonicalJson(body));
  const r = await call(reordered, h);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("鍵・テナントが未設定なら 503（どこへ入れるか推測しない）", async () => {
  setup();
  process.env.HR_LEAD_TENANT_ID = "";
  const r1 = await call(lead());
  process.env.HR_LEAD_TENANT_ID = T1;
  process.env.MUGENDOJO_LEAD_SECRET = "";
  const r2 = await call(lead());
  process.env.MUGENDOJO_LEAD_SECRET = SECRET;
  assert.equal(r1.statusCode, 503);
  assert.equal(r2.statusCode, 503);
  assert.equal(apps().length, 0);
});

await ok("POST 以外は 405", async () => {
  setup();
  const r = await call(lead(), {}, "GET");
  assert.equal(r.statusCode, 405);
});

console.log("\n=== 入力 ===\n");

await ok("氏名・メール・送信IDが無ければ 400（項目名つき）", async () => {
  setup();
  for (const [over, field] of [[{ name: "  " }, "name"], [{ email: "" }, "email"], [{ submission_id: "" }, "submission_id"]]) {
    const r = await call(lead(over));
    assert.equal(r.statusCode, 400, field);
    assert.equal(r.body.field, field);
  }
  assert.equal(apps().length, 0);
});

await ok("メールの形が違えば 400", async () => {
  setup();
  for (const email of ["taro", "taro@", "taro@example", "a b@example.jp"]) {
    const r = await call(lead({ email }));
    assert.equal(r.statusCode, 400, email);
    assert.equal(r.body.field, "email");
  }
});

await ok("電話番号の形が違えば 400。空なら通す", async () => {
  setup();
  const bad = await call(lead({ phone: "<script>" }));
  assert.equal(bad.statusCode, 400);
  const good = await call(lead({ phone: "090-1234-5678" }));
  assert.equal(good.statusCode, 200);
  assert.equal(mdApps()[0].phone, "090-1234-5678");
});

await ok("メールは小文字・前後の空白なしで保存する", async () => {
  setup();
  await call(lead({ email: "  Taro@Example.JP " }));
  assert.equal(mdApps()[0].email, "taro@example.jp");
});

await ok("http(s) 以外の URL は保存しない", async () => {
  setup();
  await call(lead({ referrer: "javascript:alert(1)", source_url: "ftp://x" }));
  const a = mdApps()[0];
  assert.ok(!("referrer" in a.attribution.first));
  assert.ok(!("source_url" in a.attribution.first));
});

console.log("\n=== 重複 ===\n");

await ok("同じメールで再送しても1行。興味は足し合わせ、最新の流入・最終接触日時に更新", async () => {
  setup();
  const first = await call(lead({ interests: ["副業"] }));
  const before = mdApps()[0].last_contacted_at;
  await new Promise((r) => setTimeout(r, 5));
  const again = await call(lead({ email: "TARO@example.jp", interests: ["転職"], utm_source: "google", utm_medium: "cpc",
    utm_campaign: "", diagnosis_type: "career", challenge_text: "" }));
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.result, "updated");
  assert.equal(again.body.applicantId, first.body.applicantId);
  const a = mdApps();
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].lead_profile.interests, ["副業", "転職"]);
  assert.equal(a[0].lead_profile.diagnosis_type, "career", "診断は最新");
  assert.equal(a[0].lead_profile.challenge_text, "AIを使ったサービスを作りたい", "空では消さない");
  assert.equal(a[0].utm_source, "instagram", "列は最初の流入のまま");
  assert.equal(a[0].attribution.last.utm_source, "google", "最新の流入は last");
  assert.equal(a[0].attribution.first.utm_source, "instagram");
  assert.equal(a[0].attribution.touches, 2);
  assert.ok(a[0].last_contacted_at > before);
  const t = tl(a[0].id).map((x) => x.event_key);
  assert.deepEqual(t, ["applied", "lead_resubmitted"]);
});

await ok("再送では通知を積み上げず、同じ通知を最新にして未読へ戻す", async () => {
  setup();
  await call(lead());
  notes()[0].read_at = nowIso();
  await call(lead());
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].read_at, null);
  assert.match(notes()[0].title, /再度申込/);
});

await ok("同じ送信IDの再送は何も変えない（replayed・タイムライン・監査ログも増えない）", async () => {
  setup();
  const body = lead();
  await call(body);
  const r = await call(body);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.result, "replayed");
  assert.equal(mdApps().length, 1);
  assert.equal(tl(r.body.applicantId).length, 1);
  assert.equal(logged.length, 1);
});

await ok("見送り済みのリードが再送しても、状態は変えずにタイムラインへ残す", async () => {
  setup();
  const r = await call(lead());
  mdApps()[0].status = "passed";
  await call(lead());
  assert.equal(mdApps()[0].status, "passed");
  assert.match(tl(r.body.applicantId).at(-1).label, /状態は変えていません/);
});

await ok("同時に2回送られて一意索引に負けても、新しく作らず更新に回る", async () => {
  setup();
  await call(lead());
  hideNextLookup = true;
  const r = await call(lead());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "updated");
  assert.equal(mdApps().length, 1);
});

await ok("採用の応募者と同じメールでも統合しない（別の行・タイムラインに注記・採用側は変えない）", async () => {
  setup();
  mem.rows.gw_hr_applicants.push({ id: uid(90), tenant_id: T1, name: "山田 太郎", email: "Taro@Example.jp",
    lead_category: "recruitment", stage: "casual_interview", status: "interview_scheduled", source: "Wantedly" });
  const r = await call(lead());
  assert.equal(r.body.result, "created");
  assert.equal(apps().length, 2);
  const rec = apps().find((a) => a.id === uid(90));
  assert.equal(rec.status, "interview_scheduled");
  assert.equal(rec.lead_category, "recruitment");
  assert.ok(tl(r.body.applicantId).some((t) => t.event_key === "lead_same_email" && /採用/.test(t.detail)));
  assert.equal(tl(uid(90)).length, 0);
});

console.log("\n=== テナント分離 ===\n");

await ok("別テナントに同じメールの無限道場リードがあっても、設定したテナントに新しく作る", async () => {
  setup();
  mem.rows.gw_hr_applicants.push({ id: uid(91), tenant_id: T2, name: "別会社", email: "taro@example.jp",
    lead_category: "mugendojo", stage: "applied", status: "scheduling", attribution: { submission_ids: [] } });
  const r = await call(lead());
  assert.equal(r.body.result, "created");
  assert.notEqual(r.body.applicantId, uid(91));
  assert.equal(mdApps(T1).length, 1);
  assert.equal(mdApps(T2)[0].name, "別会社");
  assert.ok(!notes().some((x) => x.employee_id === E_T2), "別テナントの人には通知しない");
});

await ok("本文に tenant_id を入れても無視する（設定が正）", async () => {
  setup();
  await call(lead({ tenant_id: T2 }));
  assert.equal(mdApps(T1).length, 1);
  assert.equal(mdApps(T2).length, 0);
});

console.log("\n=== レート制限 ===\n");

await ok(`同じ人から10分に${PER_LEAD_LIMIT.max}回を超えたら 429`, async () => {
  setup();
  for (let i = 0; i < PER_LEAD_LIMIT.max; i++) {
    const r = await call(lead());
    assert.equal(r.statusCode, 200, `${i}: ${JSON.stringify(r.body)}`);
  }
  const over = await call(lead());
  assert.equal(over.statusCode, 429);
  assert.equal(over.body.error, "rate_limited");
});

await ok(`テナント全体で10分に${NEW_LEAD_LIMIT.max}件を超える新規は 429`, async () => {
  setup();
  for (let i = 0; i < NEW_LEAD_LIMIT.max; i++) {
    mem.rows.gw_hr_applicants.push({ id: uid(1000 + i), tenant_id: T1, name: `x${i}`, email: `x${i}@example.jp`,
      lead_category: "mugendojo", stage: "applied", status: "scheduling", created_at: nowIso() });
  }
  const r = await call(lead({ email: "new@example.jp" }));
  assert.equal(r.statusCode, 429);
});

console.log("\n=== 講師・メンター応募（lead_type = mugendojo_instructor）===\n");

const CASUAL_URL = "https://timerex.net/s/eight/cas001";
const inst = (over = {}) => ({
  submission_id: `ins-${String(++n).padStart(6, "0")}`,
  lead_type: "mugendojo_instructor",
  name: "講師 花子", email: "hanako@example.jp",
  occupation: "株式会社テスト 代表 / AI・DX支援", company: "株式会社テスト",
  specialties: ["生成AI", "DX", "生成AI"], career_text: "自治体向けDX支援・AI研修",
  motivation_text: "挑戦する人を支えたい", teaching_experience: "社内研修の講師 3年",
  availability: "平日夜・土曜", work_styles: ["オンライン", "対面", "ほか"],
  profile_url: "https://example.jp/hanako", website_url: "javascript:alert(1)", note_text: "よろしくお願いします",
  source_url: "https://mugendojo.jp/instructors/recruit", utm_source: "column", utm_medium: "referral",
  ...over,
});
const recApps = (t = T1) => apps().filter((a) => a.tenant_id === t && a.lead_category === "recruitment");

await ok("講師応募は採用（recruitment）の応募者として入る：募集職種「無限道場 講師・メンター」・応募経路「無限道場HP」", async () => {
  setup();
  process.env.TIMEREX_CASUAL_INTERVIEW_URL = CASUAL_URL;
  const r = await call(inst());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, "created");
  const a = recApps();
  assert.equal(a.length, 1);
  assert.equal(mdApps().length, 0, "無料カウンセリング（無限道場）の区分には入れない");
  assert.equal(a[0].job_title, "無限道場 講師・メンター");
  assert.equal(a[0].source, "無限道場HP");
  assert.equal(a[0].stage, "applied");
  assert.equal(a[0].status, "scheduling");
  assert.equal(a[0].profile_url, "https://example.jp/hanako");
  assert.equal(a[0].attribution.lead_type, "mugendojo_instructor");
  const p = a[0].lead_profile;
  assert.equal(p.kind, "instructor");
  assert.deepEqual(p.specialties, ["生成AI", "DX"], "重複は除く");
  assert.deepEqual(p.work_styles, ["オンライン", "対面"], "決まった値だけ");
  assert.equal(p.website_url, undefined, "http(s) 以外のURLは保存しない");
  assert.equal(p.career_text, "自治体向けDX支援・AI研修");
  assert.equal(p.motivation_text, "挑戦する人を支えたい");
  assert.equal(p.interests, undefined, "講師応募は興味の欄を持たない");
  assert.equal(r.body.schedulingUrl, `${CASUAL_URL}?applicant_id=${a[0].id}`, "採用のカジュアル面談の予約枠＋応募者ID");
  assert.ok(tl(a[0].id).some((t) => t.event_key === "applied" && t.label === "無限道場HPから講師・メンターに応募"));
  const nt = notes().filter((x) => x.dedupe_key === `hr_lead:${a[0].id}`);
  assert.ok(nt.length >= 1 && nt.every((x) => x.title === "無限道場HPから講師・メンターの応募が入りました"));
  assert.ok(nt.every((x) => x.link.includes("category=recruitment")));
  assert.ok(nt.some((x) => x.employee_id === E_HR) && !nt.some((x) => x.employee_id === E_WATCH), "無料カウンセリングの通知先ではなく、採用HRの担当へ");
  assert.equal(logged.at(-1).detail.leadType, "mugendojo_instructor");
  assert.equal(logged.at(-1).detail.category, "recruitment");
  assert.ok(!JSON.stringify(logged).includes("hanako@example.jp"), "監査ログにメールを残さない");
});

await ok("講師応募の必須（現在の仕事・専門分野・経歴・応募理由）が無ければ 400（field 付き）", async () => {
  setup();
  for (const [k, v] of [["occupation", ""], ["specialties", []], ["career_text", " "], ["motivation_text", ""]]) {
    const r = await call(inst({ [k]: v }));
    assert.equal(r.statusCode, 400, k);
    assert.equal(r.body.field, k);
  }
  const bad = await call(inst({ email: "not-an-email" }));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.field, "email");
  assert.equal(recApps().length, 0);
});

await ok("同じメールで講師に再応募：1人のまま更新・タイムラインに再送信（同じ送信IDは何もしない）", async () => {
  setup();
  const first = await call(inst());
  const again = await call(inst({ email: "HANAKO@example.jp", specialties: ["システム開発"], career_text: "追記した経歴" }));
  assert.equal(again.body.result, "updated");
  assert.equal(again.body.applicantId, first.body.applicantId);
  assert.equal(recApps().length, 1);
  const a = recApps()[0];
  assert.deepEqual(a.lead_profile.specialties, ["システム開発"], "最新の応募内容");
  assert.equal(a.lead_profile.career_text, "追記した経歴");
  assert.equal(a.lead_profile.motivation_text, "挑戦する人を支えたい", "空で消さない");
  assert.ok(tl(a.id).some((t) => t.event_key === "lead_resubmitted" && t.label.startsWith("無限道場HPから再送信")));
  const body = inst();
  const r1 = await call(body);
  const r2 = await call(body);
  assert.equal(r2.body.result, "replayed");
  assert.equal(r1.body.applicantId, r2.body.applicantId);
});

await ok("採用の別の職種・無料カウンセリングに同じメールがいても統合しない（別の行・注記）", async () => {
  setup();
  mem.rows.gw_hr_applicants.push({ id: uid(81), tenant_id: T1, name: "講師 花子", email: "hanako@example.jp",
    lead_category: "recruitment", job_title: "営業職", stage: "applied", status: "todo", created_at: nowIso() });
  await call(lead({ email: "hanako@example.jp" }));      // 無料カウンセリング
  const r = await call(inst());
  assert.equal(r.body.result, "created");
  assert.notEqual(r.body.applicantId, uid(81));
  assert.equal(recApps().length, 2);
  assert.equal(mdApps().length, 1);
  const note = tl(r.body.applicantId).find((t) => t.event_key === "lead_same_email");
  assert.ok(note, "同じメールの応募者がいることを残す");
  assert.match(note.detail, /営業職/);
  assert.match(note.detail, /無限道場/);
});

await ok("講師に応募した人が無料カウンセリングにも申し込んだら、無限道場の区分に別に入る（講師応募は変えない）", async () => {
  setup();
  const i = await call(inst());
  const c = await call(lead({ email: "hanako@example.jp" }));
  assert.equal(c.body.result, "created");
  assert.notEqual(c.body.applicantId, i.body.applicantId);
  assert.equal(mdApps().length, 1);
  assert.equal(recApps()[0].job_title, "無限道場 講師・メンター");
});

await ok("採用の予約枠が未設定なら schedulingUrl は null（応募は登録する）", async () => {
  setup();
  delete process.env.TIMEREX_CASUAL_INTERVIEW_URL;
  const r = await call(inst());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.schedulingUrl, null);
  assert.equal(recApps().length, 1);
});

await ok("lead_type が無い・知らない値は、従来どおり無料カウンセリング（後方互換）", async () => {
  setup();
  const a = await call(lead());
  const b = await call(lead({ email: "other@example.jp", lead_type: "something_else" }));
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(mdApps().length, 2);
  assert.equal(recApps().length, 0);
  assert.equal(a.body.schedulingUrl.startsWith("https://timerex.net/s/eight/md0001"), true, "無限道場の予約枠のまま");
});

await ok("署名は lms 側（src/lib/hr-lead-sign.ts）と同じ値になる（互換の確認用の値）", async () => {
  const body = { submission_id: "manual-0001", name: "テスト 太郎", email: "test@example.jp", utm_source: "manual" };
  assert.equal(signLeadRequest("x".repeat(40), 1790000000, body), "v1=9802e68862c1863fff64eb2c918a2eadc22ad2dc3ed521d48bf566e371602bd9");
});

console.log("\n=== DB未準備 ===\n");

await ok("db/118 未実行（lead_category 列が無い）なら 503 not_ready で、SQL名を返す", async () => {
  setup();
  mem.state.missing = { table: "gw_hr_applicants", column: "lead_category" };
  const r = await call(lead());
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "not_ready");
  assert.match(r.body.message, /db\/118_hr_leads\.sql/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
