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
import { shapeBlocker, forPrompt } from "../../lib/blockers.js";
import { summarizeForShare } from "../../lib/nippo-share.js";

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

  if (!force && last?.status === "completed") {
    // 評価は済んでいるのに共有サマリーだけ失敗した日を、再評価せずに補完する。
    // 既に共有があればAIは呼ばない。
    await ensureShare(sb, ctx, nippo);
    return json(res, 200, { evaluation: shape(last), cached: true });
  }

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
  const [{ data: recent }, { data: emp }, { data: open }] = await Promise.all([
    sb.from("tc_nippo").select("work_items, tomorrow_plan, work_date")
      .eq("user_id", nippo.user_id).lt("work_date", nippo.work_date)
      .order("work_date", { ascending: false }).limit(1),
    // 自走レベル。同じ日報でも、L1には手順を、L3には問いを返させる
    sb.from("gw_employees").select("autonomy_level")
      .eq("user_id", nippo.user_id).limit(1),
    // 止まったままの仕事。あるなら、明日の1件はそこから出させる
    sb.from("gw_blockers").select("*")
      .eq("user_id", nippo.user_id).eq("status", "open")
      .order("blocked_since").limit(5),
  ]);

  const level = emp?.[0]?.autonomy_level || 1;
  const blockers = (open || []).map((b) => shapeBlocker(b, nippo.work_date));

  const r = await evaluateNippo({
    today: nippo, recent: recent || [],
    level, blockers: forPrompt(blockers),
  });

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
        // 達成度。本人の画面のいちばん上に出る
        achievement: r.result.achievement,
        tomorrow_advice: r.result.tomorrow_advice,
        // 止まりそうな困りごとの候補。ここではまだ Blocker にしない。
        // 上げるかどうかは本人が押す
        blocker_candidates: r.result.blocker_candidates || [],
        autonomy_level: level,
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

  // AIの提案（tomorrow_advice・improvement_points）は評価結果として
  // 本人の画面に出るだけで、もう gw_action_items への自動起票はしない
  // （gw_tasks/gw_focus_days が Single Source of Truth のため）
  if (r.ok) {
    // みんなの日報に出すサマリー。評価とは別の呼び出しにしてある。
    // 点数・未達理由・相談事項を渡さないためで、渡していないものは書かれない
    await buildShare(sb, ctx, nippo);
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

// 評価済みなのに共有だけ無い場合の補完。既存共有は触らず、AI課金も増やさない。
const SHARE_IDENTITY = "id,tenant_id,nippo_id,user_id,work_date,visible";
const sameShare = (s, ctx, n) => Boolean(s?.id && s.tenant_id === ctx.tenantId &&
  s.nippo_id === n.id && s.user_id === n.user_id && s.work_date === n.work_date &&
  typeof s.visible === "boolean");

export async function ensureShare(sb, ctx, nippo) {
  try {
    const { data, error } = await sb.from("gw_nippo_shares").select(SHARE_IDENTITY).eq("nippo_id", nippo.id).maybeSingle();
    // An unreadable visibility setting is not evidence that no share exists.
    if (error) return false;
    if (data) return sameShare(data, ctx, nippo);
    return await buildShare(sb, ctx, nippo);
  } catch (e) {
    console.error("[nippo-eval] 共有サマリーの補完に失敗:", e.message);
    return false;
  }
}

// ---- みんなの日報に出すサマリー ------------------------------------------------
// 公開してよい4項目（今日やったこと・成果・学び・明日やること）だけを持つ
// 別の表に入れる。点数・未達理由・相談事項は、この表に列そのものが無い。
// 失敗しても評価は成立させる。共有は後から作り直せる
export async function buildShare(sb, ctx, nippo) {
  try {
    const { data: prev, error: readError } = await sb.from("gw_nippo_shares")
      .select(SHARE_IDENTITY).eq("nippo_id", nippo.id).maybeSingle();
    if (readError || (prev && !sameShare(prev, ctx, nippo))) return false;
    // Do not regenerate or publish a summary the author deliberately hid.
    if (prev?.visible === false) return true;

    const s = await summarizeForShare(nippo);
    if (!s.ok) return false;

    const summary = {
      did: s.result.did,
      result: s.result.result,
      learn: s.result.learn,
      tomorrow: s.result.tomorrow,
      model: s.model,
      updated_at: new Date().toISOString(),
    };
    // Never write a visibility value read before an AI call back over a newer hide.
    // Existing identity is immutable here. If it changed or was hidden, update nothing.
    const write = prev
      ? sb.from("gw_nippo_shares").update(summary).eq("id", prev.id)
        .eq("tenant_id", ctx.tenantId).eq("nippo_id", nippo.id)
        .eq("user_id", nippo.user_id).eq("work_date", nippo.work_date).eq("visible", true)
      : sb.from("gw_nippo_shares").insert({ ...summary, tenant_id: ctx.tenantId,
        nippo_id: nippo.id, user_id: nippo.user_id, user_name: nippo.user_name,
        work_date: nippo.work_date, visible: true });
    // Only a complete summary is inserted. A concurrent creator wins the unique
    // nippo_id constraint; never retry that conflict with an overwriting upsert.
    const { data: saved, error } = await write.select("id").maybeSingle();
    if (error) {
      console.error("[nippo-eval] 共有サマリーを保存できませんでした:", error.message);
      return false;
    }
    return Boolean(saved?.id);
  } catch (e) {
    console.error("[nippo-eval] 共有サマリーを作れませんでした:", e.message);
    return false;
  }
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
    achievement: row.achievement,
    tomorrowAdvice: row.tomorrow_advice,
    blockerCandidates: row.blocker_candidates || [],
    autonomyLevel: row.autonomy_level,
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
