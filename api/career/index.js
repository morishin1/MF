// 評価・キャリア（管理者・経営者・人事・マネージャー）
//
// GET  /api/career                       … 社員一覧（NEXT ACTION 順）と、トラック・Level
// GET  /api/career?employeeId=…          … 社員の詳細（現在地・次のLevel・進捗・現在給与・評価）
// GET  /api/career?evidence=…&from&to    … 評価の根拠（既存データを読むだけ）
// GET  /api/career?master=1              … キャリアマスタ（トラック・Level・基準）
// GET  /api/career?history=1             … 評価履歴
// GET  /api/career?preview=…             … 本人画面のプレビュー（本人に見える形そのもの）
// GET  /api/career?journey=1             … 採用決定 → 契約 → 入社 → キャリア → 育成 の進行一覧
// GET  /api/career?applicant=…           … 採用決定（まだ社員でない人）の詳細。採用HRの権限がある人だけ
// POST /api/career {action:…}
//        seedStarter     … 共通テンプレート（L1〜L5・L2の基準）を入れる         owner/admin
//        saveTrack       … トラックを作る・直す                                 owner/admin
//        saveLevel       … Level（役割・給与レンジ）を作る・直す                  owner/admin
//        saveCriterion   … 評価基準を作る・直す                                 owner/admin
//        setCareer       … 社員のキャリア（現在地・次回評価・1年/3年）を設定する   担当者
//        saveReview      … 評価を下書きで保存する（本人には見えない）             担当者
//        confirmReview   … 評価を確定する（Level Up・昇給判断）                  owner/admin
//        requestConfirm  … 契約・キャリア面談の内容を、本人へ確認依頼する        担当者
//
// ■ 契約・キャリア面談（db/095）
//   状態（未設定・面談準備・契約準備・本人確認待ち・署名待ち・開始・評価時期）は保存しない。
//   作成依頼・署名依頼・キャリア・評価から毎回計算する（lib/career.js flowOf）。
//   契約の変更は既存の作成依頼 → 労働条件通知書 → 電子署名で行う（ここでは作らない）。
//
// ■ 自動で昇給・昇格させない
//   Level が変わるのは confirmReview だけ。人が result を選んで押したときだけ。
//   saveReview で level_up を選んでも、確定するまで何も変わらない。
//   AI や数値から confirmReview を呼ぶ経路は作らない。
//
// ■ 給与を書き換えない
//   この API から gw_contracts へ書き込む経路は無い。現在給与は読むだけ。
//   昇給を検討にしたときは、契約更新（契約書作成依頼 → 電子署名）への行き先を返す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit, canDecideHire } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import {
  canManageCareer, canDecideCareer, careerSeesAll, inCareerScope,
  levelsOf, nextLevelOf, progressOf, systemJudgement, cleanResults, nextActionOf, suggestTrack, selfCheckView,
  REVIEW_RESULT_KEYS, SALARY_DECISION_KEYS, EVIDENCE_TYPE_KEYS, CRITERION_RESULTS, REVIEW_RESULTS,
  SALARY_DECISIONS, EVIDENCE_TYPES, RANGE_NOTE_ADMIN, TIMELINE_NOTE, STARTER,
  flowOf, confirmPending, FLOW_STATES, CONTRACT_DOC_KINDS, OPEN_ORDER_STATUSES,
  contractStatus, careerStatus, overallStatus, OVERALL_STATES,
} from "../../lib/career.js";
import { memberCareerView } from "../../lib/career-member.js";
import { LEVELS as AUTONOMY_LEVELS } from "../../lib/autonomy.js";
import { journeyOf, intakeBreakdown, JOURNEY_STATES, ACTOR_LABELS } from "../../lib/journey.js";
import { computeStage, STAGES as ONBOARD_STAGES, stageOf } from "../../lib/onboard-stage.js";
import { gatherFactsBulk } from "../../lib/onboard-advance.js";
import { journeyForEmployee, journeyLinks } from "../../lib/journey-load.js";

const EMP_FIELDS =
  "id, tenant_id, user_id, display_name, department, position, status, joined_on, "
  + "manager_id, initial_role, job_family_code, autonomy_level";
const SETUP = "db/092_career.sql";

