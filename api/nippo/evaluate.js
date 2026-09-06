// POST /api/nippo/evaluate { nippoId }        … その日報をAIに評価させる
// POST /api/nippo/evaluate { nippoId, override:{scores, comment} }
//                                              … 管理者がAI評価を直す
//
// 日報の保存とAI評価は分けてある。
// AIが落ちても日報の提出は成功させたいので、提出時には「評価待ち」の行だけ作り、
// 実際の評価はこの口で行う。画面は提出後にここを1回叩く。
//
// 評価は上書きしない。もう一度回すと行が増える。
// 点数が変わった経緯が消えると、あとから「なぜこの評価だったか」を説明できない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { evaluateNippo, isConfigured, PROMPT_VERSION } from "../../lib/nippo-eval.js";
import { ACTIONS as CRITERIA, score } from "../../lib/scoring.js";
import { planFromNippo, savePlan } from "../../lib/actions.js";

const canReview = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const body = await readJson(req);
  if (!body?.nippoId) return json(res, 400, { error: "invalid_body", required: ["nippoId"] });

  const sb = admin();
  const { data: nippo } = await sb.from("tc_nippo").select("*").eq("id", body.nippoId).maybeSingle();
  if (!nippo) return json(res, 404, { error: "nippo_not_found" });

  // 自分の日報か、読む立場の人か。他人の評価を回させない
  const mine = nippo.user_id === user.id;
  if (!mine && !canReview(ctx)) return json(res, 403, { error: "forbidden" });

  if (body.override) {
    if (!canReview(ctx)) return json(res, 403, { error: "forbidden", hint: "評価の修正は管理者のみです" });
    return saveOverride(res, sb, ctx, user, body);
  }

  if (!isConfigured()) {
    return json(res, 503, {
      error: "not_configured",
      hint: "AI評価の鍵が未設定です（OPENAI_API_KEY または ANTHROPIC_API_KEY）",
    });
  }

  return run(res, sb, ctx, user, nippo, { force: body.force === true && canReview(ctx) });
}

// ---- 評価を回す -------------------------------------------------------------
async function run(res, sb, ctx, user, nippo, { force }) {
  // 既に済んでいれば、それを返す。画面を開き直すたびに課金しない
  const { data: last } = await sb
    .from("gw_nippo_ai_evals").select("*")
    .eq("nippo_id", nippo.id).order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (!force && last?.status === "completed") return json(res, 200, { evaluation: shape(last), cached: true });

  // 走っている最中に二重で叩かれた場合。1分以内なら待ってもらう
  if (!force && last?.status === "processing" && Date.now() - new Date(last.updated_at).getTime() < 60000) {
    return json(res, 202, { evaluation: shape(last), running: true });
  }

  const { data: row, error: ie } = await sb.from("gw_nippo_ai_evals").insert({
    nippo_id: nippo.id,
    user_id: nippo.user_id,
    work_date: nippo.work_date,
    status: "processing",
    prompt_version: PROMPT_VERSION,
  }).select("*").single();
  if (ie) return json(res, 500, { error: "db_insert_failed", detail: ie.message });

  // 前日ぶんは前後関係の参考にだけ渡す。毎回過去を全部送ると高くつく
  const { data: recent } = await sb
    .from("tc_nippo").select("work_items, tomorrow_plan, work_date")
    .eq("user_id", nippo.user_id).lt("work_date", nippo.work_date)
    .order("work_date", { ascending: false }).limit(1);

  const r = await evaluateNippo({ today: nippo, recent: recent || [] });

  const patch = r.ok
    ? {
        status: "completed",
        model: r.model,
        total_score: r.result.total_score,
        categories: r.result.categories,
        scores: r.result.scores,
        good_points: r.result.good_points,
        improvement_points: r.result.improvement_points,
        ai_comment: r.result.ai_comment,
        tomorrow_advice: r.result.tomorrow_advice,
        system_metrics: r.metrics,
        raw_response: r.raw,
        attempts: r.attempts,
        error_detail: null,
        updated_at: new Date().toISOString(),
      }
    : {
        status: "failed",
        system_metrics: r.metrics,
        attempts: r.attempts,
        error_detail: String(r.detail || "").slice(0, 500),
        updated_at: new Date().toISOString(),
      };

  const { data: saved } = await sb
    .from("gw_nippo_ai_evals").update(patch).eq("id", row.id).select("*").single();

  // AIの提案を、翌営業日のダッシュボードに出す。
  // 評価を読んで終わりにせず、次の行動として残るようにする。
  // 本人が書いた「明日の最優先」は提出時に入っているので、ここでは足されない
  if (r.ok) {
    try {
      const plan = planFromNippo({ nippo, evaluation: saved });
      await savePlan(sb, plan, nippo.id);
    } catch (e) {
      // 宿題が作れなくても評価は成立する。画面から足せる
      console.error("[nippo-eval] 次にやることを作れませんでした:", e.message);
    }
  }

  if (!r.ok) {
    return json(res, 502, {
      evaluation: shape(saved),
      error: "ai_failed",
      hint: "AIが応答しませんでした。少し待ってから「もう一度評価する」をお試しください",
    });
  }
  return json(res, 200, { evaluation: shape(saved) });
}

