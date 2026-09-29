// 評価・キャリア（api/career/index.js・api/career/me.js・api/cron/career.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか（指示書 §41）
//   キャリアマスタ … track / level / 給与レンジ / criteria を作れる。テナントが分かれている。権限
//   社員キャリア   … 初期Level・次Level・1年後/3年後・次回評価。本人は自分だけ。管理者は対象社員を管理
//   評価           … 基準ごとの結果を保存。根拠を出す。未確定は本人に見えない。Level Up は人が確定したときだけ。
//                    下書きで level_up を選んでも Level は動かない。確定した評価は履歴に残り、変えられない
//   給与           … 現在給与は gw_contracts から読む。次のレンジを出す。gw_contracts には書かない。
//                    昇給を検討にすると、契約更新（作成依頼・電子署名）への行き先を返す
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB ----------------------------------------------------------------
const db = { rows: {} };
const writes = [];           // [op, table]
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "in") return v.includes(r[k]);
    if (op === "neq") return r[k] !== v;
    if (op === "gte") return r[k] != null && r[k] >= v;
    if (op === "lte") return r[k] != null && r[k] <= v;
    return true;
  });
}
function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? "") < (b[col] ?? "") ? (asc ? -1 : 1) : (a[col] ?? "") > (b[col] ?? "") ? (asc ? 1 : -1) : 0));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    lte(k, v) { f.push(["lte", k, v]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      writes.push(["insert", name]);
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), created_at: new Date(Date.now() + seq).toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn, rej) => Promise.resolve({ data: made.map(copy), error: null }).then(fn, rej),
      };
      return r2;
    },
    update(patch) {
      writes.push(["update", name]);
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply(),
        single: () => apply(),
        then: (fn, rej) => apply().then(fn, rej),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });

const emp = (id, extra = {}) => ({ id, tenant_id: "t1", user_id: `u-${id}`, display_name: id, status: "active", ...extra });
const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], employee: emp("e-owner") };
const ADMIN = { userId: "u-admin", tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: emp("e-admin") };
const HR = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], employee: emp("e-hr") };
const MANAGER = { userId: "u-mgr", tenantId: "t1", isAdmin: false, isHr: false, roles: ["manager"], employee: emp("e-mgr") };
const TARO = { userId: "u-e-taro", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: emp("e-taro") };
const HANAKO = { userId: "u-e-hanako", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: emp("e-hanako") };
const RECRUITER = { ...TARO, userId: "u-rec", roles: ["recruiter"] };
const OTHER = { userId: "u-o2", tenantId: "t2", isAdmin: false, isHr: true, roles: ["owner"], employee: { ...emp("e-o2"), tenant_id: "t2" } };
let who = OWNER;

const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
const notified = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (rows) => { notified.push(...rows); return { created: rows.length }; } },
});

const { default: careerApi } = await import(atRoot("api/career/index.js"));
const { default: meApi } = await import(atRoot("api/career/me.js"));
const { default: cronApi } = await import(atRoot("api/cron/career.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const get = (qs = "") => call(careerApi, { method: "GET", url: `/api/career${qs}` });
const act = (body) => call(careerApi, { method: "POST", url: "/api/career", body });
const mine = () => call(meApi, { method: "GET", url: "/api/career/me" });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const jst = (n = 0) => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);

function setup() {
  who = OWNER;
  logged.length = 0; notified.length = 0; writes.length = 0;
  db.rows = {
    gw_career_tracks: [], gw_career_levels: [], gw_career_criteria: [],
    gw_employee_careers: [], gw_career_reviews: [], gw_tasks: [], gw_role_grants: [],
    gw_employees: [
      emp("e-owner"), emp("e-admin"), emp("e-hr"), emp("e-mgr"),
      emp("e-taro", { manager_id: "e-mgr", joined_on: "2026-04-01", job_family_code: "エンジニア", autonomy_level: 2 }),
      emp("e-hanako", { manager_id: "e-owner", joined_on: "2025-04-01" }),
      { ...emp("e-o2"), tenant_id: "t2" },
    ],
    gw_contracts: [
      { id: "c-old", tenant_id: "t1", employee_id: "e-taro", status: "superseded", wage_type: "月給", wage_amount: 220000, created_at: "2026-01-01" },
      { id: "c-now", tenant_id: "t1", employee_id: "e-taro", status: "active", wage_type: "月給", wage_amount: 240000, created_at: "2026-04-01" },
    ],
    gw_growth_history: [
      { user_id: "u-e-taro", happened_on: jst(-20), title: "問い合わせ対応を一人で完了できるようになった", source: "manual" },
      { user_id: "u-e-hanako", happened_on: jst(-20), title: "他人のできるようになったこと", source: "manual" },
    ],
    gw_growth_plans: [], gw_growth_months: [], gw_growth_kpis: [],
    tc_nippo: [{ user_id: "u-e-taro", work_date: jst(-3) }, { user_id: "u-e-taro", work_date: jst(-2) }],
    gw_nippo_ai_evals: [], gw_autonomy_reviews: [], gw_probation_reviews: [],
  };
}

/** 共通テンプレート＋給与レンジを入れ、太郎を L1 に設定する */
async function seedAndSet({ nextReviewOn = jst(60) } = {}) {
  who = OWNER;
  const s = await act({ action: "seedStarter" });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  const levels = db.rows.gw_career_levels.sort((a, b) => a.level_no - b.level_no);
  const [l1, l2] = levels;
  await act({ action: "saveLevel", id: l1.id, trackId: s.body.trackId, levelNo: 1, levelName: l1.level_name, salaryMin: 220000, salaryMax: 250000 });
  await act({ action: "saveLevel", id: l2.id, trackId: s.body.trackId, levelNo: 2, levelName: l2.level_name, salaryMin: 260000, salaryMax: 300000 });
  const r = await act({ action: "setCareer", employeeId: "e-taro", trackId: s.body.trackId, currentLevelId: l1.id,
    nextReviewOn, oneYearTargetNote: "一人で案件を回す", threeYearTargetNote: "チームを持つ",
    managerNote: "内部メモ：来期は様子を見る", agreed: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return { trackId: s.body.trackId, l1, l2, levels };
}

console.log("— キャリアマスタ —");

await ok("共通テンプレートで track・L1〜L5・L2の基準が入る", async () => {
  setup();
  await seedAndSet();
  assert.equal(db.rows.gw_career_tracks.length, 1);
  assert.equal(db.rows.gw_career_tracks[0].name, "共通");
  assert.deepEqual(db.rows.gw_career_levels.map((l) => l.level_no).sort(), [1, 2, 3, 4, 5]);
  const cats = new Set(db.rows.gw_career_criteria.map((c) => c.category));
  assert.deepEqual([...cats], ["業務遂行", "専門スキル", "顧客・品質", "改善・AI活用", "チーム貢献"]);
  assert.equal((await act({ action: "seedStarter" })).statusCode, 409, "二度は入れない");
});

await ok("track 作成・level 作成・給与レンジ設定・criteria 作成（職種もカテゴリーも自由）", async () => {
  setup();
  const t = await act({ action: "saveTrack", name: "エンジニア", oneYearGoal: "L2", threeYearGoal: "L3〜4" });
  assert.equal(t.statusCode, 200);
  const l = await act({ action: "saveLevel", trackId: t.body.track.id, levelNo: 1, levelName: "基本業務習得",
    salaryMin: 240000, salaryMax: 260000, typicalMonths: 0 });
  assert.equal(l.statusCode, 200, JSON.stringify(l.body));
  assert.equal(l.body.level.salaryMin, 240000);
  assert.equal(l.body.level.salaryMax, 260000);
  const c = await act({ action: "saveCriterion", levelId: l.body.level.id, category: "設計力", title: "小さな機能を設計できる",
    evidenceType: "kpi" });
  assert.equal(c.statusCode, 200);
  assert.equal(db.rows.gw_career_criteria[0].category, "設計力");
});

await ok("給与レンジは下限≦上限・0以上。同じ番号の Level は作れない", async () => {
  setup();
  const t = await act({ action: "saveTrack", name: "営業" });
  const bad = await act({ action: "saveLevel", trackId: t.body.track.id, levelNo: 1, levelName: "x", salaryMin: 300000, salaryMax: 200000 });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "bad_range");
  const neg = await act({ action: "saveLevel", trackId: t.body.track.id, levelNo: 1, levelName: "x", salaryMin: -1 });
  assert.equal(neg.statusCode, 400);
  await act({ action: "saveLevel", trackId: t.body.track.id, levelNo: 1, levelName: "x" });
  const dup = await act({ action: "saveLevel", trackId: t.body.track.id, levelNo: 1, levelName: "y" });
  assert.equal(dup.statusCode, 409);
});

await ok("マスタの編集は owner / admin だけ（人事・マネージャーは見るだけ）", async () => {
  setup();
  who = ADMIN;
  assert.equal((await act({ action: "saveTrack", name: "事業推進" })).statusCode, 200);
  for (const p of [HR, MANAGER]) {
    who = p;
    const r = await act({ action: "saveTrack", name: "x" });
    assert.equal(r.statusCode, 403, String(p.roles));
    assert.equal((await get("?master=1")).statusCode, 200, "見るのはよい");
    assert.equal((await get("?master=1")).body.canEdit, false);
  }
});

await ok("一般メンバー・採用担当は管理APIを使えない", async () => {
  setup();
  for (const p of [TARO, RECRUITER]) {
    who = p;
    assert.equal((await get()).statusCode, 403);
    assert.equal((await act({ action: "saveTrack", name: "x" })).statusCode, 403);
  }
});

await ok("テナント分離：他社のマスタ・社員は見えず、使えない", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  who = OTHER;
  const m = await get("?master=1");
  assert.equal(m.body.tracks.length, 0);
  const l = await get();
  assert.equal(l.body.people.some((p) => p.employee.id === "e-taro"), false);
  assert.equal((await get("?employeeId=e-taro")).statusCode, 404);
  const r = await act({ action: "saveLevel", trackId, levelNo: 9, levelName: "乗っ取り" });
  assert.equal(r.statusCode, 400);
  const u = await act({ action: "saveLevel", id: l1.id, trackId, levelNo: 1, levelName: "乗っ取り" });
  assert.equal(u.statusCode, 400);
  assert.notEqual(db.rows.gw_career_levels.find((x) => x.id === l1.id).level_name, "乗っ取り");
});

console.log("\n— 社員キャリア —");

await ok("初期Level・次Level・次回評価・1年後/3年後が本人に見える（管理メモは見えない）", async () => {
  setup();
  await seedAndSet({ nextReviewOn: "2027-01-31" });
  who = TARO;
  const r = await mine();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.currentLevel.levelNo, 1);
  assert.equal(r.body.nextLevel.levelNo, 2);
  assert.equal(r.body.nextLevel.salaryRange, "260,000円〜300,000円");
  assert.match(r.body.rangeNote, /目安/);
  assert.equal(r.body.career.nextReviewOn, "2027-01-31");
  assert.equal(r.body.horizon.oneYear.level.levelNo, 2);
  assert.ok(r.body.horizon.threeYear.level.levelNo >= 3);
  assert.match(r.body.horizon.note, /目安/);
  assert.equal(r.body.career.oneYearTargetNote, "一人で案件を回す");
  assert.equal(JSON.stringify(r.body).includes("内部メモ"), false, "管理者メモを本人に返さない");
  assert.equal(r.body.progress.remaining.length, 10, "次のLevelまであと10項目");
});

