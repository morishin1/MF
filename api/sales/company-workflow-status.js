// Company workflow: ① basic public identity ② AI research ③ proposal preparation.
// No "shared / offers / won" stages: offers belong to Sales proposal management.
// Never count AI hypotheses as confirmed demand or infer company links by name.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell,isOwner} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";

const text=(v,n=400)=>String(v??"").trim().slice(0,n);
const step=(state,label)=>({state,label});
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 res.setHeader?.("Cache-Control","private, no-store");
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return json(res,403,{error:"forbidden"});
 const id=new URL(req.url||"/","http://localhost").searchParams.get("companyId");
 if(!isUuid(id))return json(res,400,{error:"invalid_company_id"});
 const db=admin(),scope=await companyInScope(db,ctx.tenantId,id);
 if(!scope.ok)return json(res,scope.status,{error:scope.error});
 try{
  const [c,a,approved,needs,linked,shortlist,members,salesLink,batch] = await Promise.all([
   db.schema("enger").from("companies").select("id,name,corporate_number,website")
     .eq("id",id).is("deleted_at",null).maybeSingle(),
   db.schema("enger").from("dx2_company_analysis")
     .select("analysis_summary,business_summary,analyzed_at")
     .eq("company_id",id).order("analyzed_at",{ascending:false}).limit(1),
   db.schema("enger").from("dx2_company_local_ai_profiles")
     .select("approved_at,profile_json").eq("tenant_id",ctx.tenantId).eq("company_id",id)
     .not("approved_at","is",null).order("approved_at",{ascending:false}).limit(1),
   db.schema("enger").from("dx2_company_needs").select("id",{count:"exact",head:true})
     .eq("company_id",id).eq("is_active",true),
   db.schema("enger").from("dx2_company_talent_links").select("id",{count:"exact",head:true})
     .eq("tenant_id",ctx.tenantId).eq("company_id",id)
     .in("status",["saved","planned","proposed"]),
   db.schema("enger").from("dx2_company_sales_shortlist")
     .select("status,published_at").eq("tenant_id",ctx.tenantId).eq("company_id",id).limit(200),
   db.schema("enger").from("dx2_company_portal_members")
     .select("id",{count:"exact",head:true}).eq("tenant_id",ctx.tenantId).eq("company_id",id)
     .is("disabled_at",null).not("auth_user_id","is",null),
   db.from("gw_sales_company_links").select("company_id").eq("tenant_id",ctx.tenantId)
     .eq("source_system","enger").eq("source_company_id",id).limit(2),
   db.from("gw_sales_company_ai_pilot_batches").select("sales_company_ids,enger_company_ids")
     .eq("tenant_id",ctx.tenantId).maybeSingle(),
  ]);
  if(c.error||!c.data||a.error||salesLink.error)
    return json(res,503,{error:"company_evidence_unavailable"});
  const company=c.data,links=salesLink.data||[],aSaved=approved.error?null:approved.data?.[0]||null;
  let cloud=null;
  if(links.length===1){
    const r=await db.from("gw_sales_company_summaries")
     .select("status,summary,facts,match_signals,sources,unknowns,next_actions,processed_at,attempt_count")
     .eq("tenant_id",ctx.tenantId).eq("company_id",links[0].company_id).maybeSingle();
    if(!r.error)cloud=r.data;
  }
  const legacy=a.data?.[0]||null;
  const hasNumber=Boolean(company.corporate_number),hasWebsite=Boolean(company.website);
  const basic=hasNumber&&hasWebsite?step("done","基本情報登録済み")
    :step("review",!hasNumber&&!hasWebsite?"法人番号・HP未登録":"未登録項目あり");
  const completed=cloud?.status==="completed",hasApproved=Boolean(aSaved),hasOlder=Boolean(legacy?.analysis_summary||legacy?.business_summary);
  const ai=completed?step("done","AI分析済み"):hasApproved?step("done","分析MD保存済み")
    :cloud?.status==="failed"?step("review","再調査が必要")
    :cloud?.status==="processing"?step("review","分析中")
    :hasOlder?step("review","旧分析あり"):step("pending","AI分析待ち");
  const matched=linked.error?null:linked.count;
  const saved=shortlist.error?null:(shortlist.data||[]).length;
  const published=shortlist.error?null:(shortlist.data||[]).filter(x=>x.status==="published"&&x.published_at).length;
  const proposed=published>0?step("done","商談用候補 "+published+"件")
    :saved===null||matched===null?step("unknown","照合中")
    :saved+matched>0?step("recorded","候補保存 "+(saved+matched)+"件")
    :step("pending","候補未選定");
  const hypothesis=completed?cloud.match_signals||{}:{};
  const legacyText=aSaved?.profile_json?.company_summary||
    legacy?.analysis_summary||legacy?.business_summary||"";
  // Use the private company-business Preview for isolated end-to-end testing.
  // Production always links to enger.jp, and no external user-supplied URLs are accepted.
  const portalPreview=String(process.env.ENGER_BUSINESS_PORTAL_ORIGIN||"");
  const portalOrigin=process.env.VERCEL_ENV==="preview"&&
    /^https:\/\/enger-[a-z0-9-]+\.vercel\.app$/.test(portalPreview)
      ?portalPreview:"https://enger.jp";
  const pilotSelected=!batch.error&&batch.data?.enger_company_ids?.includes(id)&&
    links.length===1&&batch.data?.sales_company_ids?.includes(links[0].company_id);
  const pilot=pilotSelected?{
    eligible:true,salesCompanyId:links[0].company_id,
    enabled:process.env.ENGER_COMPANY_AI_PILOT==="enabled",
    canRun:isOwner(ctx)&&process.env.ENGER_COMPANY_AI_PILOT==="enabled",
    status:cloud?.status||"unstarted",attemptCount:cloud?.attempt_count||0,
  }:null;
  return json(res,200,{
    companyId:id,
    steps:{info:basic,analysis:ai,proposal:proposed},
    analysis:{
      source:completed?"cloud":hasApproved?"approved-md":hasOlder?"existing-ai":"none",
      summary:text(completed?cloud.summary:legacyText,650),
      facts:completed?cloud.facts||{}:{},
      demandHypotheses:Array.isArray(hypothesis.demand_hypotheses)?hypothesis.demand_hypotheses.slice(0,5):[],
      supplyHypotheses:Array.isArray(hypothesis.supply_hypotheses)?hypothesis.supply_hypotheses.slice(0,5):[],
      unknowns:completed?cloud.unknowns||[]:[],
      nextActions:completed?cloud.next_actions||[]:[],
      sources:completed?cloud.sources||[]:[],
      generatedAt:cloud?.processed_at||aSaved?.approved_at||legacy?.analyzed_at||null,
      hasCorporateNumber:hasNumber,hasWebsite,
      confirmedNeeds:needs.error?null:needs.count,
    },
    proposal:{
      savedCount:saved,linkedTalentCount:matched,publishedCount:published,
      portalAccounts:members.error?null:members.count,
      staffMeetingUrl:"/sales/company-meeting.html?companyId="+encodeURIComponent(id),
      clientLoginUrl:portalOrigin+"/business/login?next="+encodeURIComponent("/business/meeting?companyId="+id),
      ready:published>0,
      note:"候補を選び、公開用に承認してから商談画面に進みます。会社の担当者は本人のアカウントでログインします。"
    },
    pilot,
  });
 }catch {
  return json(res,503,{error:"workflow_status_unavailable"});
 }
}