const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v, n = 2000) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);
const int = (v) => (v === "" || v === null || v === undefined ? null
  : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  // 給与を含む。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageCareer(ctx)) return json(res, 403, { error: "forbidden" });

  try {
    if (req.method === "GET") return await read(req, res, ctx);
    if (req.method === "POST") return await act(req, res, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SETUP);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[career]", e?.message || e);
    return json(res, 500, { error: "career_failed", detail: String(e?.message || e) });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** Supabase の { data, error } を、失敗なら投げる形に */
const must = async (q) => {
  const { data, error } = await q;
  if (error) throw error;
  return data;
};
/** 無くても困らない材料。失敗したら null（その表が未適用の環境でも画面は出す） */
const soft = async (q) => {
  try { const { data, error } = await q; return error ? null : data; } catch { return null; }
};

async function loadMaster(sb, ctx) {
  const [tracks, levels, criteria] = await Promise.all([
    must(sb.from("gw_career_tracks").select("*").eq("tenant_id", ctx.tenantId).order("sort_order", { ascending: true })),
    must(sb.from("gw_career_levels").select("*").eq("tenant_id", ctx.tenantId).order("level_no", { ascending: true })),
    must(sb.from("gw_career_criteria").select("*").eq("tenant_id", ctx.tenantId).order("sort_order", { ascending: true })),
  ]);
  return { tracks: tracks || [], levels: levels || [], criteria: criteria || [] };
}

const levelView = (l) => (l ? {
  id: l.id, trackId: l.track_id, levelNo: l.level_no, levelName: l.level_name,
  roleSummary: l.role_summary, expectedRole: l.expected_role, typicalMonths: l.typical_months,
  salaryMin: l.salary_min, salaryMax: l.salary_max, nextLevelSummary: l.next_level_summary,
  isActive: l.is_active !== false,
} : null);

async function currentWage(sb, ctx, employeeId) {
  // 現在給与は active 契約から読む（キャリアにはコピーしない）
  const rows = await soft(sb.from("gw_contracts")
    .select("id, wage_type, wage_amount, wage_note, status, created_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1));
  const c = rows?.[0];
  return c ? { contractId: c.id, wageType: c.wage_type, wageAmount: c.wage_amount, wageNote: c.wage_note } : null;
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();
  if (q.get("master")) {
    const m = await loadMaster(sb, ctx);
    return json(res, 200, {
      ...m, canEdit: canDecideCareer(ctx), evidenceTypes: EVIDENCE_TYPES,
    });
  }
  if (q.get("history")) return history(res, sb, ctx);
  if (q.get("evidence")) return evidence(res, sb, ctx, q.get("evidence"), q.get("from"), q.get("to"));
  if (q.get("preview")) return preview(res, sb, ctx, q.get("preview"));
  if (q.get("journey")) return journeyList(res, sb, ctx);
  if (q.get("applicant")) return applicantDetail(res, sb, ctx, q.get("applicant"));
  if (q.get("employeeId")) return detail(res, sb, ctx, q.get("employeeId"));
  return list(res, sb, ctx);
}

async function scopedEmployees(sb, ctx) {
  const emps = await must(sb.from("gw_employees").select(EMP_FIELDS)
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "leaving", "invited"]).limit(1000));
  return (emps || []).filter((e) => inCareerScope(ctx, e));
}

async function list(res, sb, ctx) {
  const today = jstToday();
  const [emps, m, careers, reviews, contract] = await Promise.all([
    scopedEmployees(sb, ctx),
    loadMaster(sb, ctx),
    must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId).eq("is_active", true)),
    must(sb.from("gw_career_reviews")
      .select("id, employee_id, career_id, status, target_level_id, criterion_results, decided_at, created_at")
      .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(2000)),
    contractState(sb, ctx),
  ]);
  const nameById = new Map(emps.map((e) => [e.id, e.display_name]));
  const allNames = contract.names;
  const careerOf = new Map((careers || []).map((c) => [c.employee_id, c]));
  const levelById = new Map(m.levels.map((l) => [l.id, l]));
  const trackById = new Map(m.tracks.map((t) => [t.id, t]));

  const people = emps.map((e) => {
    const c = careerOf.get(e.id) || null;
    const mine = (reviews || []).filter((r) => r.employee_id === e.id && (!c || r.career_id === c.id));
    const draft = mine.find((r) => r.status === "draft") || null;
    const lastConfirmed = mine.find((r) => r.status === "confirmed") || null;
    const cur = c ? levelById.get(c.current_level_id) : null;
    const next = c ? (levelById.get(c.target_level_id) || nextLevelOf(m.levels, cur)) : null;
    const crit = next ? m.criteria.filter((x) => x.level_id === next.id) : [];
    const results = lastConfirmed && lastConfirmed.target_level_id === next?.id ? lastConfirmed.criterion_results : [];
    const progress = next ? progressOf(crit, results) : null;
    const action = nextActionOf({ career: c, draft, progress, nextLevel: next, today });
    const suggestion = c ? null : suggestTrack(e, m.tracks);
    const wage = contract.wageOf.get(e.id) || null;
    const flow = flowOf({ career: c, draft, orders: contract.ordersOf.get(e.id) || [],
      signs: contract.signsOf.get(e.id) || [], today });
    // 契約・キャリアの完了状態（§2・§3・§17）。flow とは別の、独立した2軸の点検
    const cSt = contractStatus({ contract: wage ? { id: wage.id } : null, signs: contract.signsAllOf.get(e.id) || [] });
    const kSt = careerStatus({ career: c });
    const overall = overallStatus({ contractStatus: cSt, careerStatus: kSt });
    return {
      employee: { id: e.id, name: e.display_name, department: e.department, status: e.status,
                  joinedOn: e.joined_on, autonomyLevel: e.autonomy_level,
                  managerName: e.manager_id ? (nameById.get(e.manager_id) || allNames.get(e.manager_id) || null) : null },
      currentWage: wage ? { wageType: wage.wage_type, wageAmount: wage.wage_amount, contractType: wage.contract_type } : null,
      flow,
      contractStatus: cSt, careerStatus: kSt, overallStatus: overall,
      career: c ? {
        id: c.id, trackId: c.track_id, trackName: trackById.get(c.track_id)?.name || null,
        currentLevel: levelView(cur), nextLevel: levelView(next),
        nextReviewOn: c.next_review_on, agreedAt: c.agreed_at,
      } : null,
      progress: progress ? { achieved: progress.achieved, total: progress.total, left: progress.remaining.length } : null,
      draftReviewId: draft?.id || null,
      nextAction: action,
      suggestion: suggestion ? { trackId: suggestion.id, trackName: suggestion.name,
        levelId: levelsOf(m.levels, suggestion.id)[0]?.id || null } : null,
    };
  }).sort((a, b) => (a.flow.rank - b.flow.rank) || (a.nextAction.rank - b.nextAction.rank)
    || String(a.career?.nextReviewOn || "9999").localeCompare(String(b.career?.nextReviewOn || "9999"))
    || String(a.employee.name).localeCompare(String(b.employee.name), "ja"));

  return json(res, 200, {
    people,
    tracks: m.tracks.map((t) => ({ id: t.id, name: t.name, isActive: t.is_active !== false })),
    levels: m.levels.map(levelView),
    canDecide: canDecideCareer(ctx),
    canEditMaster: canDecideCareer(ctx),
    seesAll: careerSeesAll(ctx),
    flowStates: FLOW_STATES,
    overallStates: OVERALL_STATES,
    today,
  });
}

/**
 * 一覧・詳細の「契約の進み具合」と現在給与。既存の表を読むだけ（どれも無くても画面は出す）
 *   作成依頼 … gw_doc_orders（雇用契約・まだ本人に届いていないもの）
 *   署名依頼 … gw_sign_requests（雇用契約・sent。flowOf() 用）
 *   署名済み含む … gw_sign_requests（雇用契約・sent/signed。contractStatus() の「締結済みか」用）
 *   現在給与 … gw_contracts（active の新しいもの）
 */