// ---- 管理者による修正 -------------------------------------------------------
// AI評価を最終評価にしない。直した項目だけ manager_scores に残し、
// AIが何点だったかは消さない（あとで基準を見直すときの材料になる）
async function saveOverride(res, sb, ctx, user, body) {
  const { data: last } = await sb
    .from("gw_nippo_ai_evals").select("*")
    .eq("nippo_id", body.nippoId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!last) return json(res, 404, { error: "evaluation_not_found" });

  const keys = CRITERIA.map((c) => c.key);
  const scores = {};
  for (const [k, v] of Object.entries(body.override.scores || {})) {
    if (!keys.includes(k)) continue;
    if (v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return json(res, 400, { error: "invalid_score", hint: "各項目は0〜10の整数です" });
    }
    scores[k] = n;
  }

  // 最終点は「管理者が直した点 ＋ 直していない項目のAI点」を、
  // AIと同じ重み付け（成果40/行動30/成長20/チーム10）で100点に換算して出す
  const merged = Object.fromEntries(keys.map((k) =>
    [k, scores[k] !== undefined ? scores[k] : pickScore(last.scores?.[k])]));
  const { total, categories } = score(merged);

  const { data, error } = await sb.from("gw_nippo_ai_evals").update({
    manager_scores: Object.keys(scores).length ? scores : null,
    manager_comment: String(body.override.comment ?? "").trim().slice(0, 2000) || null,
    manager_total: total,
    manager_categories: categories,
    decided_by: user.id,
    decided_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", last.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "nippo.eval_override",
    target: `nippo:${body.nippoId}`, detail: { changed: Object.keys(scores), total },
  });
  return json(res, 200, { evaluation: shape(data) });
}

const pickScore = (s) => (s && s.status === "evaluated" && Number.isFinite(s.score) ? s.score : null);

/** 画面に返す形。生の応答は返さない（重いうえ、画面では使わない） */
export function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    nippoId: row.nippo_id,
    workDate: row.work_date,
    status: row.status,
    model: row.model,
    promptVersion: row.prompt_version,
    totalScore: row.total_score,
    categories: row.categories,
    scores: row.scores,
    goodPoints: row.good_points || [],
    improvementPoints: row.improvement_points || [],
    aiComment: row.ai_comment,
    tomorrowAdvice: row.tomorrow_advice,
    metrics: row.system_metrics,
    managerScores: row.manager_scores,
    managerComment: row.manager_comment,
    managerTotal: row.manager_total,
    managerCategories: row.manager_categories,
    decidedAt: row.decided_at,
    error: row.error_detail,
    createdAt: row.created_at,
  };
}
