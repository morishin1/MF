// GET  /api/career/me                          … 自分のキャリア（現在地・次のLevel・次にやること・1年/3年・
//                                                できるようになったこと・前回評価）
// POST /api/career/me {action:"addGoal", criterionId} … 次のLevelの基準を、自分のタスクに加える
//
// ■ 本人に見せるもの・見せないもの（§32）
//   見せる   … 現在のLevel・役割・次Levelの条件と給与レンジ・進捗・次回評価日・
//              1年後/3年後の目安・できるようになったこと・確定済みの評価・次のアクション
//   見せない … 管理者メモ（manager_note）・給与の調整メモ（salary_note）・下書きの評価・
//              システム判定・他の社員
//   進捗は「確定済み」の評価だけから作る。下書きは本人の画面に一切出ない。
//
// ■ 現在給与は契約（gw_contracts の active）から読む。キャリア側には持たない。
// ■ 給与レンジは「目安」。必ず RANGE_NOTE を添える（保証ではない）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import {
  levelsOf, nextLevelOf, horizonLevel, progressOf, rangeText,
  CRITERION_RESULTS, REVIEW_RESULTS, RANGE_NOTE, TIMELINE_NOTE,
} from "../../lib/career.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません" });
  try {
    if (req.method === "GET") return await read(res, ctx, user);
    if (req.method === "POST") return await act(req, res, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, "db/092_career.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[career/me]", e?.message || e);
    return json(res, 500, { error: "career_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const soft = async (q) => { try { const { data, error } = await q; return error ? null : data; } catch { return null; } };

/** 本人に見せる Level の形。役割と、給与レンジ（目安）だけ */
const levelView = (l) => (l ? {
  id: l.id, levelNo: l.level_no, levelName: l.level_name, roleSummary: l.role_summary,
  expectedRole: l.expected_role, nextLevelSummary: l.next_level_summary, typicalMonths: l.typical_months,
  salaryRange: rangeText(l),
} : null);

async function mine(sb, ctx) {
  const careers = await must(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id).eq("is_active", true));
  const c = careers?.[0] || null;
  if (!c) return { c: null };
  const [track, levels] = await Promise.all([
    must(sb.from("gw_career_tracks").select("*").eq("id", c.track_id).eq("tenant_id", ctx.tenantId).maybeSingle()),
    must(sb.from("gw_career_levels").select("*").eq("tenant_id", ctx.tenantId).eq("track_id", c.track_id)
      .order("level_no", { ascending: true })),
  ]);
  const byId = new Map((levels || []).map((l) => [l.id, l]));
  const cur = byId.get(c.current_level_id) || null;
  const next = byId.get(c.target_level_id) || nextLevelOf(levels, cur);
  const criteria = next ? (await must(sb.from("gw_career_criteria").select("*").eq("tenant_id", ctx.tenantId)
    .eq("level_id", next.id).order("sort_order", { ascending: true }))).filter((x) => x.is_active !== false) : [];
  return { c, track, levels: levels || [], cur, next, criteria };
}

async function read(res, ctx, user) {
  const sb = admin();
  const { c, track, levels, cur, next, criteria } = await mine(sb, ctx);
  // できるようになったことは auth.users.id で持っている（db/031）。本人のものだけ
  const history = await soft(sb.from("gw_growth_history").select("happened_on, title, source")
    .eq("user_id", user.id).order("happened_on", { ascending: false }).limit(30));
  const growthHistory = (history || []).map((h) => ({ on: h.happened_on, title: h.title }));

  if (!c) {
    return json(res, 200, {
      career: null,
      message: "キャリアはまだ設定されていません。上長との初回キャリア面談のあとで表示されます。",
      growthHistory,
    });
  }

  // 確定済みの評価だけ（下書きは本人に見せない）
  const reviews = await must(sb.from("gw_career_reviews")
    .select("id, status, result, target_level_id, from_level_id, criterion_results, manager_comment, employee_comment, review_period_from, review_period_to, decided_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id).eq("status", "confirmed")
    .order("decided_at", { ascending: false }).limit(10));
  const last = (reviews || [])[0] || null;
  const results = last && next && last.target_level_id === next.id ? last.criterion_results : [];
  const progress = next ? progressOf(criteria, results) : null;

  const contracts = await soft(sb.from("gw_contracts").select("wage_type, wage_amount, created_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1));
  const wage = contracts?.[0] || null;

  const oneYear = horizonLevel(levels, cur, 12);
  const threeYear = horizonLevel(levels, cur, 36);
  const levelById = new Map(levels.map((l) => [l.id, l]));

  return json(res, 200, {
    career: {
      trackName: track?.name || null,
      nextReviewOn: c.next_review_on,
      oneYearTargetNote: c.one_year_target_note,
      threeYearTargetNote: c.three_year_target_note,
      employeeWish: c.employee_wish,
      agreed: Boolean(c.agreed_at),
    },
    currentLevel: levelView(cur),
    nextLevel: levelView(next),
    currentWage: wage ? { wageType: wage.wage_type, wageAmount: wage.wage_amount } : null,
    rangeNote: RANGE_NOTE,
    progress: progress ? {
      achieved: progress.achieved, total: progress.total,
      categories: progress.categories.map((g) => ({ category: g.category, achieved: g.achieved, total: g.total,
        items: g.items.map((i) => ({ id: i.id, title: i.title, status: i.status, required: i.required })) })),
      // 次のLevelまで、あと何をすればよいか（最優先で見せる）
      remaining: progress.remaining.map((i) => ({ id: i.id, category: i.category, title: i.title,
        description: i.description, status: i.status, required: i.required })),
    } : null,
    horizon: {
      oneYear: { level: levelView(oneYear), goal: track?.one_year_goal || null },
      threeYear: { level: levelView(threeYear), goal: track?.three_year_goal || null },
      note: TIMELINE_NOTE,
    },
    growthHistory,
    lastReview: last ? {
      decidedAt: last.decided_at, result: last.result,
      periodFrom: last.review_period_from, periodTo: last.review_period_to,
      managerComment: last.manager_comment, employeeComment: last.employee_comment,
      fromLevel: levelView(levelById.get(last.from_level_id)),
      targetLevel: levelView(levelById.get(last.target_level_id)),
      achieved: (last.criterion_results || []).filter((x) => x.result === "achieved").length,
      total: (last.criterion_results || []).filter((x) => x.result !== "na").length,
    } : null,
    labels: { criterionResults: CRITERION_RESULTS, reviewResults: REVIEW_RESULTS },
  });
}

async function act(req, res, ctx, user) {
  const body = await readJson(req);
  if (body?.action !== "addGoal") return json(res, 400, { error: "invalid_action" });
  const sb = admin();
  const { c, next, criteria } = await mine(sb, ctx);
  if (!c || !next) return json(res, 409, { error: "no_next_level" });
  // 自分の次のLevelの基準だけ。他人の基準・他のLevelの基準は選べない
  const crit = (criteria || []).find((x) => x.id === body.criterionId);
  if (!crit) return json(res, 404, { error: "not_found" });

  const title = `［キャリア］${crit.title}`;
  const open = await soft(sb.from("gw_tasks").select("id, status").eq("tenant_id", ctx.tenantId)
    .eq("assignee_id", ctx.employee.id).eq("title", title));
  if ((open || []).some((t) => !["done", "cancelled"].includes(t.status))) {
    return json(res, 200, { ok: true, already: true });
  }
  const { data, error } = await sb.from("gw_tasks").insert({
    tenant_id: ctx.tenantId, title,
    body: `Level ${next.level_no}「${next.level_name}」に向けて（${crit.category}）`,
    assignee_id: ctx.employee.id, category: "career", priority: "normal", status: "todo",
    created_by: user.id,
  }).select("id").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  return json(res, 200, { ok: true, taskId: data.id });
}
