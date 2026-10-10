// 採用HR：面談合格後の「採用区分」（正社員・育成枠・業務委託・パート・スポット）を、API から通す。
//
// ■ 何を守るテストか（HR 面談合格後の採用・育成フロー UI/UX 仕様 Phase 1）
//   1. 合格（decision=hired）と一緒に採用区分を選べる。選考タイムラインに「合格」「採用区分：業務委託を選択」と誰がやったか
//   2. 区分を選ぶと、状態・NEXT ACTION が区分の言い方になる（業務委託オファーの作成待ち → オファーを作成）
//   3. 区分ごとに入力項目が変わる：区分に無い項目は受け付けない・持ち込まない（業務委託に試用期間・月給を入れない）
//      必須の項目が無ければ作れない。区分に無い選択肢（報酬形態）ははじく
//   4. 給与：金額は既存の給与の列。インセンティブ・交通費も、給与を見られない人には返さない・消さない
//   5. オファーを作ったあとは区分を変えられない
//   6. 本人向けページは区分の書類名・項目名だけ（社内用の備考・社内の状態は出さない）
//   7. ステップバー：応募 → 面談 → 合格 → オファー → 承諾 → 契約 → 入社/稼働（育成枠は育成の流れ）
//   8. 区分の無い、これまでの合格通知はそのまま動く。db/129 未適用でも一覧・詳細は止まらない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

const db = { rows: {}, noOfferTypeColumn: false };
const logged = [];
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
const test1 = (x, [op, k, v]) => (op === "eq" ? x[k] === v : op === "neq" ? x[k] !== v
  : op === "in" ? v.includes(x[k]) : op === "is" ? (x[k] ?? null) === v : true);
// db/129 が未適用の環境：offer_type を読もうとすると「列が無い」
const missing = (cols) => db.noOfferTypeColumn && /offer_type/.test(String(cols || ""))
  ? { data: null, error: { code: "42703", message: 'column "offer_type" does not exist' } } : null;
