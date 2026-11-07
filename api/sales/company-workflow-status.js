// GET /api/sales/company-workflow-status?companyId=<ENGER UUID>
// Evidence-backed progress for the Sales company detail stepper. No mutations.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell,isOwner} from "../../lib/gw.js";
import { pilotFor, safePilotUrl } from "../../lib/sales-company-ai-pilot.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {canManageProposals} from "../../lib/sales-proposals.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";

const short = (v,max=250) => String(v??"").trim().slice(0,max);
const stage = (state,label) => ({state,label});
const unavailable = () => stage("unknown","取得できません");
const countStatus = (result,noun) => result.error ? unavailable()
  : result.count > 0 ? stage("recorded",noun+result.count+"件")
  : stage("pending","未登録");
const summaryStatus = (record,local,prior,company) => {
  if(record && record.status==="completed")return stage("done","AI分析済み");
  if(record && record.status==="failed")return stage("review","AI再調査待ち");
  if(record && record.status==="processing")return stage("review","AI分析中");
  if(local?.approved_at)return stage("done","分析MD保存済み");
  if(prior&&(prior.analysis_summary||prior.business_summary))
    return stage("review","AI下書きあり");
  if(!company.corporate_number&&!company.website)
    return stage("review","法人番号・HP未登録");
  return stage("pending","AI分析待ち");
};

export default async function handler(req,res) {
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  res.setHeader?.("Cache-Control","private, no-store");
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return json(res,403,{error:"forbidden"});
  const companyId=new URL(req.url||"/","http://localhost").searchParams.get("companyId");
  if(!isUuid(companyId))return json(res,400,{error:"invalid_company_id"});
  try {
    const db=admin();
    const scope=await companyInScope(db,ctx.tenantId,companyId);
    if(!scope.ok)return json(res,scope.status,{error:scope.error});
    const [company,analysis,profile,needs,linked,shortlisted,offers,salesLink] = await Promise.all([
      db.schema("enger").from("companies")
        .select("id,name,corporate_number,website").eq("id",companyId)
        .is("deleted_at",null).maybeSingle(),
      db.schema("enger").from("dx2_company_analysis")
        .select("analysis_summary,business_summary,analyzed_at")
        .eq("company_id",companyId).order("analyzed_at",{ascending:false}).limit(1),
      db.schema("enger").from("dx2_company_local_ai_profiles")
        .select("approved_at,profile_json").eq("tenant_id",ctx.tenantId)
        .eq("company_id",companyId).not("approved_at","is",null)
        .order("approved_at",{ascending:false}).limit(1),
      db.schema("enger").from("dx2_company_needs")
        .select("id",{count:"exact",head:true}).eq("company_id",companyId).eq("is_active",true),
      db.schema("enger").from("dx2_company_talent_links")
        .select("id",{count:"exact",head:true}).eq("tenant_id",ctx.tenantId)
        .eq("company_id",companyId).in("status",["saved","planned","proposed"]),
      db.schema("enger").from("dx2_company_sales_shortlist")
        .select("id,published_at,status").eq("tenant_id",ctx.tenantId)
        .eq("company_id",companyId).limit(300),
      db.schema("enger").from("dx2_company_portal_offers")
        .select("id",{count:"exact",head:true}).eq("tenant_id",ctx.tenantId)
        .eq("company_id",companyId),
      db.from("gw_sales_company_links").select("company_id")
        .eq("tenant_id",ctx.tenantId).eq("source_system","enger")
        .eq("source_company_id",companyId).limit(2),
    ]);
    if(company.error||!company.data||analysis.error||salesLink.error)
      return json(res,503,{error:"workflow_sources_unavailable",
        hint:"企業情報・分析履歴を照合できません。進捗を完了扱いにしません。"});
    const c=company.data;
    const links=salesLink.data||[];
    let cloud=null, pilot=null;
    if(links.length===1) {
      const candidate=pilotFor(links[0].company_id);
      if(candidate) pilot={
        salesCompanyId:links[0].company_id,
        eligible:true,
        enabled:process.env.ENGER_COMPANY_AI_PILOT==="enabled",
        canRun:isOwner(ctx)&&process.env.ENGER_COMPANY_AI_PILOT==="enabled"
      };
      const response=await db.from("gw_sales_company_summaries")
        .select("status,summary,processed_at,attempt_count").eq("tenant_id",ctx.tenantId)
        .eq("company_id",links[0].company_id).maybeSingle();
      // A missing optional summary table must not hide the original Sales workflow.
      if(!response.error)cloud=response.data;
    }
    const approved=profile.error?null:profile.data?.[0]||null;
    const older=analysis.data?.[0]||null;
    const ai=summaryStatus(cloud,approved,older,c);
    const need=countStatus(needs,"ニーズ登録 ");
    const match=(linked.error||shortlisted.error)?unavailable()
      : (linked.count||0)+(shortlisted.data||[]).length>0
        ? stage("recorded","候補保存 "+((linked.count||0)+(shortlisted.data||[]).length)+"件")
        : stage("pending","候補未選定");
    const share=shortlisted.error?unavailable()
      : (shortlisted.data||[]).filter(x=>x.published_at).length>0
        ? stage("done","共有 "+shortlisted.data.filter(x=>x.published_at).length+"件")
        : stage("pending","未共有");
    const offersStatus=countStatus(offers,"オファー ");
    const source=cloud?.status==="completed" ? "cloud"
      : approved ? "approved-md" : older&&(older.analysis_summary||older.business_summary)
      ? "existing-ai" : "none";
    let summary=cloud?.status==="completed" ? cloud.summary : "";
    if(!summary&&approved) summary=approved.profile_json?.company_summary;
    if(!summary&&older) summary=older.analysis_summary||older.business_summary;
    return json(res,200,{
      companyId,pilot:pilot&&{...pilot,status:cloud?.status||"unstarted",attemptCount:cloud?.attempt_count||0},
      analysis:{source,summary:short(summary,380),
        hasCorporateNumber:Boolean(c.corporate_number),hasWebsite:Boolean(c.website),
        generatedAt:cloud?.processed_at||approved?.approved_at||older?.analyzed_at||null},
      steps:{info:ai,needs:need,match,portal:share,offers:offersStatus},
      note:"ステータスは記録済みの情報に基づく表示です。ニーズ・案件の募集継続や成約確定を自動保証するものではありません。"
    });
  }catch {
    return json(res,503,{error:"workflow_status_unavailable",
      hint:"営業フローの記録を確認できません。"});
  }
}
