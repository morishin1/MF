// Sales company meeting shortlist. Favorites are private until a staff member explicitly publishes them.
// GET ?companyId=... &mode=state|search&type=job&q=&tab=all|focus|new
// POST {companyId,itemType,itemId,action:favorite|remove|publish|unpublish,confirmed?}
// Never sends email: the Sales mail composer handles explicit contact checks and delivery.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope,readPublicCandidates,logPortalEvent} from "../../lib/sales-company-portal-db.js";
import {isPublicTalent,toPublicTalent} from "../../lib/enger-talent-public.js";
import {PUBLISHED_JOB_COLUMNS,jobAvailable,toPublicJob,toSalesJob} from "../../lib/sales-company-share-public.js";

const TABLE="dx2_company_sales_shortlist";
const error=(res,code,hint,status=400)=>json(res,status,{error:code,hint});
const limited=s=>String(s||"").trim().normalize("NFKC").slice(0,100);
const ids=arr=>[...new Set(arr.filter(x=>isUuid(x)))];
const MAX_FAVORITES=100;
async function detail(db,row) {
 if(row.item_type==="talent"){
   const r=await readPublicCandidates(db,q=>q.eq("id",row.candidate_id),1);
   if(r.error)return {error:true};
   const t=r.rows.find(x=>x.id===row.candidate_id);
   return t&&isPublicTalent(t) ? {kind:"talent",id:t.id,...toPublicTalent(t),eligible:true} : null;
 }
 const r=await db.schema("enger").from("jobs").select(PUBLISHED_JOB_COLUMNS).eq("id",row.job_id).maybeSingle();
 if(r.error)return {error:true};
 return r.data ? {kind:"job",id:r.data.id,...toSalesJob(r.data),
   eligible:jobAvailable(r.data)} : null;
}
function statusView(row,item){
 return {id:row.id,itemType:row.item_type,itemId:row.candidate_id||row.job_id,
   status:row.status,createdAt:row.created_at,publishedAt:row.published_at,
   eligible:Boolean(item?.eligible),item:item||null};
}
async function canPublish(db,tenant,companyId) {
 const r=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
   .select("id,needs_contact_review,directory_hidden_at").eq("tenant_id",tenant)
   .eq("id",companyId).maybeSingle();
 return !r.error&&r.data&&!r.data.needs_contact_review&&!r.data.directory_hidden_at;
}
async function readState(db,tenant,companyId) {
 const r=await db.schema("enger").from(TABLE)
  .select("id,item_type,candidate_id,job_id,status,created_at,published_at")
  .eq("tenant_id",tenant).eq("company_id",companyId)
  .order("created_at",{ascending:false}).limit(MAX_FAVORITES+1);
 if(r.error)return {error:r.error};
 if(r.data.length>MAX_FAVORITES)return {error:{message:"Too many favorites"}};
 const talentIds=ids(r.data.filter(x=>x.item_type==="talent").map(x=>x.candidate_id));
 const jobIds=ids(r.data.filter(x=>x.item_type==="job").map(x=>x.job_id));
 const [talents,jobs]=await Promise.all([
   talentIds.length?readPublicCandidates(db,q=>q.in("id",talentIds),talentIds.length):Promise.resolve({rows:[]}),
   jobIds.length?db.schema("enger").from("jobs").select(PUBLISHED_JOB_COLUMNS)
     .in("id",jobIds).limit(jobIds.length):Promise.resolve({data:[]}),
 ]);
 if(talents.error||jobs.error)return {error:{message:"item lookup failed"}};
 const talentsById=new Map((talents.rows||[]).map(x=>[x.id,x]));
 const jobsById=new Map((jobs.data||[]).map(x=>[x.id,x]));
 const interestIds=r.data.filter(x=>x.status==="published").map(x=>x.id);
 const interestResult=interestIds.length?await db.schema("enger").from("dx2_company_portal_events")
   .select("target_id,created_at").eq("company_id",companyId).eq("action","shortlist.interest")
   .in("target_id",interestIds).order("created_at",{ascending:false}).limit(200)
   :{data:[]};
 const interestCount=new Map();
 for(const e of interestResult.data||[])interestCount.set(e.target_id,(interestCount.get(e.target_id)||0)+1);
 const items=r.data.map(row=>{
   const asset=row.item_type==="talent"?talentsById.get(row.candidate_id):jobsById.get(row.job_id);
   const eligible=row.item_type==="talent"?isPublicTalent(asset):jobAvailable(asset);
   const item=!asset?null:row.item_type==="talent"
     ?{kind:"talent",id:asset.id,...toPublicTalent(asset),eligible}
     :{kind:"job",id:asset.id,...toSalesJob(asset),eligible};
   return {...statusView(row,item),interests:interestCount.get(row.id)||0};
 });
 return {items,favorites:r.data.length,published:r.data.filter(x=>x.status==="published").length};
}
async function searchJobs(db,params) {
 const tab=["all","focus","new"].includes(params.get("tab"))?params.get("tab"):"all";
 const q=limited(params.get("q")).toLowerCase();
 const words=q.split(/\s+/).filter(Boolean).slice(0,4);
 // Bounded search; never imply completeness outside this 600-job pool.
 let query=db.schema("enger").from("jobs").select(PUBLISHED_JOB_COLUMNS)
   .is("deleted_at",null).eq("is_closed",false).eq("is_published",true)
   .order("created_at",{ascending:false}).limit(600);
 if(tab==="focus")query=query.eq("is_focus",true);
 if(tab==="new")query=query.gte("created_at",new Date(Date.now()-14*86400000).toISOString());
 const r=await query;
 if(r.error)return {error:r.error};
 const rows=(r.data||[]).filter(jobAvailable).filter(j=>{
   if(!words.length)return true;
   const text=[j.title,j.role_label,...(j.skills||[])].filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
   return words.every(w=>text.includes(w));
 }).slice(0,30);
 return {rows:rows.map(toSalesJob),truncated:(r.data||[]).length>=600,scope:"published_jobs"};
}
export default async function handler(req,res) {
 const user=await requireUser(req,res);if(!user)return;
 res.setHeader?.("Cache-Control","private, no-store");
 if(!["GET","POST"].includes(req.method))return methodNotAllowed(res,["GET","POST"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return error(res,"forbidden","Sales権限が必要です。",403);
 const p=new URL(req.url||"/","http://localhost").searchParams;
 let body=null;
 if(req.method==="POST")try{body=await readJson(req);}catch{return error(res,"bad_json","入力形式を確認してください。");}
 const companyId=req.method==="GET"?p.get("companyId"):body?.companyId;
 if(!isUuid(companyId))return error(res,"invalid_company","企業IDが正しくありません。");
 const db=admin(),scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return error(res,scope.error,"企業IDとSalesの権限を確認できません。",scope.status);
 if(req.method==="GET") {
   if(p.get("mode")==="search"){
     if(p.get("type")!=="job")return error(res,"invalid_type","案件検索にのみ対応しています。");
     const found=await searchJobs(db,p);
     if(found.error)return error(res,"job_search_unavailable","案件を検索できませんでした。",503);
     return json(res,200,found);
   }
   const state=await readState(db,ctx.tenantId,companyId);
   if(state.error)return error(res,"shortlist_unavailable","お気に入りを取得できませんでした。",503);
   return json(res,200,{...state,canShare:await canPublish(db,ctx.tenantId,companyId),
     shareUrl:"https://enger.jp/business/recommendations"});
 }
 const itemType=body?.itemType,itemId=body?.itemId,action=body?.action;
 if(!["talent","job"].includes(itemType)||!isUuid(itemId)||
   !["favorite","remove","publish","unpublish"].includes(action))
   return error(res,"invalid_request","対象と操作を確認してください。");
 if(["publish","remove","unpublish"].includes(action)&&body.confirmed!==true)
   return error(res,"confirmation_required","公開・解除の操作を確認してください。");
 if(action==="publish"&&!(await canPublish(db,ctx.tenantId,companyId)))
   return error(res,"company_contact_blocked","連絡注意・非表示中の企業へ公開できません。",409);
 const entry={item_type:itemType,candidate_id:itemType==="talent"?itemId:null,
   job_id:itemType==="job"?itemId:null};
 const checked=await detail(db,entry);
 if(checked?.error)return error(res,"item_unavailable","案件・人材を確認できませんでした。",503);
 if(!checked||!checked.eligible){
   if(action==="favorite"||action==="publish")
     return error(res,"item_not_public","この案件・人材は現在、企業へ提示できません。",409);
 }
 const filters=db.schema("enger").from(TABLE)
   .select("id,status").eq("tenant_id",ctx.tenantId).eq("company_id",companyId)
   .eq(itemType==="talent"?"candidate_id":"job_id",itemId).limit(1);
 const existing=await filters;
 if(existing.error)return error(res,"shortlist_unavailable","お気に入りの状態を確認できません。",503);
 const old=existing.data?.[0]||null;
 if(action==="favorite"){
   if(old)return json(res,200,{ok:true,unchanged:true,status:old.status});
   const count=await db.schema("enger").from(TABLE).select("id",{count:"exact",head:true})
     .eq("tenant_id",ctx.tenantId).eq("company_id",companyId);
   if(count.error||count.count>=MAX_FAVORITES)return error(res,"too_many_favorites","お気に入り上限100件です。",409);
   const ins=await db.schema("enger").from(TABLE).insert({
     tenant_id:ctx.tenantId,company_id:companyId,...entry,status:"favorite",created_by:user.id,
   }).select("id").single();
   if(ins.error)return error(res,"favorite_failed","保存できませんでした。",503);
 }else if(action==="publish"){
   const patch={status:"published",published_at:new Date().toISOString(),
     published_by:user.id,updated_at:new Date().toISOString()};
   if(old){
     const up=await db.schema("enger").from(TABLE).update(patch)
       .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("id",old.id);
     if(up.error)return error(res,"publish_failed","公開の状態を保存できませんでした。",503);
   }else{
     const ins=await db.schema("enger").from(TABLE).insert({
       tenant_id:ctx.tenantId,company_id:companyId,...entry,
       status:"published",created_by:user.id,...patch,
     });
     if(ins.error)return error(res,"publish_failed","公開の状態を保存できませんでした。",503);
   }
 }else{
   if(old){
     const up=action==="remove"?
       await db.schema("enger").from(TABLE).delete()
        .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("id",old.id):
       await db.schema("enger").from(TABLE)
        .update({status:"favorite",published_at:null,published_by:null,updated_at:new Date().toISOString()})
        .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("id",old.id);
     if(up.error)return error(res,"shortlist_update_failed","公開・保存の状態を変更できませんでした。",503);
   }
 }
 await logPortalEvent(db,{companyId,actorKind:"staff",actorUserId:user.id,
   action:"shortlist."+action,targetId:itemId,detail:{kind:itemType}});
 return json(res,200,{ok:true,status:action==="publish"?"published":action==="favorite"?"favorite":
   action==="unpublish"?"favorite":"removed",shareUrl:"https://enger.jp/business/recommendations"});
}