function table(name) {
  const f = [];
  let lim = null;
  let cols = "*";
  const rows = () => { const o = (db.rows[name] || []).filter((x) => f.every((c) => test1(x, c))); return lim ? o.slice(0, lim) : o; };
  const q = {
    select(c) { cols = c; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order() { return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => Promise.resolve(missing(cols) || { data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve(missing(cols) || { data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve(missing(cols) || { data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({ id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn) };
      return r2;
    },
    update(patch) {
      const g = [];
      const apply = () => {
        if (db.noOfferTypeColumn && "offer_type" in patch) {
          return Promise.resolve({ data: null, error: { code: "42703", message: 'column "offer_type" does not exist' } });
        }
        const hit = (db.rows[name] || []).filter((x) => g.every((c) => test1(x, c)));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      };
      const r2 = { eq: (k, v) => { g.push(["eq", k, v]); return r2; }, select: () => r2,
        single: apply, maybeSingle: apply, then: (fn) => apply().then(fn) };
      return r2;
    },
    delete() { const r2 = { eq: () => r2, then: (fn) => Promise.resolve({ data: null, error: null }).then(fn) }; return r2; },
  };
  return q;
}
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => ({ created: rows.length }) } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const REAL_GW = await import(atRoot("lib/gw.js"));
const RECRUITER = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-hr" } };
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, roles: ["owner"], employee: { id: "e-owner" } };
let who = OWNER;
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: detailApi } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));
const { default: offersApi } = await import(atRoot("api/hr/offers/index.js"));
const { shapePublicOffer, nextActionOf } = await import(atRoot("lib/hr.js"));
const T = await import(atRoot("lib/hr-offer-types.js"));
const { json } = await import(atRoot("lib/http.js"));

// lib/http.js の json() は res.__redactSalary を見て給与を外す。本物の出口を通す
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (fn, req) => { const r = res(); await fn({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getDetail = (id) => call(detailApi, { method: "GET", url: `/api/hr/applicants/detail?id=${id}` });
const patchDetail = (body) => call(detailApi, { method: "PATCH", url: "/api/hr/applicants/detail", body });
const listAll = () => call(listApi, { method: "GET", url: "/api/hr/applicants" });
const createOffer = (body) => call(offersApi, { method: "POST", url: "/api/hr/offers", body });
const patchOffer = (body) => call(offersApi, { method: "PATCH", url: "/api/hr/offers", body });
void json;

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = OWNER;
  db.noOfferTypeColumn = false;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [
      // 社長面談のあと、社長判断待ち。応募時の条件に「月給」「試用期間3か月」「正社員」が入っている
      { id: "a1", tenant_id: "t1", name: "山田 太郎", email: "yamada@example.test", job_title: "エンジニア", source: "Wantedly",
        stage: "ceo_interview", status: "ceo_decision_pending", rank: "A", decision: null,
        employment_type: "正社員", probation_months: 3, wage_type: "月給", wage_amount: 300000, work_location: "東京",
        lead_category: "recruitment", offer_type: null },
    ],
    gw_hr_interviews: [], gw_hr_timeline: [], gw_hr_offers: [],
    gw_employees: [
      { id: "e-owner", tenant_id: "t1", user_id: "u-owner", display_name: "社長 一郎", status: "active" },
      { id: "e-hr", tenant_id: "t1", user_id: "u-hr", display_name: "採用 花子", status: "active" },
    ],
    memberships: [], gw_role_grants: [{ employee_id: "e-owner", role: "owner" }],
  };
}
const app = (id) => db.rows.gw_hr_applicants.find((a) => a.id === id);
const tl = () => db.rows.gw_hr_timeline.map((t) => t.label);

console.log("\n— 区分の定義（lib/hr-offer-types.js） —");
await ok("5つの区分。区分ごとに項目が違う（業務委託に試用期間・役職が無い／正社員にインセンティブがある）", () => {
  assert.deepEqual(T.OFFER_TYPE_KEYS, ["executive_employee", "training", "contractor", "part_time", "spot"]);
  const keys = (k) => T.offerTypeOf(k).fields.map((f) => f.key);
  assert.ok(keys("executive_employee").includes("position") && keys("executive_employee").includes("incentive"));
  assert.ok(!keys("contractor").includes("probationMonths") && !keys("contractor").includes("position"));
  assert.ok(keys("contractor").includes("deliverables") && keys("contractor").includes("nda"));
  assert.ok(keys("training").includes("course") && keys("training").includes("midReviewOn"));
  assert.ok(keys("part_time").includes("commuteCost") && keys("part_time").includes("weeklyHours"));
  assert.ok(keys("spot").includes("projectName") && keys("spot").includes("successCriteria"));
  // 本人向けの書類名（§11：合格通知書ではなく、区分に応じたオファー）
  assert.deepEqual(T.OFFER_TYPES.map((t) => t.offerName), ["内定通知", "育成参加決定通知", "業務委託オファー", "採用通知", "案件オファー"]);
});

await ok("区分の条件：知らない項目は捨てる・選択肢と日付を確かめる・給与を見られない人は給与の文章を消せない", () => {
  const r = T.normalizeOfferTerms("contractor", { duties: "AI/DX支援", nda: "必要", hacker: "x", probation: "3" });
  assert.deepEqual(r.value, { duties: "AI/DX支援", nda: "必要" });
  assert.equal(T.normalizeOfferTerms("contractor", { nda: "たぶん" }).error, "invalid_body");
  assert.equal(T.normalizeOfferTerms("training", { midReviewOn: "来月" }).error, "invalid_body");
  const kept = T.normalizeOfferTerms("executive_employee", { position: "部長", incentive: "上書き" },
    { salary: false, previous: { incentive: "四半期ごとに業績連動" } });
  assert.deepEqual(kept.value, { position: "部長", incentive: "四半期ごとに業績連動" });
});

await ok("区分つきの更新：区分に無い既存の項目（業務委託の試用期間）は受け付けない", async () => {
  const { normalizeOffer } = await import(atRoot("lib/hr.js"));
  const r = normalizeOffer({ probationMonths: 6, weeklyHours: 40, joinDate: "2026-12-01", offerTerms: { duties: "x" } },
    null, { partial: true, offerType: "contractor" });
  assert.deepEqual(r.value, { join_date: "2026-12-01", offer_terms: { duties: "x" } });
});

console.log("\n— 合格 → 採用区分を選ぶ —");
await ok("合格と一緒に「業務委託」を選ぶ：タイムラインに合格・区分選択と、誰がやったか", async () => {
  setup();
  const r = await patchDetail({ id: "a1", decision: "hired", stage: "offer", status: "offer_draft_pending", offerType: "contractor" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(app("a1").offer_type, "contractor");
  assert.ok(tl().includes("合格") && tl().includes("採用区分：業務委託を選択"), tl().join(","));
  const decided = db.rows.gw_hr_timeline.find((t) => t.event_key === "decision_hired");
  assert.equal(decided.label, "合格", "判断の記録は「合格」（§11。選考段階の名前「内定」とは別）");
  const d = (await getDetail("a1")).body;
  const sel = d.timeline.find((t) => t.eventKey === "offer_type_selected");
  assert.equal(sel.actorName, "社長 一郎", "誰が選んだか");
  assert.equal(d.offerTypes.length, 5);
  assert.equal(d.offerTypeReady, true);
});

await ok("区分を選ぶと、状態と NEXT ACTION が区分の言い方になる（一覧も同じ）", async () => {
  setup();
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending" });
  let a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.statusLabel, a.nextActionCta, a.nextActionKey], ["採用区分の選択待ち", "採用区分を選ぶ", "chooseOfferType"]);
  assert.equal((await patchDetail({ id: "a1", offerType: "contractor" })).statusCode, 200);
  a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.offerType, a.offerTypeLabel, a.statusLabel], ["contractor", "業務委託", "業務委託オファーの作成待ち"]);
  assert.deepEqual([a.nextActionCta, a.nextActionKey], ["オファーを作成", "createOffer"]);
  assert.ok(a.nextAction.includes("業務委託オファー"), a.nextAction);
  const l = (await listAll()).body.applicants.find((x) => x.id === "a1");
  assert.deepEqual([l.statusLabel, l.nextActionCta], ["業務委託オファーの作成待ち", "オファーを作成"]);
});

await ok("知らない区分ははじく", async () => {
  setup();
  Object.assign(app("a1"), { status: "offer_draft_pending" });
  const r = await patchDetail({ id: "a1", offerType: "freelance" });
  assert.equal(r.statusCode, 400);
  assert.equal(app("a1").offer_type, null);
});

console.log("\n— 区分ごとのオファー —");
await ok("業務委託：必要な項目だけ。試用期間・正社員・月給は持ち込まない。必須（委託業務・契約開始日）が無ければ作れない", async () => {
  setup();
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending", offer_type: "contractor" });
  const bad = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", offerTerms: { nda: "必要" } });
  assert.equal(bad.statusCode, 400);
  assert.ok(/委託業務/.test(bad.body.detail) && /契約開始日/.test(bad.body.detail), bad.body.detail);
  const wrongWage = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", joinDate: "2026-11-01",
    wageType: "月給", offerTerms: { duties: "AI/DX支援" } });
  assert.equal(wrongWage.statusCode, 400, "業務委託の報酬形態に「月給」は無い");
  const r = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", joinDate: "2026-11-01",
    wageType: "月額固定", wageAmount: 400000, workLocation: "リモート",
    offerTerms: { duties: "AI/DX支援業務", workDays: "月・水・金", nda: "必要", deliverables: "月次レポート", position: "部長" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const o = db.rows.gw_hr_offers[0];
  assert.equal(o.offer_type, "contractor");
  assert.equal(o.employment_type, "業務委託");
  assert.equal(o.probation_months, null, "業務委託に試用期間を持ち込まない");
  assert.deepEqual([o.wage_type, o.wage_amount], ["月額固定", 400000]);
  assert.deepEqual(o.offer_terms, { duties: "AI/DX支援業務", workDays: "月・水・金", deliverables: "月次レポート", nda: "必要" },
    "区分に無い項目（役職）は入らない");
  assert.equal(app("a1").status, "offer_review_pending");
  assert.ok(tl().includes("業務委託オファーを作成"), tl().join(","));
  const a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.statusLabel, a.nextActionCta], ["業務委託オファーの社内確認待ち", "内容を確認する"]);
});

