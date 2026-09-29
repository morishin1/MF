// 応募者・合格通知の給与を、専用の表（gw_hr_pay）で読み書きする設定（HR_PAY_SPLIT=1）。
//
// ■ 何を守るテストか
//
//   1. 給与は gw_hr_pay から読む。元の列（gw_hr_applicants / gw_hr_offers）は読まない
//      （元の列には、わざと古い値を入れておく。それが返ってきたら失敗）
//   2. 書くときも gw_hr_pay へ。元の行には給与を入れない
//   3. 給与を見られない人（採用担当）の操作でも、合格通知の給与は、サーバの中で引き継がれる
//      （応募者の条件が、そのまま合格通知に入る。応答には載らない）
//   4. 再発行で新しい版ができても、給与が引き継がれる
//   5. 候補者本人の公開ページには、本人の合格通知どおりの給与が出る
//   6. HR_PAY_SPLIT=1 なのに gw_hr_pay が無いときは、黙って空にせず、はっきり失敗する
//   7. 設定していないとき（既定）は、これまでどおり元の列を使う（ほかのテストが確かめている）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

process.env.HR_PAY_SPLIT = "1";

const db = { rows: {}, missing: null };

function table(name) {
  const f = [];
  const copy = (r) => (r ? { ...r } : null);
  const err = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
    if (op === "is") return v === null ? r[k] == null : r[k] === v;
    return true;
  }));
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: err() ? null : copy(rows()[0]) || null, error: err() }),
    single: () => Promise.resolve({ data: err() ? null : copy(rows()[0]) || null, error: err() }),
    then: (fn) => Promise.resolve({ data: err() ? null : rows().map(copy), error: err() }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      if (!err()) (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2, single: () => Promise.resolve({ data: err() ? null : copy(made[0]), error: err() }),
        then: (fn) => Promise.resolve({ data: err() ? null : made.map(copy), error: err() }).then(fn),
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
        const hit = err() ? [] : (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: err() } : { data: copy(hit[0]) || null, error: err() });
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
let who = RECRUITER;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: applicants } = await import(atRoot("api/hr/applicants/index.js"));
const { default: detail } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: offers } = await import(atRoot("api/hr/offers/index.js"));
const { default: publicOffer } = await import(atRoot("api/hr/offers/public.js"));
const { default: ceoReview } = await import(atRoot("api/hr/ceo-review.js"));
const { default: advance } = await import(atRoot("api/hr/applicants/advance.js"));

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
const view = (token) => call(publicOffer, { method: "GET", url: `/api/hr/offers/public?token=${token}` });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const STALE = 111;   // 元の列に残っている古い値。これが返ってきたら、元の列を読んでいる
const pay = (o) => (db.rows.gw_hr_pay || []).find((p) => Object.entries(o).every(([k, v]) => (v === null ? p[k] == null : p[k] === v)));

function setup() {
  who = RECRUITER;
  db.missing = null;
  db.rows = {
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", stage: "offer", status: "offer_draft_pending",
        rank: "A", decision: "hired", employment_type: "正社員", join_date: "2026-11-01",
        wage_type: "古い", wage_amount: STALE, weekly_hours: 40, created_at: "2026-09-20T00:00:00Z" },
      { id: "a2", tenant_id: "t1", name: "推薦された人", job_title: "営業", stage: "ceo_recommend", status: "ceo_interview_pending",
        rank: "A", decision: null, wage_type: "古い", wage_amount: STALE, created_at: "2026-09-21T00:00:00Z" },
      { id: "a3", tenant_id: "t1", name: "承諾済みの人", stage: "offer", status: "accepted", decision: "hired",
        join_date: "2026-11-01", wage_type: "古い", wage_amount: STALE, created_at: "2026-09-22T00:00:00Z" },
    ],
    gw_hr_pay: [
      { id: "p1", tenant_id: "t1", applicant_id: "a1", offer_id: null, wage_type: "月給", wage_amount: 400000 },
      { id: "p2", tenant_id: "t1", applicant_id: "a2", offer_id: null, wage_type: "月給", wage_amount: 350000 },
      { id: "p3", tenant_id: "t1", applicant_id: "a3", offer_id: null, wage_type: "月給", wage_amount: 380000 },
    ],
    gw_hr_interviews: [], gw_hr_timeline: [], gw_hr_offers: [], gw_employees: [], gw_hr_documents: [], tenants: [{ id: "t1", name: "エイト" }],
  };
}