async function contractState(sb, ctx, employeeId = null) {
  const scope = (q) => (employeeId ? q.eq("employee_id", employeeId) : q);
  const [orders, signs, allSigns, contracts, emps] = await Promise.all([
    soft(scope(sb.from("gw_doc_orders").select("id, employee_id, doc_kind, title, status, requested_at, created_at")
      .eq("tenant_id", ctx.tenantId).in("status", OPEN_ORDER_STATUSES)).limit(2000)),
    soft(scope(sb.from("gw_sign_requests").select("id, employee_id, doc_kind, title, status, sent_at, due_on")
      .eq("tenant_id", ctx.tenantId).eq("status", "sent")).order("sent_at", { ascending: false }).limit(2000)),
    soft(scope(sb.from("gw_sign_requests").select("id, employee_id, doc_kind, title, status, sent_at, signed_at, due_on, contract_id")
      .eq("tenant_id", ctx.tenantId).in("status", ["sent", "signed"])).order("sent_at", { ascending: false }).limit(2000)),
    soft(scope(sb.from("gw_contracts").select("id, employee_id, contract_type, wage_type, wage_amount, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "active")).order("created_at", { ascending: false }).limit(2000)),
    employeeId ? null : soft(sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).limit(2000)),
  ]);
  const group = (rows) => {
    const out = new Map();
    for (const r of rows || []) {
      if (r.doc_kind && !CONTRACT_DOC_KINDS.includes(r.doc_kind)) continue;
      if (!out.has(r.employee_id)) out.set(r.employee_id, []);
      out.get(r.employee_id).push(r);
    }
    return out;
  };
  const wageOf = new Map();
  for (const c of contracts || []) if (!wageOf.has(c.employee_id)) wageOf.set(c.employee_id, c);
  return {
    ordersOf: group(orders), signsOf: group(signs), signsAllOf: group(allSigns), wageOf,
    names: new Map((emps || []).map((e) => [e.id, e.display_name])),
  };
}

async function loadEmployee(sb, ctx, id) {
  const e = await must(sb.from("gw_employees").select(EMP_FIELDS).eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
  return e && inCareerScope(ctx, e) ? e : null;
}

async function detail(res, sb, ctx, employeeId) {
  const e = await loadEmployee(sb, ctx, employeeId);
  if (!e) return json(res, 404, { error: "not_found" });
  const [m, careers, reviews, wage, contracts, orders, signs, growth, autonomyLog, manager] = await Promise.all([
    loadMaster(sb, ctx),
    must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).eq("is_active", true)),
    must(sb.from("gw_career_reviews").select("*").eq("tenant_id", ctx.tenantId).eq("employee_id", e.id)
      .order("created_at", { ascending: false }).limit(50)),
    currentWage(sb, ctx, e.id),
    // 契約は読むだけ。現在給与・契約条件は常にここから（キャリアにはコピーしない）
    soft(sb.from("gw_contracts").select("*").eq("tenant_id", ctx.tenantId).eq("employee_id", e.id)
      .order("created_at", { ascending: false }).limit(20)),
    soft(sb.from("gw_doc_orders").select("id, doc_kind, title, status, requested_at, created_at, due_on")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).order("requested_at", { ascending: false }).limit(20)),
    soft(sb.from("gw_sign_requests").select("id, doc_kind, title, status, sent_at, signed_at, due_on, contract_id")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).order("sent_at", { ascending: false }).limit(20)),
    growthOf(sb, ctx, e.id),
    soft(sb.from("gw_autonomy_reviews").select("from_level, to_level, reason, decided_at")
      .eq("employee_id", e.id).order("decided_at", { ascending: false }).limit(5)),
    e.manager_id ? soft(sb.from("gw_employees").select("id, display_name").eq("id", e.manager_id)
      .eq("tenant_id", ctx.tenantId).maybeSingle()) : null,
  ]);
  const c = careers?.[0] || null;
  const levelById = new Map(m.levels.map((l) => [l.id, l]));
  const cur = c ? levelById.get(c.current_level_id) : null;
  const next = c ? (levelById.get(c.target_level_id) || nextLevelOf(m.levels, cur)) : null;
  const crit = next ? m.criteria.filter((x) => x.level_id === next.id && x.is_active !== false) : [];
  const mine = (reviews || []).filter((r) => !c || r.career_id === c.id);
  const draft = mine.find((r) => r.status === "draft") || null;
  const lastConfirmed = mine.find((r) => r.status === "confirmed") || null;
  const results = lastConfirmed && lastConfirmed.target_level_id === next?.id ? lastConfirmed.criterion_results : [];
  const progress = next ? progressOf(crit, results) : null;
  // 本人の自己チェック（db/110）。閲覧のみ（ここから書き込む経路は無い。書くのは本人だけ・api/career/me.js）
  const selfCheck = next && c ? selfCheckView(crit, c.self_check_results, results) : null;
  const today = jstToday();
  const isContract = (r) => !r.doc_kind || CONTRACT_DOC_KINDS.includes(r.doc_kind);
  const openOrders = (orders || []).filter((o) => isContract(o) && OPEN_ORDER_STATUSES.includes(o.status));
  const sentSigns = (signs || []).filter((x) => isContract(x) && x.status === "sent");
  const active = (contracts || []).find((x) => x.status === "active") || null;
  const autonomyLevel = AUTONOMY_LEVELS.find((l) => l.level === Number(e.autonomy_level)) || null;
  const careerFlow = flowOf({ career: c, draft, orders: openOrders, signs: sentSigns, today });
  // 契約・キャリアの完了状態（§2・§3・§17）。flow とは別の、独立した2軸の点検
  const signedOrSent = (signs || []).filter((x) => isContract(x) && ["sent", "signed"].includes(x.status));
  const cSt = contractStatus({ contract: active ? { id: active.id } : null, signs: signedOrSent });
  const kSt = careerStatus({ career: c });
  const overall = overallStatus({ contractStatus: cSt, careerStatus: kSt });
  // 進み具合は本人の画面と同じ関数で（lib/journey-load.js）。管理者と本人で食い違わない
  const { journey, onboarding: onb } = await journeyForEmployee(sb, ctx.tenantId, e, today);

  return json(res, 200, {
    employee: { id: e.id, userId: e.user_id || null, name: e.display_name, department: e.department, position: e.position,
                joinedOn: e.joined_on, autonomyLevel: e.autonomy_level, initialRole: e.initial_role,
                managerName: manager?.display_name || null },
    career: c ? {
      id: c.id, trackId: c.track_id, currentLevelId: c.current_level_id, targetLevelId: c.target_level_id,
      startedAt: c.started_at, nextReviewOn: c.next_review_on,
      oneYearTargetNote: c.one_year_target_note, threeYearTargetNote: c.three_year_target_note,
      employeeWish: c.employee_wish, managerNote: c.manager_note, agreedAt: c.agreed_at,
      confirmRequestedAt: c.confirm_requested_at || null, employeeConfirmedAt: c.employee_confirmed_at || null,
      confirmPending: confirmPending(c),
    } : null,
    flow: careerFlow,
    // 契約・キャリアの完了状態（§2・§3・§17。管理者・本人共通の判定）
    contractStatus: cSt, careerStatus: kSt, overallStatus: overall,
    // 採用決定 → 契約 → 入社 → キャリア → 育成 のどこか（lib/journey.js）。ドロワー上部の NEXT ACTION はこれ
    journey,
    onboarding: onb ? onboardingView(onb) : null,
    // 現在の契約（active）と過去の契約。読むだけ
    contract: contractView(active),
    pastContracts: (contracts || []).filter((x) => x.id !== active?.id && x.status !== "draft").map(contractView),
    orders: (orders || []).filter(isContract).map((o) => ({ id: o.id, title: o.title, status: o.status,
      requestedAt: o.requested_at || o.created_at, dueOn: o.due_on })),
    signs: (signs || []).filter(isContract).map((x) => ({ id: x.id, title: x.title, status: x.status,
      sentAt: x.sent_at, signedAt: x.signed_at, dueOn: x.due_on,
      // active契約に紐づくか（db/097）。無い古いデータは contractId が null のまま（§6の[現在契約]チップ判定に使う）
      contractId: x.contract_id || null, currentContract: Boolean(active) && (!x.contract_id || x.contract_id === active.id) })),
    growth,
    autonomy: {
      level: e.autonomy_level ?? null, label: autonomyLevel?.label || null,
      levels: AUTONOMY_LEVELS.map((l) => ({ level: l.level, label: l.label, summary: l.summary })),
      recent: (autonomyLog || []).map((a) => ({ from: a.from_level, to: a.to_level, reason: a.reason, at: a.decided_at })),
      // 自走レベルを動かすのは既存の /api/autonomy（理由つき・履歴が残る）。そこと同じ人だけ
      canEdit: Boolean(ctx.isAdmin || ctx.isHr || (ctx.roles || []).includes("owner")),
      note: "自走レベルは任せられる範囲です。キャリアLevel（役割・期待値・給与レンジ）とは別に決めます。",
    },
    canGrowth: Boolean(ctx.isAdmin || ctx.isHr || (ctx.roles || []).includes("owner")),
    track: c ? m.tracks.find((t) => t.id === c.track_id) || null : null,
    currentLevel: levelView(cur),
    nextLevel: levelView(next),
    levels: c ? levelsOf(m.levels, c.track_id).map(levelView) : [],
    criteria: crit.map((x) => ({ id: x.id, category: x.category, title: x.title, description: x.description,
      required: x.required !== false, evidenceType: x.evidence_type, requiredLevel: x.required_level })),
    progress,
    selfCheck,
    currentWage: wage,
    rangeNote: RANGE_NOTE_ADMIN,
    timelineNote: TIMELINE_NOTE,
    draft,
    reviews: mine,
    nextAction: nextActionOf({ career: c, draft, progress, nextLevel: next, today }),
    suggestion: c ? null : (() => {
      const t = suggestTrack(e, m.tracks);
      return t ? { trackId: t.id, trackName: t.name, levelId: levelsOf(m.levels, t.id)[0]?.id || null } : null;
    })(),
    tracks: m.tracks.filter((t) => t.is_active !== false).map((t) => ({ id: t.id, name: t.name,
      oneYearGoal: t.one_year_goal || null, threeYearGoal: t.three_year_goal || null })),
    allCriteria: m.criteria.filter((x) => x.is_active !== false).map((x) => ({ id: x.id, levelId: x.level_id,
      category: x.category, title: x.title, required: x.required !== false })),
    allLevels: m.levels.filter((l) => l.is_active !== false).map(levelView),
    labels: { criterionResults: CRITERION_RESULTS, reviewResults: REVIEW_RESULTS, salaryDecisions: SALARY_DECISIONS,
              evidenceTypes: EVIDENCE_TYPES },
    canDecide: canDecideCareer(ctx),
    // 昇給を検討するときの行き先。契約の更新は既存の雇用契約・作成依頼・電子署名で行う
    contractLinks: {
      order: `admin-esign.html?tab=order&employeeId=${encodeURIComponent(e.id)}`,
      contracts: "admin-contracts.html",
      signs: "admin-esign.html?tab=list",
      growth: `admin-growth.html?employeeId=${encodeURIComponent(e.id)}`,
      preview: `career.html?preview=${encodeURIComponent(e.id)}`,
    },
    today,
  });
}

