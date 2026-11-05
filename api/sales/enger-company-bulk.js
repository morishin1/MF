// PATCH /api/sales/enger-company-bulk
// Reversible directory exclusion and evidence-based priority/relationship updates.
// Never delete ENGER master companies or their proposal, meeting, and touchpoint history.
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {gwLog} from "../../lib/gw-audit.js";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS=new Set(["exclude","restore","priority","relationship","broadcast"]);
const RELATIONS=new Set(["unknown","active","past","none_confirmed"]);
export default async function handler(req,res) {
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=="PATCH")return methodNotAllowed(res,["PATCH"]);
 res.setHeader?.("Cache-Control","private, no-store");
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:"forbidden"});
 const body=await readJson(req);
 const action=String(body.action||""),ids=body.ids;
 if(!ACTIONS.has(action)||!Array.isArray(ids)||!ids.length||ids.length>50
    ||ids.some(id=>!UUID.test(id))||new Set(ids).size!==ids.length)
   return json(res,400,{error:"invalid_selection",hint:"重複しない1〜50社を選んでください。"});
 if(action==="priority"&&body.priority!==null&&!["A","B","C","D"].includes(body.priority))
   return json(res,400,{error:"invalid_priority",hint:"A/B/C/Dを選ぶか、上書きを解除してください。"});
 if(action==="broadcast"&&typeof body.blastTarget!=="boolean")
   return json(res,400,{error:"invalid_broadcast",hint:"配信の登録・解除を選んでください。"});
 const relation=String(body.relationshipStatus||"");
 const evidence=String(body.evidence||"").trim().slice(0,2000);
 if(action==="relationship"&&(!RELATIONS.has(relation)
    ||(relation!=="unknown"&&evidence.length<10)))
   return json(res,400,{error:"relationship_evidence_required",hint:"取引あり・過去取引・取引なしの確定には10文字以上の確認根拠が必要です。"});
 // Different from a hard delete: updating list visibility is allowed; only
 // owner/manager/admin may exclude or restore, keeping all underlying histories.
 if(["exclude","restore"].includes(action)&&!ctx.isAdmin
   && !(ctx.roles||[]).some(x=>x==="owner"||x==="manager"))
   return json(res,403,{error:"manager_required",hint:"除外・復元は管理者または責任者のみ操作できます。"});
 try {
   const db=admin(),tenant=ctx.tenantId;
   const active=await db.schema("enger").from("companies").select("id").in("id",ids).is("deleted_at",null);
   if(active.error||!active.data||active.data.length!==ids.length)
     return json(res,409,{error:"company_list_changed",hint:"選択した企業が存在しません。再表示してから操作してください。"});
   const existing=await db.from("gw_sales_enger_company_overrides")
     .select("company_id,priority,relationship_status,relationship_evidence,hidden_at")
     .eq("tenant_id",tenant).in("company_id",ids);
   if(existing.error)return json(res,503,{error:"directory_review_unavailable",hint:"保存済み評価を取得できません。"});
   const before=new Map((existing.data||[]).map(r=>[r.company_id,r]));
   const now=new Date().toISOString();
   const records=ids.map(companyId=>{
     const old=before.get(companyId)||{};
     if(action==="broadcast")return {tenant_id:tenant,company_id:companyId,blast_target:body.blastTarget,blast_updated_at:now,blast_updated_by:user.id};
     return {
       tenant_id:tenant,company_id:companyId,
       priority:action==="priority"?body.priority:(old.priority??null),
       relationship_status:action==="relationship"?relation:(old.relationship_status||"unknown"),
       relationship_evidence:action==="relationship"?(relation==="unknown"?null:evidence):(old.relationship_evidence??null),
       hidden_at:action==="exclude"?now:action==="restore"?null:(old.hidden_at??null),
       updated_at:now,updated_by:user.id,
     };
   });
   const saved=await db.from("gw_sales_enger_company_overrides")
       .upsert(records,{onConflict:"tenant_id,company_id"}).select("company_id");
   if(saved.error||!saved.data||saved.data.length!==ids.length)
     return json(res,503,{error:"directory_save_failed",hint:"更新件数が一致しません。再読み込みして確認してください。"});
   await gwLog({tenantId:tenant,actorId:user.id,
     action:"sales.enger_directory_"+action,target:"enger_companies:"+ids.length,
     detail:{ids,action,blastTarget:action==="broadcast"?body.blastTarget:undefined,priority:action==="priority"?body.priority:undefined,
       relationshipStatus:action==="relationship"?relation:undefined,
       evidence:action==="relationship"?evidence:undefined}});
   return json(res,200,{updated:saved.data.length,action,complete:true});
 }catch{
   return json(res,503,{error:"directory_save_failed",hint:"変更を保存できませんでした。再読み込みしてください。"});
 }
}
