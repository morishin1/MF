// Read-only, user-scoped material for an AI draft of the next working day's goal.
// Never send private events, task descriptions, participants, email, notes or other employees' work.
import { nextFocusDate } from "./focus.js";
import { weekStart } from "./nippo.js";

const after = date => {
  const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);
};
const timeJst=v=>v?new Date(new Date(v).getTime()+9*3600000).toISOString().slice(11,16):null;
const clip=(v,max=120)=>String(v||"").replace(/[\r\n\t]+/g," ").trim().slice(0,max);
const safeEvents=rows=>(rows||[])
  .filter(e=>e.title?.trim()&&e.category!=="private"&&
    (e.all_day||(e.ends_at&&Date.parse(e.ends_at)>Date.parse(e.starts_at))))
  .slice(0,12).map(e=>({title:clip(e.title),start:e.all_day?"終日":timeJst(e.starts_at),
    end:e.all_day?"終日":timeJst(e.ends_at),allDay:!!e.all_day}));
const taskSort=(a,b)=>{
  const ranked=a.focus_date===a.targetDate?0:1,rankedB=b.focus_date===b.targetDate?0:1;
  if(ranked!==rankedB)return ranked-rankedB;
  const priority=t=>t.priority==="high"?0:t.priority==="normal"?1:2;
  return priority(a)-priority(b)||String(a.due_on||"9999-99-99").localeCompare(String(b.due_on||"9999-99-99"));
};
export function selectTomorrowTasks(rows,targetDate){
  const filtered=(rows||[]).filter(t=>["todo","doing"].includes(t.status)&&!t.is_template&&
    (t.focus_date===targetDate||(t.due_on&&t.due_on<=targetDate)));
  const enriched=filtered.map(t=>({...t,targetDate}));
  const unique=new Set();
  return enriched.sort(taskSort).filter(t=>t.title?.trim()&&!unique.has(t.id)&&unique.add(t.id))
    .slice(0,12).map(t=>({id:t.id,title:clip(t.title),priority:t.priority||"normal",
      dueOn:t.due_on||null,focus:t.focus_date===targetDate,
      doneWhen:clip(t.done_condition||"",150)}));
}
export function selectTomorrowEvents(rows){return safeEvents(rows);}
export function contextSummary(context){
  return {targetDate:context.targetDate,hasCompanyGoal:!!context.weekGoal?.kgi,
    taskCount:context.tasks.length,eventCount:context.events.length,
    tasks:context.tasks,events:context.events,
    weekGoal:context.weekGoal?{kgi:context.weekGoal.kgi,kpis:context.weekGoal.kpis||[]}:null};
}
export async function loadTomorrowContext(sb,ctx,reportDate){
  const targetDate=nextFocusDate(reportDate);
  if(!targetDate||!ctx?.employee?.id||!ctx?.tenantId)return {error:"invalid_context"};
  const from=targetDate+"T00:00:00+09:00",to=after(targetDate)+"T00:00:00+09:00";
  const [tasksResult,calendarResult,goalResult]=await Promise.all([
    sb.from("gw_tasks").select("id,title,status,priority,due_on,focus_date,is_template,done_condition")
      .eq("tenant_id",ctx.tenantId).eq("assignee_id",ctx.employee.id)
      .in("status",["todo","doing"])
      .order("due_on",{ascending:true,nullsFirst:false}).limit(250),
    sb.from("gw_calendar_events").select("id,title,category,source,all_day,starts_at,ends_at")
      .eq("tenant_id",ctx.tenantId).eq("employee_id",ctx.employee.id)
      .eq("source","self").neq("category","private")
      .gte("starts_at",from).lt("starts_at",to).order("starts_at").limit(200),
    sb.from("gw_week_goals").select("kgi,kpis,priority_work,status")
      .eq("tenant_id",ctx.tenantId).eq("employee_id",ctx.employee.id)
      .eq("week_start",weekStart(targetDate)).maybeSingle(),
  ]);
  if(tasksResult.error||calendarResult.error||goalResult.error)
    return {error:"source_unavailable",targetDate,sources:{
      tasks:!tasksResult.error,calendar:!calendarResult.error,weekGoal:!goalResult.error,
    }};
  const g=goalResult.data?.status==="active"?goalResult.data:null;
  return {targetDate,reportDate,
    tasks:selectTomorrowTasks(tasksResult.data,targetDate),
    events:selectTomorrowEvents(calendarResult.data),
    weekGoal:g?.kgi?{kgi:clip(g.kgi,400),kpis:Array.isArray(g.kpis)?g.kpis.slice(0,5).map(k=>({
      name:clip(k.name,70),target:k.target,unit:clip(k.unit,18),
    })):[],priorityWork:clip(g.priority_work,250)}:null,
    sourceNames:["自分の未完了タスク","自分の業務カレンダー","公開済み週ゴール"],
  };
}
