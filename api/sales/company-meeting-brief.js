// GET /api/sales/company-meeting-brief?companyId=<uuid>
// Sales-only meeting summary. Verified company-linked ENGER receipts take precedence
// over existing AI analysis hypotheses. Never join companies by a name string.
import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { admin } from "../../lib/supabase.js";
import { isUuid } from "../../lib/sales.js";
import { companyInScope, readPublicCandidates } from "../../lib/sales-company-portal-db.js";
import { isPublicTalent, toPublicTalent } from "../../lib/enger-talent-public.js";

const JOB_FIELDS = "id,job_no,title,role_label,skills,status,is_focus,is_closed,deleted_at,created_at";
const MAX_MATCH_POOL = 400; // bounded and explicitly identified as partial
const TERMS = [
  ["JavaScript", /javascript/i], ["TypeScript", /typescript/i],
  ["Python", /python/i], ["Java", /(^|[^a-z])java(?=$|[^a-z])/i],
  ["React", /react/i], ["AWS", /(^|[^a-z])aws(?=$|[^a-z])/i],
  ["Azure", /azure/i], ["GCP", /(^|[^a-z])gcp(?=$|[^a-z])/i],
  ["PHP", /(^|[^a-z])php(?=$|[^a-z])/i], ["Ruby", /ruby/i],
  ["C#", /c#/i], ["C++", /c\+\+/i], ["SQL", /(^|[^a-z])sql(?=$|[^a-z])/i],
  ["Docker", /docker/i], ["Kubernetes", /kubernetes/i],
  ["Salesforce", /salesforce/i], ["SAP", /(^|[^a-z])sap(?=$|[^a-z])/i],
  ["PMO", /(^|[^a-z])pmo(?=$|[^a-z])/i], ["生成AI", /生成ai/i],
  ["クラウド", /クラウド/], ["インフラ", /インフラ/],
  ["データ分析", /データ分析/],
];
const norm = v => String(v ?? "").normalize("NFKC").trim();
const short = (v, n=260) => norm(v).slice(0,n);
const valText = v => Array.isArray(v) ? v.map(valText).filter(Boolean).join("・")
  : v && typeof v === "object" ? Object.values(v).map(valText).filter(Boolean).join("・") : short(v, 1200);
const dedup = list => [...new Set(list.filter(Boolean))];
const techTerms = text => TERMS.filter(([,pattern]) => pattern.test(String(text||""))).map(([name])=>name);
const skillTerms = skills => dedup((skills||[]).flatMap(s=>techTerms(String(s)))).slice(0,8);
const overlap = (skills,keywords) => {
  const itemTerms=dedup([...skillTerms(skills),...(skills||[]).map(x=>String(x).normalize("NFKC").trim())]);
  return keywords.filter(k=>itemTerms.some(x=>x.toLowerCase()===String(k).toLowerCase()));
};
const validJob = job => job && !job.deleted_at && job.is_closed !== true &&
  !["終了","募集終了","クローズ","停止","NG","closed"].includes(String(job.status||""));
const visibleJob = job => ({
  id:job.id,no:job.job_no||null,title:short(job.title,120)||"案件名未登録",
  role:short(job.role_label,80),skills:(job.skills||[]).slice(0,10).map(x=>short(x,35)),
  isFocus:job.is_focus===true,
});

export default async function handler(req,res) {
  const user = await requireUser(req,res);
  if(!user)return;
  res.setHeader?.("Cache-Control","private, no-store");
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return json(res,403,{error:"forbidden"});
  const id=new URL(req.url||"/","http://localhost").searchParams.get("companyId");
  if(!isUuid(id))return json(res,400,{error:"invalid_company"});
  try {
    const db=admin();
    const scope=await companyInScope(db,ctx.tenantId,id);
    if(!scope.ok)return json(res,scope.status,{error:scope.error});
    const [directory, company, analysis, needs, supplies, proposals, localProfile] = await Promise.all([
      db.schema("enger").from("dx2_sales_company_directory_for_tenant")
        .select("id,bucket,industry,prefecture,relationship_status,classification_basis,needs_contact_review")
        .eq("tenant_id",ctx.tenantId).eq("id",id).maybeSingle(),
      db.schema("enger").from("companies")
        .select("id,name,industry,prefecture,website,employee_band,tags")
        .eq("id",id).is("deleted_at",null).maybeSingle(),
      db.schema("enger").from("dx2_company_analysis")
        .select("analysis_summary,business_summary,company_strength,possible_issue,dx_opportunity,matching_work,estimated_issues,recommended_services,analysis_confidence,analysis_source,source_urls,analyzed_at")
        .eq("company_id",id).order("analyzed_at",{ascending:false,nullsFirst:false}).limit(1),
      db.schema("enger").from("dx2_company_needs")
        .select("id,kind,title,skills,is_active,created_at").eq("company_id",id)
        .eq("is_active",true).order("created_at",{ascending:false}).limit(30),
      db.schema("enger").from("dx2_sales_company_supply_pipeline")
        .select("id,request_kind,stage,job_id,candidate_id,created_at")
        .eq("tenant_id",ctx.tenantId).eq("company_id",id)
        .order("created_at",{ascending:false}).limit(70),
      db.schema("enger").from("proposals")
        .select("id,job_id,candidate_id,job_title,stage,created_at")
        .eq("company_id",id).is("deleted_at",null)
        .order("created_at",{ascending:false}).limit(70),
      db.schema("enger").from("dx2_company_local_ai_profiles")
        .select("id,profile_json,approved_at").eq("tenant_id",ctx.tenantId).eq("company_id",id)
        .order("approved_at",{ascending:false}).limit(1),
    ]);
    if([directory,company,analysis,needs,supplies,proposals].some(r=>r.error)
       || !directory.data || !company.data) {
      return json(res,503,{error:"meeting_brief_unavailable",
        hint:"企業分析・受領情報・提案履歴を照合できませんでした。未取得を0件とは表示しません。"});
    }
    const d=directory.data,c=company.data,a=analysis.data?.[0]||null;
    // Optional until db/162 has been applied. AI-derived fields are unverified.
    const latestProfile=!localProfile.error ? localProfile.data?.[0] : null;
    const aiInput=latestProfile?.profile_json||null;
    const receipts=(supplies.data||[]).filter(r=>r.stage==="registered");
    const sourceJobIds=dedup([
      ...receipts.map(r=>r.job_id),...(proposals.data||[]).map(r=>r.job_id)
    ]).filter(isUuid).slice(0,50);
    const sourceTalentIds=dedup([
      ...receipts.map(r=>r.candidate_id),...(proposals.data||[]).map(r=>r.candidate_id)
    ]).filter(isUuid).slice(0,50);
    const [jobsResult,talentsResult] = await Promise.all([
      sourceJobIds.length ? db.schema("enger").from("jobs").select(JOB_FIELDS)
        .in("id",sourceJobIds).limit(50) : Promise.resolve({data:[]}),
      sourceTalentIds.length ? readPublicCandidates(db, q=>q.in("id",sourceTalentIds),sourceTalentIds.length)
        : Promise.resolve({rows:[]}),
    ]);
    if(jobsResult.error||talentsResult.error)return json(res,503,{error:"receipt_detail_unavailable",
      hint:"企業IDに紐づく案件・人材の登録情報を照合できませんでした。"});
    const linkedJobs=(jobsResult.data||[]).filter(validJob);
    const linkedTalents=(talentsResult.rows||[]).filter(isPublicTalent);
    const verifiedSkills=dedup([
      ...(needs.data||[]).flatMap(r=>skillTerms(r.skills)),
      ...receipts.filter(r=>r.job_id).flatMap(()=>[]),
      ...linkedJobs.flatMap(j=>skillTerms(j.skills)),
      ...linkedTalents.flatMap(t=>skillTerms(t.skills)),
    ]).slice(0,8);
    const analysisText=a ? [
      a.analysis_summary,a.business_summary,a.matching_work,a.estimated_issues,a.recommended_services,
      a.possible_issue,a.dx_opportunity,
    ].map(valText).join(" ") : "";
    const hypothesisSkills = verifiedSkills.length ? [] : techTerms(analysisText).slice(0,4);
    const importedSkills=verifiedSkills.length ? [] : dedup((aiInput?.matching_requirements||[])
      .filter(r=>r.direction==="talent").flatMap(r=>Array.isArray(r.skills)?r.skills:[])).slice(0,8);
    const keywords = verifiedSkills.length ? verifiedSkills : importedSkills.length ? importedSkills : hypothesisSkills;
    const basis = verifiedSkills.length ? "企業IDに紐づく登録案件・人材・ニーズ"
      : importedSkills.length ? "ローカルAI結果から登録された条件（未確認）"
      : hypothesisSkills.length ? "保存済みAI分析からの仮説" : "条件未登録";
    const potentialExisting = ["existing","revive"].includes(d.bucket)
       || ["active","past"].includes(d.relationship_status);
    const mode = (sourceJobIds.length||sourceTalentIds.length||(needs.data||[]).length)
      ? "existing-linked" : potentialExisting ? "existing-unlinked" : "new";
    // Matching is an initial *skill overlap*, not ENGER's final fit/scoring or approval.
    let matchedJobs=[],matchedTalents=[];
    if(keywords.length) {
      const [jobPool,talentPool] = await Promise.all([
        db.schema("enger").from("jobs").select(JOB_FIELDS).is("deleted_at",null)
          .order("created_at",{ascending:false}).limit(MAX_MATCH_POOL),
        readPublicCandidates(db,q=>q,MAX_MATCH_POOL),
      ]);
      if(jobPool.error||talentPool.error)return json(res,503,{error:"match_pool_unavailable",
        hint:"候補を取得できないため、条件一致を確認できませんでした。"});
      const sourceJobSet=new Set(sourceJobIds),sourceTalentSet=new Set(sourceTalentIds);
      matchedJobs=(jobPool.data||[]).filter(x=>validJob(x)&&!sourceJobSet.has(x.id))
        .map(job=>({job,matched:overlap(job.skills,keywords)}))
        .filter(x=>x.matched.length).sort((x,y)=>y.matched.length-x.matched.length)
        .slice(0,6).map(x=>({...visibleJob(x.job),matchedSkills:x.matched}));
      matchedTalents=(talentPool.rows||[]).filter(t=>isPublicTalent(t)&&!sourceTalentSet.has(t.id))
        .map(t=>({talent:t,matched:overlap(t.skills,keywords)}))
        .filter(x=>x.matched.length).sort((x,y)=>y.matched.length-x.matched.length)
        .slice(0,6).map(x=>({id:x.talent.id,...toPublicTalent(x.talent),matchedSkills:x.matched}));
    }
    const original = aiInput?.company_summary || (a && (a.analysis_summary||a.business_summary));
    const summary=original ? short(valText(original),600) : short(
      [c.industry||d.industry,c.prefecture||d.prefecture,c.employee_band].filter(Boolean).join("・"),300);
    const aiReady=Boolean(aiInput || (a && (a.analysis_summary||a.business_summary||a.estimated_issues||a.possible_issue)));
    return json(res,200,{
      company:{id,name:short(c.name,160),industry:short(c.industry||d.industry,80),
        prefecture:short(c.prefecture||d.prefecture,50),mode,classification:short(d.classification_basis,200),
        needsContactReview:Boolean(d.needs_contact_review)},
      summary:{text:summary||"企業概要は未登録です。",type:original?"saved-ai":"company-record",
        issue:a?short(valText(a.possible_issue||a.estimated_issues),240):"",
        strength:a?short(valText(a.company_strength),240):"",
        opportunity:a?short(valText(a.dx_opportunity),240):"",
        analysisAt:latestProfile?.approved_at||a?.analyzed_at||null,hasAI:aiReady,
        note:aiReady?"保存済みの企業AI分析です。推定事項は商談で確認してください。":
          "保存済みAI分析が見つかりません。登録企業情報のみから整理しています。"},
      source:{needs:(needs.data||[]).map(r=>({id:r.id,kind:r.kind,title:short(r.title,120),
          skills:(r.skills||[]).map(x=>short(x,40)).slice(0,12)})),
        registeredRequests:receipts.length,proposalCount:(proposals.data||[]).length,
        linkedJobs:linkedJobs.map(visibleJob),
        linkedTalents:linkedTalents.map(t=>({id:t.id,...toPublicTalent(t)})),
        hasLinkedRecords:Boolean(sourceJobIds.length||sourceTalentIds.length||(needs.data||[]).length),
      },
      suggestions:{basis,skills:keywords,verified:verifiedSkills.length>0,
        localAIProfileId:latestProfile?.id||null,
        matchingRequirements:(aiInput?.matching_requirements||[]).map(r=>({
          direction:r.direction,role:r.role,skills:r.skills,work_style:r.work_style,
          location:r.location,start_date:r.start_date,verification:"ai_unverified",
        })),
        talents:matchedTalents,jobs:matchedJobs,poolLimit:MAX_MATCH_POOL,
        disclaimer:"スキル一致による参考候補です。ENGER DXの正式マッチング、所属・条件確認、提案可否を代替しません。"},
      note:"企業はIDで照合しています。会社名だけで受領案件・人材を推測して紐づけません。",
    });
  }catch(error) {
    return json(res,503,{error:"meeting_brief_unavailable",
      hint:"商談サマリーを読み込めませんでした。企業DBの照合状態をご確認ください。"});
  }
}