const contractView = (c) => (c ? {
  id: c.id, status: c.status, contractType: c.contract_type || null,
  wageType: c.wage_type || null, wageAmount: c.wage_amount ?? null, wageNote: c.wage_note || null,
  periodFrom: c.period_from || null, periodTo: c.period_to || null, fixedTerm: c.fixed_term ?? null,
  probationMonths: c.probation_months ?? null, probationEnd: c.probation_end || null,
  workHours: c.work_hours || null, createdAt: c.created_at || null,
} : null);

/** 3か月育成（既存の gw_growth_plans / months / kpis）の、いちばん新しい計画 */
async function growthOf(sb, ctx, employeeId) {
  const plans = await soft(sb.from("gw_growth_plans").select("id, start_date, end_date, three_month_kgi, status")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).order("start_date", { ascending: false }).limit(1));
  const plan = plans?.[0];
  if (!plan) return null;
  const months = await soft(sb.from("gw_growth_months").select("id, month_no, kgi, status")
    .eq("plan_id", plan.id).order("month_no", { ascending: true }));
  const ids = (months || []).map((x) => x.id);
  const kpis = ids.length ? await soft(sb.from("gw_growth_kpis").select("month_id, name, target_value, unit")
    .in("month_id", ids).order("sort_order", { ascending: true })) : [];
  return {
    id: plan.id, status: plan.status, from: plan.start_date, to: plan.end_date, threeMonthKgi: plan.three_month_kgi,
    months: (months || []).map((mo) => ({ monthNo: mo.month_no, kgi: mo.kgi, status: mo.status,
      kpis: (kpis || []).filter((k) => k.month_id === mo.id).map((k) => ({ name: k.name, target: k.target_value, unit: k.unit })) })),
  };
}

/** 管理者が「本人画面をプレビュー」。本人の API と同じ組み立て（lib/career-member.js） */
async function preview(res, sb, ctx, employeeId) {
  const e = await loadEmployee(sb, ctx, employeeId);
  if (!e) return json(res, 404, { error: "not_found" });
  const view = await memberCareerView(sb, { tenantId: ctx.tenantId, employee: e, userId: e.user_id || null });
  const { journey } = await journeyForEmployee(sb, ctx.tenantId, e);
  return json(res, 200, { ...view, journey, preview: { employeeName: e.display_name } });
}

/**
 * 評価の根拠。既存の記録を読んで並べるだけ（ここで点数にしない）。
 * 期間の既定は直近3か月
 */
async function evidence(res, sb, ctx, employeeId, fromQ, toQ) {
  const e = await loadEmployee(sb, ctx, employeeId);
  if (!e) return json(res, 404, { error: "not_found" });
  const to = isDate(toQ) ? toQ : jstToday();
  const from = isDate(fromQ) ? fromQ : addDays(to, -90);
  const uid = e.user_id;

  const [plans, history, tasks, nippo, evals, autonomy, probation, reviews] = await Promise.all([
    soft(sb.from("gw_growth_plans").select("id, start_date, end_date, three_month_kgi, status")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).order("start_date", { ascending: false }).limit(2)),
    uid ? soft(sb.from("gw_growth_history").select("happened_on, title, evidence, source")
      .eq("user_id", uid).gte("happened_on", from).lte("happened_on", to).order("happened_on", { ascending: false }).limit(50)) : null,
    soft(sb.from("gw_tasks").select("id, title, status, due_on, completed_at")
      .eq("tenant_id", ctx.tenantId).eq("assignee_id", e.id).limit(1000)),
    uid ? soft(sb.from("tc_nippo").select("work_date").eq("user_id", uid)
      .gte("work_date", from).lte("work_date", to).limit(400)) : null,
    uid ? soft(sb.from("gw_nippo_ai_evals").select("work_date, status").eq("user_id", uid)
      .eq("status", "completed").gte("work_date", from).lte("work_date", to).limit(400)) : null,
    soft(sb.from("gw_autonomy_reviews").select("from_level, to_level, reason, decided_at")
      .eq("employee_id", e.id).order("decided_at", { ascending: false }).limit(3)),
    soft(sb.from("gw_probation_reviews").select("checkpoint, period_from, period_to, verdict, decision, decision_note")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).order("period_to", { ascending: false }).limit(4)),
    soft(sb.from("gw_career_reviews").select("status, manager_comment, decided_at, created_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", e.id).eq("status", "confirmed")
      .order("created_at", { ascending: false }).limit(3)),
  ]);

  const plan = plans?.[0] || null;
  let months = null;
  let kpis = null;
  if (plan) {
    months = await soft(sb.from("gw_growth_months").select("id, month_no, month, kgi, status, review_note")
      .eq("plan_id", plan.id).order("month_no", { ascending: true }));
    const ids = (months || []).map((x) => x.id);
    kpis = ids.length ? await soft(sb.from("gw_growth_kpis").select("month_id, name, target_value, unit, kind")
      .in("month_id", ids).order("sort_order", { ascending: true })) : [];
  }
  const inPeriod = (d) => d && String(d).slice(0, 10) >= from && String(d).slice(0, 10) <= to;
  const doneTasks = (tasks || []).filter((t) => t.status === "done" && inPeriod(t.completed_at));
  const openOverdue = (tasks || []).filter((t) => !["done", "cancelled"].includes(t.status) && t.due_on && t.due_on < to);

  return json(res, 200, {
    period: { from, to },
    note: "根拠は評価の材料です。数字がそのまま評価結果になるわけではありません。",
    kpi: plan ? {
      threeMonthKgi: plan.three_month_kgi, status: plan.status, from: plan.start_date, to: plan.end_date,
      months: (months || []).map((mo) => ({
        monthNo: mo.month_no, kgi: mo.kgi, reviewNote: mo.review_note,
        kpis: (kpis || []).filter((k) => k.month_id === mo.id).map((k) => ({ name: k.name, target: k.target_value, unit: k.unit })),
      })),
    } : null,
    nippo: nippo ? { days: nippo.length, aiEvaluated: evals ? evals.length : null } : null,
    tasks: tasks ? { done: doneTasks.length, overdue: openOverdue.length,
      recentDone: doneTasks.slice(0, 5).map((t) => t.title) } : null,
    growthHistory: (history || []).map((h) => ({ on: h.happened_on, title: h.title, evidence: h.evidence })),
    autonomy: { level: e.autonomy_level ?? null,
      recent: (autonomy || []).map((a) => ({ from: a.from_level, to: a.to_level, reason: a.reason, at: a.decided_at })) },
    probation: (probation || []).map((p) => ({ checkpoint: p.checkpoint, verdict: p.verdict, decision: p.decision,
      note: p.decision_note, to: p.period_to })),
    managerComments: (reviews || []).filter((r) => r.manager_comment)
      .map((r) => ({ at: r.decided_at || r.created_at, comment: r.manager_comment })),
    links: { goals: "admin-goals.html", growth: "admin-growth.html", autonomy: "admin-autonomy.html",
             nippo: "admin-nippo.html", probation: "admin-probation.html" },
  });
}

