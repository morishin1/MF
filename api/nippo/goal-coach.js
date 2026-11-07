// POST /api/nippo/goal-coach
// 本人の作業内容から、責任者の週次目標に沿う「ゴール/完了条件/次の一手」を下書き。
// このAPIは書き込みをしない。AI呼び出しは本人のボタン操作時のみ。
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate, isDate, weekStart } from "../../lib/nippo.js";
import { draftGoalCoach, aiConfigured } from "../../lib/nippo-goal-coach.js";

function dayPlus(date, days) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee?.id) return json(res, 403, { error: "no_membership" });
  res.setHeader("Cache-Control", "private, no-store");
  const body = await readJson(req);
  const taskTitle = String(body?.taskTitle ?? "").trim();
  if (!taskTitle || taskTitle.length > 200) {
    return json(res, 400, { error: "invalid_task", hint: "取り組む仕事を200字以内で入力してください" });
  }
  const date = isDate(body?.date) ? body.date : jstDate();
  if (date < dayPlus(jstDate(), -7) || date > dayPlus(jstDate(), 7)) {
    return json(res, 400, { error: "invalid_date", hint: "対象日は前後7日以内を指定してください" });
  }
  if (!aiConfigured()) return json(res, 503, { error: "ai_not_configured", hint: "AIの接続設定がありません。上司にゴールを確認してください" });

  // 1人あたり1日5件を上限にする。AIは押したときだけ実行し、費用の暴走を抑える。
  // 操作ログには入力された作業名・AIの回答・個人情報を保存しない。
  const sb = admin();
  const { count: calls, error: capError } = await sb.from("gw_activity_log")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("actor_id", user.id)
    .eq("action", "nippo.goal_coach")
    .gte("ts", jstDate() + "T00:00:00+09:00");
  if (capError) return json(res, 503, { error: "limit_unavailable", hint: "AIの利用回数を確認できません。管理者にご相談ください" });
  if ((calls ?? 0) >= 5) return json(res, 429, { error: "daily_limit", hint: "今日のAIコーチは5回までです。追加の確認は上司へ相談してください" });

  const { data: row, error } = await sb.from("gw_week_goals")
    .select("kgi,kpis,priority_work,status")
    .eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id)
    .eq("week_start", weekStart(date))
    .maybeSingle();
  if (error) return json(res, 503, { error: "goals_unavailable", hint: "今週の目標を確認できません。再度お試しください" });
  const confirmedGoal = row?.status === "active" ? row : null;
  try {
    const { suggestion } = await draftGoalCoach({ taskTitle, date, confirmedGoal });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "nippo.goal_coach",
      target: "self", detail: { date, has_company_goal: Boolean(confirmedGoal?.kgi) } });
    return json(res, 200, { suggestion, hasCompanyGoal: Boolean(confirmedGoal?.kgi), remaining: Math.max(0, 4 - (calls ?? 0)) });
  } catch (e) {
    console.error("[nippo/goal-coach] generation failed:", e?.message || "error");
    return json(res, 503, { error: "coach_unavailable", hint: "AIの提案を作れませんでした。仕事の完了条件を上司と確認してください" });
  }
}