await ok("本人は自分のキャリアだけ（他の社員のものは返らない）", async () => {
  setup();
  await seedAndSet();
  who = HANAKO;
  const r = await mine();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.career, null, "花子は未設定");
  assert.equal(r.body.growthHistory.length, 1);
  assert.equal(r.body.growthHistory[0].title, "他人のできるようになったこと");
  who = TARO;
  const t = await mine();
  assert.deepEqual(t.body.growthHistory.map((h) => h.title), ["問い合わせ対応を一人で完了できるようになった"]);
});

await ok("現在給与は gw_contracts の active から読む（キャリアにはコピーしない）", async () => {
  setup();
  await seedAndSet();
  who = TARO;
  const r = await mine();
  assert.equal(r.body.currentWage.wageAmount, 240000);
  who = OWNER;
  const d = await get("?employeeId=e-taro");
  assert.equal(d.body.currentWage.wageAmount, 240000);
  assert.equal(d.body.currentWage.contractId, "c-now");
  assert.equal(JSON.stringify(db.rows.gw_employee_careers).includes("240000"), false);
});

await ok("管理者の一覧：未設定は「キャリア設定が必要です」が先頭、職種から候補を出す（確定はしない）", async () => {
  setup();
  who = OWNER;
  await act({ action: "seedStarter" });
  await act({ action: "saveTrack", name: "エンジニア" });
  const r = await get();
  assert.equal(r.statusCode, 200);
  const taro = r.body.people.find((p) => p.employee.id === "e-taro");
  assert.equal(taro.nextAction.key, "setup");
  assert.equal(taro.nextAction.label, "キャリア設定が必要です");
  assert.equal(taro.suggestion.trackName, "エンジニア");
  assert.equal(taro.career, null, "候補は出すが、設定はしない");
  assert.equal(db.rows.gw_employee_careers.length, 0);
});

await ok("マネージャーは自分が上長の社員だけ", async () => {
  setup();
  await seedAndSet();
  who = MANAGER;
  const r = await get();
  assert.deepEqual(r.body.people.map((p) => p.employee.id), ["e-taro"]);
  assert.equal((await get("?employeeId=e-hanako")).statusCode, 404);
});

await ok("設定後の Level の直接変更は owner / admin だけ（人事は評価を通す）", async () => {
  setup();
  const { trackId, l2 } = await seedAndSet();
  who = HR;
  const r = await act({ action: "setCareer", employeeId: "e-taro", trackId, currentLevelId: l2.id });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "level_change_needs_review");
});

console.log("\n— 評価 —");

async function draftAll(result = "achieved", extra = {}) {
  const crit = db.rows.gw_career_criteria;
  return act({ action: "saveReview", employeeId: "e-taro",
    criterionResults: crit.map((c, i) => ({ criterionId: c.id, result: i < 8 ? result : "in_progress", note: "根拠あり" })),
    managerComment: "よく頑張っています", salaryNote: "社内：+2万を想定", ...extra });
}