async function history(res, sb, ctx) {
  const [rows, emps, m] = await Promise.all([
    must(sb.from("gw_career_reviews").select("*").eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false }).limit(500)),
    scopedEmployees(sb, ctx),
    loadMaster(sb, ctx),
  ]);
  const empById = new Map(emps.map((e) => [e.id, e]));
  const levelById = new Map(m.levels.map((l) => [l.id, l]));
  return json(res, 200, {
    reviews: (rows || []).filter((r) => empById.has(r.employee_id)).map((r) => ({
      id: r.id, employeeId: r.employee_id, employeeName: empById.get(r.employee_id)?.display_name,
      status: r.status, result: r.result, salaryDecision: r.salary_decision,
      fromLevel: levelView(levelById.get(r.from_level_id)), targetLevel: levelView(levelById.get(r.target_level_id)),
      periodFrom: r.review_period_from, periodTo: r.review_period_to,
      achieved: (r.criterion_results || []).filter((x) => x.result === "achieved").length,
      total: (r.criterion_results || []).filter((x) => x.result !== "na").length,
      decidedAt: r.decided_at, createdAt: r.created_at,
    })),
    labels: { reviewResults: REVIEW_RESULTS, salaryDecisions: SALARY_DECISIONS },
  });
}

// ---- 書く ---------------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const a = body?.action;
  const sb = admin();
  const MASTER = ["seedStarter", "saveTrack", "saveLevel", "saveCriterion"];
  if ((MASTER.includes(a) || a === "confirmReview") && !canDecideCareer(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "キャリアマスタの編集と評価の確定は、管理者・経営者だけができます" });
  }
  if (a === "seedStarter") return seedStarter(res, sb, ctx, user);
  if (a === "saveTrack") return saveTrack(res, sb, ctx, user, body);
  if (a === "saveLevel") return saveLevel(res, sb, ctx, user, body);
  if (a === "saveCriterion") return saveCriterion(res, sb, ctx, user, body);
  if (a === "setCareer") return setCareer(res, sb, ctx, user, body);
  if (a === "saveReview") return saveReview(res, sb, ctx, user, body);
  if (a === "confirmReview") return confirmReview(res, sb, ctx, user, body);
  if (a === "requestConfirm") return requestConfirm(res, sb, ctx, user, body);
  return json(res, 400, { error: "invalid_action" });
}

const now = () => new Date().toISOString();
const log = (ctx, user, action, target, detail) =>
  gwLog({ tenantId: ctx.tenantId, actorId: user.id, action, target, detail });

async function seedStarter(res, sb, ctx, user) {
  const exists = await must(sb.from("gw_career_tracks").select("id").eq("tenant_id", ctx.tenantId)
    .eq("name", STARTER.track.name).maybeSingle());
  if (exists) return json(res, 409, { error: "exists", hint: "共通テンプレートはすでに入っています" });
  const t = await must(sb.from("gw_career_tracks").insert({
    tenant_id: ctx.tenantId, ...STARTER.track, sort_order: 0, created_at: now(), updated_at: now(),
  }).select("*").single());
  const levels = await must(sb.from("gw_career_levels").insert(STARTER.levels.map((l, i) => ({
    tenant_id: ctx.tenantId, track_id: t.id, ...l, sort_order: i, created_at: now(), updated_at: now(),
  }))).select("*"));
  const rows = [];
  for (const [no, list] of Object.entries(STARTER.criteria)) {
    const lv = (levels || []).find((l) => l.level_no === Number(no));
    if (!lv) continue;
    list.forEach(([category, title, evidenceType], i) => rows.push({
      tenant_id: ctx.tenantId, level_id: lv.id, category, title, evidence_type: evidenceType,
      required_level: evidenceType === "autonomy" ? 2 : null,
      required: true, weight: 1, sort_order: i, created_at: now(), updated_at: now(),
    }));
  }
  if (rows.length) await must(sb.from("gw_career_criteria").insert(rows));
  await log(ctx, user, "career.master.seed", `career_track:${t.id}`, { levels: levels?.length || 0, criteria: rows.length });
  return json(res, 200, { ok: true, trackId: t.id });
}

async function upsert(sb, table, ctx, id, patch) {
  if (id) {
    const cur = await must(sb.from(table).select("id").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
    if (!cur) return null;
    return must(sb.from(table).update({ ...patch, updated_at: now() }).eq("id", id).eq("tenant_id", ctx.tenantId)
      .select("*").maybeSingle());
  }
  return must(sb.from(table).insert({ tenant_id: ctx.tenantId, ...patch, created_at: now(), updated_at: now() })
    .select("*").single());
}

async function saveTrack(res, sb, ctx, user, b) {
  const name = str(b.name, 60);
  if (!name) return json(res, 400, { error: "no_name", hint: "職種名を入れてください" });
  const row = await upsert(sb, "gw_career_tracks", ctx, b.id, {
    name, description: str(b.description), one_year_goal: str(b.oneYearGoal), three_year_goal: str(b.threeYearGoal),
    is_active: b.isActive !== false, sort_order: int(b.sortOrder) ?? 0,
  });
  if (!row) return json(res, 404, { error: "not_found" });
  await log(ctx, user, "career.track.save", `career_track:${row.id}`, { name });
  return json(res, 200, { track: row });
}

async function saveLevel(res, sb, ctx, user, b) {
  const track = await must(sb.from("gw_career_tracks").select("id").eq("id", b.trackId || "")
    .eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!track) return json(res, 400, { error: "no_track", hint: "職種を選んでください" });
  const levelNo = int(b.levelNo);
  if (!levelNo || levelNo < 1 || levelNo > 20) return json(res, 400, { error: "bad_level_no", hint: "Level の番号は1〜20です" });
  const levelName = str(b.levelName, 80);
  if (!levelName) return json(res, 400, { error: "no_name", hint: "Level の名前を入れてください" });
  const salaryMin = int(b.salaryMin);
  const salaryMax = int(b.salaryMax);
  if ((salaryMin !== null && salaryMin < 0) || (salaryMax !== null && salaryMax < 0)) {
    return json(res, 400, { error: "bad_range", hint: "給与レンジは0以上にしてください" });
  }
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
    return json(res, 400, { error: "bad_range", hint: "給与レンジの下限が上限を超えています" });
  }
  // 同じトラックに同じ番号を2つ作らない
  const dup = await must(sb.from("gw_career_levels").select("id").eq("tenant_id", ctx.tenantId)
    .eq("track_id", track.id).eq("level_no", levelNo).maybeSingle());
  if (dup && dup.id !== b.id) return json(res, 409, { error: "duplicate_level", hint: `Level ${levelNo} はすでにあります` });

  const row = await upsert(sb, "gw_career_levels", ctx, b.id, {
    track_id: track.id, level_no: levelNo, level_name: levelName,
    role_summary: str(b.roleSummary, 200), expected_role: str(b.expectedRole), typical_months: int(b.typicalMonths),
    salary_min: salaryMin, salary_max: salaryMax, next_level_summary: str(b.nextLevelSummary, 300),
    is_active: b.isActive !== false, sort_order: int(b.sortOrder) ?? levelNo,
  });
  if (!row) return json(res, 404, { error: "not_found" });
  await log(ctx, user, "career.level.save", `career_level:${row.id}`,
    { trackId: track.id, levelNo, salaryMin, salaryMax });
  return json(res, 200, { level: levelView(row) });
}

