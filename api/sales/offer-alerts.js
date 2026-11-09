// Lightweight sales offer-alert feed: red badges reflect *unhandled* company offers.
// A read does not clear alerts; moving status away from "new" does.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";

export default async function handler(req,res){
 res.setHeader?.("Cache-Control","private, no-store");
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
   return json(res,403,{error:"forbidden"});
 const db=admin();
 const pending=await db.schema("enger").from("dx2_company_portal_offers")
   .select("id,company_id,created_at").eq("tenant_id",ctx.tenantId)
   .eq("status","new").order("created_at",{ascending:false}).limit(201);
 if(pending.error)return json(res,503,{error:"offer_alert_unavailable",hint:"オファー通知を取得できませんでした。"});
 const rows=pending.data||[];
 const companyIds=[...new Set(rows.map(r=>r.company_id).filter(isUuid))];
 let directory={data:[],error:null};
 if(companyIds.length){
   directory=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
     .select("id,name").eq("tenant_id",ctx.tenantId).in("id",companyIds);
 }
 if(directory.error)return json(res,503,{error:"offer_alert_scope_unavailable"});
 const accessible=new Map((directory.data||[]).map(x=>[x.id,x.name]));
 const visible=rows.filter(x=>accessible.has(x.company_id));
 return json(res,200,{
   pendingCount:visible.length,
   countCapped:rows.length>200,
   recent:visible.slice(0,5).map(x=>({
     offerId:x.id,companyId:x.company_id,
     companyName:String(accessible.get(x.company_id)||"企業").slice(0,120),
     createdAt:x.created_at,
   })),
   observedAt:new Date().toISOString(),
   meaning:"未対応の企業オファー。画面を開いただけでは消えず、対応状態を変更すると減ります。",
 });
}
