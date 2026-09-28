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

mock.module(atRoot("lib/gw.js"), { namedExports: { gwContext: async () => who } });
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

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
