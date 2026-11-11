// Read-only confirmation that this company's ENGER offer was saved during
// this Sales meeting. The browser message is never trusted as proof.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";

export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return json(res,403,{error:"forbidden"});
 const qs=new URL(req.url||"/","http://localhost").searchParams;
 const companyId=qs.get("companyId"),sessionId=qs.get("sessionId");
 if(!isUuid(companyId)||!isUuid(sessionId))return json(res,400,{error:"invalid_session"});
 const db=admin();
 try{
  const scope=await companyInScope(db,ctx.tenantId,companyId);
  if(!scope.ok)return json(res,scope.status||404,{error:scope.error});
  const session=await db.from("gw_sales_live_meeting_sessions")
    .select("id,company_id,tenant_id,started_at,status,stage")
    .eq("id",sessionId).eq("company_id",companyId)
    .eq("tenant_id",ctx.tenantId).maybeSingle();
  if(session.error)throw session.error;
  if(!session.data)return json(res,404,{error:"session_not_found"});
  const offers=await db.schema("enger").from("dx2_company_portal_offers")
    .select("id,created_at",{"count":"exact"})
    .eq("company_id",companyId).eq("tenant_id",ctx.tenantId)
    .gte("created_at",session.data.started_at).order("created_at",{ascending:false})
    .limit(30);
  if(offers.error)throw offers.error;
  // Do not return private offer content; staff just needs a verified count.
  return json(res,200,{ok:true,sessionId,companyId,
    count:offers.count??(offers.data||[]).length,
    hasOffer:(offers.count??(offers.data||[]).length)>0,
    stage:session.data.stage,status:session.data.status});
 }catch(error){
  console.error("[sales/company-offer-progress]",String(error?.code||error?.message||"unknown").slice(0,120));
  return json(res,503,{error:"offer_progress_unavailable"});
 }
}
