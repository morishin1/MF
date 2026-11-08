// Sales企業詳細の商談日時・URLを既存 gw_sales_meetings に保存し、Googleカレンダー追加リンクを返す。
// Google Calendar API/OAuthを呼ばない。Google側で利用者が「保存」したとき予定が作成される。
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid,CLOSED_STATUSES} from "../../lib/sales.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";
import {MEETING_FIELDS,activeMeeting,applyScheduled,shapeMeeting} from "../../lib/sales-meetings.js";
import {validateMeetingCalendarInput,googleCalendarEventUrl} from "../../lib/sales-meeting-calendar.js";
import {gwLog} from "../../lib/gw-audit.js";

const unavailable=(res,e)=>{
 console.error("[sales/company-meeting-calendar]",String(e?.code||"unavailable").slice(0,40));
 return json(res,503,{error:"meeting_unavailable",hint:"商談予定を保存・取得できませんでした。もう一度確認してください。"});
};
const error=(res,status,code,hint)=>json(res,status,{error:code,hint});

async function resolveCompany(db,ctx,companyId){
 const scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return {status:scope.status,error:scope.error};
 const link=await db.from("gw_sales_company_links").select("company_id")
  .eq("tenant_id",ctx.tenantId).eq("source_system","enger")
  .eq("source_company_id",companyId).limit(2);
 if(link.error)throw link.error;
 if(link.data?.length!==1)return {status:409,error:link.data?.length?"ambiguous_link":"sales_link_missing"};
 const sales=await db.from("gw_sales_companies")
  .select("id,name,tenant_id,status,ng_reason,hidden_at,owner_id")
  .eq("tenant_id",ctx.tenantId).eq("id",link.data[0].company_id).maybeSingle();
 if(sales.error)throw sales.error;
 if(!sales.data)return {status:409,error:"sales_company_missing"};
 return {sales:sales.data,companyId,companyName:scope.company.name};
}
async function getLatestMeeting(db,ctx,sales){
 const r=await db.from("gw_sales_meetings").select(MEETING_FIELDS)
   .eq("tenant_id",ctx.tenantId).eq("company_id",sales.id)
   .order("created_at",{ascending:false}).limit(40);
 if(r.error)throw r.error;
 return activeMeeting(r.data||[]);
}
function responseShape(company,meeting){
 const publicMeetingUrl="https://enger.jp/business/meeting?companyId="+encodeURIComponent(company.companyId);
 const result=meeting?shapeMeeting(meeting):null;
 return {
  canSchedule:!company.sales.ng_reason&&!company.sales.hidden_at&&
    !CLOSED_STATUSES.includes(company.sales.status),
  companyName:company.companyName,
  meeting:result,
  customerMeetingUrl:publicMeetingUrl,
  calendarUrl:meeting?.status==="scheduled"&&meeting.scheduled_at?
    googleCalendarEventUrl({
      companyName:company.companyName,scheduledAt:meeting.scheduled_at,
      durationMin:meeting.duration_min||30,meetingUrl:meeting.meeting_url,
      companyMeetingUrl:publicMeetingUrl,
    }):null,
  note:"Googleカレンダーの予定作成画面を開きます。Google側で「保存」を押すまで登録されません。以後の日時変更も自動同期しません。",
 };
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(!["GET","POST"].includes(req.method))return methodNotAllowed(res,["GET","POST"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return json(res,403,{error:"forbidden"});
 const body=req.method==="POST"?await readJson(req):{};
 const params=new URL(req.url||"/","http://localhost").searchParams;
 const companyId=String(req.method==="POST"?body.companyId:params.get("companyId")||"");
 if(!isUuid(companyId))return error(res,400,"invalid_company","企業IDを確認してください。");
 const db=admin();
 try{
  const company=await resolveCompany(db,ctx,companyId);
  if(!company.sales){
   return error(res,company.status||409,company.error||"company_unavailable",
    "Salesの企業IDとの紐づけが必要です。企業基本情報を確認してください。");
  }
  const current=await getLatestMeeting(db,ctx,company.sales);
  if(req.method==="GET")return json(res,200,responseShape(company,current));
  if(company.sales.ng_reason||company.sales.hidden_at||CLOSED_STATUSES.includes(company.sales.status))
   return error(res,403,"company_blocked","営業停止・非表示・終了済みの企業の商談は登録できません。");
  const input=validateMeetingCalendarInput(body);
  if(input.error)return error(res,400,input.error,input.hint);
  const v=input.value;
  const prev=current;
  if(prev?.status==="scheduled"&&
   Date.parse(prev.scheduled_at)===Date.parse(v.scheduledAt)&&
   String(prev.meeting_url||"")===String(v.meetingUrl||"")&&
   Number(prev.duration_min)===v.durationMin){
   return json(res,200,{ok:true,unchanged:true,...responseShape(company,prev)});
  }
  if(prev?.timerex_event_id)return error(res,409,"timerex_managed",
    "TimeRexで確定した予定です。日時やURLの変更はTimeRexから行ってください。");
  let target=prev;
  if(!target){
   const inserted=await db.from("gw_sales_meetings").insert({
     tenant_id:ctx.tenantId,company_id:company.sales.id,
     owner_id:company.sales.owner_id||ctx.employee?.id||null,
     kind:"first_meeting",duration_min:v.durationMin,status:"scheduling",created_by:user.id,
   }).select(MEETING_FIELDS).single();
   if(inserted.error)return unavailable(res,inserted.error);
   target=inserted.data;
  }
  const scheduled=await applyScheduled(db,{
    meeting:target,company:company.sales,scheduledAt:v.scheduledAt,
    meetingUrl:v.meetingUrl,durationMin:v.durationMin,
    employeeId:ctx.employee?.id||null,userId:user.id,
  });
  try {
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:"sales.company_meeting_calendar_schedule",
      target:"sales_company:"+company.sales.id,detail:{meetingId:scheduled.meeting.id}});
  }catch(e){
    // 商談自体は保存済み。監査の補助記録が失敗しても保存失敗と誤表示しない。
    console.error("[sales/company-meeting-calendar] audit_failed",String(e?.code||"unknown").slice(0,30));
  }
  return json(res,200,{ok:true,unchanged:false,...responseShape(company,scheduled.meeting)});
 }catch(e){return unavailable(res,e);}
}