await ok("オファーを作ったあとは、区分を変えられない", async () => {
  setup();
  Object.assign(app("a1"), { status: "offer_review_pending", offer_type: "contractor" });
  const r = await patchDetail({ id: "a1", offerType: "spot" });
  assert.equal(r.statusCode, 409);
  assert.equal(app("a1").offer_type, "contractor");
});

await ok("確定 → 送付待ち：NEXT ACTION「業務委託オファーを候補者へ送ってください」［候補者へ送信］", async () => {
  setup();
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending", offer_type: "contractor" });
  const made = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", joinDate: "2026-11-01", offerTerms: { duties: "AI/DX支援" } });
  const c = await patchOffer({ id: made.body.offer.id, action: "confirm" });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  const a = (await getDetail("a1")).body.applicant;
  assert.deepEqual([a.statusLabel, a.nextActionCta, a.nextActionKey], ["業務委託オファーの送付待ち", "候補者へ送信", "sendOffer"]);
  assert.ok(tl().includes("業務委託オファーの内容を確定"));
});

console.log("\n— 給与（金額・インセンティブ・交通費） —");
await ok("正社員：インセンティブは給与。給与を見られない人には返らず、その人の保存でも消えない", async () => {
  setup();
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending", offer_type: "executive_employee" });
  const made = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", joinDate: "2026-11-01", wageType: "月給", wageAmount: 500000,
    offerTerms: { position: "マネージャー", incentive: "四半期ごとに業績連動（最大月給の1か月分）" } });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  assert.equal(made.body.offer.offerTerms.incentive, "四半期ごとに業績連動（最大月給の1か月分）", "経営者には見える");

  who = RECRUITER;
  const d = (await getDetail("a1")).body;
  const view = d.offers[0];
  assert.equal(view.offerTerms.position, "マネージャー");
  assert.equal("incentive" in view.offerTerms, false, "採用担当にはインセンティブを返さない");
  assert.equal("wageAmount" in view, false, "金額も返さない");
  assert.equal(d.salaryVisible, false);
  const up = await patchOffer({ id: view.id, action: "update", offerTerms: { position: "部長", incentive: "上書きしようとする" } });
  assert.equal(up.statusCode, 200, JSON.stringify(up.body));
  assert.deepEqual(db.rows.gw_hr_offers[0].offer_terms, { position: "部長", incentive: "四半期ごとに業績連動（最大月給の1か月分）" },
    "見えていない給与の文章を消さない・書き換えない");
});

