// 給与を、見られない人に出さない・書かせない（段階1）。採用HR側の API。
//
// ■ 何を守るテストか
//
//   給与（応募者・内定の wageType / wageAmount）は、見られる人にだけ返す。
//     ・見られない … 採用担当（recruiter）。応答にキーが無い。書き込みも無視される
//     ・見られる   … 人事（hr）・会計の管理者・経営者（段階1）。これまでどおり
//     ・段階2（SALARY_OWNER_ONLY=1）… 経営者だけ。人事・管理者にも出ない
//   採用担当が給与を見られなくても、合格通知は作れる。応募者に入っている条件は、
//   サーバ側でそのまま引き継ぐ（本人には、合格通知どおりの条件が届く）。
//   見えていない値を、採用担当が保存して null で上書きしてしまう事故も起きない。
//
//   判定そのもの（canSeeSalary）の表と、応答から給与を外す部品（lib/salary.js）も、ここで確かめる。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : -1));
    return out;
  };
  const copy = (r) => (r ? { ...r } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order(col) { order = col; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        select: () => r2, single: () => apply(), maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async () => {} } });

const ctxOf = (roles, extra = {}) => ({
  tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: false, roles,
  employee: { id: `emp-${roles[0] || "x"}`, display_name: roles[0] || "x" }, ...extra,
});
const RECRUITER = ctxOf(["recruiter"]);
const HR = ctxOf(["hr"]);
const OWNER = ctxOf(["owner"]);
// 採用判断ができる管理者（canDecideHire = 採用HRを使える ∧ 管理者）。ここでは採用担当を兼ねる管理者
const ADMIN_RECRUITER = ctxOf(["recruiter"], { isAdmin: true });
let who = RECRUITER;

// 判定は本物（lib/gw.js）を使う。テストで条件を書き直すと、本番とずれても気づけない
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: applicants } = await import(atRoot("api/hr/applicants/index.js"));
const { default: detail } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: offers } = await import(atRoot("api/hr/offers/index.js"));
const { default: ceoReview } = await import(atRoot("api/hr/ceo-review.js"));
const { default: advance } = await import(atRoot("api/hr/applicants/advance.js"));
const SAL = await import(atRoot("lib/salary.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const list = () => call(applicants, { method: "GET", url: "/api/hr/applicants" });
const create = (body) => call(applicants, { method: "POST", url: "/api/hr/applicants", body });
const getOne = (id) => call(detail, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const patch = (body) => call(detail, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const mkOffer = (body) => call(offers, { method: "POST", url: "/api/hr/offers", body });
const offerAct = (body) => call(offers, { method: "PATCH", url: "/api/hr/offers", body });
const review = () => call(ceoReview, { method: "GET", url: "/api/hr/ceo-review" });
const prefill = (id) => call(advance, { method: "GET", url: `/api/hr/applicants/advance?applicantId=${id}` });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
  finally { delete process.env.SALARY_OWNER_ONLY; }
};
const hasWage = (o) => o && ("wageType" in o || "wageAmount" in o);

function setup() {
  who = RECRUITER;
  delete process.env.SALARY_OWNER_ONLY;
  db.rows = {
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", stage: "offer", status: "offer_draft_pending",
        rank: "A", decision: "hired", employment_type: "正社員", contract_type: "無期", join_date: "2026-11-01",
        probation_months: 3, wage_type: "月給", wage_amount: 400000, weekly_hours: 40, work_location: "東京",
        created_at: "2026-09-20T00:00:00Z" },
      { id: "a2", tenant_id: "t1", name: "推薦された人", job_title: "営業", stage: "ceo_recommend", status: "ceo_interview_pending",
        rank: "A", decision: null, wage_type: "月給", wage_amount: 350000, created_at: "2026-09-21T00:00:00Z" },
      { id: "a3", tenant_id: "t1", name: "承諾済みの人", job_title: "エンジニア", stage: "offer", status: "accepted",
        decision: "hired", join_date: "2026-11-01", wage_type: "月給", wage_amount: 380000, created_at: "2026-09-22T00:00:00Z" },
    ],
    gw_hr_interviews: [], gw_hr_timeline: [], gw_hr_offers: [], gw_employees: [], gw_hr_documents: [],
  };
}

console.log("\n=== 判定（canSeeSalary） ===\n");

await ok("段階1: 経営者・人事・管理者は見られる。採用担当・責任者・経理・IT・営業・一般は見られない", async () => {
  const yes = [OWNER, HR, ctxOf([], { isAdmin: true }), ctxOf(["owner", "recruiter"])];
  const no = [RECRUITER, ctxOf(["manager"]), ctxOf(["finance"]), ctxOf(["it"]), ctxOf(["sales"]), ctxOf([]),
    ctxOf(["labor_advisor"], { isAdvisor: true })];
  for (const c of yes) assert.equal(REAL_GW.canSeeSalary(c), true, JSON.stringify(c.roles));
  for (const c of no) assert.equal(REAL_GW.canSeeSalary(c), false, JSON.stringify(c.roles));
});

await ok("段階2（SALARY_OWNER_ONLY=1）: 経営者だけ。人事・管理者も見られない", async () => {
  process.env.SALARY_OWNER_ONLY = "1";
  assert.equal(REAL_GW.canSeeSalary(OWNER), true);
  assert.equal(REAL_GW.canSeeSalary(HR), false);
  assert.equal(REAL_GW.canSeeSalary(ctxOf([], { isAdmin: true })), false);
  assert.equal(REAL_GW.canSeeSalary(RECRUITER), false);
});

await ok("責任者・採用担当は、経営者の権限を継承しない（isOwner / canKeiei は経営者だけ）", async () => {
  for (const c of [HR, RECRUITER, ctxOf(["manager"]), ctxOf(["finance"]), ctxOf([], { isAdmin: true })]) {
    assert.equal(REAL_GW.isOwner(c), false);
    assert.equal(REAL_GW.canKeiei(c), false);
  }
  assert.equal(REAL_GW.canKeiei(OWNER), true);
});

console.log("\n=== 部品（lib/salary.js） ===\n");

await ok("応答から、入れ子・配列の中まで給与のキーを外す。ほかのキーは残す", async () => {
  const out = SAL.redactSalary({
    a: 1, wageAmount: 300000, currentWage: { wageType: "月給" },
    list: [{ id: "x", salary_min: 1, salary_note: "n", name: "山田" }],
    levels: [{ salaryMin: 200000, salaryMax: 300000, levelName: "L1" }],
    labels: { salaryDecisions: { none: "なし" } },
  });
  assert.deepEqual(out, { a: 1, list: [{ id: "x", name: "山田" }], levels: [{ levelName: "L1" }], labels: { salaryDecisions: { none: "なし" } } });
});

await ok("入力から給与のキーを外す（元は変えない）", async () => {
  const body = { id: "a1", wageAmount: 1, wage_type: "x", name: "山田" };
  const out = SAL.dropSalaryInput(body);
  assert.deepEqual(out, { id: "a1", name: "山田" });
  assert.equal(body.wageAmount, 1);
});

await ok("select の列名から、給与の列だけを外す", async () => {
  assert.equal(SAL.withoutColumns("id, name, wage_type, wage_amount, weekly_hours"), "id, name, weekly_hours");
});

console.log("\n=== 応募者（GET/POST/PATCH /api/hr/applicants） ===\n");

await ok("採用担当には、一覧に給与が返らない。画面には出さないよう伝える", async () => {
  setup(); who = RECRUITER;
  const r = await list();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.applicants.length, 3);
  for (const a of r.body.applicants) assert.equal(hasWage(a), false, a.name);
  assert.equal(r.body.salaryVisible, false);
  assert.ok(!JSON.stringify(r.body).includes("400000"), "金額そのものが、どこにも出ていない");
});

