// Staff-only intake review for ENGER company portal submissions.
// Approval marks the record verified; publishing/matching requires a separate
// explicit ENGER DX operator action after verifying consent and conditions.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {canManageProposals} from "../../lib/sales-proposals.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
const TABLE="dx2_company_partner_submissions";
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(!["GET","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","PATCH"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return json(res,403,{error:"forbidden"});
 const db=admin();
 if(req.method==="GET"){
  const status=new URL(req.url||"/","http://localhost").searchParams.get("status")||"pending_review";
  if(!["pending_review","approved","needs_changes","rejected","all"].includes(status))
   return json(res,400,{error:"invalid_status"});
  let q=db.schema("enger").from(TABLE)
   .select("id,company_id,member_id,item_type,title,description,skills,budget,start_date,work_style,attachment_name,attachment_size,status,review_note,created_at,updated_at")
   .eq("tenant_id",ctx.tenantId).order("created_at",{ascending:false}).limit(100);
  if(status!=="all")q=q.eq("status",status);
  const result=await q;
  if(result.error)return json(res,503,{error:"review_list_unavailable"});
  const rows=result.data||[];
  const ids=[...new Set(rows.map(r=>r.company_id))];
  const companies=ids.length?await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
   .select("id,name").eq("tenant_id",ctx.tenantId).in("id",ids):{data:[],error:null};
  if(companies.error)return json(res,503,{error:"company_scope_unavailable"});
  const names=new Map((companies.data||[]).map(c=>[c.id,c.name]));
  return json(res,200,{items:rows.filter(r=>names.has(r.company_id)).map(r=>({
   id:r.id,companyId:r.company_id,companyName:names.get(r.company_id),
   itemType:r.item_type,title:r.title,description:r.description,skills:r.skills,
   budget:r.budget,startDate:r.start_date,workStyle:r.work_style,
   attachmentName:r.attachment_name,attachmentSize:r.attachment_size,
   status:r.status,reviewNote:r.review_note,createdAt:r.created_at
  })),canReview:canManageProposals(ctx)});
 }
 if(!canManageProposals(ctx))
  return json(res,403,{error:"review_manager_required",hint:"承認・見送りは責任者・管理者が操作します。"});
 let body;try{body=await readJson(req);}catch{return json(res,400,{error:"invalid_json"});}
 if(!isUuid(body?.submissionId)||body?.confirmed!==true)return json(res,400,{error:"invalid_review"});
 const allowed={approve:"approved",needs_changes:"needs_changes",reject:"rejected"};
 const resultStatus=allowed[body.action];
 if(!resultStatus)return json(res,400,{error:"invalid_action"});
 const note=String(body.reviewNote||"").trim().slice(0,800);
 if((body.action!=="approve")&&note.length<3)
  return json(res,400,{error:"review_reason_required",hint:"修正依頼・見送りの理由を入力してください。"});
 // Approval never publishes confidential partner candidates or uploads.
 const updated=await db.schema("enger").from(TABLE).update({
  status:resultStatus,review_note:note,reviewed_by:user.id,
  reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString()
 }).eq("id",body.submissionId).eq("tenant_id",ctx.tenantId)
   .eq("status","pending_review").select("id,company_id,item_type,title,status").maybeSingle();
 if(updated.error)return json(res,503,{error:"review_save_failed"});
 if(!updated.data)return json(res,409,{error:"already_reviewed",
  hint:"この提出内容はすでに確認されています。最新状態を読み直してください。"});
 const companyId=updated.data.company_id;
 const link=await db.from("gw_sales_company_links").select("company_id")
   .eq("tenant_id",ctx.tenantId).eq("source_system","enger")
   .eq("source_company_id",companyId).limit(2);
 if(!link.error&&link.data?.length===1){
  await db.from("gw_sales_events").insert({
   tenant_id:ctx.tenantId,company_id:link.data[0].company_id,
   event_key:"company_submission_review",label:"ENGER企業提出：「"+updated.data.title.slice(0,100)+"」"+resultStatus,
   detail:note.slice(0,500),created_by:user.id,channel:"other"
  });
 }
 return json(res,200,{ok:true,id:updated.data.id,status:resultStatus,
  matchingReady:false,
  hint:"確認結果を保存しました。ENGER DXへの反映・公開は別途担当者の承認操作が必要です。"});
}