await ok("パート：交通費（commuteCost）も同じく給与として扱う", async () => {
  setup();
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending", offer_type: "part_time" });
  const made = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", joinDate: "2026-11-01", employmentType: "アルバイト",
    wageType: "時給", wageAmount: 1300, weeklyHours: 20, offerTerms: { workDays: "月・火・木", commuteCost: "実費（上限 月2万円）" } });
  assert.equal(made.statusCode, 200, JSON.stringify(made.body));
  const o = db.rows.gw_hr_offers[0];
  assert.deepEqual([o.employment_type, o.wage_type, o.weekly_hours], ["アルバイト", "時給", 20]);
  who = RECRUITER;
  const view = (await getDetail("a1")).body.offers[0];
  assert.equal("commuteCost" in view.offerTerms, false);
});

console.log("\n— 本人向けページ（社内用語・社内用の項目を出さない） —");
await ok("業務委託オファー：書類名・契約形態・区分の項目名だけ。試用期間・社内メモは出さない", () => {
  const offer = { offer_type: "contractor", employment_type: "業務委託", join_date: "2026-11-01", contract_end_date: "2027-03-31",
    wage_type: "月額固定", wage_amount: 400000, work_location: "リモート", probation_months: 3, respond_by: "2026-10-31",
    offer_terms: { duties: "AI/DX支援業務", workHours: "週20時間程度", nda: "必要" }, accepted_at: null, declined_at: null };
  const v = shapePublicOffer(offer, { name: "山田 太郎", rank: "A" }, { name: "株式会社エイト" }, null);
  assert.equal(v.offerName, "業務委託オファー");
  const items = Object.fromEntries(v.items.map((i) => [i.label, i.value]));
  assert.deepEqual(items, {
    契約形態: "業務委託", 委託業務: "AI/DX支援業務", 報酬: "月額固定 400,000円", 稼働時間: "週20時間程度",
    稼働場所: "リモート", 契約開始日: "2026年11月1日", 契約終了日: "2027年3月31日", NDA: "必要",
  });
  assert.ok(v.afterAccept.includes("次は契約手続き"));
  assert.equal(JSON.stringify(v).includes("rank"), false);
});

await ok("育成枠：社内用の備考は本人に出さない", () => {
  const v = shapePublicOffer({ offer_type: "training", join_date: "2026-11-01",
    offer_terms: { course: "AIエンジニア育成", note: "社内メモ：要フォロー" } }, { name: "佐藤" }, null, null);
  assert.equal(v.offerName, "育成参加決定通知");
  assert.equal(JSON.stringify(v).includes("社内メモ"), false);
  assert.ok(v.items.some((i) => i.label === "育成コース" && i.value === "AIエンジニア育成"));
});

await ok("区分の無い、これまでの合格通知は従来の形のまま（区分の項目を足さない）", () => {
  const v = shapePublicOffer({ job_title: "営業", join_date: "2026-11-01" }, { name: "佐藤" }, null, null);
  assert.equal(v.offerType, undefined);
  assert.equal(v.jobTitle, "営業");
});