await ok("基準ごとの結果を保存（知らない基準・値は落とす）。システム判定は参考として付く", async () => {
  setup();
  await seedAndSet();
  who = HR;
  const r = await draftAll("achieved", { criterionResults: [
    ...db.rows.gw_career_criteria.slice(0, 8).map((c) => ({ criterionId: c.id, result: "achieved" })),
    { criterionId: "unknown", result: "achieved" },
    { criterionId: db.rows.gw_career_criteria[8].id, result: "excellent" },
  ] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const rv = db.rows.gw_career_reviews[0];
  assert.equal(rv.status, "draft");
  assert.equal(rv.criterion_results.length, 8);
  assert.equal(r.body.systemJudgement.achieved, 8);
  assert.equal(r.body.systemJudgement.total, 10);
  assert.match(r.body.systemJudgement.note, /参考/);
});

await ok("根拠（KPI・日報・タスク・できるようになったこと・自走レベル）を出す", async () => {
  setup();
  await seedAndSet();
  db.rows.gw_tasks.push({ id: "t1", tenant_id: "t1", assignee_id: "e-taro", title: "資料作成", status: "done", completed_at: `${jst(-5)}T01:00:00Z` });
  db.rows.gw_growth_plans.push({ id: "p1", tenant_id: "t1", employee_id: "e-taro", start_date: jst(-80), end_date: jst(10), three_month_kgi: "一人で問い合わせ対応", status: "active" });
  db.rows.gw_growth_months.push({ id: "m1", plan_id: "p1", month_no: 1, kgi: "対応10件" });
  db.rows.gw_growth_kpis.push({ month_id: "m1", name: "対応件数", target_value: 10, unit: "件", sort_order: 0 });
  who = OWNER;
  const r = await get("?evidence=e-taro");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.kpi.threeMonthKgi, "一人で問い合わせ対応");
  assert.equal(r.body.kpi.months[0].kpis[0].name, "対応件数");
  assert.equal(r.body.nippo.days, 2);
  assert.equal(r.body.tasks.done, 1);
  assert.equal(r.body.growthHistory.length, 1);
  assert.equal(r.body.autonomy.level, 2);
  assert.match(r.body.note, /材料/);
});

await ok("未確定（下書き）の評価は本人に見えない", async () => {
  setup();
  await seedAndSet();
  who = HR;
  await draftAll("achieved");
  who = TARO;
  const r = await mine();
  assert.equal(r.body.lastReview, null);
  assert.equal(r.body.progress.achieved, 0, "下書きの結果で進捗を動かさない");
  assert.equal(JSON.stringify(r.body).includes("よく頑張っています"), false);
});

await ok("下書きで level_up を選んでも Level は動かない（人が確定したときだけ）", async () => {
  setup();
  const { l1 } = await seedAndSet();
  who = HR;
  await draftAll("achieved", { result: "level_up", salaryDecision: "raise" });
  assert.equal(db.rows.gw_employee_careers[0].current_level_id, l1.id);
  // 確定は owner / admin だけ
  const r = await act({ action: "confirmReview", id: db.rows.gw_career_reviews[0].id, result: "level_up" });
  assert.equal(r.statusCode, 403);
  assert.equal(db.rows.gw_employee_careers[0].current_level_id, l1.id);
  assert.equal(db.rows.gw_career_reviews[0].status, "draft");
});

await ok("確定には最終判断が要る（下書きの値を黙って使わない）", async () => {
  setup();
  await seedAndSet();
  await draftAll("achieved", { result: "level_up" });
  const r = await act({ action: "confirmReview", id: db.rows.gw_career_reviews[0].id });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_result");
});

await ok("人が Level Up を確定 → Level が上がり、本人に通知・本人に見える", async () => {
  setup();
  const { l2, levels } = await seedAndSet();
  await draftAll("achieved");
  const id = db.rows.gw_career_reviews[0].id;
  const r = await act({ action: "confirmReview", id, result: "level_up", salaryDecision: "keep", nextReviewOn: "2027-07-31" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = db.rows.gw_employee_careers[0];
  assert.equal(c.current_level_id, l2.id);
  assert.equal(c.target_level_id, levels[2].id, "次の目標は L3");
  assert.equal(c.next_review_on, "2027-07-31");
  assert.equal(r.body.newLevel.levelNo, 2);
  assert.equal(r.body.contractNext, null);
  const n = notified.find((x) => x.employeeId === "e-taro");
  assert.equal(n.title, "キャリア評価が更新されました");
  assert.equal(/内部|社内：/.test(JSON.stringify(n)), false, "通知に内部メモを入れない");
  assert.ok(logged.some((l) => l.action === "career.review.confirm" && l.detail.result === "level_up"));

  who = TARO;
  const m = await mine();
  assert.equal(m.body.currentLevel.levelNo, 2);
  assert.equal(m.body.lastReview.result, "level_up");
  assert.equal(m.body.lastReview.managerComment, "よく頑張っています");
  assert.equal(JSON.stringify(m.body).includes("社内：+2万"), false, "給与の調整メモは本人に見せない");
});

await ok("確定した評価は履歴に残り、変えられない・二重に確定できない", async () => {
  setup();
  await seedAndSet();
  await draftAll("achieved");
  const id = db.rows.gw_career_reviews[0].id;
  await act({ action: "confirmReview", id, result: "continue" });
  assert.equal((await act({ action: "confirmReview", id, result: "level_up" })).statusCode, 409);
  const edit = await act({ action: "saveReview", id, employeeId: "e-taro", criterionResults: [] });
  assert.equal(edit.statusCode, 409);
  const h = await get("?history=1");
  assert.equal(h.body.reviews.length, 1);
  assert.equal(h.body.reviews[0].status, "confirmed");
  assert.equal(h.body.reviews[0].result, "continue");
});

await ok("「現Level継続」で確定すると Level は変わらない", async () => {
  setup();
  const { l1 } = await seedAndSet();
  await draftAll("achieved");
  await act({ action: "confirmReview", id: db.rows.gw_career_reviews[0].id, result: "continue" });
  assert.equal(db.rows.gw_employee_careers[0].current_level_id, l1.id);
});

console.log("\n— 給与 —");

await ok("昇給を検討で確定しても gw_contracts は書き換えず、契約更新への行き先を返す", async () => {
  setup();
  await seedAndSet();
  await draftAll("achieved");
  writes.length = 0;
  const r = await act({ action: "confirmReview", id: db.rows.gw_career_reviews[0].id, result: "level_up", salaryDecision: "raise" });
  assert.equal(r.statusCode, 200);
  assert.equal(writes.some(([, t]) => t === "gw_contracts"), false, "契約には書かない");
  assert.equal(db.rows.gw_contracts.find((c) => c.id === "c-now").wage_amount, 240000);
  assert.equal(db.rows.gw_career_reviews[0].salary_decision, "raise");
  assert.match(r.body.contractNext.order, /admin-esign\.html\?tab=order&employeeId=e-taro/);
  assert.match(r.body.contractNext.message, /電子署名/);
});

await ok("管理者の詳細に次のレンジ・現在給与・注記が出る", async () => {
  setup();
  await seedAndSet();
  const d = await get("?employeeId=e-taro");
  assert.equal(d.body.nextLevel.salaryMin, 260000);
  assert.equal(d.body.nextLevel.salaryMax, 300000);
  assert.match(d.body.rangeNote, /実際の昇給・昇格は/);
  assert.match(d.body.contractLinks.order, /tab=order/);
});

console.log("\n— 本人の「今期の目標に追加」・通知 —");

await ok("次のLevelの基準を自分のタスクに加えられる（他のLevelの基準は選べない・二重に作らない）", async () => {
  setup();
  const { levels } = await seedAndSet();
  who = TARO;
  const crit = db.rows.gw_career_criteria[0];
  const r = await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "addGoal", criterionId: crit.id } });
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_tasks.length, 1);
  assert.equal(db.rows.gw_tasks[0].assignee_id, "e-taro");
  assert.match(db.rows.gw_tasks[0].title, /キャリア/);
  const again = await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "addGoal", criterionId: crit.id } });
  assert.equal(again.body.already, true);
  assert.equal(db.rows.gw_tasks.length, 1);
  // 別のLevelの基準
  who = OWNER;
  const c = await act({ action: "saveCriterion", levelId: levels[3].id, category: "x", title: "L4の基準" });
  who = TARO;
  const bad = await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "addGoal", criterionId: c.body.criterion.id } });
  assert.equal(bad.statusCode, 404);
});

await ok("次回評価7日前に、上長・人事・経営者へ「キャリア評価の時期です」（本人には送らない）", async () => {
  setup();
  await seedAndSet({ nextReviewOn: jst(7) });
  db.rows.gw_role_grants.push({ tenant_id: "t1", employee_id: "e-hr", role: "hr" });
  notified.length = 0;
  const r = await call(cronApi, { method: "GET", url: "/api/cron/career" });
  assert.equal(r.statusCode, 200);
  const to = notified.map((n) => n.employeeId).sort();
  assert.deepEqual(to, ["e-hr", "e-mgr"]);
  assert.ok(notified.every((n) => n.title === "キャリア評価の時期です"));
  assert.equal(to.includes("e-taro"), false);
});

console.log("\n— 契約・キャリア面談（db/095） —");

const { flowOf } = await import(atRoot("lib/career.js"));