async function saveCriterion(res, sb, ctx, user, b) {
  const level = await must(sb.from("gw_career_levels").select("id").eq("id", b.levelId || "")
    .eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!level) return json(res, 400, { error: "no_level", hint: "Level を選んでください" });
  const category = str(b.category, 40);
  const title = str(b.title, 200);
  if (!category || !title) return json(res, 400, { error: "invalid_body", hint: "カテゴリーと基準を入れてください" });
  const row = await upsert(sb, "gw_career_criteria", ctx, b.id, {
    level_id: level.id, category, title, description: str(b.description),
    required_level: int(b.requiredLevel), required: b.required !== false,
    weight: Number.isFinite(Number(b.weight)) && Number(b.weight) > 0 ? Number(b.weight) : 1,
    evidence_type: EVIDENCE_TYPE_KEYS.includes(b.evidenceType) ? b.evidenceType : "manager",
    sort_order: int(b.sortOrder) ?? 0, is_active: b.isActive !== false,
  });
  if (!row) return json(res, 404, { error: "not_found" });
  await log(ctx, user, "career.criterion.save", `career_criterion:${row.id}`, { levelId: level.id, category, title });
  return json(res, 200, { criterion: row });
}

async function setCareer(res, sb, ctx, user, b) {
  const e = await loadEmployee(sb, ctx, b.employeeId || "");
  if (!e) return json(res, 404, { error: "not_found" });
  const m = await loadMaster(sb, ctx);
  const track = m.tracks.find((t) => t.id === b.trackId);
  if (!track) return json(res, 400, { error: "no_track", hint: "職種を選んでください" });
  const cur = m.levels.find((l) => l.id === b.currentLevelId && l.track_id === track.id);
  if (!cur) return json(res, 400, { error: "no_level", hint: "その職種の Level を選んでください" });
  const target = b.targetLevelId
    ? m.levels.find((l) => l.id === b.targetLevelId && l.track_id === track.id && l.level_no > cur.level_no)
    : nextLevelOf(m.levels, cur);
  if (b.targetLevelId && !target) return json(res, 400, { error: "bad_target", hint: "目標は今より上の Level を選んでください" });
  if (b.nextReviewOn && !isDate(b.nextReviewOn)) return json(res, 400, { error: "bad_date" });

  const existing = (await must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId)
    .eq("employee_id", e.id).eq("is_active", true)))?.[0] || null;
  // Level を直接動かせるのは、はじめの設定のときだけ。
  // 設定したあとの Level の変更は、評価の確定（confirmReview）を通す
  if (existing && (existing.current_level_id !== cur.id || existing.track_id !== track.id) && !canDecideCareer(ctx)) {
    return json(res, 403, { error: "level_change_needs_review",
      hint: "設定後の Level・職種の変更は、評価の確定（管理者・経営者）で行います" });
  }
  // 送られてきた項目だけ書き換える。面談モーダルは STEP ごとに一部だけ送るので、
  // 送っていない項目（本人の希望・管理者メモなど）を空で上書きしない
  const given = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const keep = (k, col, v) => (given(k) || !existing ? v : existing[col] ?? null);
  const patch = {
    track_id: track.id, current_level_id: cur.id, target_level_id: target?.id || null,
    started_at: isDate(b.startedAt) ? b.startedAt : (existing?.started_at || e.joined_on || null),
    next_review_on: keep("nextReviewOn", "next_review_on", b.nextReviewOn || null),
    one_year_target_note: keep("oneYearTargetNote", "one_year_target_note", str(b.oneYearTargetNote)),
    three_year_target_note: keep("threeYearTargetNote", "three_year_target_note", str(b.threeYearTargetNote)),
    employee_wish: keep("employeeWish", "employee_wish", str(b.employeeWish)),
    manager_note: keep("managerNote", "manager_note", str(b.managerNote)),
    agreed_at: b.agreed ? (existing?.agreed_at || now()) : (b.agreed === false ? null : existing?.agreed_at || null),
    updated_by: user.id, updated_at: now(),
  };
  const row = existing
    ? await must(sb.from("gw_employee_careers").update(patch).eq("id", existing.id).select("*").maybeSingle())
    : await must(sb.from("gw_employee_careers").insert({
      tenant_id: ctx.tenantId, employee_id: e.id, is_active: true, created_at: now(), ...patch,
    }).select("*").single());
  await log(ctx, user, existing ? "career.update" : "career.create", `employee:${e.id}`, {
    trackId: track.id, levelNo: cur.level_no, nextReviewOn: patch.next_review_on,
    ...(existing && existing.current_level_id !== cur.id ? { levelChanged: true } : {}),
  });
  return json(res, 200, { career: row });
}

async function reviewContext(sb, ctx, employeeId) {
  const e = await loadEmployee(sb, ctx, employeeId || "");
  if (!e) return { error: 404 };
  const m = await loadMaster(sb, ctx);
  const c = (await must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId)
    .eq("employee_id", e.id).eq("is_active", true)))?.[0];
  if (!c) return { error: 409, hint: "先にキャリアを設定してください" };
  const cur = m.levels.find((l) => l.id === c.current_level_id);
  const target = m.levels.find((l) => l.id === c.target_level_id) || nextLevelOf(m.levels, cur);
  const crit = target ? m.criteria.filter((x) => x.level_id === target.id && x.is_active !== false) : [];
  return { e, m, c, cur, target, crit };
}