await ok("人事・管理者・経営者には、これまでどおり給与が返る", async () => {
  for (const c of [HR, OWNER, ctxOf(["recruiter"], { isAdmin: true })]) {
    setup(); who = c;
    const r = await list();
    const a1 = r.body.applicants.find((a) => a.id === "a1");
    assert.equal(a1.wageAmount, 400000, JSON.stringify(c.roles));
    assert.equal(r.body.salaryVisible, true);
  }
});

await ok("段階2では、人事・管理者にも給与が返らない。経営者には返る", async () => {
  process.env.SALARY_OWNER_ONLY = "1";
  setup(); process.env.SALARY_OWNER_ONLY = "1";
  who = HR;
  assert.equal(hasWage((await list()).body.applicants[0]), false);
  who = ctxOf(["recruiter"], { isAdmin: true });
  assert.equal(hasWage((await list()).body.applicants[0]), false);
  who = OWNER;
  assert.equal((await list()).body.applicants.find((a) => a.id === "a1").wageAmount, 400000);
});

await ok("採用担当が応募者を開いても、給与（応募者・内定の版）が返らない", async () => {
  setup(); who = HR;
  db.rows.gw_hr_offers = [{ id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, wage_type: "月給", wage_amount: 400000,
    job_title: "エンジニア", expires_at: "2099-01-01T00:00:00Z", created_at: "2026-09-25T00:00:00Z" }];
  let r = await getOne("a1");
  assert.equal(r.body.applicant.wageAmount, 400000);
  assert.equal(r.body.offers[0].wageAmount, 400000);
  who = RECRUITER;
  r = await getOne("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(hasWage(r.body.applicant), false);
  assert.equal(hasWage(r.body.offers[0]), false);
  assert.equal(r.body.salaryVisible, false);
  assert.ok(!JSON.stringify(r.body).includes("400000"));
});

await ok("採用担当が応募者を追加しても、給与は書き込まれない", async () => {
  setup(); who = RECRUITER;
  const r = await create({ name: "新規 花子", jobTitle: "営業", source: "リファラル", wageType: "月給", wageAmount: 999999 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_hr_applicants.find((a) => a.name === "新規 花子");
  assert.ok(row);
  assert.ok(row.wage_amount == null, "給与は入っていない");
});

await ok("採用担当が応募者を更新しても、給与は書き換わらない（見えていない値を消さない）", async () => {
  setup(); who = RECRUITER;
  const r = await patch({ id: "a1", jobTitle: "シニアエンジニア", wageAmount: 1, wageType: "時給" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_hr_applicants.find((a) => a.id === "a1");
  assert.equal(row.job_title, "シニアエンジニア");
  assert.equal(row.wage_amount, 400000);
  assert.equal(row.wage_type, "月給");
  assert.equal(hasWage(r.body.applicant), false);
});

await ok("給与だけを更新しようとした採用担当は、更新する項目が無いので断られる", async () => {
  setup(); who = RECRUITER;
  const r = await patch({ id: "a1", wageAmount: 1 });
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_hr_applicants.find((a) => a.id === "a1").wage_amount, 400000);
});

await ok("人事は、これまでどおり給与を更新できる", async () => {
  setup(); who = HR;
  const r = await patch({ id: "a1", wageAmount: 420000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_applicants.find((a) => a.id === "a1").wage_amount, 420000);
  assert.equal(r.body.applicant.wageAmount, 420000);
});

console.log("\n=== 合格通知（POST/PATCH /api/hr/offers） ===\n");

await ok("採用担当は、給与が見えないまま合格通知を作れる。応募者の条件はサーバ側で引き継がれる", async () => {
  setup(); who = RECRUITER;
  const r = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(hasWage(r.body.offer), false, "応答には給与が無い");
  const stored = db.rows.gw_hr_offers[0];
  assert.equal(stored.wage_amount, 400000, "本人に届く合格通知には、応募者の条件どおりの給与が入っている");
  assert.equal(stored.wage_type, "月給");
});

await ok("採用担当が、合格通知で給与を上書きしようとしても、無視される", async () => {
  setup(); who = RECRUITER;
  const r = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15", wageAmount: 1, wageType: "時給", weeklyHours: 30 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const stored = db.rows.gw_hr_offers[0];
  assert.equal(stored.wage_amount, 400000);
  assert.equal(stored.weekly_hours, 30, "給与以外の項目は、これまでどおり上書きできる");
});

await ok("採用担当が、社内確認中の合格通知を直しても、給与は書き換わらない・返らない", async () => {
  setup(); who = HR;
  const c = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15" });
  const id = c.body.offer.id;
  who = RECRUITER;
  let r = await offerAct({ id, action: "update", wageAmount: 1, workLocation: "大阪" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(hasWage(r.body.offer), false);
  const stored = db.rows.gw_hr_offers[0];
  assert.equal(stored.wage_amount, 400000);
  assert.equal(stored.work_location, "大阪");
  r = await offerAct({ id, action: "update", wageAmount: 2 });
  assert.equal(r.statusCode, 400, "給与だけを直そうとすると、直す項目が無い");
  assert.equal(db.rows.gw_hr_offers[0].wage_amount, 400000);
});

await ok("人事が作る合格通知には、これまでどおり給与が入り、返る", async () => {
  setup(); who = HR;
  const r = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15", wageAmount: 450000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.offer.wageAmount, 450000);
  assert.equal(db.rows.gw_hr_offers[0].wage_amount, 450000);
});

console.log("\n=== CEO REVIEW・本採用への事前入力 ===\n");

await ok("CEO REVIEW: 管理者・経営者には給与が返る（段階1）。段階2では経営者だけ", async () => {
  setup(); who = OWNER;
  let r = await review();
  let all = [...r.body.todayMeetings, ...r.body.recommended, ...r.body.decisionPending];
  assert.equal(all[0].wageAmount, 350000);
  who = ADMIN_RECRUITER;
  r = await review();
  all = [...r.body.todayMeetings, ...r.body.recommended, ...r.body.decisionPending];
  assert.equal(all[0].wageAmount, 350000, "段階1: 管理者は、これまでどおり");
  process.env.SALARY_OWNER_ONLY = "1";
  r = await review();
  all = [...r.body.todayMeetings, ...r.body.recommended, ...r.body.decisionPending];
  assert.equal(all.length, 1);
  assert.equal(hasWage(all[0]), false, "段階2: 管理者には返らない");
  who = OWNER;
  r = await review();
  all = [...r.body.todayMeetings, ...r.body.recommended, ...r.body.decisionPending];
  assert.equal(all[0].wageAmount, 350000, "段階2でも、経営者には返る");
});

await ok("本採用への事前入力: 給与は、見られる人にだけ入る", async () => {
  setup(); who = OWNER;
  let r = await prefill("a3");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.prefill.wageAmount, 380000);
  assert.equal(r.body.prefill.joinDate, "2026-11-01");
  process.env.SALARY_OWNER_ONLY = "1";
  who = ADMIN_RECRUITER;
  r = await prefill("a3");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(hasWage(r.body.prefill), false, "段階2の管理者には、給与の事前入力が入らない");
  assert.equal(r.body.prefill.joinDate, "2026-11-01", "給与以外は、これまでどおり");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