await ok("状態は保存せず、既存データから計算する（未設定→面談準備→契約準備→本人確認待ち→署名待ち→評価時期→開始）", async () => {
  const today = "2026-09-28";
  const base = { id: "car", next_review_on: "2026-12-20" };
  assert.equal(flowOf({ career: null, today }).state, "setup");
  assert.equal(flowOf({ career: null, today }).cta.label, "契約・キャリア面談を開始");
  assert.equal(flowOf({ career: base, today }).state, "meeting");
  const agreed = { ...base, agreed_at: "2026-04-01" };
  assert.equal(flowOf({ career: agreed, today }).state, "active", "以前の「合意済み」は確認済みとして扱う");
  assert.equal(flowOf({ career: agreed, orders: [{ requested_at: "2026-09-01" }], today }).state, "contract_preparing");
  const asked = { ...base, confirm_requested_at: "2026-09-28T01:00:00Z" };
  const f = flowOf({ career: asked, today });
  assert.equal(f.state, "employee_review");
  assert.equal(f.label, "本人の確認待ちです");
  assert.equal(f.sub, "送信：2026/09/28");
  assert.equal(f.tone, "yellow");
  const confirmed = { ...asked, employee_confirmed_at: "2026-09-29T00:00:00Z" };
  assert.equal(flowOf({ career: confirmed, signs: [{ sent_at: "2026-09-29T00:00:00Z" }], today }).state, "signing");
  assert.equal(flowOf({ career: confirmed, signs: [{ sent_at: "x" }], today }).cta.label, "署名状況を見る");
  assert.equal(flowOf({ career: { ...confirmed, next_review_on: "2026-10-05" }, today }).state, "review_due");
  assert.equal(flowOf({ career: { ...confirmed, next_review_on: "2026-10-05" }, today }).cta.label, "評価する");
  assert.equal(flowOf({ career: { ...confirmed, next_review_on: "2026-09-01" }, today }).tone, "red");
  assert.equal(flowOf({ career: confirmed, draft: { id: "d" }, today }).label, "Level判定待ちです");
  const act0 = flowOf({ career: confirmed, today });
  assert.equal(act0.state, "active");
  assert.equal(act0.tone, "green");
  assert.equal(flowOf({ career: { ...confirmed, next_review_on: null }, today }).label, "次回評価日を設定してください");
  // 再依頼したら、前の確認は数えない
  assert.equal(flowOf({ career: { ...confirmed, confirm_requested_at: "2026-10-01T00:00:00Z" }, today }).state, "employee_review");
});

await ok("一覧：現在給与（active 契約）・状態・NEXT ACTION・担当。未設定が先頭", async () => {
  setup();
  await seedAndSet();
  const r = await get();
  assert.equal(r.statusCode, 200);
  const taro = r.body.people.find((p) => p.employee.id === "e-taro");
  assert.equal(taro.currentWage.wageAmount, 240000, "superseded ではなく active の給与");
  assert.equal(taro.employee.managerName, "e-mgr");
  assert.ok(taro.flow && taro.flow.state && taro.flow.label);
  assert.equal(r.body.people[0].flow.state, "setup");
  assert.equal(r.body.flowStates.length, 7);
  // 契約・キャリアの完了状態（§2・§3・§17）。active契約はあるが署名済み書面が無いので未完了
  assert.equal(taro.contractStatus.key, "unsigned");
  assert.equal(taro.contractStatus.warn, true);
  assert.equal(taro.careerStatus.key, "confirmed", "agreed:true は確認済み扱い");
  assert.equal(taro.overallStatus.key, "contract_pending");
  assert.equal(r.body.overallStates.length, 5);
});

await ok("契約準備・署名待ちは作成依頼・署名依頼から（雇用契約だけ。誓約書などは数えない）", async () => {
  setup();
  await seedAndSet();
  db.rows.gw_sign_requests = [{ id: "s-pledge", tenant_id: "t1", employee_id: "e-taro", doc_kind: "pledge", status: "sent", title: "誓約書", sent_at: "2026-09-01" }];
  let d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.flow.state, "active");
  db.rows.gw_doc_orders = [{ id: "o1", tenant_id: "t1", employee_id: "e-taro", doc_kind: "employment", status: "requested", title: "労働条件通知書", requested_at: "2026-09-20" }];
  d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.flow.state, "contract_preparing");
  assert.equal(d.flow.cta.key, "orders");
  assert.ok(d.contractLinks.order.includes("tab=order&employeeId=e-taro"));
  db.rows.gw_doc_orders[0].status = "sent";
  db.rows.gw_sign_requests.push({ id: "s-emp", tenant_id: "t1", employee_id: "e-taro", doc_kind: "employment", status: "sent", title: "労働条件通知書", sent_at: "2026-09-25" });
  d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.flow.state, "signing");
  assert.equal(d.signs.length, 1, "契約タブには雇用契約の署名だけ");
  const list = (await get()).body.people.find((p) => p.employee.id === "e-taro");
  assert.equal(list.flow.state, "signing");
});

await ok("契約締結済み＋キャリア確認済みで、全体状態が completed になる（§2・§3・§17）", async () => {
  setup();
  await seedAndSet();
  db.rows.gw_sign_requests = [{ id: "s-emp", tenant_id: "t1", employee_id: "e-taro", doc_kind: "employment",
    status: "signed", title: "雇用契約書", sent_at: "2026-04-01", signed_at: "2026-04-02", contract_id: "c-now" }];
  const d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.contractStatus.key, "signed");
  assert.equal(d.careerStatus.key, "confirmed");
  assert.equal(d.overallStatus.key, "completed");
  assert.match(d.overallStatus.nextAction.label, /次回評価/);
  assert.equal(d.signs[0].contractId, "c-now");
  assert.equal(d.signs[0].currentContract, true, "[現在契約]チップの判定に使う");
  // 同じ判定関数を、管理者の本人プレビューでも使う（§17：管理者・本人で食い違わない）
  const preview = (await get("?preview=e-taro")).body;
  assert.equal(preview.overallStatus.key, "completed");
});

await ok("署名済み書面が別の契約のものなら、完了扱いにしない（§8）", async () => {
  setup();
  await seedAndSet();
  db.rows.gw_sign_requests = [{ id: "s-old", tenant_id: "t1", employee_id: "e-taro", doc_kind: "employment",
    status: "signed", title: "旧・雇用契約書", sent_at: "2026-01-01", signed_at: "2026-01-02", contract_id: "c-old" }];
  const d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.contractStatus.key, "unsigned");
  assert.equal(d.contractStatus.warn, true);
  assert.equal(d.overallStatus.key, "contract_pending");
});

await ok("署名済み書面はあるが active 契約が無いと、完了扱いにしない（§8）", async () => {
  setup();
  db.rows.gw_contracts = [];
  db.rows.gw_sign_requests = [{ id: "s-orphan", tenant_id: "t1", employee_id: "e-taro", doc_kind: "employment",
    status: "signed", title: "雇用契約書", sent_at: "2026-04-01", signed_at: "2026-04-02" }];
  const d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.contractStatus.key, "orphan_signed");
  assert.equal(d.contractStatus.warn, true);
  assert.equal(d.contract, null);
});

await ok("詳細：現在の契約（読むだけ）・過去の契約・自走レベル（キャリアLevelと別）・育成", async () => {
  setup();
  await seedAndSet();
  Object.assign(db.rows.gw_contracts[1], { contract_type: "正社員", period_from: "2026-10-01", probation_months: 6, work_hours: "9:00〜17:00" });
  db.rows.gw_growth_plans = [{ id: "gp1", tenant_id: "t1", employee_id: "e-taro", start_date: "2026-10-01", end_date: "2026-12-31", three_month_kgi: "小規模機能を一人で", status: "draft" }];
  db.rows.gw_growth_months = [{ id: "gm1", plan_id: "gp1", month_no: 1, kgi: "設計を1件" }];
  db.rows.gw_growth_kpis = [{ month_id: "gm1", name: "設計書", target_value: 1, unit: "件", sort_order: 0 }];
  const before = writes.filter(([, t]) => t === "gw_contracts").length;
  const d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.contract.contractType, "正社員");
  assert.equal(d.contract.wageAmount, 240000);
  assert.equal(d.contract.probationMonths, 6);
  assert.equal(d.contract.workHours, "9:00〜17:00");
  assert.equal(d.pastContracts.length, 1);
  assert.equal(d.pastContracts[0].wageAmount, 220000);
  assert.equal(d.autonomy.level, 2);
  assert.equal(d.autonomy.levels.length, 4);
  assert.match(d.autonomy.note, /キャリアLevel/);
  assert.equal(d.growth.threeMonthKgi, "小規模機能を一人で");
  assert.equal(d.growth.months[0].kpis[0].name, "設計書");
  assert.ok(d.tracks[0].oneYearGoal, "STEP3 の初期表示に職種マスタの1年後");
  assert.equal(d.employee.userId, "u-e-taro");
  assert.equal(writes.filter(([, t]) => t === "gw_contracts").length, before, "gw_contracts には書かない");
});