async function saveReview(res, sb, ctx, user, b) {
  const r = await reviewContext(sb, ctx, b.employeeId);
  if (r.error) return json(res, r.error, { error: r.error === 404 ? "not_found" : "no_career", hint: r.hint });
  const { e, c, cur, target, crit } = r;
  const results = cleanResults(crit, b.criterionResults);
  const judgement = systemJudgement(crit, results, target);
  const patch = {
    from_level_id: cur?.id || null, target_level_id: target?.id || null,
    review_period_from: isDate(b.periodFrom) ? b.periodFrom : null,
    review_period_to: isDate(b.periodTo) ? b.periodTo : null,
    criterion_results: results,
    evidence_summary: b.evidenceSummary && typeof b.evidenceSummary === "object" ? b.evidenceSummary : null,
    system_judgement: judgement,
    employee_comment: str(b.employeeComment), manager_comment: str(b.managerComment), salary_note: str(b.salaryNote),
    result: REVIEW_RESULT_KEYS.includes(b.result) ? b.result : null,
    salary_decision: SALARY_DECISION_KEYS.includes(b.salaryDecision) ? b.salaryDecision : "none",
    updated_at: now(),
  };
  let row;
  if (b.id) {
    const cur2 = await must(sb.from("gw_career_reviews").select("id, status, employee_id").eq("id", b.id)
      .eq("tenant_id", ctx.tenantId).maybeSingle());
    if (!cur2 || cur2.employee_id !== e.id) return json(res, 404, { error: "not_found" });
    // 確定した評価は直さない（履歴として残す）。直すときは新しい評価を作る
    if (cur2.status === "confirmed") return json(res, 409, { error: "already_confirmed", hint: "確定した評価は変更できません" });
    row = await must(sb.from("gw_career_reviews").update(patch).eq("id", b.id).select("*").maybeSingle());
  } else {
    row = await must(sb.from("gw_career_reviews").insert({
      tenant_id: ctx.tenantId, employee_id: e.id, career_id: c.id, status: "draft",
      created_by: user.id, created_at: now(), ...patch,
    }).select("*").single());
  }
  await log(ctx, user, "career.review.save", `career_review:${row.id}`,
    { employeeId: e.id, achieved: judgement.achieved, total: judgement.total });
  return json(res, 200, { review: row, systemJudgement: judgement });
}

async function confirmReview(res, sb, ctx, user, b) {
  const rv = await must(sb.from("gw_career_reviews").select("*").eq("id", b.id || "")
    .eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!rv) return json(res, 404, { error: "not_found" });
  if (rv.status === "confirmed") return json(res, 409, { error: "already_confirmed" });
  const r = await reviewContext(sb, ctx, rv.employee_id);
  if (r.error) return json(res, r.error, { error: "no_career", hint: r.hint });
  const { e, m, c, target } = r;

  // 最終判断は、押す人が選ぶ。下書きの値を黙って使わない
  const result = b.result;
  if (!REVIEW_RESULT_KEYS.includes(result)) {
    return json(res, 400, { error: "no_result", hint: "最終判断（現Level継続・Level Up・保留）を選んでください" });
  }
  const salaryDecision = SALARY_DECISION_KEYS.includes(b.salaryDecision) ? b.salaryDecision : "none";
  if (result === "level_up" && !target) return json(res, 400, { error: "no_target", hint: "上の Level がありません" });

  const decidedAt = now();
  const saved = await must(sb.from("gw_career_reviews").update({
    status: "confirmed", result, salary_decision: salaryDecision,
    decided_by: user.id, decided_at: decidedAt, updated_at: decidedAt,
    ...(b.managerComment !== undefined ? { manager_comment: str(b.managerComment) } : {}),
    ...(b.salaryNote !== undefined ? { salary_note: str(b.salaryNote) } : {}),
  }).eq("id", rv.id).eq("status", "draft").select("*").maybeSingle());
  if (!saved) return json(res, 409, { error: "already_confirmed" });

  let newLevel = null;
  const careerPatch = { updated_by: user.id, updated_at: decidedAt,
    ...(isDate(b.nextReviewOn) ? { next_review_on: b.nextReviewOn } : {}) };
  if (result === "level_up") {
    newLevel = target;
    const after = nextLevelOf(m.levels, target);
    Object.assign(careerPatch, { current_level_id: target.id, target_level_id: after?.id || null });
  }
  await must(sb.from("gw_employee_careers").update(careerPatch).eq("id", c.id).select("id").maybeSingle());

  await log(ctx, user, "career.review.confirm", `career_review:${rv.id}`, {
    employeeId: e.id, result, salaryDecision,
    ...(newLevel ? { newLevelNo: newLevel.level_no } : {}),
  });
  // 本人へ。中身（管理者メモ・給与の調整メモ）は通知に入れない
  await notify([{
    tenantId: ctx.tenantId, employeeId: e.id, kind: "general",
    title: "キャリア評価が更新されました",
    body: newLevel ? `Level ${newLevel.level_no}「${newLevel.level_name}」になりました` : "キャリア画面で確認できます",
    link: "career.html",
    dedupeKey: `career-review:${rv.id}`,
  }]);

  return json(res, 200, {
    review: saved,
    newLevel: levelView(newLevel),
    // 昇給を検討にしたとき。金額はここでは決めない。契約の更新へ
    contractNext: salaryDecision === "raise" ? {
      message: "新しい給与条件は、労働条件通知書の更新と電子署名で確定します",
      order: `admin-esign.html?tab=order&employeeId=${encodeURIComponent(e.id)}`,
      contracts: "admin-contracts.html",
    } : null,
  });
}

/**
 * 契約・キャリア面談の内容を、本人へ確認依頼する。
 * 本人には1つの依頼（契約・キャリアの確認）として届くが、ここで動くのはキャリアの側だけ。
 * 契約書は既存の作成依頼 → 電子署名で本人に届く（署名は contracts.html）。
 * 何度送ってもよい（面談をやり直したとき）。本人の「確認しました」は、最新の依頼に対して数える
 */
async function requestConfirm(res, sb, ctx, user, b) {
  const e = await loadEmployee(sb, ctx, b.employeeId || "");
  if (!e) return json(res, 404, { error: "not_found" });
  const c = (await must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId)
    .eq("employee_id", e.id).eq("is_active", true)))?.[0] || null;
  if (!c) return json(res, 409, { error: "no_career", hint: "先に現在地（職種・Level）を設定してください" });
  if (!c.next_review_on) return json(res, 400, { error: "no_review_date", hint: "次回評価日を決めてから送ってください" });
  const at = now();
  const row = await must(sb.from("gw_employee_careers").update({
    confirm_requested_at: at, confirm_requested_by: user.id, updated_by: user.id, updated_at: at,
  }).eq("id", c.id).eq("tenant_id", ctx.tenantId).select("*").maybeSingle());
  await log(ctx, user, "career.confirm.request", `employee:${e.id}`, { careerId: c.id });
  // 本人へ。中身（管理者メモなど）は通知に入れない
  await notify([{
    tenantId: ctx.tenantId, employeeId: e.id, kind: "general",
    title: "契約・キャリアの確認があります",
    body: "会社から、現在の契約内容と今後のキャリアプランが届いています。",
    link: "career.html#confirm",
    dedupeKey: `career-confirm:${c.id}:${at}`,
  }]);
  return json(res, 200, { ok: true, requestedAt: at, career: row });
}

// ---- 採用決定 → 契約 → 入社 → キャリア → 育成 ----------------------------------------

