// Company-scoped, read-only, explicitly approved AI research for Sales company info.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";

const bounded=(value,max=1000)=>typeof value==="string"?value.normalize("NFKC").trim().slice(0,max):"";
const intelView=data=>{
 const x=data&&typeof data==="object"&&!Array.isArray(data)?data:{};
 return {
   business_model:bounded(x.business_model,650),
   company_scale:bounded(x.company_scale,450),
   talent_holdings:bounded(x.talent_holdings,650),
   job_holdings:bounded(x.job_holdings,650),
   sales_priorities:bounded(x.sales_priorities,550),
   official_website_findings:bounded(x.official_website_findings,650),
   research_note:bounded(x.research_note,350),
   external_sources:(Array.isArray(x.external_sources)?x.external_sources:[]).slice(0,8)
     .filter(y=>y&&typeof y==="object"&&typeof y.url==="string"&&/^https:\/\//.test(y.url))
     .map(y=>({url:bounded(y.url,600),title:bounded(y.title,150),checked_at:bounded(y.checked_at,30)})),
 };
};
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 res.setHeader?.("Cache-Control","private, no-store");
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return json(res,403,{error:"forbidden"});
 const companyId=new URL(req.url||"/","http://localhost").searchParams.get("companyId");
 if(!isUuid(companyId))return json(res,400,{error:"invalid_company"});
 const db=admin(),scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return json(res,scope.status,{error:scope.error});
 const [profiles,previous]=await Promise.all([
   db.schema("enger").from("dx2_company_local_ai_profiles")
     .select("id,profile_json,approved_at").eq("tenant_id",ctx.tenantId)
     .eq("company_id",companyId).order("approved_at",{ascending:false}).limit(1),
   db.schema("enger").from("dx2_company_analysis")
     .select("analysis_summary,business_summary,analyzed_at")
     .eq("company_id",companyId).order("analyzed_at",{ascending:false}).limit(1),
 ]);
 if(profiles.error||previous.error)return json(res,503,{error:"summary_unavailable",
   hint:"保存された企業サマリーを取得できませんでした。"});
 const approved=profiles.data?.[0]||null;
 const payload=approved?.profile_json||{};
 const legacy=previous.data?.[0]||null;
 const summary=bounded(payload.company_summary,1400)||
   bounded(legacy?.analysis_summary||legacy?.business_summary,1400);
 return json(res,200,{
   companyId,hasSummary:!!summary,hasApprovedAI:!!approved,
   summary,companyIntelligence:intelView(payload.company_intelligence),
   approvedAt:approved?.approved_at||legacy?.analyzed_at||null,
   source:approved?"AI分析・担当者承認済み":legacy?"既存企業分析":"未登録",
   verification:approved?"ai_unverified":"company_record",
   note:approved?"AI調査情報を含むため、規模・保有人材・案件の事実は商談で確認してください。":
     "企業情報MDファイルから分析し、MDアップロードで承認するとサマリーが表示されます。",
 });
}
