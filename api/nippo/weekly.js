// GET  /api/nippo/weekly?weekStart=YYYY-MM-DD&userId=… … その週の材料と、いまの評価
// POST /api/nippo/weekly {weekStart, userId, action}
//        action="evaluate" … AIに10項目100点で採点させる（保存する）
//        action="save"     … 管理者が点と総評を確定する
//        action="submit"   … 本人へ提出する（ここで初めて本人に見える）
//
// 日次は行動改善、週次は評価。役割を分けている。
// 本人の画面には submitted_at が入ってから出る。下書きのまま見えると
// 「評価が下がった」と誤解される。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { weekStart as toWeekStart, isDate, jstDate } from "../../lib/nippo.js";
import { CRITERIA } from "../../lib/nippo-eval.js";
import {
  weeklyMetrics, evaluateWeek, weekdaysOf, isConfigured, WEEKLY_PROMPT_VERSION,
} from "../../lib/nippo-period.js";

const KEYS = CRITERIA.map((c) => c.key);
const canReview = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canReview(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return act(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

/** その週の材料を集める。評価も採点も、まずこれを土台にする */
async function gather(sb, userId, ws) {
  const days = weekdaysOf(ws);
  const [{ data: nippos }, { data: review }] = await Promise.all([
    sb.from("tc_nippo").select("*")
      .eq("user_id", userId).gte("work_date", days[0]).lte("work_date", days[4])
      .order("work_date"),
    sb.from("tc_weekly_review").select("*")
      .eq("user_id", userId).eq("week_start", ws).maybeSingle(),
  ]);

  const list = nippos || [];
  let evals = [];
  if (list.length) {
    const { data } = await sb.from("gw_nippo_ai_evals").select("*")
      .in("nippo_id", list.map((n) => n.id)).eq("status", "completed")
      .order("created_at", { ascending: false });
    // 1日につき最新の評価だけ
    const seen = new Set();
    for (const e of data || []) {
      if (seen.has(e.nippo_id)) continue;
      seen.add(e.nippo_id);
      evals.push(e);
    }
  }
  return { nippos: list, evals, review: review || null };
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const ws = isDate(q.get("weekStart")) ? toWeekStart(q.get("weekStart")) : toWeekStart(jstDate());
  const userId = q.get("userId");
  if (!userId) return json(res, 400, { error: "invalid_query", required: ["userId"] });

  const sb = admin();
  const { nippos, evals, review } = await gather(sb, userId, ws);

  return json(res, 200, {
    weekStart: ws,
    userId,
    metrics: weeklyMetrics({ weekStart: ws, nippos, evals }),
    review: shape(review),
    criteria: CRITERIA,
    aiConfigured: isConfigured(),
  });
}

// ---- 操作 -------------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const ws = isDate(body?.weekStart) ? toWeekStart(body.weekStart) : toWeekStart(jstDate());
  if (!body?.userId) return json(res, 400, { error: "invalid_body", required: ["userId"] });

  const sb = admin();
  const { data: emp } = await sb.from("gw_employees")
    .select("display_name").eq("user_id", body.userId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  if (body.action === "evaluate") return runAi(res, sb, ctx, user, body.userId, ws, emp);
  if (body.action === "save" || body.action === "submit") {
    return save(res, sb, ctx, user, body, ws, emp);
  }
  return json(res, 400, { error: "unknown_action" });
}

// ---- AIに採点させる ---------------------------------------------------------
async function runAi(res, sb, ctx, user, userId, ws, emp) {
  if (!isConfigured()) {
    return json(res, 503, {
      error: "not_configured",
      hint: "AI評価の鍵が未設定です（OPENAI_API_KEY または ANTHROPIC_API_KEY）",
    });
  }

  const { nippos, evals, review } = await gather(sb, userId, ws);
  if (!nippos.length) {
    return json(res, 400, { error: "no_nippo", hint: "この週の日報がまだありません" });
  }

  const metrics = weeklyMetrics({ weekStart: ws, nippos, evals });
  await upsert(sb, userId, ws, emp, { ai_status: "processing", ai_prompt_version: WEEKLY_PROMPT_VERSION });

  const r = await evaluateWeek({ metrics, nippos, evals, review });

  const patch = r.ok
    ? {
        ai_status: "completed",
        ai_model: r.model,
        ai_scores: r.result.scores,
        ai_total: r.result.total,
        ai_strengths: r.result.strengths,
        ai_improvements: r.result.improvements,
        ai_focus: r.result.focus,
        ai_summary: r.result.summary,
        ai_metrics: metrics,
        ai_error: null,
        ai_generated_at: new Date().toISOString(),
      }
    : {
        ai_status: "failed",
        ai_metrics: metrics,
        ai_error: String(r.detail || "").slice(0, 500),
      };

  const saved = await upsert(sb, userId, ws, emp, patch);
  if (!r.ok) {
    return json(res, 502, {
      review: shape(saved), error: "ai_failed",
      hint: "AIが応答しませんでした。少し待ってからもう一度お試しください",
    });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "nippo.weekly_ai",
    target: `employee:${emp.display_name}`, detail: { week_start: ws, total: r.result.total },
  });
  return json(res, 200, { review: shape(saved), metrics });
}

// ---- 管理者が確定する -------------------------------------------------------
async function save(res, sb, ctx, user, body, ws, emp) {
  const scores = {};
  for (const [k, v] of Object.entries(body.scores || {})) {
    if (!KEYS.includes(k)) continue;
    if (v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return json(res, 400, { error: "invalid_score", hint: "各項目は0〜10の整数です" });
    }
    scores[k] = n;
  }

  const vals = Object.values(scores);
  const total = vals.length
    ? Math.round((vals.reduce((a, b) => a + b, 0) / (vals.length * 10)) * 100)
    : null;

  const patch = {
    eval_scores: vals.length ? scores : null,
    eval_total: total,
    eval_comment: String(body.comment ?? "").trim().slice(0, 4000) || null,
    decided_by: user.id,
    updated_at: new Date().toISOString(),
  };
  // 提出して初めて本人に見える。押さない限り下書きのまま
  if (body.action === "submit") patch.submitted_at = new Date().toISOString();

  const saved = await upsert(sb, body.userId, ws, emp, patch);

  if (body.action === "submit") {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "nippo.weekly_submit",
      target: `employee:${emp.display_name}`, detail: { week_start: ws, total },
    });
  }
  return json(res, 200, { review: shape(saved) });
}

async function upsert(sb, userId, ws, emp, patch) {
  const { data, error } = await sb.from("tc_weekly_review").upsert({
    user_id: userId,
    user_name: emp.display_name,
    week_start: ws,
    ...patch,
  }, { onConflict: "user_id,week_start" }).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

/** 画面に返す形 */
export function shape(w) {
  if (!w) return null;
  return {
    weekStart: w.week_start,
    userId: w.user_id,
    userName: w.user_name,
    // 本人の振り返り4問
    q1: w.q1, q2: w.q2, q3: w.q3, q4: w.q4,
    // AIの採点
    aiStatus: w.ai_status,
    aiScores: w.ai_scores,
    aiTotal: w.ai_total,
    aiStrengths: w.ai_strengths || [],
    aiImprovements: w.ai_improvements || [],
    aiFocus: w.ai_focus || [],
    aiSummary: w.ai_summary,
    aiModel: w.ai_model,
    aiError: w.ai_error,
    aiMetrics: w.ai_metrics,
    // 管理者が確定した点
    evalScores: w.eval_scores,
    evalTotal: w.eval_total,
    evalComment: w.eval_comment,
    submittedAt: w.submitted_at,
  };
}
