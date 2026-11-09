// Staff-only ENGER success-fee ledger. Finance records remain separate;
// this API never creates an invoice or books accounting revenue.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {canManageProposals} from "../../lib/sales-proposals.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";
import {FEE_STATUS,FEE_MODEL,parseFeeDraft,feeTransition,feeSummary} from "../../lib/sales-success-fees.js";

const TABLE="gw_sales_success_fees";
const COLS="id,tenant_id,company_id,offer_id,fee_model,fee_month,fee_yen,payer_name,status,agreement_reference,confirmed_on,invoice_number,invoiced_on,paid_on,note,created_by,updated_by,created_at,updated_at";
const out=(res,status,error,hint)=>json(res,status,{error,hint});
const view=x=>({
 id:x.id,offerId:x.offer_id,model:x.fee_model,modelLabel:FEE_MODEL[x.fee_model],
 feeMonth:x.fee_month,feeYen:Number(x.fee_yen),
 payerName:x.payer_name,status:x.status,statusLabel:FEE_STATUS[x.status],
 agreementReference:x.agreement_reference,confirmedOn:x.confirmed_on,
 invoiceNumber:x.invoice_number,invoicedOn:x.invoiced_on,paidOn:x.paid_on,
 note:x.note,createdAt:x.created_at,updatedAt:x.updated_at
});

export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 res.setHeader?.("Cache-Control","private, no-store");
 if(!["GET","POST","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","POST","PATCH"]);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return out(res,403,"forbidden","Sales権限が必要です。");
 let body={};
 if(req.method!=="GET"){
   try{body=await readJson(req);}catch{return out(res,400,"bad_json","入力を確認してください。");}
 }
 const companyId=req.method==="GET"?
   new URL(req.url||"/","http://localhost").searchParams.get("companyId"):body.companyId;
 if(!isUuid(companyId))return out(res,400,"invalid_company","企業IDが正しくありません。");
 const db=admin();
 const scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return out(res,scope.status,scope.error,"担当企業のアクセス権を確認できませんでした。");
 const manager=canManageProposals(ctx);
 if(req.method==="GET"){
   const r=await db.from(TABLE).select(COLS).eq("tenant_id",ctx.tenantId)
     .eq("company_id",companyId).order("created_at",{ascending:false}).limit(300);
   if(r.error)return out(res,503,"fees_unavailable","成果報酬台帳を読み込めませんでした。");
   return json(res,200,{items:(r.data||[]).map(view),summary:feeSummary(r.data||[]),
     isManager:manager,statusLabels:FEE_STATUS,modelLabels:FEE_MODEL,
     note:"成果報酬の営業管理台帳です。会計売上・請求書の発行ではありません。"});
 }
 if(req.method==="POST"){
   if(!isUuid(body.offerId))return out(res,400,"invalid_offer","オファーを選択してください。");
   const check=parseFeeDraft(body);
   if(check.error)return out(res,400,check.error,"報酬モデル・金額・支払企業・対象月を確認してください。");
   const found=await db.schema("enger").from("dx2_company_portal_offers")
     .select("id,status").eq("tenant_id",ctx.tenantId)
     .eq("company_id",companyId).eq("id",body.offerId).maybeSingle();
   if(found.error)return out(res,503,"offer_unavailable","オファーを確認できませんでした。");
   if(!found.data||found.data.status==="lost")return out(res,409,"offer_not_eligible","有効なオファーを指定してください。");
   const inserted=await db.from(TABLE).insert({
     tenant_id:ctx.tenantId,company_id:companyId,offer_id:body.offerId,
     ...check.value,status:"draft",created_by:user.id,updated_by:user.id,
   }).select(COLS).single();
   if(inserted.error)return out(res,inserted.error.code==="23505"?409:503,
      inserted.error.code==="23505"?"already_registered":"fee_save_failed",
      inserted.error.code==="23505"?"同じオファー・対象月の成果報酬は登録済みです。":"保存できませんでした。");
   return json(res,201,{ok:true,item:view(inserted.data),note:"見込として保存しました。契約成立後、責任者が確認します。"});
 }
 if(!isUuid(body.feeId)||body.confirmed!==true||
    !Object.hasOwn(FEE_STATUS,body.expectedStatus))
   return out(res,400,"invalid_transition","対象・変更前の状態・確認が必要です。");
 const existing=await db.from(TABLE).select(COLS).eq("id",body.feeId)
   .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).maybeSingle();
 if(existing.error)return out(res,503,"fee_read_failed","報酬状態を確認できませんでした。");
 if(!existing.data)return out(res,404,"fee_not_found","対象が見つかりません。");
 if(existing.data.status!==body.expectedStatus)return out(res,409,"stale_fee","別の担当者が更新しました。再取得してください。");
 const offer=await db.schema("enger").from("dx2_company_portal_offers")
   .select("id,status").eq("id",existing.data.offer_id)
   .eq("tenant_id",ctx.tenantId).eq("company_id",companyId).maybeSingle();
 if(offer.error||!offer.data)return out(res,503,"offer_unavailable","オファーの契約状態を確認できませんでした。");
 const patch=feeTransition(existing.data,body,{manager,offerStatus:offer.data.status});
 if(patch.error)return out(res,patch.error==="manager_required"?403:409,patch.error,
   ({manager_required:"契約・請求・入金の確認は責任者が行います。",
    contract_not_yet_agreed:"オファーを先に「成約確認待ち」に更新し、契約の根拠を確認してください。",
    agreement_reference_required:"契約書・申込書などの確認できる参照番号またはURLを8文字以上で入力してください。",
    invoice_reference_required:"請求記録に進めるには請求書番号が必要です。"}[patch.error]||"状態の移動・日付を確認してください。"));
 const updated=await db.from(TABLE).update({
   ...patch.value,updated_by:user.id,updated_at:new Date().toISOString()
 }).eq("id",body.feeId).eq("tenant_id",ctx.tenantId)
   .eq("company_id",companyId).eq("status",body.expectedStatus)
   .select(COLS).maybeSingle();
 if(updated.error||!updated.data)return out(res,409,"fee_update_failed","更新できませんでした。最新状態を再取得してください。");
 return json(res,200,{ok:true,item:view(updated.data)});
}
