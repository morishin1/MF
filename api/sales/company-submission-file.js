// Staff-only signed download for company-submitted skill sheets.
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","private, no-store");
 if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return json(res,403,{error:"forbidden"});
 const qs=new URL(req.url||"/","http://localhost").searchParams;
 const id=qs.get("id");
 if(!isUuid(id))return json(res,400,{error:"invalid_id"});
 const db=admin();
 const row=await db.schema("enger").from("dx2_company_partner_submissions")
  .select("id,company_id,tenant_id,attachment_path,attachment_name")
  .eq("id",id).eq("tenant_id",ctx.tenantId).maybeSingle();
 if(row.error)return json(res,503,{error:"not_available"});
 if(!row.data?.attachment_path)return json(res,404,{error:"file_not_found"});
 const scope=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
   .select("id").eq("tenant_id",ctx.tenantId).eq("id",row.data.company_id).maybeSingle();
 if(scope.error||!scope.data)return json(res,404,{error:"not_found"});
 const path=row.data.attachment_path;
 if(!path.startsWith(ctx.tenantId+"/"+row.data.company_id+"/"+row.data.id+"/"))
  return json(res,409,{error:"file_scope_mismatch"});
 const result=await db.storage.from("enger-company-private").createSignedUrl(path,120);
 if(result.error||!result.data?.signedUrl)return json(res,503,{error:"download_unavailable"});
 res.writeHead(302,{"Location":result.data.signedUrl,"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"});
 res.end();
}