await ok("STEP ごとの保存は、送った項目だけ書き換える（管理者メモ・本人の希望を消さない）。職種マスタは変わらない", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  const trackBefore = JSON.stringify(db.rows.gw_career_tracks[0]);
  const r = await act({ action: "setCareer", employeeId: "e-taro", trackId, currentLevelId: l1.id,
    oneYearTargetNote: "小規模開発を一人で完結", threeYearTargetNote: "案件をリード" });
  assert.equal(r.statusCode, 200);
  const c = db.rows.gw_employee_careers[0];
  assert.equal(c.one_year_target_note, "小規模開発を一人で完結");
  assert.equal(c.manager_note, "内部メモ：来期は様子を見る", "送っていない管理者メモは残る");
  assert.ok(c.next_review_on, "送っていない次回評価日は残る");
  assert.equal(JSON.stringify(db.rows.gw_career_tracks[0]), trackBefore, "職種マスタは変わらない");
  await act({ action: "setCareer", employeeId: "e-taro", trackId, currentLevelId: l1.id, nextReviewOn: "2026-12-20" });
  assert.equal(db.rows.gw_employee_careers[0].next_review_on, "2026-12-20");
  assert.equal(db.rows.gw_employee_careers[0].one_year_target_note, "小規模開発を一人で完結");
});

await ok("本人へ確認依頼：次回評価日が要る・本人に通知（中身は入れない）・状態は本人確認待ち", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  assert.equal((await act({ action: "requestConfirm", employeeId: "e-hanako" })).statusCode, 409, "キャリア未設定は送れない");
  await act({ action: "setCareer", employeeId: "e-taro", trackId, currentLevelId: l1.id, nextReviewOn: null });
  assert.equal((await act({ action: "requestConfirm", employeeId: "e-taro" })).statusCode, 400, "次回評価日が要る");
  await act({ action: "setCareer", employeeId: "e-taro", trackId, currentLevelId: l1.id, nextReviewOn: jst(80) });
  notified.length = 0;
  const r = await act({ action: "requestConfirm", employeeId: "e-taro" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(db.rows.gw_employee_careers[0].confirm_requested_at);
  assert.equal(db.rows.gw_employee_careers[0].confirm_requested_by, "u-owner");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].employeeId, "e-taro");
  assert.equal(notified[0].title, "契約・キャリアの確認があります");
  assert.ok(!JSON.stringify(notified[0]).includes("内部メモ"));
  assert.ok(logged.some((l) => l.action === "career.confirm.request"));
  const d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.flow.state, "employee_review");
  assert.equal(d.career.confirmPending, true);
  // 担当外のマネージャー・他テナントは送れない
  who = MANAGER;
  assert.equal((await act({ action: "requestConfirm", employeeId: "e-hanako" })).statusCode, 404);
  who = OTHER;
  assert.equal((await act({ action: "requestConfirm", employeeId: "e-taro" })).statusCode, 404);
  who = TARO;
  assert.equal((await act({ action: "requestConfirm", employeeId: "e-taro" })).statusCode, 403, "本人は依頼を出せない");
});

await ok("本人：ホームの NEXT ACTION・1画面の契約/キャリア・「内容を確認しました」（署名とは別）", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  await act({ action: "setCareer", employeeId: "e-taro", trackId, currentLevelId: l1.id, oneYearTargetNote: "小規模開発を一人で完結" });
  who = TARO;
  let sum = await call(meApi, { method: "GET", url: "/api/career/me?summary=1" });
  assert.equal(sum.body.show, false, "依頼前は出さない");
  assert.equal((await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "confirmPlan" } })).statusCode, 409);
  who = OWNER;
  db.rows.gw_employees.find((e) => e.id === "e-owner").user_id = "u-owner";
  await act({ action: "requestConfirm", employeeId: "e-taro" });
  db.rows.gw_sign_requests = [{ id: "s-emp", tenant_id: "t1", employee_id: "e-taro", doc_kind: "employment", status: "sent", title: "労働条件通知書", sent_at: "2026-09-25" }];
  who = TARO;
  sum = await call(meApi, { method: "GET", url: "/api/career/me?summary=1" });
  assert.equal(sum.body.show, true);
  assert.equal(sum.body.confirmPending, true);
  assert.equal(sum.body.signPending, 1);
  const me = (await mine()).body;
  assert.equal(me.confirm.pending, true);
  assert.equal(me.contract.wageAmount, 240000);
  assert.equal(me.contractSign.pending.length, 1);
  assert.equal(me.contractSign.link, "contracts.html");
  assert.equal(me.career.oneYearTargetNote, "小規模開発を一人で完結");
  assert.ok(!JSON.stringify(me).includes("内部メモ"), "管理者メモは本人に見せない");
  notified.length = 0;
  const r = await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "confirmPlan" } });
  assert.equal(r.statusCode, 200);
  assert.ok(db.rows.gw_employee_careers[0].employee_confirmed_at);
  assert.equal(db.rows.gw_sign_requests[0].status, "sent", "キャリアの確認で契約書は署名済みにならない");
  assert.deepEqual(notified.map((n) => n.employeeId), ["e-owner"], "依頼した人に知らせる");
  const again = await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "confirmPlan" } });
  assert.equal(again.body.already, true);
  who = OWNER;
  const d = (await get("?employeeId=e-taro")).body;
  assert.equal(d.career.confirmPending, false);
  assert.equal(d.flow.state, "signing", "キャリアの確認後も、契約書の署名は別に待つ");
});

await ok("本人画面のプレビュー：本人と同じ形・管理者メモなし・担当者だけ", async () => {
  setup();
  await seedAndSet();
  const r = await get("?preview=e-taro");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.preview.employeeName, "e-taro");
  assert.equal(r.body.currentLevel.levelNo, 1);
  assert.ok(r.body.rangeNote.includes("目安"));
  assert.ok(!JSON.stringify(r.body).includes("内部メモ"));
  who = MANAGER;
  assert.equal((await get("?preview=e-hanako")).statusCode, 404, "担当外は見られない");
  who = TARO;
  assert.equal((await get("?preview=e-taro")).statusCode, 403);
});

console.log("\n— 採用決定 → 契約 → 入社 → キャリア → 育成 —");

const { journeyOf, memberAskOf } = await import(atRoot("lib/journey.js"));
const { intakeGate } = await import(atRoot("lib/onboard-gate.js"));

