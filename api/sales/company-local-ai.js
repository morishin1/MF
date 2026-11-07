import { createHash } from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { admin } from "../../lib/supabase.js";
import { isUuid } from "../../lib/sales.js";
import { companyInScope } from "../../lib/sales-company-portal-db.js";
import { parseLocalAIResult, localAIMarkdown, sanitizedSource, LocalAIValidationError } from "../../lib/sales-company-local-ai.js";
import { toEngerJobMatchInput, toEngerCandidateMatchReference, toEngerNeedDraft } from "../../lib/sales-local-ai-matching-adapter.js";

const table="dx2_company_local_ai_profiles";
const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const fail=(res,error,hint,status=400)=>json(res,status,{error,hint});

export async function sourceSnapshot(db,tenant,id) {
  const [c,a,n,p,r,h,cl]=await Promise.all([
    db.schema("enger").from("companies").select("id,name,corporate_number,address,city,industry,prefecture,website,employee_band,tags").eq("id",id).is("deleted_at",null).maybeSingle(),
    db.schema("enger").from("dx2_company_analysis").select("analysis_summary,business_summary,matching_work,possible_issue,dx_opportunity,source_urls,analyzed_at").eq("company_id",id).order("analyzed_at",{ascending:false}).limit(1),
    db.schema("enger").from("dx2_company_needs").select("id,kind,title,skills,remote_type,start_period,headcount,is_active,updated_at").eq("company_id",id).order("updated_at",{ascending:false}).limit(30),
    db.schema("enger").from("proposals").select("id,job_id,candidate_id,job_title,stage,created_at").eq("company_id",id).is("deleted_at",null).order("created_at",{ascending:false}).limit(40),
    db.schema("enger").from("dx2_sales_company_supply_pipeline")
      .select("id,request_kind,stage,job_id,candidate_id,source_channel,created_at")
      .eq("tenant_id",tenant).eq("company_id",id).order("created_at",{ascending:false}).limit(40),
    db.schema("enger").from("dx2_sales_company_history_links")
      .select("entity_type,entity_id,source_kind,linked_at")
      .eq("tenant_id",tenant).eq("company_id",id).limit(60),
    db.schema("enger").from("dx2_company_talent_links")
      .select("candidate_id,status,created_at")
      .eq("tenant_id",tenant).eq("company_id",id).limit(60),
  ]);
  if([c,a,n,p,r,h,cl].some(x=>x.error)||!c.data)throw Error("source_unavailable");
  const history=h.data||[],links=cl.data||[],receipts=r.data||[],proposals=p.data||[];
  const jobIds=[...new Set([
    ...history.filter(x=>x.entity_type==="job").map(x=>x.entity_id),
    ...proposals.map(x=>x.job_id),...receipts.map(x=>x.job_id),
  ].filter(isUuid))].slice(0,60);
  const candidateIds=[...new Set([
    ...history.filter(x=>x.entity_type==="talent").map(x=>x.entity_id),
    ...proposals.map(x=>x.candidate_id),...receipts.map(x=>x.candidate_id),
    ...links.map(x=>x.candidate_id),
  ].filter(isUuid))].slice(0,60);
  const [jobs,talents]=await Promise.all([
    jobIds.length?db.schema("enger").from("jobs")
      .select("id,job_no,role_label,skills,status,is_closed,deleted_at,created_at")
      .in("id",jobIds).limit(60):Promise.resolve({data:[]}),
    candidateIds.length?db.schema("enger").from("candidates")
      .select("id,candidate_no,title,skills,status,is_closed,deleted_at,created_at")
      .in("id",candidateIds).limit(60):Promise.resolve({data:[]}),
  ]);
  if(jobs.error||talents.error)throw Error("related_assets_unavailable");
  const refs=["company_profile",...(a.data?.length?["previous_analysis"]:[]),
    ...(n.data||[]).map(x=>"need:"+x.id),
    ...proposals.map(x=>"proposal:"+x.id),
    ...receipts.map(x=>"receipt:"+x.id),
    ...history.map(x=>"history:"+x.entity_type+":"+x.entity_id),
    ...links.map(x=>"linked_talent:"+x.candidate_id)];
  return sanitizedSource({
    company:c.data,previous_analysis:a.data?.[0]||null,company_needs:n.data||[],
    proposals,registered_supply:receipts,historical_links:history,company_talent_links:links,
    related_jobs:(jobs.data||[]).map(x=>({
      id:x.id,job_no:x.job_no,role:x.role_label,skills:(x.skills||[]).slice(0,14),
      status:x.status,closed:x.is_closed,deleted:!!x.deleted_at,created_at:x.created_at,
      relation:receipts.some(v=>v.job_id===x.id)?"受領済み":
        history.some(v=>v.entity_type==="job"&&v.entity_id===x.id)?"確認済みの過去履歴":"過去提案の関連案件",
    })),
    related_talents:(talents.data||[]).map(x=>({
      id:x.id,candidate_no:x.candidate_no,role:x.title,skills:(x.skills||[]).slice(0,14),
      status:x.status,closed:x.is_closed,deleted:!!x.deleted_at,created_at:x.created_at,
      relation:receipts.some(v=>v.candidate_id===x.id)?"受領済み":
        history.some(v=>v.entity_type==="talent"&&v.entity_id===x.id)?"確認済みの過去履歴":
        links.some(v=>v.candidate_id===x.id)?"企業に紐づいた候補":"過去提案の関連人材",
    })),
    inventory_counts:{
      received_jobs:receipts.filter(x=>x.stage==="registered"&&x.job_id).length,
      received_talents:receipts.filter(x=>x.stage==="registered"&&x.candidate_id).length,
      linked_talent_candidates:links.length,
      confirmed_historical_jobs:history.filter(x=>x.entity_type==="job").length,
      confirmed_historical_talents:history.filter(x=>x.entity_type==="talent").length,
      related_job_samples:jobs.data?.length||0,related_talent_samples:talents.data?.length||0,
      company_id_proposals:proposals.length,
    },
    source_refs:[...new Set(refs)],
    note:"企業IDに関連する情報のみ。HP本文は未取得。関連/提案/紹介は所有や保有の証明ではなく、過去案件は現在の募集中とは限らない。個人名・仕入単価・商流は含めない。",
  });
}
function profiles(parsed) {
  return parsed.matching_requirements.map((req,index)=>({
    index,direction:req.direction,rationale:req.rationale,evidence_refs:req.evidence_refs,
    verification:"ai_unverified",
    // Mapping to the *actual* ENGER rankCandidates input columns; not a created job.
    job_match_input:toEngerJobMatchInput(req),
    // rankJobs requires a real candidate ID; never fabricate candidate facts.
    candidate_match_ref:toEngerCandidateMatchReference(req),
    enger_need_draft:toEngerNeedDraft(req,parsed.company_id,index),
  }));
}
export default async function handler(req,res) {
  res.setHeader?.("Cache-Control","private, no-store");
  const user=await requireUser(req,res);if(!user)return;
  if(!["GET","POST"].includes(req.method))return methodNotAllowed(res,["GET","POST"]);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return fail(res,"forbidden","Sales権限が必要です。",403);
  let body=null;
  if(req.method==="POST"){
    try {body=await readJson(req);} catch{return fail(res,"bad_json","JSONを読み取れませんでした。");}
  }
  const companyId=req.method==="GET"?new URL(req.url||"/","http://localhost").searchParams.get("companyId"):body?.companyId;
  if(!isUuid(companyId))return fail(res,"invalid_company","企業IDが正しくありません。");
  const db=admin();
  const scope=await companyInScope(db,ctx.tenantId,companyId);
  if(!scope.ok)return fail(res,scope.error,"この企業は対象外です。",scope.status);
  let snapshot;
  try{snapshot=await sourceSnapshot(db,ctx.tenantId,companyId);}
  catch{return fail(res,"source_unavailable","元データが取得できませんでした。",503);}
  const sourceHash=digest(snapshot);
  const approvedCandidateIds=new Set([
    ...(snapshot.proposals||[]).map(p=>p.candidate_id),
    ...(snapshot.registered_supply||[]).filter(r=>r.stage==="registered").map(r=>r.candidate_id)
  ].filter(isUuid));
  const approvedJobIds=new Set([
    ...(snapshot.proposals||[]).map(p=>p.job_id),
    ...(snapshot.registered_supply||[]).filter(r=>r.stage==="registered").map(r=>r.job_id)
  ].filter(isUuid));
  if(req.method==="GET") {
    return json(res,200,{
      companyId,companyName:scope.company.name,sourceHash,
      markdown:localAIMarkdown(snapshot,sourceHash),refs:snapshot.source_refs,
    });
  }
  const action=body?.action;
  if(!["preview","save"].includes(action))return fail(res,"invalid_action","操作が正しくありません。");
  let parsed;
  try{parsed=parseLocalAIResult(body?.text,companyId,sourceHash,snapshot.source_refs);}
  catch(e){return e instanceof LocalAIValidationError?
    fail(res,e.code,e.message):fail(res,"invalid_result","AI結果を解析できませんでした。");}
  // A pasted AI output may reference only IDs actually linked to this company.
  for(const req of parsed.matching_requirements){
    if(req.source_candidate_id&&!approvedCandidateIds.has(req.source_candidate_id))
      return fail(res,"unverified_candidate_id","企業IDで確認できない人材IDはマッチング条件に登録できません。");
    if(req.source_job_id&&!approvedJobIds.has(req.source_job_id))
      return fail(res,"unverified_job_id","企業IDで確認できない案件IDはマッチング条件に登録できません。");
  }
  const mapped=profiles(parsed);
  const result={parsed,mapped,sourceHash,
    note:"AI仮説です。ENGERの正式案件・人材情報を自動変更しません。"};
  if(action==="preview")return json(res,200,{ok:true,saved:false,...result});
  if(body.confirmed!==true)return fail(res,"approval_required","項目を確認してから登録してください。");
  const payload={...parsed,mapped};
  const payloadDigest=digest(payload);
  const before=await db.schema("enger").from(table).select("id").eq("tenant_id",ctx.tenantId)
    .eq("company_id",companyId).eq("payload_digest",payloadDigest).limit(1);
  if(before.error)return fail(res,"db_162_unavailable","db/162が未適用か取得できません。",503);
  if(before.data?.length)return json(res,200,{ok:true,saved:true,alreadySaved:true,...result});
  const inserted=await db.schema("enger").from(table).insert({
    tenant_id:ctx.tenantId,company_id:companyId,source_digest:sourceHash,
    payload_digest:payloadDigest,profile_json:payload,approved_by:user.id,
  }).select("id").single();
  if(inserted.error)return fail(res,"save_failed","保存できませんでした。DBの設定を確認してください。",503);
  return json(res,200,{ok:true,saved:true,profileId:inserted.data.id,...result});
}
