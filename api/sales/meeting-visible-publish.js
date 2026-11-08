// 企業の候補一覧から、画面に表示されている公開可能な人材・案件だけを一括公開する。
// 商談開始の明示ボタンでのみ実行。会社権限、公開状態、データ鮮度をサーバ側で再確認。
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope,readPublicCandidates} from "../../lib/sales-company-portal-db.js";
import {isPublicTalent} from "../../lib/enger-talent-public.js";
import {PUBLISHED_JOB_COLUMNS,jobAvailable} from "../../lib/sales-company-share-public.js";

const TABLE="dx2_company_sales_shortlist";
const MAX_ITEMS=30;
const error=(res,status,code,hint)=>json(res,status,{error:code,hint});
const parseItems=(items)=>{
 if(!Array.isArray(items)||items.length>MAX_ITEMS)return null;
 const valid=items.map(item=>{
  if(!item||!["talent","job"].includes(item.kind)||!isUuid(item.id))return null;
  return {kind:item.kind,id:item.id.toLowerCase()};
 });
 if(valid.some(x=>!x))return null;
 const keys=valid.map(x=>x.kind+":"+x.id);
 if(new Set(keys).size!==keys.length)return null;
 return valid;
};
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(req.method!=="POST")return methodNotAllowed(res,["POST"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return error(res,403,"forbidden","Sales権限が必要です。");
 let body;try{body=await readJson(req)}catch{return error(res,400,"invalid_json","入力内容を確認してください。")}
 if(!isUuid(body?.companyId)||body.confirmed!==true)
  return error(res,400,"confirmation_required","企業・公開対象を確認してください。");
 const items=parseItems(body.items);
 if(!items)return error(res,400,"invalid_items","表示候補は最大30件です。再読み込みしてください。");
 const db=admin(),companyId=body.companyId;
 try{
  const scope=await companyInScope(db,ctx.tenantId,companyId);
  if(!scope.ok)return error(res,scope.status,scope.error,"企業の権限を確認できません。");
  const directory=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
    .select("id,needs_contact_review,directory_hidden_at")
    .eq("tenant_id",ctx.tenantId).eq("id",companyId).maybeSingle();
  if(directory.error)return error(res,503,"company_unavailable","企業の状態を確認できません。");
  if(!directory.data||directory.data.needs_contact_review||directory.data.directory_hidden_at)
    return error(res,409,"company_blocked","連絡注意・非表示の企業には候補を公開できません。");
  const talentIds=items.filter(x=>x.kind==="talent").map(x=>x.id);
  const jobIds=items.filter(x=>x.kind==="job").map(x=>x.id);
  // 公開可否を一括確認。判断不能なら何も公開せず、担当者に情報の再確認を促す。
  const [talents,jobs]=await Promise.all([
    talentIds.length?readPublicCandidates(db,q=>q.in("id",talentIds),talentIds.length):
      Promise.resolve({rows:[],error:null}),
    jobIds.length?db.schema("enger").from("jobs").select(PUBLISHED_JOB_COLUMNS)
      .in("id",jobIds).limit(jobIds.length):Promise.resolve({data:[],error:null})
  ]);
  if(talents.error||jobs.error)return error(res,503,"lookup_failed","人材・案件の最新状態を確認できませんでした。");
  const approvedTalents=new Set((talents.rows||[]).filter(isPublicTalent).map(x=>x.id));
  const approvedJobs=new Set((jobs.data||[]).filter(jobAvailable).map(x=>x.id));
  if(talentIds.some(id=>!approvedTalents.has(id))||jobIds.some(id=>!approvedJobs.has(id)))
    return error(res,409,"item_not_public","表示候補の一部は公開できない状態です。候補一覧を更新してください。");
  if(items.length===0)return json(res,200,{ok:true,publishedCount:0,keys:[]});
  const now=new Date().toISOString();
  const common={tenant_id:ctx.tenantId,company_id:companyId,status:"published",
    published_at:now,published_by:user.id,created_by:user.id,updated_at:now};
  if(talentIds.length){
    const rows=talentIds.map(candidate_id=>({...common,item_type:"talent",candidate_id,job_id:null}));
    const result=await db.schema("enger").from(TABLE).upsert(rows,{
      onConflict:"tenant_id,company_id,candidate_id"
    });
    if(result.error)throw result.error;
  }
  if(jobIds.length){
    const rows=jobIds.map(job_id=>({...common,item_type:"job",candidate_id:null,job_id}));
    const result=await db.schema("enger").from(TABLE).upsert(rows,{
      onConflict:"tenant_id,company_id,job_id"
    });
    if(result.error)throw result.error;
  }
  return json(res,200,{ok:true,publishedCount:items.length,
    keys:items.map(x=>x.kind+":"+x.id)});
 }catch(e){
   console.error("[sales/meeting-visible-publish]",String(e?.code||e?.message||"unknown").slice(0,120));
   return error(res,503,"publish_failed","公開の保存に失敗しました。更新して再実行してください。");
 }
}