function onboardingView({ proc, facts, stage }) {
  const b = intakeBreakdown(facts || {});
  const cur = stageOf(stage.key);
  return {
    procedureId: proc.id, targetOn: proc.target_on || null, stageAt: proc.stage_at || null,
    stage: stage.key, stageN: cur.n, stageLabel: cur.label,
    steps: ONBOARD_STAGES.map((s) => ({ key: s.key, n: s.n, label: s.label, actorLabel: s.actorLabel,
      state: s.n < cur.n || stage.key === "complete" ? "done" : s.n === cur.n ? "now" : "todo" })),
    blockers: stage.blockers || [],
    profileSubmitted: b.profileSubmitted, employeeOpen: b.employeeOpen, internalOpen: b.internalOpen,
    orderStatus: facts?.order?.status || null, signStatus: facts?.sign?.status || null,
    consentsOk: facts ? Boolean(facts.consentsOk) : null,
    links: { hr: `admin-hr.html?id=${encodeURIComponent(proc.id)}`,
             view: `onboarding.html?employeeId=${encodeURIComponent(proc.employee_id)}` },
  };
}

const APPLICANT_FIELDS = "id, tenant_id, name, status, decision, stage, join_date, employment_type, contract_type, "
  + "contract_end_date, probation_months, wage_type, wage_amount, weekly_hours, work_location, recruiter_id, "
  + "employee_id, updated_at, created_at";

/** 採用決定で、まだ社員になっていない人。応募者の情報は採用HRの権限がある人だけ（lib/gw.js canRecruit） */
async function hiredApplicants(sb, ctx) {
  if (!canRecruit(ctx)) return [];
  const rows = await soft(sb.from("gw_hr_applicants").select(APPLICANT_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("decision", "hired").limit(500));
  return (rows || []).filter((a) => !a.employee_id && !["declined", "passed", "done"].includes(a.status));
}

function applicantJourney(ctx, a, today) {
  return journeyOf({
    applicant: a, employee: null, canAdvance: canDecideHire(ctx), today,
    links: { onboard: `admin-onboard.html?applicantId=${encodeURIComponent(a.id)}`,
             applicant: `hr/applicants.html?id=${encodeURIComponent(a.id)}` },
  });
}

async function journeyList(res, sb, ctx) {
  const today = jstToday();
  const [emps, applicants, procs, careers, reviews, contract, plans] = await Promise.all([
    scopedEmployees(sb, ctx),
    hiredApplicants(sb, ctx),
    soft(sb.from("gw_procedures").select("id, tenant_id, employee_id, kind, status, target_on, stage, stage_at, updated_at, created_at")
      .eq("tenant_id", ctx.tenantId).eq("kind", "onboarding").order("created_at", { ascending: false }).limit(1000)),
    must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId).eq("is_active", true)),
    must(sb.from("gw_career_reviews").select("id, employee_id, career_id, status, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "draft").limit(2000)),
    contractState(sb, ctx),
    soft(sb.from("gw_growth_plans").select("id, employee_id, status, start_date, end_date")
      .eq("tenant_id", ctx.tenantId).order("start_date", { ascending: false }).limit(2000)),
  ]);
  const empById = new Map(emps.map((e) => [e.id, e]));
  // 1人につき、いちばん新しい入社手続き（取り消しは除く）。担当範囲の社員だけ
  const procOf = new Map();
  for (const p of procs || []) {
    if (p.status === "cancelled" || !empById.has(p.employee_id) || procOf.has(p.employee_id)) continue;
    procOf.set(p.employee_id, p);
  }
  const procList = [...procOf.values()];
  const items = procList.length ? await soft(sb.from("gw_procedure_items")
    .select("id, procedure_id, item_key, owner, required, status").in("procedure_id", procList.map((p) => p.id))) : [];
  const itemsByProc = new Map();
  for (const i of items || []) {
    if (!itemsByProc.has(i.procedure_id)) itemsByProc.set(i.procedure_id, []);
    itemsByProc.get(i.procedure_id).push(i);
  }
  let factsBy = new Map();
  try { factsBy = await gatherFactsBulk(sb, ctx.tenantId, procList, itemsByProc); } catch { factsBy = new Map(); }
  const careerOf = new Map((careers || []).map((c) => [c.employee_id, c]));
  const draftOf = new Map((reviews || []).map((r) => [r.employee_id, r]));
  const planOf = new Map();
  for (const g of plans || []) if (!planOf.has(g.employee_id)) planOf.set(g.employee_id, g);
  const nameOf = contract.names;

  const rows = [];
  for (const a of applicants) {
    rows.push({
      kind: "applicant", id: a.id, name: a.name, department: a.employment_type || null,
      joinOn: a.join_date || null, updatedAt: a.updated_at || a.created_at || null,
      journey: applicantJourney(ctx, a, today),
    });
  }
  for (const p of procList) {
    const e = empById.get(p.employee_id);
    const c = careerOf.get(e.id) || null;
    const facts = factsBy.get(p.id) || null;
    const stage = facts ? computeStage(facts) : { key: p.stage || "conditions" };
    const careerFlow = flowOf({ career: c, draft: draftOf.get(e.id) || null, orders: contract.ordersOf.get(e.id) || [],
      signs: contract.signsOf.get(e.id) || [], today });
    const g = planOf.get(e.id) || null;
    const journey = journeyOf({
      employee: e, procedure: p, stage, facts, career: c, careerFlow,
      growth: g ? { status: g.status, end_date: g.end_date } : null, links: journeyLinks(e.id, p.id), today,
    });
    const updated = [p.stage_at, p.updated_at, c?.updated_at].filter(Boolean).sort().pop() || null;
    rows.push({
      kind: "employee", id: e.id, name: e.display_name, department: e.department || null,
      joinOn: p.target_on || e.joined_on || null, updatedAt: updated,
      managerName: e.manager_id ? nameOf.get(e.manager_id) || null : null,
      journey,
    });
  }
  // まだ終わっていない人を、流れの前のほうから。同じ段階なら入社日が近い順
  rows.sort((x, y) => (Number(x.journey.state === "active") - Number(y.journey.state === "active"))
    || (x.journey.step - y.journey.step)
    || String(x.joinOn || "9999").localeCompare(String(y.joinOn || "9999")));
  return json(res, 200, { rows, states: JOURNEY_STATES, actors: ACTOR_LABELS, seesApplicants: canRecruit(ctx), today });
}

async function applicantDetail(res, sb, ctx, id) {
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden", hint: "採用HRの権限がある人だけが見られます" });
  const a = await soft(sb.from("gw_hr_applicants").select(APPLICANT_FIELDS).eq("id", id)
    .eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!a || a.decision !== "hired") return json(res, 404, { error: "not_found" });
  if (a.employee_id) return json(res, 409, { error: "already_employee", employeeId: a.employee_id });
  const recruiter = a.recruiter_id ? await soft(sb.from("gw_employees").select("display_name")
    .eq("id", a.recruiter_id).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  return json(res, 200, {
    applicant: {
      id: a.id, name: a.name, status: a.status, joinDate: a.join_date, employmentType: a.employment_type,
      contractType: a.contract_type, contractEndDate: a.contract_end_date, probationMonths: a.probation_months,
      wageType: a.wage_type, wageAmount: a.wage_amount, weeklyHours: a.weekly_hours, workLocation: a.work_location,
      recruiterName: recruiter?.display_name || null,
    },
    journey: applicantJourney(ctx, a, jstToday()),
    canAdvance: canDecideHire(ctx),
    links: { applicant: `hr/applicants.html?id=${encodeURIComponent(a.id)}` },
  });
}

