// Staff-owned review of company-submitted private jobs and talent skill sheets.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canManageProposals} from "../../lib/sales-proposals.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {gwLog} from "../../lib/gw-audit.js";
const T="dx2_company_partner_submissions",BUCKET="enger-company-private";
const STATUSES=new Set(["pending_review","approved","needs_changes","rejected"]);
const fail=(res,error,message,status=400)=>json(res,status,{error,hint:message});
export default async function handler(req,res){
 res.setHeader?.("Cache-Control","private, no-store");
 const user=await requireUser(req,res);if(!user)return;
 if(!["GET","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","PATCH"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return fail(res,"forbidden","Salesの管理権限が必要です。",403);
 const db=admin();
 const p=new URL(req.url||"/","http://localhost").searchParams;
 if(req.method==="GET"){
  const companyId=p.get("companyId");
  if(companyId&&!isUuid(companyId))return fail(res,"invalid_company","企業IDを確認してください。");
  const status=p.get("status")||"pending_review";
  if(status!=="all"&&!STATUSES.has(status))return fail(res,"invalid_status","状態を確認してください。");
  const fileId=p.get("fileId");
  if(fileId){
   if(!canManageProposals(ctx))return fail(res,"manager_only","機微ファイルの閲覧には管理者権限が必要です。",403);
   if(!isUuid(fileId)||!companyId)return fail(res,"invalid_file","対象の企業と登録IDが必要です。");
   const rec=await db.schema("enger").from(T).select("attachment_path")
    .eq("id",fileId).eq("tenant_id",ctx.tenantId).eq("company_id",companyId).maybeSingle();
   if(rec.error)return fail(res,"file_unavailable","スキルシートの状態を取得できません。",503);
   if(!rec.data?.attachment_path)return fail(res,"file_missing","スキルシートがありません。",404);
   const signed=await db.storage.from(BUCKET).createSignedUrl(rec.data.attachment_path,90);
   if(signed.error||!signed.data?.signedUrl)return fail(res,"file_unavailable","ファイルを開けません。",503);
   return json(res,200,{url:signed.data.signedUrl,expiresIn:90});
  }
  let query=db.schema("enger").from(T)
   .select("id,company_id,member_id,item_type,title,description,skills,budget,start_date,work_style,attachment_name,status,review_note,created_at,reviewed_at")
   .eq("tenant_id",ctx.tenantId).order("created_at",{ascending:false}).limit(100);
  if(companyId)query=query.eq("company_id",companyId);
  if(status!=="all")query=query.eq("status",status);
  const got=await query;
  if(got.error)return fail(res,"list_unavailable","企業登録一覧を取得できません。",503);
  const ids=[...new Set((got.data||[]).map(x=>x.company_id))];
  const companies=ids.length?await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
   .select("id,name").eq("tenant_id",ctx.tenantId).in("id",ids):{data:[],error:null};
  if(companies.error)return fail(res,"scope_unavailable","企業の紐付けを確認できません。",503);
  const names=new Map((companies.data||[]).map(c=>[c.id,c.name]));
  const rows=(got.data||[]).filter(x=>names.has(x.company_id))
   .map(x=>({...x,company_name:names.get(x.company_id)}));
  return json(res,200,{rows,canReview:canManageProposals(ctx),
   note:"ENGER担当者の確認待ち。承認しても即座に外部公開せず、DX側のマッチング対象への反映を別途確認します。"});
 }
 if(!canManageProposals(ctx))return fail(res,"manager_only","承認は営業責任者・管理者が行えます。",403);
 let body;try{body=await readJson(req);}catch{return fail(res,"invalid_json","入力を確認してください。");}
 if(!isUuid(body?.companyId)||!isUuid(body?.submissionId)||
   !STATUSES.has(body?.status)||body.status==="pending_review"||
   !STATUSES.has(body?.expectedStatus)||body.confirmed!==true)
  return fail(res,"invalid_review","企業・登録内容・状態を確認してください。");
 const existing=await db.schema("enger").from(T).select("id,status")
  .eq("id",body.submissionId).eq("tenant_id",ctx.tenantId).eq("company_id",body.companyId).maybeSingle();
 if(existing.error||!existing.data)return fail(res,"submission_unavailable","登録情報を取得できません。",404);
 if(existing.data.status!==body.expectedStatus)return fail(res,"stale_review","他の担当者が更新しました。再取得してください。",409);
 if(existing.data.status==="approved")return fail(res,"already_approved","承認済みの内容は削除・再公開しません。",409);
 const note=String(body.note||"").trim().slice(0,700);
 if(body.status!=="approved"&&note.length<3)
  return fail(res,"review_reason_required","差戻し・見送り理由を記載してください。");
 const update=await db.schema("enger").from(T).update({
  status:body.status,review_note:note,reviewed_by:user.id,
  reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString()
 }).eq("id",existing.data.id).eq("tenant_id",ctx.tenantId).eq("company_id",body.companyId)
   .eq("status",body.expectedStatus).select("id,status").maybeSingle();
 if(update.error||!update.data)return fail(res,"review_conflict","審査状態を保存できませんでした。",409);
 await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.company_intake_review",
  target:"enger_submission:"+existing.data.id,detail:{companyId:body.companyId,
   from:existing.data.status,to:body.status}});
 return json(res,200,{ok:true,status:update.data.status,note:"ENGERでの公開は別途確認が必要です。"});
}
