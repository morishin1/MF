// Enterprise portal offers received through ENGER Business.
// Company-scoped and tenant-scoped; offer status is NOT a concluded contract.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {canManageProposals} from "../../lib/sales-proposals.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope,logPortalEvent} from "../../lib/sales-company-portal-db.js";

const TABLE="dx2_company_portal_offers";
const FIELDS="id,tenant_id,company_id,member_id,shortlist_id,item_type,candidate_id,job_id,status,message,context_submission_id,context_note,created_at,updated_at,reviewed_by,reviewed_at";
const STATUS={new:"未対応",contacting:"連絡中",meeting:"面談調整",negotiating:"条件交渉",won:"成約確認待ち",lost:"見送り"};
const safe=(v,n=140)=>String(v??"").normalize("NFKC").trim().slice(0,n);
const fail=(res,error,hint,status=400)=>json(res,status,{error,hint});
async function fetchOffers(db,tenantId,companyId){
 let query=db.schema("enger").from(TABLE).select(FIELDS).eq("tenant_id",tenantId)
   .order("created_at",{ascending:false}).limit(201);
 if(companyId)query=query.eq("company_id",companyId);
 const result=await query;
 if(result.error)return {error:true};
 const rows=(result.data||[]).slice(0,200);
 const companyIds=[...new Set(rows.map(x=>x.company_id).filter(isUuid))];
 const memberIds=[...new Set(rows.map(x=>x.member_id).filter(isUuid))];
 const jobIds=[...new Set(rows.map(x=>x.job_id).filter(isUuid))];
 const talentIds=[...new Set(rows.map(x=>x.candidate_id).filter(isUuid))];
 const contextIds=[...new Set(rows.map(x=>x.context_submission_id).filter(isUuid))];
 const [companies,members,jobs,talents,contexts]=await Promise.all([
   companyIds.length?db.schema("enger").from("dx2_sales_company_directory_for_tenant")
     .select("id,name").eq("tenant_id",tenantId).in("id",companyIds)
     :Promise.resolve({data:[]}),
   memberIds.length?db.schema("enger").from("dx2_company_portal_members")
     .select("id,email,display_name").eq("tenant_id",tenantId).in("id",memberIds)
     :Promise.resolve({data:[]}),
   jobIds.length?db.schema("enger").from("jobs")
     .select("id,job_no,role_label,created_at").in("id",jobIds)
     :Promise.resolve({data:[]}),
   talentIds.length?db.schema("enger").from("candidates")
     .select("id,candidate_no,title,created_at").in("id",talentIds)
     :Promise.resolve({data:[]}),
   contextIds.length?db.schema("enger").from("dx2_company_partner_submissions")
     .select("id,tenant_id,company_id,item_type,title,skills,budget,start_date,work_style,description,is_focus,status")
     .eq("tenant_id",tenantId).in("id",contextIds).limit(200)
     :Promise.resolve({data:[]}),
 ]);
 if([companies,members,jobs,talents,contexts].some(x=>x.error))return {error:true};
 const companyById=new Map((companies.data||[]).map(x=>[x.id,x]));
 const memberById=new Map((members.data||[]).map(x=>[x.id,x]));
 const jobById=new Map((jobs.data||[]).map(x=>[x.id,x]));
 const talentById=new Map((talents.data||[]).map(x=>[x.id,x]));
 const contextById=new Map((contexts.data||[]).map(x=>[x.id,x]));
 const offers=rows.filter(x=>companyById.has(x.company_id)).map(x=>{
   const member=memberById.get(x.member_id);
   const job=jobById.get(x.job_id),talent=talentById.get(x.candidate_id);
   const label=x.item_type==="job"?(job?.role_label||"案件（詳細は未確認）"):
     (talent?.title||"人材（詳細は未確認）");
   const itemNo=x.item_type==="job"?job?.job_no:talent?.candidate_no;
   const ref=contextById.get(x.context_submission_id);
   const context=ref&&ref.company_id===x.company_id?{
     id:ref.id,type:ref.item_type,title:safe(ref.title,160),
     skills:(Array.isArray(ref.skills)?ref.skills:[]).map(v=>safe(v,70)).slice(0,16),
     budget:safe(ref.budget,100),workStyle:safe(ref.work_style,100),
     description:safe(ref.description,3000),startDate:ref.start_date,
     isFocus:ref.is_focus===true,status:ref.status,
   }:null;
   return {
     id:x.id,companyId:x.company_id,companyName:safe(companyById.get(x.company_id)?.name,150),
     memberName:safe(member?.display_name,80)||"企業担当者",
     loginId:safe(member?.email,160),type:x.item_type,itemId:x.job_id||x.candidate_id,
     title:safe(label),itemNo:itemNo==null?null:String(itemNo),
     status:x.status,statusLabel:STATUS[x.status]||x.status,
     message:safe(x.message,500),context,contextNote:safe(x.context_note,1500),
     createdAt:x.created_at,reviewedAt:x.reviewed_at,
     updatedAt:x.updated_at,
   };
 });
 return {offers,hasMore:(result.data||[]).length>200,totalReturned:offers.length};
}
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 res.setHeader?.("Cache-Control","private, no-store");
 if(!["GET","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","PATCH"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return fail(res,"forbidden","Sales閲覧権限がありません。",403);
 const p=new URL(req.url||"/","http://localhost").searchParams;
 let body={};
 if(req.method==="PATCH")try{body=await readJson(req);}catch{return fail(res,"bad_json","入力を確認してください。");}
 const companyId=req.method==="GET"?p.get("companyId"):body.companyId;
 if(companyId && !isUuid(companyId))return fail(res,"invalid_company","企業IDが正しくありません。");
 const db=admin();
 if(companyId){const scope=await companyInScope(db,ctx.tenantId,companyId);
   if(!scope.ok)return fail(res,scope.error,"企業の管理権限を確認できません。",scope.status);}
 if(req.method==="GET"){
   const found=await fetchOffers(db,ctx.tenantId,companyId||null);
   if(found.error)return fail(res,"offer_data_unavailable","オファー一覧を取得できませんでした。",503);
   return json(res,200,{...found,statusLabels:STATUS,
     note:"企業から送信された正式なオファーのみ表示。問い合わせと区別します。成約確定はSales提案管理で行います。"});
 }
 if(!companyId||!isUuid(body.offerId)||!STATUS[body.status]||body.confirmed!==true)
   return fail(res,"invalid_offer","対象・状態・更新確認が必要です。");
 if(!STATUS[body.expectedStatus])
   return fail(res,"missing_version","最新のオファー状態を再取得してください。",409);
 if(["won","lost"].includes(body.status)&&!canManageProposals(ctx))
   return fail(res,"approval_required","成約確認・見送りは営業責任者または管理者が更新できます。",403);
 const old=await db.schema("enger").from(TABLE).select("id,status").eq("tenant_id",ctx.tenantId)
   .eq("company_id",companyId).eq("id",body.offerId).maybeSingle();
 if(old.error)return fail(res,"offer_unavailable","オファー状態を確認できませんでした。",503);
 if(!old.data)return fail(res,"not_found","対象のオファーがありません。",404);
 if(old.data.status!==body.expectedStatus)return fail(res,"stale_offer","別の担当者が更新しました。再読込してください。",409);
 if(old.data.status===body.status)return json(res,200,{ok:true,unchanged:true});
 const updated=await db.schema("enger").from(TABLE).update({
   status:body.status,reviewed_by:user.id,reviewed_at:new Date().toISOString(),
   updated_at:new Date().toISOString(),
 }).eq("tenant_id",ctx.tenantId).eq("company_id",companyId).eq("id",body.offerId)
   .eq("status",body.expectedStatus).select("id,status,updated_at").maybeSingle();
 if(updated.error||!updated.data)return fail(res,"offer_update_conflict","更新できませんでした。最新の状態で再試行してください。",409);
 await logPortalEvent(db,{companyId,actorKind:"staff",actorUserId:user.id,action:"offer.review",
   targetId:body.offerId,detail:{from:old.data.status,to:body.status}});
 return json(res,200,{ok:true,offerId:updated.data.id,status:updated.data.status});
}