await ok("状態遷移：採用決定→契約条件→書類作成→署名→入社情報→書類→会社確認→キャリア→育成→通常評価", async () => {
  const today = "2026-09-28";
  const links = { onboard: "admin-onboard.html?applicantId=a1", order: "o", signs: "s", hr: "h", growth: "g", applicant: "ap" };
  const J = (x) => journeyOf({ links, today, ...x });
  const waitOffer = J({ applicant: { status: "offer_response_pending" }, employee: null, canAdvance: true });
  assert.equal(waitOffer.state, "hired");
  assert.equal(waitOffer.label, "内定の承諾を待っています");
  const hired = J({ applicant: { status: "accepted" }, employee: null, canAdvance: true });
  assert.equal(hired.label, "契約条件を設定してください");
  assert.equal(hired.cta.label, "契約条件を設定");
  assert.equal(J({ applicant: { status: "accepted" }, employee: null, canAdvance: false }).cta, null, "経営者・管理者以外には入口を出さない");
  const E = { id: "e1" };
  const P = { id: "p1", status: "in_progress" };
  const c1 = J({ employee: E, procedure: P, stage: { key: "conditions" } });
  assert.deepEqual([c1.state, c1.label, c1.cta.label], ["contract_setup", "労働条件通知書を作成してください", "書類を作成"]);
  const d1 = J({ employee: E, procedure: P, stage: { key: "advisor_review" }, facts: { order: { status: "requested" } } });
  assert.deepEqual([d1.state, d1.actorLabel], ["document_preparing", "社労士"]);
  const d2 = J({ employee: E, procedure: P, stage: { key: "advisor_review" }, facts: { order: { status: "uploaded" } } });
  assert.equal(d2.cta.label, "本人へ送る");
  const sg = J({ employee: E, procedure: P, stage: { key: "signing" }, facts: { sign: { status: "sent" } } });
  assert.deepEqual([sg.state, sg.stateLabel, sg.label, sg.cta.label], ["signing", "本人署名待ち", "本人の署名完了を待っています", "署名状況を見る"]);
  const info = J({ employee: E, procedure: P, stage: { key: "intake" }, facts: { profile: null, items: [] } });
  assert.deepEqual([info.state, info.label, info.cta], ["onboarding_info", "入社連絡票の入力待ちです", null]);
  const docs = J({ employee: E, procedure: P, stage: { key: "intake" },
    facts: { profile: { status: "submitted" }, items: [{ owner: "employee", required: true, status: "todo", item_key: "doc_id" }] } });
  assert.equal(docs.state, "documents_pending");
  const rev = J({ employee: E, procedure: P, stage: { key: "intake" },
    facts: { profile: { status: "submitted" }, items: [{ owner: "admin", status: "todo" }] } });
  assert.deepEqual([rev.state, rev.cta.label], ["company_review", "手続きを確認"]);
  const cs = J({ employee: E, procedure: P, stage: { key: "complete" }, career: null, careerFlow: { state: "setup" } });
  assert.deepEqual([cs.state, cs.stateLabel, cs.label, cs.cta.label], ["career_setup", "入社手続き完了", "キャリアプランを設定してください", "キャリア設定"]);
  const gs = J({ employee: E, procedure: P, stage: { key: "complete" }, career: { id: "c" }, careerFlow: { state: "active" }, growth: null });
  assert.deepEqual([gs.state, gs.stateLabel, gs.label, gs.cta.label], ["growth_active", "キャリア設定完了", "3か月育成を開始してください", "3か月育成を開始"]);
  const ga = J({ employee: E, procedure: P, stage: { key: "complete" }, career: { id: "c" }, careerFlow: { state: "active" },
    growth: { status: "active", end_date: "2026-12-31" } });
  assert.equal(ga.label, "3か月育成中です");
  const done = J({ employee: E, procedure: P, stage: { key: "complete" }, career: { id: "c" },
    careerFlow: { state: "review_due", label: "3か月評価を実施してください", cta: { key: "review", label: "評価する" } },
    growth: { status: "active", end_date: "2026-09-01" } });
  assert.deepEqual([done.state, done.label, done.cta.label], ["active", "3か月評価を実施してください", "評価する"]);
  // 以前からの社員（入社手続き無し）に「育成を始めて」とは言わない
  assert.equal(J({ employee: E, procedure: null, career: { id: "c" }, careerFlow: { state: "active", label: "育成中です" } }).state, "active");
});

await ok("本人のホームは、いま必要な NEXT ACTION を1つだけ（契約 → 入社情報 → 書類 → キャリア）", async () => {
  assert.equal(memberAskOf({ signPending: 1, confirmPending: false }).title, "契約内容の確認があります");
  assert.equal(memberAskOf({ signPending: 1, confirmPending: true }).title, "契約・キャリアの確認があります");
  assert.equal(memberAskOf({ signPending: 0, stage: "intake", facts: { items: [] } }).title, "入社情報を入力してください");
  assert.equal(memberAskOf({ signPending: 0, stage: "intake",
    facts: { profile: { status: "submitted" }, items: [{ owner: "employee", status: "todo", item_key: "doc_id" }] } }).title, "必要書類を提出してください");
  assert.equal(memberAskOf({ signPending: 0, stage: "signing", facts: { items: [] } }), null, "署名前に入社情報を求めない");
  assert.equal(memberAskOf({ signPending: 0, confirmPending: true }).title, "キャリアプランの確認があります");
  assert.equal(memberAskOf({ signPending: 0, confirmPending: false }), null);
});

function onboardingFixture() {
  db.rows.gw_employees.push(emp("e-new", { status: "invited", manager_id: "e-mgr" }));
  db.rows.gw_procedures = [{ id: "p-new", tenant_id: "t1", employee_id: "e-new", kind: "onboarding", status: "in_progress",
    target_on: "2026-10-01", created_at: "2026-09-01" }];
  db.rows.gw_procedure_items = [
    { id: "i1", procedure_id: "p-new", item_key: "doc_id", owner: "employee", required: true, status: "todo" },
    { id: "i2", procedure_id: "p-new", item_key: "insurance", owner: "admin", required: true, status: "todo" },
  ];
  db.rows.gw_doc_orders = []; db.rows.gw_sign_requests = []; db.rows.gw_onboard_profiles = [];
  db.rows.gw_onboard_consents = []; db.rows.gw_consent_docs = [];
  db.rows.gw_hr_applicants = [
    { id: "a-ok", tenant_id: "t1", name: "承諾 済子", decision: "hired", status: "accepted", join_date: "2026-11-01",
      employment_type: "正社員", wage_type: "月給", wage_amount: 250000, employee_id: null },
    { id: "a-wait", tenant_id: "t1", name: "承諾 待子", decision: "hired", status: "offer_response_pending", employee_id: null },
    { id: "a-done", tenant_id: "t1", name: "社員 済男", decision: "hired", status: "done", employee_id: "e-taro" },
    { id: "a-no", tenant_id: "t1", name: "見送り", decision: "rejected", status: "passed", employee_id: null },
  ];
}
const consentAll = () => ["pledge", "privacy", "rules"].map((k) => ({ employee_id: "e-new", kind: k, version: "1.0", agreed_at: "2026-09-10" }));

await ok("進行一覧：採用決定の人（採用HR権限だけ）と、入社手続き中の社員。事実が進むと状態も進む", async () => {
  setup();
  await seedAndSet();
  onboardingFixture();
  const row = async () => (await get("?journey=1")).body.rows.find((r) => r.id === "e-new");
  let r = await get("?journey=1");
  assert.equal(r.statusCode, 200);
  const apps = r.body.rows.filter((x) => x.kind === "applicant").map((x) => x.id).sort();
  assert.deepEqual(apps, ["a-ok", "a-wait"], "社員になった人・見送りは出さない");
  assert.equal(r.body.rows.find((x) => x.id === "a-ok").journey.cta.label, "契約条件を設定");
  assert.equal(r.body.rows.find((x) => x.id === "a-ok").joinOn, "2026-11-01");
  assert.equal((await row()).journey.state, "contract_setup");
  assert.equal((await row()).joinOn, "2026-10-01");
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "requested", updated_at: "2026-09-02" });
  assert.equal((await row()).journey.state, "document_preparing");
  db.rows.gw_doc_orders[0].status = "sent";
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "sent", sent_at: "2026-09-03" });
  const sg = await row();
  assert.equal(sg.journey.state, "signing");
  assert.equal(sg.journey.actorLabel, "本人");
  // 署名しても、誓約書の同意がそろうまでは入社手続きへ進まない
  db.rows.gw_sign_requests[0].status = "signed";
  assert.equal((await row()).journey.state, "signing");
  db.rows.gw_onboard_consents.push(...consentAll());
  assert.equal((await row()).journey.state, "onboarding_info");
  db.rows.gw_onboard_profiles.push({ employee_id: "e-new", status: "submitted" });
  assert.equal((await row()).journey.state, "documents_pending");
  db.rows.gw_procedure_items[0].status = "submitted";
  assert.equal((await row()).journey.state, "company_review");
  db.rows.gw_procedure_items[1].status = "done";
  const cs = await row();
  assert.equal(cs.journey.state, "career_setup");
  assert.equal(cs.journey.stateLabel, "入社手続き完了");
  // マネージャーは担当の社員だけ。応募者は見えない（採用HRの権限が無い）
  who = MANAGER;
  const m = (await get("?journey=1")).body;
  assert.equal(m.rows.some((x) => x.kind === "applicant"), false);
  assert.equal(m.seesApplicants, false);
  assert.ok(m.rows.some((x) => x.id === "e-new"));
});

