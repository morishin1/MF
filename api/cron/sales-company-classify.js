// Vercel CRON, guarded by CRON_SECRET. Up to four scoped records per invocation.
// Enqueueing is explicit (100-company pilot or confirmed new company); never
// automatically classify every historical record without a separate decision.
import {admin} from "../../lib/supabase.js";
import {EIGHT_TENANT,canClassifyTenant,classifyWithHaiku,CLASSIFIER_VERSION} from "../../lib/sales-company-classification-ai.js";
const TABLE="gw_sales_company_classifications";
export const config={maxDuration:60};
const json=(res,status,body)=>res.status(status).json(body);
const now=()=>new Date().toISOString();

async function finish(db,item,update){
 const out=await db.from(TABLE).update({...update,updated_at:now()})
  .eq("tenant_id",item.tenant_id).eq("company_id",item.company_id)
  .eq("status","processing").eq("human_override",false).select("company_id").maybeSingle();
 if(out.error||!out.data)throw Error("classification_update_failed");
}
async function runOne(db,job){
 const claimed=await db.from(TABLE).update({
  status:"processing",attempts:job.attempts+1,started_at:now(),last_error:null,updated_at:now()
 }).eq("tenant_id",job.tenant_id).eq("company_id",job.company_id)
  .eq("status","queued").eq("attempts",job.attempts).eq("human_override",false)
  .select("tenant_id,company_id,attempts").maybeSingle();
 if(claimed.error)throw Error("claim_failed");
 if(!claimed.data)return {status:"claimed_elsewhere"};
 const item=claimed.data;
 try{
  if(!canClassifyTenant(item.tenant_id))throw Error("invalid_tenant");
  const [company,directory]=await Promise.all([
   db.schema("enger").from("companies")
    .select("id,name,corporate_number,website,industry,org_kind,deleted_at")
    .eq("id",item.company_id).is("deleted_at",null).maybeSingle(),
   db.schema("enger").from("dx2_sales_company_directory_for_tenant")
    .select("id,si_ses_candidate,directory_hidden_at")
    .eq("tenant_id",item.tenant_id).eq("id",item.company_id).maybeSingle()
  ]);
  if(company.error||directory.error||!company.data||!directory.data||
    directory.data.directory_hidden_at)throw Error("company_not_accessible");
  const result=await classifyWithHaiku({
   company:{...company.data,si_ses_candidate:directory.data.si_ses_candidate},
   website:company.data.website
  });
  await finish(db,item,{
   ...result,classified_at:now(),last_error:null
  });
  return {status:result.status,companyId:item.company_id,model:result.model};
 }catch(e){
  const error=String(e?.message||"classification_failed").replace(/[^\w-]/g,"_").slice(0,100);
  const retry=item.attempts<2&&!["invalid_tenant","company_not_accessible"].includes(error);
  await finish(db,item,{status:retry?"queued":"failed",last_error:error,started_at:null});
  return {status:retry?"retry":"failed",companyId:item.company_id,error};
 }
}

export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(req.method!=="GET")return json(res,405,{error:"method_not_allowed"});
 if(!process.env.CRON_SECRET||req.headers.authorization!=="Bearer "+process.env.CRON_SECRET)
  return json(res,401,{error:"unauthorized"});
 if(!process.env.ANTHROPIC_API_KEY)return json(res,503,{error:"ai_not_configured"});
 const db=admin();
 try{
  const expired=new Date(Date.now()-15*60000).toISOString();
  // Recover stopped jobs; failed jobs are capped and not retried endlessly.
  const stale=await db.from(TABLE).update({status:"queued",updated_at:now(),last_error:"stale_worker_retry"})
   .eq("tenant_id",EIGHT_TENANT).eq("status","processing").eq("human_override",false)
   .lt("started_at",expired).lt("attempts",2);
  if(stale.error)throw Error("stale_recovery_failed");
  const exhausted=await db.from(TABLE).update({status:"failed",last_error:"stale_worker_exhausted",updated_at:now()})
   .eq("tenant_id",EIGHT_TENANT).eq("status","processing").eq("human_override",false)
   .lt("started_at",expired).gte("attempts",2);
  if(exhausted.error)throw Error("exhausted_recovery_failed");
  const queue=await db.from(TABLE).select("tenant_id,company_id,attempts")
   .eq("tenant_id",EIGHT_TENANT).eq("status","queued").eq("human_override",false)
   .order("created_at",{ascending:true}).limit(4);
  if(queue.error)throw Error("queue_unavailable");
  const jobs=queue.data||[];
  const results=[];
  // 2-way concurrency avoids exhausting the 60-second execution limit.
  for(let i=0;i<jobs.length;i+=2){
   const part=await Promise.all(jobs.slice(i,i+2).map(job=>runOne(db,job)));
   results.push(...part);
  }
  return json(res,200,{ok:true,processed:results.length,
   completed:results.filter(x=>x.status==="completed").length,
   needsReview:results.filter(x=>x.status==="needs_review").length,
   failures:results.filter(x=>x.status==="failed").length,
   retries:results.filter(x=>x.status==="retry").length,
   // Do not return website texts or model responses in logs.
   model:CLASSIFIER_VERSION
  });
 }catch(e){
  console.error("[cron/sales-company-classify]",String(e?.message||"failed").slice(0,100));
  return json(res,503,{error:"classification_worker_unavailable"});
 }
}
