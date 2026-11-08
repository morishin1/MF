// POST /api/nippo/goal-coach
// 本人の作業内容から、責任者の週次目標に沿う「ゴール/完了条件/次の一手」を下書き。
// このAPIは書き込みをしない。AI呼び出しは本人のボタン操作時のみ。
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

import { jstDate, isDate, weekStart } from "../../lib/nippo.js";
import { draftGoalCoach, draftTomorrowGoalCoach, aiConfigured } from "../../lib/nippo-goal-coach.js";
import { loadTomorrowContext, contextSummary } from "../../lib/nippo-tomorrow-context.js";

function dayPlus(date, days) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET")
    return methodNotAllowed(res, ["GET","POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee?.id) return json(res, 403, { error: "no_membership" });
  res.setHeader("Cache-Control", "private, no-store");
  const body=req.method==="POST"?await readJson(req):null;
  const q=new URL(req.url,"http://localhost").searchParams;
  const mode=req.method==="GET"?"tomorrow":(body?.mode||"today");
  const taskTitle=String(body?.taskTitle??"").trim();
  if(taskTitle.length>200||(mode==="today"&&!taskTitle))
    return json(res,400,{error:"invalid_task",hint:"対象の仕事を200字以内で入力してください"});
  const date=mode==="tomorrow"?(req.method==="GET"?q.get("reportDate"):body?.reportDate):
    (isDate(body?.date)?body.date:jstDate());
  const validDate=isDate(date)&&(mode==="tomorrow"?
    date>=dayPlus(jstDate(),-30)&&date<=jstDate():
    date>=dayPlus(jstDate(),-7)&&date<=dayPlus(jstDate(),7));
  if(!validDate)
    return json(res,400,{error:"invalid_date",hint:"対象の日付を確認してください"});
  const sb=admin();
  let context=null;
  if(mode==="tomorrow"){
    context=await loadTomorrowContext(sb,ctx,date);
    if(context.error)return json(res,503,{error:"context_unavailable",
      hint:"タスク・業務カレンダー・週目標の情報を取得できませんでした。再度お試しください"});
    if(req.method==="GET")return json(res,200,contextSummary(context));
    if(!context.tasks.length&&!context.events.length&&!taskTitle)
      return json(res,400,{error:"no_source_items",
        hint:"次の勤務日のタスクとカレンダー予定がありません。予定を登録するか、取り組む仕事を入力してください"});
  }else if(req.method!=="POST")return methodNotAllowed(res,["POST"]);
  if(!aiConfigured())return json(res,503,{error:"ai_not_configured",
    hint:"AIの接続設定がありません。タスクや予定を確認し、本人が手動でゴールを決めてください"});

  // 1人あたり1日5回まで。失敗したAI呼び出しも課金されうるため、
  // 生成前に「試行」を記録する。入力された仕事名・回答本文はログに残さない。
  const { count: calls, error: capError } = await sb.from("gw_activity_log")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("actor_id", user.id)
    .eq("action", "nippo.goal_coach_attempt")
    .gte("ts", jstDate() + "T00:00:00+09:00");
  if (capError) return json(res, 503, { error: "limit_unavailable", hint: "AIの利用回数を確認できません。管理者にご相談ください" });
  if ((calls ?? 0) >= 5) return json(res, 429, { error: "daily_limit", hint: "今日のAIコーチは5回までです。追加の確認は上司へ相談してください" });

  let confirmedGoal=context?.weekGoal||null;
  if(mode!=="tomorrow"){
    const {data:row,error}=await sb.from("gw_week_goals")
      .select("kgi,kpis,priority_work,status")
      .eq("tenant_id",ctx.tenantId).eq("employee_id",ctx.employee.id)
      .eq("week_start",weekStart(date)).maybeSingle();
    if(error)return json(res,503,{error:"goals_unavailable",hint:"週の目標を確認できません"});
    confirmedGoal=row?.status==="active"?row:null;
  }
  const { error: reserveError } = await sb.from("gw_activity_log").insert({
    tenant_id: ctx.tenantId, actor_id: user.id,
    action: "nippo.goal_coach_attempt", target: "self",
    detail: { date, mode, targetDate:context?.targetDate||date,
      taskCount:context?.tasks?.length||0,eventCount:context?.events?.length||0,
      has_company_goal: Boolean(confirmedGoal?.kgi) },
  });
  if (reserveError) return json(res, 503, { error: "limit_unavailable", hint: "AIの利用履歴を記録できません。今回はAIを呼び出していません" });
  try {
    const {suggestion}=mode==="tomorrow"?
      await draftTomorrowGoalCoach({context,taskTitle}):
      await draftGoalCoach({taskTitle,date,confirmedGoal});
    return json(res,200,{suggestion,
      ...(context?{context:contextSummary(context)}:{}),
      hasCompanyGoal:Boolean(confirmedGoal?.kgi),remaining:Math.max(0,4-(calls??0))});
  } catch (e) {
    console.error("[nippo/goal-coach] generation failed:", e?.message || "error");
    return json(res, 503, { error: "coach_unavailable", hint: "AIの提案を作れませんでした。仕事の完了条件を上司と確認してください" });
  }
}