console.log("\n=== 読む：給与は gw_hr_pay から（元の列は読まない） ===\n");

await ok("応募者一覧: 給与を見られる人には gw_hr_pay の値。古い元の列の値は返らない", async () => {
  for (const c of [HR, OWNER]) {
    setup(); who = c;
    const r = await list();
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.applicants.find((a) => a.id === "a1").wageAmount, 400000);
    assert.ok(!JSON.stringify(r.body).includes(String(STALE)), "元の列の値が返っていない");
  }
});

await ok("応募者一覧: 採用担当には給与が返らない（元の列も、gw_hr_pay も）", async () => {
  setup(); who = RECRUITER;
  const r = await list();
  assert.equal(r.statusCode, 200);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes("400000") && !raw.includes(String(STALE)) && !raw.includes("wageAmount"));
});

await ok("応募者の詳細: 応募者・合格通知の版とも、gw_hr_pay の値", async () => {
  setup(); who = HR;
  db.rows.gw_hr_offers = [{ id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, wage_type: "古い", wage_amount: STALE,
    expires_at: "2099-01-01T00:00:00Z", created_at: "2026-09-25T00:00:00Z" }];
  db.rows.gw_hr_pay.push({ id: "p9", tenant_id: "t1", applicant_id: "a1", offer_id: "o1", wage_type: "月給", wage_amount: 390000 });
  const r = await getOne("a1");
  assert.equal(r.body.applicant.wageAmount, 400000);
  assert.equal(r.body.offers[0].wageAmount, 390000);
  assert.ok(!JSON.stringify(r.body).includes(String(STALE)));
});

await ok("CEO REVIEW・本採用の事前入力も、gw_hr_pay の値", async () => {
  setup(); who = OWNER;
  const r = await review();
  const all = [...r.body.todayMeetings, ...r.body.recommended, ...r.body.decisionPending];
  assert.equal(all[0].wageAmount, 350000);
  const p = await prefill("a3");
  assert.equal(p.body.prefill.wageAmount, 380000);
});

console.log("\n=== 書く：給与は gw_hr_pay へ（元の行には入れない） ===\n");

