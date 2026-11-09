// GET: staff activity for the Sales detailed-analysis tab. No client-supplied
// actor or tenant override. Managers see team; Sales members see only self.
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canManageProposals} from "../../lib/sales-proposals.js";
import {DEFAULT_PERIOD,resolvePeriod} from "../../lib/sales-period.js";
import {admin} from "../../lib/supabase.js";
import {json,methodNotAllowed} from "../../lib/http.js";
import {buildMemberMeetingAnalysis} from "../../lib/sales-meeting-funnel-analysis.js";

const PAGE=500,MAX=12000;
async function readAll(makeQuery){
 const rows=[];
 for(let offset=0;offset<=MAX;offset+=PAGE){
  const n=Math.min(PAGE,MAX-offset+1);
  const result=await makeQuery().order("id",{ascending:true}).range(offset,offset+n-1);
  if(result.error)throw result.error;
  rows.push(...(result.data||[]));
  if(rows.length>MAX)throw Error("too_many_rows");
  if(!result.data||result.data.length<n)return rows;
 }
 throw Error("too_many_rows");
}
export default async function handler(req,res){
 res.setHeader?.("Cache-Control","private, no-store");
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 const user=await requireUser(req,res);
 if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:"forbidden"});
 const query=new URL(req.url||"/","http://localhost").searchParams;
 const period=resolvePeriod(query.get("period")||DEFAULT_PERIOD,{
  from:query.get("from"),to:query.get("to")
 });
 if(period.error)return json(res,400,{error:period.error,hint:period.hint});
 const manager=canManageProposals(ctx),db=admin(),tenant=ctx.tenantId;
 const between=(q,col)=>q.gte(col,period.sinceIso).lt(col,period.untilIso);
 // Restrict at the database query as well as again in the pure aggregator.
 const mine=(q,col)=>manager?q:q.eq(col,user.id);
 try{
  const [shortlists,sessions,closeouts,employees,aiSummaries]=await Promise.all([
   readAll(()=>between(mine(db.schema("enger").from("dx2_company_sales_shortlist")
    .select("id,company_id,published_by,published_at").eq("tenant_id",tenant)
    .eq("status","published"),"published_by"),"published_at")),
   readAll(()=>between(mine(db.from("gw_sales_live_meeting_sessions")
    .select("id,company_id,started_by,started_at").eq("tenant_id",tenant),"started_by"),"started_at")),
   readAll(()=>between(mine(db.from("gw_sales_meeting_closeouts")
    .select("id,company_id,created_by,mail_status,mail_sent_at,outcome").eq("tenant_id",tenant)
    .eq("mail_status","sent"),"created_by"),"mail_sent_at")),
   db.from("gw_employees").select("id,user_id,display_name").eq("tenant_id",tenant)
    .limit(manager?1500:1).then(x=>x),
   manager?readAll(()=>between(db.from("gw_sales_company_summaries")
     .select("company_id,status,processed_at").eq("tenant_id",tenant)
     .eq("status","completed"),"processed_at")):Promise.resolve([]),
  ]);
  if(employees.error)throw employees.error;
  const filtered=manager?(employees.data||[]):(employees.data||[]).filter(x=>x.user_id===user.id);
  const analysis=buildMemberMeetingAnalysis({
   period,employees:filtered,shortlists,sessions,closeouts,aiSummaries,manager,viewerAuthId:user.id,
  });
  return json(res,200,{...analysis,generatedAt:new Date().toISOString()});
 }catch(error){
  if(String(error?.message||"").includes("too_many_rows"))
   return json(res,413,{error:"too_many_rows",hint:"記録件数が上限を超えています。期間を短くして集計してください。"});
  console.error("[sales/meeting-funnel-analysis]",String(error?.code||error?.message||"unknown").slice(0,80));
  return json(res,503,{error:"meeting_funnel_unavailable",hint:"商談分析を取得できませんでした。対象DBの商談履歴テーブルを確認してください。"});
 }
}
