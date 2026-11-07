import { createHash } from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { admin } from "../../lib/supabase.js";
import { isUuid } from "../../lib/sales.js";
import { companyInScope } from "../../lib/sales-company-portal-db.js";
import { parseLocalAIResult, localAIMarkdown, sanitizedSource, LocalAIValidationError } from "../../lib/sales-company-local-ai.js";
import { toEngerJobMatchInput, toEngerCandidateMatchReference } from "../../lib/sales-local-ai-matching-adapter.js";

const table="dx2_company_local_ai_profiles";
const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const fail=(res,error,hint,status=400)=>json(res,status,{error,hint});

async function sourceSnapshot(db,tenant,id) {
  const [c,a,n,p,r]=await Promise.all([
    db.schema("enger").from("companies").select("id,name,industry,prefecture,website,employee_band,tags,updated_at").eq("id",id).is("deleted_at",null).maybeSingle(),
    db.schema("enger").from("dx2_company_analysis").select("analysis_summary,business_summary,matching_work,possible_issue,dx_opportunity,source_urls,analyzed_at").eq("company_id",id).maybeSingle(),
    db.schema("enger").from("dx2_company_needs").select("id,kind,title,skills,remote_type,start_period,headcount,is_active,updated_at").eq("company_id",id).order("updated_at",{ascending:false}).limit(30),
    db.schema("enger").from("proposals").select("id,job_id,candidate_id,job_title,stage,created_at").eq("company_id",id).is("deleted_at",null).order("created_at",{ascending:false}).limit(40),
    db.schema("enger").from("dx2_sales_company_supply_pipeline").select("id,request_kind,stage,job_id,candidate_id,created_at").eq("tenant_id",tenant).eq("company_id",id).order("created_at",{ascending:false}).limit(40),
  ]);
  if([c,a,n,p,r].some(x=>x.error)||!c.data)throw Error("source_unavailable");
  const refs=["company_profile",...(a.data?["previous_analysis"]:[]),
    ...(n.data||[]).map(x=>"need:"+x.id),
    ...(p.data||[]).map(x=>"proposal:"+x.id),
    ...(r.data||[]).map(x=>"receipt:"+x.id)];
  return sanitizedSource({
    company:c.data,previous_analysis:a.data||null,company_needs:n.data||[],
    proposals:p.data||[],registered_supply:r.data||[],source_refs:refs,
    note:"HP本文は未取得。企業IDで確認できる情報のみ。個人・単価・商流の非公開情報を推測しない。",
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