await ok("応募者を追加すると、給与は gw_hr_pay に入り、元の行には入らない", async () => {
  setup(); who = HR;
  const r = await create({ name: "新規 花子", jobTitle: "営業", source: "リファラル", wageType: "月給", wageAmount: 300000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.applicant.wageAmount, 300000, "作った本人には、給与が返る");
  const base = db.rows.gw_hr_applicants.find((a) => a.name === "新規 花子");
  assert.ok(base.wage_amount == null && base.wage_type == null, "元の行には給与が入っていない");
  assert.equal(pay({ applicant_id: base.id, offer_id: null }).wage_amount, 300000);
});

await ok("採用担当が応募者を追加しても、給与は gw_hr_pay にも入らない", async () => {
  setup(); who = RECRUITER;
  const r = await create({ name: "新規 花子", jobTitle: "営業", source: "リファラル", wageAmount: 999 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const base = db.rows.gw_hr_applicants.find((a) => a.name === "新規 花子");
  assert.equal(pay({ applicant_id: base.id }), undefined);
});

await ok("応募者の給与を更新すると gw_hr_pay が変わる。元の列は変わらない。採用担当の更新は無視される", async () => {
  setup(); who = HR;
  let r = await patch({ id: "a1", wageAmount: 420000, jobTitle: "シニア" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(pay({ applicant_id: "a1", offer_id: null }).wage_amount, 420000);
  assert.equal(db.rows.gw_hr_applicants[0].wage_amount, STALE, "元の列は触っていない");
  assert.equal(db.rows.gw_hr_applicants[0].job_title, "シニア");
  assert.equal(r.body.applicant.wageAmount, 420000);
  who = RECRUITER;
  r = await patch({ id: "a1", wageAmount: 1, jobTitle: "リード" });
  assert.equal(r.statusCode, 200);
  assert.equal(pay({ applicant_id: "a1", offer_id: null }).wage_amount, 420000, "採用担当の入力は無視される");
});

await ok("給与の行がまだ無い応募者にも、給与を入れられる（行を作る）", async () => {
  setup(); who = HR;
  db.rows.gw_hr_pay = [];
  const r = await patch({ id: "a1", wageType: "月給", wageAmount: 410000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(pay({ applicant_id: "a1", offer_id: null }).wage_amount, 410000);
});

console.log("\n=== 合格通知：給与は gw_hr_pay の版ごとの行へ ===\n");

await ok("採用担当が合格通知を作ると、応募者の給与が、サーバの中でそのまま引き継がれる（応答には載らない）", async () => {
  setup(); who = RECRUITER;
  const r = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15", wageAmount: 1 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(!("wageAmount" in r.body.offer));
  const o = db.rows.gw_hr_offers[0];
  assert.ok(o.wage_amount == null, "元の行には給与が入っていない");
  assert.equal(pay({ offer_id: o.id }).wage_amount, 400000, "応募者の条件がそのまま入り、採用担当の 1 は無視された");
});

await ok("人事が合格通知を作ると、上書きした給与が版の行に入り、応答にも返る", async () => {
  setup(); who = HR;
  const r = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15", wageAmount: 450000 });
  assert.equal(r.body.offer.wageAmount, 450000);
  assert.equal(pay({ offer_id: db.rows.gw_hr_offers[0].id }).wage_amount, 450000);
  assert.equal(pay({ applicant_id: "a1", offer_id: null }).wage_amount, 400000, "応募者の現在の条件は、そのまま");
});

await ok("社内確認中の合格通知を直すと、その版の給与だけが変わる", async () => {
  setup(); who = HR;
  const c = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15" });
  const id = c.body.offer.id;
  const r = await offerAct({ id, action: "update", wageAmount: 420000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.offer.wageAmount, 420000);
  assert.equal(pay({ offer_id: id }).wage_amount, 420000);
  assert.ok(db.rows.gw_hr_offers[0].wage_amount == null);
  const r2 = await offerAct({ id, action: "update", workLocation: "大阪" });
  assert.equal(r2.body.offer.wageAmount, 420000, "給与以外を直しても、給与は消えない");
});

await ok("確定・URL発行・送付済みの応答にも、人事には給与が返る。採用担当には返らない", async () => {
  setup(); who = HR;
  const c = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15" });
  const id = c.body.offer.id;
  assert.equal((await offerAct({ id, action: "confirm" })).body.offer.wageAmount, 400000);
  assert.equal((await offerAct({ id, action: "issueLink" })).body.offer.wageAmount, 400000);
  who = RECRUITER;
  const m = await offerAct({ id, action: "markSent" });
  assert.equal(m.statusCode, 200, JSON.stringify(m.body));
  assert.ok(!("wageAmount" in m.body.offer));
});

await ok("再発行で新しい版ができても、給与が引き継がれる（元の行には入らない）", async () => {
  setup(); who = HR;
  const c = await mkOffer({ applicantId: "a1", respondBy: "2026-10-15", wageAmount: 450000 });
  const id = c.body.offer.id;
  await offerAct({ id, action: "confirm" });
  await offerAct({ id, action: "issueLink" });
  await offerAct({ id, action: "markSent" });
  const re = await offerAct({ id, action: "issueLink" });
  assert.equal(re.statusCode, 200, JSON.stringify(re.body));
  assert.equal(re.body.offer.version, 2);
  assert.equal(re.body.offer.wageAmount, 450000);
  const v2 = db.rows.gw_hr_offers.find((o) => o.version === 2);
  assert.ok(v2.wage_amount == null);
  assert.equal(pay({ offer_id: v2.id }).wage_amount, 450000);
  assert.equal(pay({ offer_id: id }).wage_amount, 450000, "古い版の給与は、そのまま残る");
});

await ok("候補者本人の公開ページに、本人の合格通知どおりの給与が出る", async () => {
  setup(); who = HR;
  const c = await mkOffer({ applicantId: "a1", respondBy: "2099-10-15", wageAmount: 450000 });
  const id = c.body.offer.id;
  await offerAct({ id, action: "confirm" });
  const issued = await offerAct({ id, action: "issueLink" });
  const r = await view(issued.body.token);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.wageAmount, 450000, "本人には、合格通知どおりの給与が見える");
  assert.ok(!JSON.stringify(r.body).includes(String(STALE)));
});

console.log("\n=== 設定の誤り ===\n");

await ok("HR_PAY_SPLIT=1 なのに gw_hr_pay が無いときは、黙って空にせず、はっきり失敗する", async () => {
  setup(); who = HR;
  db.missing = "gw_hr_pay";
  await assert.rejects(() => list(), (e) => e.code === "hr_pay_not_ready" && /db\/100_hr_pay\.sql/.test(e.message));
  who = RECRUITER;
  const r = await list();
  assert.equal(r.statusCode, 200, "給与を見られない人は gw_hr_pay を使わないので、影響を受けない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