await ok("詳細：上部の NEXT ACTION は進行（journey）。入社手続きタブの中身。キャリア設定→育成開始", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  onboardingFixture();
  let d = (await get("?employeeId=e-new")).body;
  assert.equal(d.journey.state, "contract_setup");
  assert.equal(d.onboarding.stage, "conditions");
  assert.equal(d.onboarding.steps.length, 5);
  assert.equal(d.onboarding.targetOn, "2026-10-01");
  assert.ok(d.onboarding.links.hr.includes("admin-hr.html?id=p-new"));
  // 入社手続きを終えた
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "signed", updated_at: "x" });
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "signed", sent_at: "x" });
  db.rows.gw_onboard_consents.push(...consentAll());
  db.rows.gw_onboard_profiles.push({ employee_id: "e-new", status: "submitted" });
  db.rows.gw_procedure_items.forEach((i) => { i.status = "done"; });
  d = (await get("?employeeId=e-new")).body;
  assert.equal(d.journey.state, "career_setup");
  assert.equal(d.journey.cta.key, "meeting");
  await act({ action: "setCareer", employeeId: "e-new", trackId, currentLevelId: l1.id, nextReviewOn: jst(90), agreed: true });
  d = (await get("?employeeId=e-new")).body;
  assert.equal(d.journey.state, "growth_active");
  assert.equal(d.journey.cta.key, "growth");
  db.rows.gw_growth_plans.push({ id: "gp", tenant_id: "t1", employee_id: "e-new", status: "active", start_date: jst(0), end_date: jst(80) });
  d = (await get("?employeeId=e-new")).body;
  assert.equal(d.journey.label, "3か月育成中です");
  // 以前からの社員（入社手続き無し）は通常評価
  assert.equal((await get("?employeeId=e-taro")).body.journey.state, "active");
});

await ok("採用決定の詳細：採用HRの権限がある人だけ。社員になった人は社員の詳細へ", async () => {
  setup();
  onboardingFixture();
  const r = await get("?applicant=a-ok");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.applicant.wageAmount, 250000);
  assert.equal(r.body.journey.cta.href, "admin-onboard.html?applicantId=a-ok");
  assert.equal(r.body.canAdvance, true);
  assert.equal((await get("?applicant=a-done")).statusCode, 409);
  assert.equal((await get("?applicant=a-no")).statusCode, 404);
  who = MANAGER;
  assert.equal((await get("?applicant=a-ok")).statusCode, 403);
  who = HR;
  const h = await get("?applicant=a-ok");
  assert.equal(h.statusCode, 200);
  assert.equal(h.body.canAdvance, false, "契約条件の設定（社員登録）は経営者・管理者");
  assert.equal(h.body.journey.cta, null);
});

await ok("署名が済むまで入社手続き（入社情報・書類）へ進ませない（サーバ側）", async () => {
  setup();
  onboardingFixture();
  const sb = { from: table };
  let g = await intakeGate(sb, "t1", "e-new");
  assert.equal(g.ok, false);
  assert.equal(g.stage, "conditions");
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "sent", updated_at: "x" });
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "sent", sent_at: "x" });
  g = await intakeGate(sb, "t1", "e-new");
  assert.equal(g.ok, false, "送っただけでは進まない");
  assert.match(g.hint, /署名/);
  db.rows.gw_sign_requests[0].status = "signed";
  db.rows.gw_onboard_consents.push(...consentAll());
  assert.equal((await intakeGate(sb, "t1", "e-new")).ok, true);
  assert.equal((await intakeGate(sb, "t1", "e-taro")).ok, true, "入社手続きの無い社員は止めない");
});

await ok("本人ホームの summary：署名待ち → 契約内容の確認、署名後 → 入社情報", async () => {
  setup();
  onboardingFixture();
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "sent", updated_at: "x" });
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "sent", sent_at: "x" });
  who = { userId: "u-e-new", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: emp("e-new") };
  let s = (await call(meApi, { method: "GET", url: "/api/career/me?summary=1" })).body;
  assert.equal(s.ask.title, "契約内容の確認があります");
  assert.equal(s.ask.href, "contracts.html");
  db.rows.gw_sign_requests[0].status = "signed";
  db.rows.gw_onboard_consents.push(...consentAll());
  s = (await call(meApi, { method: "GET", url: "/api/career/me?summary=1" })).body;
  assert.equal(s.ask.title, "入社情報を入力してください");
  assert.equal(s.ask.href, "onboarding.html");
  db.rows.gw_onboard_profiles.push({ employee_id: "e-new", status: "submitted" });
  s = (await call(meApi, { method: "GET", url: "/api/career/me?summary=1" })).body;
  assert.equal(s.ask.title, "必要書類を提出してください");
});

console.log("\n— 共通ステータスバー（管理者と本人で同じ判定） —");

const { phasesOf, PHASES } = await import(atRoot("lib/journey.js"));

await ok("内部状態 → 6段階（採用決定/契約/本人手続き/会社確認/キャリア/育成）", async () => {
  assert.deepEqual(PHASES.map((p) => p.label), ["採用決定", "契約", "本人手続き", "会社確認", "キャリア", "育成"]);
  const now = (st) => phasesOf(st).find((p) => p.state === "now")?.label || "全部完了";
  assert.equal(now("hired"), "採用決定");
  for (const st of ["contract_setup", "document_preparing", "signing"]) assert.equal(now(st), "契約");
  for (const st of ["onboarding_info", "documents_pending"]) assert.equal(now(st), "本人手続き");
  assert.equal(now("company_review"), "会社確認");
  assert.equal(now("career_setup"), "キャリア");
  assert.equal(now("growth_active"), "育成");
  assert.equal(now("active"), "全部完了");
  assert.deepEqual(phasesOf("documents_pending").map((p) => p.state), ["done", "done", "now", "todo", "todo", "todo"]);
  assert.ok(phasesOf("active").every((p) => p.state === "done"));
});

await ok("誰の対応か：本人ならCTAあり、会社・社労士のときは「操作は必要ありません」でCTAなし", async () => {
  const E = { id: "e1" }, P = { id: "p1", status: "in_progress" };
  const J = (x) => journeyOf({ links: {}, today: "2026-09-28", employee: E, procedure: P, ...x });
  const info = J({ stage: { key: "intake" }, facts: { items: [] } });
  assert.equal(info.who, "self");
  assert.equal(info.whoText.member, "あなたの対応です");
  assert.equal(info.whoText.admin, "本人の対応待ち");
  assert.deepEqual([info.member.now, info.member.cta.label, info.member.cta.href], ["入社情報の入力", "入社情報を入力する", "onboarding.html"]);
  const rev = J({ stage: { key: "intake" }, facts: { profile: { status: "submitted" }, items: [{ owner: "admin", status: "todo" }] } });
  assert.equal(rev.who, "company");
  assert.equal(rev.whoText.member, "会社が対応中です");
  assert.equal(rev.member.cta, null);
  assert.match(rev.member.next, /あなたの操作は必要ありません/);
  const adv = J({ stage: { key: "advisor_review" }, facts: { order: { status: "requested" } } });
  assert.equal(adv.whoText.member, "社労士が確認中です");
  assert.equal(adv.member.cta, null);
  const sign = J({ stage: { key: "signing" }, facts: { sign: { status: "sent" } } });
  assert.deepEqual([sign.who, sign.member.cta.href], ["self", "contracts.html"]);
  const done = journeyOf({ links: {}, today: "2026-09-28", employee: E, procedure: null, career: { id: "c" }, careerFlow: { state: "active" } });
  assert.equal(done.whoText.member, "完了しました");
  assert.equal(done.member.cta, null);
});

