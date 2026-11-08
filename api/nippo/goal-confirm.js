// A member confirms a concrete work goal; AI output alone never creates this record.
import { json,readJson,methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { isPreJoin,PRE_JOIN_HINT } from "../../lib/stages.js";
import { jstDate,isDate,weekStart } from "../../lib/nippo.js";
import { ROLLOUT_DATE,requiredGoal,timingFor } from "../../lib/nippo-goal-confirm.js";

const fail=(res,status,error,hint)=>json(res,status,{error,hint});
const safeRow=r=>r?{
  workDate:r.work_date,taskTitle:r.task_title,goalText:r.goal_text,doneWhen:r.done_when,
  source:r.source,timing:r.timing,confirmedAt:r.confirmed_at,updatedAt:r.updated_at,
}:null;

export default async function handler(req,res){
  const user=await requireUser(req,res);
  if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!ctx.employee?.id)return fail(res,403,"no_employee","社員名簿の本人情報が確認できません");
  if(isPreJoin(ctx.employee))return fail(res,403,"not_joined",PRE_JOIN_HINT);
  res.setHeader("Cache-Control","private, no-store");
  if(req.method!=="GET"&&req.method!=="POST")return methodNotAllowed(res,["GET","POST"]);
  const body=req.method==="POST"?await readJson(req):null;
  const date=req.method==="GET"?
    new URL(req.url,"http://localhost").searchParams.get("date"):body?.date;
  if(!isDate(date)||date>jstDate()||date<jstDate(-30))
    return fail(res,400,"invalid_date","当日または30日以内の対象日を選択してください");
  const sb=admin();
  const own=()=>sb.from("gw_nippo_goal_confirmations")
    .select("tenant_id,employee_id,user_id,work_date,task_title,goal_text,done_when,source,timing,confirmed_at,updated_at")
    .eq("tenant_id",ctx.tenantId).eq("employee_id",ctx.employee.id)
    .eq("user_id",user.id).eq("work_date",date);
  if(req.method==="GET"){
    const {data,error}=await own().maybeSingle();
    if(error)return fail(res,503,"goal_status_unavailable","ゴールの保存状況を確認できません。再読み込みしてください");
    return json(res,200,{confirmation:safeRow(data),rolloutDate:ROLLOUT_DATE});
  }
  const normalized=requiredGoal(body);
  if(normalized.error)return fail(res,400,"invalid_goal",normalized.error);
  const {data:report,error:reportError}=await sb.from("tc_nippo")
    .select("id,submitted_at,morning_at,goal_image").eq("user_id",user.id)
    .eq("work_date",date).maybeSingle();
  if(reportError)return fail(res,503,"report_unavailable","日報の状態を確認できません");
  if(report?.submitted_at)return fail(res,409,"already_submitted","提出済み日報には後から朝のゴールを追加できません。管理者に記録の確認を依頼してください");
  const [{data:prior,error:priorError},{data:week,error:weekError}]=await Promise.all([
    own().maybeSingle(),
    sb.from("gw_week_goals").select("status,kgi").eq("tenant_id",ctx.tenantId)
      .eq("employee_id",ctx.employee.id).eq("week_start",weekStart(date)).maybeSingle(),
  ]);
  if(priorError||weekError)return fail(res,503,"goal_read_unavailable","確定済みゴールと週目標を確認できません");
  // Source is derived from a supervisor-approved goal, never from client input.
  const source=week?.status==="active"&&String(week?.kgi||"").trim()?"company":"provisional";
  const observedTiming=timingFor(date,{forceLate:body?.late===true});
  const timing=prior?.timing==="late"||observedTiming==="late"?"late":"on_time";
  const now=new Date().toISOString();
  const fields={...normalized,
    tenant_id:ctx.tenantId,employee_id:ctx.employee.id,user_id:user.id,work_date:date,
    task_title:normalized.taskTitle,goal_text:normalized.goalText,done_when:normalized.doneWhen,
    source:prior?.source||source,timing,confirmed_at:prior?.confirmed_at||now,updated_at:now};
  delete fields.taskTitle;delete fields.goalText;delete fields.doneWhen;
  const {data,error}=await sb.from("gw_nippo_goal_confirmations")
    .upsert(fields,{onConflict:"tenant_id,employee_id,work_date"})
    .select("tenant_id,employee_id,user_id,work_date,task_title,goal_text,done_when,source,timing,confirmed_at,updated_at")
    .single();
  if(error){
    console.error("[nippo/goal-confirm]",error.code,error.message);
    return fail(res,503,"goal_save_failed","ゴールを確定できませんでした。入力内容は残しています。再度お試しください");
  }
  // Store only metadata; do not copy sensitive goal text to activity/audit logs.
  const {error:auditError}=await sb.from("gw_activity_log").insert({
    tenant_id:ctx.tenantId,actor_id:user.id,
    action:prior?"nippo.goal_reconfirmed":"nippo.goal_confirmed",
    target:"self",detail:{workDate:date,timing,source},
  });
  if(auditError)console.error("[nippo/goal-confirm] audit",auditError.code);
  return json(res,200,{ok:true,confirmation:safeRow(data)});
}
