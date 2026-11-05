// POST: connect a DB company to the existing Sales workflow; never send a message.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
import {gwLog} from "../../lib/gw-audit.js";
import {isUuid} from "../../lib/sales.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {ensureSalesCompany} from "../../lib/sales-enger-company.js";
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=="POST")return methodNotAllowed(res,["POST"]);
 res.setHeader?.("Cache-Control","private, no-store");
 const ctx=await gwContext(user.id);
 if(!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:"forbidden"});
 const body=await readJson(req),id=String(body.id||"").toLowerCase();
 if(!isUuid(id))return json(res,400,{error:"invalid_id"});
 try{
  const db=admin();
  const scope=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
   .select("id,needs_contact_review,directory_hidden_at").eq("tenant_id",ctx.tenantId).eq("id",id).maybeSingle();
  if(scope.error)throw scope.error;
  if(!scope.data)return json(res,404,{error:"company_not_found"});
  if(scope.data.needs_contact_review||scope.data.directory_hidden_at)
   return json(res,409,{error:"contact_blocked",hint:"連絡注意・除外中の企業です。管理者が確認してから営業を開始してください。"});
  const source=await db.schema("enger").from("companies")
   .select("id,name,website,contact_form_url,phone,contact_email,industry,prefecture,address,note")
   .eq("id",id).is("deleted_at",null).maybeSingle();
  if(source.error)throw source.error;
  if(!source.data)return json(res,404,{error:"company_not_found"});
  const company=await ensureSalesCompany(db,ctx,user,source.data);
  // Existing exclusions and opt-outs survive the bridge.
  if(company.hidden_at||company.ng_reason)return json(res,409,{error:"sales_contact_blocked",hint:"営業禁止・非表示の企業です。既存の営業記録を確認してください。"});
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"sales.enger_company_open",target:company.id,detail:{sourceCompanyId:id}});
  return json(res,200,{companyId:company.id});
 }catch{
  return json(res,503,{error:"company_action_unavailable",hint:"営業情報に接続できませんでした。再度開いてください。"});
 }
}