await ok("同じ人について、一覧・管理者の詳細・本人のホーム・本人のキャリア画面で進み具合が一致する", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  onboardingFixture();
  const NEWU = { userId: "u-e-new", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: emp("e-new", { status: "invited" }) };
  const pick = (j) => JSON.stringify({ state: j.state, phases: j.phases, who: j.who, member: j.member });
  const views = async () => {
    who = OWNER;
    const list = (await get("?journey=1")).body.rows.find((r) => r.id === "e-new").journey;
    const detail = (await get("?employeeId=e-new")).body.journey;
    const preview = (await get("?preview=e-new")).body.journey;
    who = NEWU;
    const home = (await call(meApi, { method: "GET", url: "/api/career/me?summary=1" })).body.journey;
    const page = (await mine()).body.journey;
    return { list, detail, preview, home, page };
  };
  const steps = [
    () => {},
    () => db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "requested", updated_at: "x" }),
    () => { db.rows.gw_doc_orders[0].status = "sent"; db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e-new", doc_kind: "employment", status: "sent", sent_at: "x" }); },
    () => { db.rows.gw_sign_requests[0].status = "signed"; db.rows.gw_onboard_consents.push(...consentAll()); },
    () => db.rows.gw_onboard_profiles.push({ employee_id: "e-new", status: "submitted" }),
    () => { db.rows.gw_procedure_items[0].status = "submitted"; },
    () => { db.rows.gw_procedure_items[1].status = "done"; },
    async () => { who = OWNER; await act({ action: "setCareer", employeeId: "e-new", trackId, currentLevelId: l1.id, nextReviewOn: jst(90) }); },
    async () => { who = OWNER; await act({ action: "requestConfirm", employeeId: "e-new" }); },
    async () => { who = NEWU; await call(meApi, { method: "POST", url: "/api/career/me", body: { action: "confirmPlan" } }); },
    () => db.rows.gw_growth_plans.push({ id: "gp", tenant_id: "t1", employee_id: "e-new", status: "active", start_date: jst(0), end_date: jst(80) }),
  ];
  const seen = [];
  for (const step of steps) {
    await step();
    const v = await views();
    const base = pick(v.detail);
    for (const k of ["list", "preview", "home", "page"]) assert.equal(pick(v[k]), base, `${v.detail.state}: ${k} が管理者の詳細と違う`);
    seen.push(`${v.detail.phases.find((p) => p.state === "now")?.label || "完了"}/${v.home.whoText}`);
  }
  assert.deepEqual(seen, [
    "契約/会社が対応中です", "契約/社労士が確認中です", "契約/あなたの対応です", "本人手続き/あなたの対応です",
    "本人手続き/あなたの対応です", "会社確認/会社が対応中です", "キャリア/会社が対応中です", "キャリア/会社が対応中です",
    "キャリア/あなたの対応です", "育成/会社が対応中です", "育成/あなたの対応です",
  ]);
  // 本人に返す形に、管理画面の行き先は入れない
  who = NEWU;
  const home = (await call(meApi, { method: "GET", url: "/api/career/me?summary=1" })).body.journey;
  assert.ok(!JSON.stringify(home).includes("admin-"), "本人に admin-*.html を返さない");
});

console.log("\n— 給与は、見られる人にだけ（責任者には見せない・書かせない） —");

// 応答のどこかに、給与のキーがあるか（キー名の完全一致で見る。labels.salaryDecisions のような、
// 選択肢の名前の表は給与の値ではない）
const SALARY_KEY_NAMES = new Set(["wageAmount", "wageType", "wageNote", "currentWage", "salaryMin", "salaryMax",
  "salaryDecision", "salaryNote", "salary_decision", "salary_note", "salary_min", "salary_max", "wage_amount", "wage_type"]);
const hasSalaryKey = (o) => {
  if (Array.isArray(o)) return o.some(hasSalaryKey);
  if (o && typeof o === "object") return Object.entries(o).some(([k, v]) => SALARY_KEY_NAMES.has(k) || hasSalaryKey(v));
  return false;
};

await ok("責任者は、部下の評価・キャリアは扱えるが、給与（現在給与・給与レンジ・給与メモ）は返らない", async () => {
  setup();
  await seedAndSet();
  who = OWNER;
  await draftAll("achieved");                       // 給与の調整メモ「+2万を想定」つきの下書き
  db.rows.gw_career_reviews[0].salary_decision = "raise";
  who = MANAGER;
  const list = await get();
  assert.equal(list.statusCode, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.people.map((p) => p.employee.id), ["e-taro"], "自分が上長の人は、これまでどおり見える");
  assert.equal(hasSalaryKey(list.body), false, "一覧に給与が無い");
  const d = await get("?employeeId=e-taro");
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  assert.equal(hasSalaryKey(d.body), false, "詳細に給与が無い（現在給与・次のレンジ・給与メモ・昇給の判断）");
  assert.ok(d.body.nextLevel && d.body.nextLevel.levelNo === 2, "給与以外の Level・基準は、これまでどおり見える");
  const m = await get("?master=1");
  assert.equal(hasSalaryKey(m.body), false, "マスタに給与レンジが無い");
  const h = await get("?history=1");
  assert.equal(hasSalaryKey(h.body), false, "評価履歴に昇給の判断が無い");
  const raw = JSON.stringify([list.body, d.body, m.body, h.body]);
  for (const n of ["240000", "260000", "300000", "+2万"]) assert.ok(!raw.includes(n), `${n} がどこにも出ていない`);
});

await ok("人事・経営者・管理者（段階1）には、これまでどおり給与が返る", async () => {
  setup();
  await seedAndSet();
  for (const c of [HR, OWNER, ADMIN]) {
    who = c;
    const d = await get("?employeeId=e-taro");
    assert.equal(d.body.currentWage.wageAmount, 240000, JSON.stringify(c.roles));
    assert.equal(d.body.nextLevel.salaryMin, 260000);
  }
});

await ok("責任者が評価の下書きを保存しても、すでに入っている昇給の判断・給与メモは消えない", async () => {
  setup();
  await seedAndSet();
  who = HR;
  await draftAll("achieved");
  const rv = db.rows.gw_career_reviews[0];
  rv.salary_decision = "raise";
  rv.salary_note = "社内：+2万を想定";
  who = MANAGER;
  const r = await act({ action: "saveReview", id: rv.id, employeeId: "e-taro", managerComment: "上長のコメントを直しました",
    salaryDecision: "none", salaryNote: "書き換えようとした" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const after = db.rows.gw_career_reviews.find((x) => x.id === rv.id);
  assert.equal(after.manager_comment, "上長のコメントを直しました", "給与以外は保存できる");
  assert.equal(after.salary_decision, "raise", "見えていない昇給の判断を、上書きしない");
  assert.equal(after.salary_note, "社内：+2万を想定");
  assert.equal(hasSalaryKey(r.body), false);
});

await ok("段階2（SALARY_OWNER_ONLY=1）: 経営者だけに返る。人事・管理者には返らず、Level を直しても給与レンジは消えない", async () => {
  setup();
  const { trackId, l1 } = await seedAndSet();
  process.env.SALARY_OWNER_ONLY = "1";
  try {
    who = HR;
    assert.equal(hasSalaryKey((await get("?employeeId=e-taro")).body), false);
    who = ADMIN;
    assert.equal(hasSalaryKey((await get()).body), false);
    // 管理者が Level の名前を直す。給与レンジは見えていないので、null で上書きされてはいけない
    const r = await act({ action: "saveLevel", id: l1.id, trackId, levelNo: 1, levelName: "新しい名前" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const row = db.rows.gw_career_levels.find((x) => x.id === l1.id);
    assert.equal(row.level_name, "新しい名前");
    assert.equal(row.salary_min, 220000);
    assert.equal(row.salary_max, 250000);
    who = OWNER;
    const d = await get("?employeeId=e-taro");
    assert.equal(d.body.currentWage.wageAmount, 240000, "経営者には、段階2でも返る");
  } finally { delete process.env.SALARY_OWNER_ONLY; }
});

await ok("本人は、これまでどおり自分の現在給与だけを見られる", async () => {
  setup();
  await seedAndSet();
  who = TARO;
  const r = await mine();
  assert.equal(r.body.currentWage.wageAmount, 240000);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