await ok("合格の連絡メール：区分つきなら「内定」「合格通知」と言わず、区分の書類名で案内する（区分なしは従来どおり）", async () => {
  const { decisionMessage } = await import(atRoot("lib/hr-messages.js"));
  const m = decisionMessage("hired", { name: "山田 太郎", tenantName: "株式会社エイト", offerType: "contractor" });
  assert.ok(m.subject.includes("業務委託オファー"), m.subject);
  assert.ok(m.body.includes("業務委託としてご参画") && m.body.includes("「業務委託オファー」"), m.body);
  assert.equal(/内定|合格通知/.test(m.subject + m.body), false);
  const legacy = decisionMessage("hired", { name: "山田 太郎" });
  assert.ok(legacy.subject.includes("内定") && legacy.body.includes("合格通知"));
});

console.log("\n— ステップバー —");
await ok("通常：応募 → 面談 → 合格 → オファー → 承諾 → 契約 → 入社/稼働 の現在地", () => {
  const now = (a) => T.recruitStepsOf(a).steps.find((s) => s.state === "now")?.label || null;
  assert.equal(now({ stage: "applied", status: "todo" }), "応募");
  assert.equal(now({ stage: "casual_interview", status: "interview_scheduled" }), "面談");
  assert.equal(now({ stage: "ceo_interview", status: "ceo_decision_pending" }), "面談");
  assert.equal(now({ stage: "offer", status: "offer_draft_pending" }), "合格", "区分を選ぶ前");
  assert.equal(now({ stage: "offer", status: "offer_draft_pending", offer_type: "contractor" }), "オファー");
  assert.equal(now({ stage: "offer", status: "offer_send_pending", offer_type: "contractor" }), "オファー");
  assert.equal(now({ stage: "offer", status: "offer_response_pending", offer_type: "contractor" }), "承諾");
  assert.equal(now({ stage: "offer", status: "accepted", offer_type: "contractor" }), "契約");
  const done = T.recruitStepsOf({ stage: "joining_scheduled", status: "done", offer_type: "executive_employee" });
  assert.ok(done.steps.every((s) => s.state === "done"));
  const ended = T.recruitStepsOf({ stage: "ceo_interview", status: "passed" });
  assert.equal(ended.ended, "見送り");
  assert.equal(ended.steps.some((s) => s.state === "now"), false);
});

await ok("育成枠：合格 → 育成参加 → 育成 → 実案件 → 評価 → 契約", () => {
  const s = T.recruitStepsOf({ stage: "offer", status: "offer_sent", offer_type: "training" });
  assert.equal(s.flow, "training");
  assert.deepEqual(s.steps.map((x) => x.label), ["合格", "育成参加", "育成", "実案件", "評価", "契約"]);
  assert.equal(s.steps.find((x) => x.state === "now").label, "育成参加");
  assert.equal(T.recruitStepsOf({ stage: "offer", status: "accepted", offer_type: "training" }).steps.find((x) => x.state === "now").label, "育成");
});

await ok("承諾後の NEXT ACTION は区分ごと（業務委託は契約・NDA、育成は参加手続き）", () => {
  assert.equal(nextActionOf({ status: "accepted", offer_type: "contractor" }).cta, "契約手続きへ進む");
  assert.equal(nextActionOf({ status: "accepted", offer_type: "training" }).cta, "参加手続きへ進む");
  assert.equal(nextActionOf({ status: "accepted" }).cta, "本採用へ進める", "区分なしは従来どおり");
});

console.log("\n— これまでの動き・db/129 未適用 —");
await ok("区分の無い応募者は、これまでどおりの合格通知を作れる（区分の列を書かない）", async () => {
  setup();
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending" });
  const r = await createOffer({ applicantId: "a1", respondBy: "2026-10-31", jobTitle: "エンジニア" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const o = db.rows.gw_hr_offers[0];
  assert.equal("offer_type" in o, false);
  assert.equal(o.probation_months, 3, "従来どおり応募者の条件を引き継ぐ");
  assert.ok(tl().includes("合格通知を作成"));
});

await ok("db/129 が未適用でも、一覧・詳細は止まらない。区分を選ぶ操作だけ「SQL を流してください」", async () => {
  setup();
  db.noOfferTypeColumn = true;
  Object.assign(app("a1"), { decision: "hired", stage: "offer", status: "offer_draft_pending" });
  delete app("a1").offer_type;
  const d = await getDetail("a1");
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  assert.equal(d.body.offerTypeReady, false);
  assert.equal((await listAll()).statusCode, 200);
  const r = await patchDetail({ id: "a1", offerType: "contractor" });
  assert.equal(r.statusCode, 503);
  assert.ok(/db\/129/.test(r.body.hint), r.body.hint);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
