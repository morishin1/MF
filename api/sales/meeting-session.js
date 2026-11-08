// Salesスタッフが操作する5ステップ商談セッション。
// 企業はENGER側で認証後にステップを読み取る。変更権限はSales側だけ。
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";

const TABLE="gw_sales_live_meeting_sessions";
const EVENTS="gw_sales_live_meeting_stage_events";
const source=/^(talent|job):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const COLUMNS="id,tenant_id,company_id,selected_keys,stage,status,version,started_at,updated_at,closed_at";
const inputKeys=(raw)=>{
 if(!Array.isArray(raw)||raw.length<1||raw.length>10)return null;
 const list=raw.map(x=>typeof x==="string"?x.trim().toLowerCase():"");
 if(list.some(x=>!source.test(x))||new Set(list).size!==list.length)return null;
 return list;
};
const itemKey=r=>r.item_type+":"+(r.item_type==="talent"?r.candidate_id:r.job_id);
const fail=(res,e)=>{
 console.error("[sales/meeting-session]",String(e?.code||e?.message||"unknown").slice(0,120));
 return json(res,503,{error:"session_unavailable",hint:"商談の進行状況を保存できませんでした。"});
};
function view(row){
 return {
  id:row.id,stage:row.stage,status:row.status,version:row.version,
  selectedKeys:row.selected_keys,
  selectedCount:row.selected_keys?.length||0,
  updatedAt:row.updated_at,startedAt:row.started_at,
  clientMeetingPath:"/business/meeting?companyId="+encodeURIComponent(row.company_id)+
    "&session="+encodeURIComponent(row.id)
 };
}
async function scopeFor(db,ctx,companyId) {
 const scope=await companyInScope(db,ctx.tenantId,companyId);
 if(!scope.ok)return {error:scope.error,status:scope.status};
 const directory=await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
  .select("needs_contact_review,directory_hidden_at").eq("tenant_id",ctx.tenantId)
  .eq("id",companyId).maybeSingle();
 if(directory.error)throw directory.error;
 if(!directory.data)return {error:"company_not_found",status:404};
 return {blocked:Boolean(directory.data.needs_contact_review||directory.data.directory_hidden_at)};
}
async function getRow(db,ctx,id,companyId) {
 if(!isUuid(id))return {error:"invalid_session"};
 const r=await db.from(TABLE).select(COLUMNS).eq("id",id).eq("tenant_id",ctx.tenantId)
  .eq("company_id",companyId).maybeSingle();
 if(r.error)throw r.error;
 return r.data?{row:r.data}:{error:"session_not_found"};
}
async function start(db,ctx,user,companyId,body,res) {
 const keys=inputKeys(body.selectedKeys);
 if(!keys)return json(res,400,{error:"invalid_selection",hint:"公開候補を1〜10件選んでください。"});
 const [shares,existing]=await Promise.all([
  db.schema("enger").from("dx2_company_sales_shortlist")
   .select("item_type,candidate_id,job_id").eq("tenant_id",ctx.tenantId)
   .eq("company_id",companyId).eq("status","published").limit(150),
  db.from(TABLE).select(COLUMNS).eq("tenant_id",ctx.tenantId)
   .eq("company_id",companyId).eq("status","active").maybeSingle()
 ]);
 if(shares.error||existing.error)throw shares.error||existing.error;
 const allowed=new Set((shares.data||[]).map(itemKey));
 if(keys.some(k=>!allowed.has(k)))
  return json(res,409,{error:"selection_not_published",
    hint:"公開承認されていない候補が含まれます。内容を確認してください。"});
 if(existing.data&&JSON.stringify(existing.data.selected_keys)===JSON.stringify(keys))
  return json(res,200,{ok:true,reused:true,session:view(existing.data)});
 // 別の商談内容が始まるときは既存の進行を閉じる。同時作成はDB一意制約で防ぐ。
 if(existing.data){
  const closed=await db.from(TABLE).update({
   status:"closed",closed_at:new Date().toISOString(),updated_at:new Date().toISOString(),updated_by:user.id
  }).eq("id",existing.data.id).eq("tenant_id",ctx.tenantId).eq("status","active");
  if(closed.error)throw closed.error;
 }
 const made=await db.from(TABLE).insert({
  tenant_id:ctx.tenantId,company_id:companyId,selected_keys:keys,stage:0,
  started_by:user.id,updated_by:user.id
 }).select(COLUMNS).single();
 if(made.error){
  if(made.error.code==="23505")return json(res,409,{error:"concurrent_meeting",hint:"他の商談が開始されました。画面を更新してください。"});
  throw made.error;
 }
 return json(res,200,{ok:true,reused:false,session:view(made.data)});
}
async function change(db,ctx,user,companyId,body,res) {
 const got=await getRow(db,ctx,body.sessionId,companyId);
 if(got.error)return json(res,404,{error:got.error});
 const current=got.row;
 if(current.status!=="active")return json(res,409,{error:"meeting_closed"});
 if(!Number.isInteger(body.stage)||body.stage<0||body.stage>4||
    Math.abs(body.stage-current.stage)!==1)
  return json(res,400,{error:"invalid_stage",hint:"商談は前へ・次へで1段階ずつ進めてください。"});
 if(!Number.isInteger(body.version)||body.version!==current.version)
  return json(res,409,{error:"stale_meeting",hint:"ほかの担当者が商談を進めました。画面を再取得してください。"});
 const updated=await db.from(TABLE).update({
  stage:body.stage,version:current.version+1,updated_at:new Date().toISOString(),updated_by:user.id
 }).eq("id",current.id).eq("tenant_id",ctx.tenantId)
  .eq("company_id",companyId).eq("status","active").eq("version",current.version)
  .select(COLUMNS).maybeSingle();
 if(updated.error)throw updated.error;
 if(!updated.data)return json(res,409,{error:"stale_meeting"});
 const event=await db.from(EVENTS).insert({
  session_id:current.id,tenant_id:ctx.tenantId,company_id:companyId,
  from_stage:current.stage,to_stage:body.stage,actor_id:user.id
 });
 if(event.error){
  console.error("[sales/meeting-session] history_failed",String(event.error.code||"unknown").slice(0,40));
 }
 return json(res,200,{ok:true,session:view(updated.data),historySaved:!event.error});
}
export default async function handler(req,res) {
 res.setHeader("Cache-Control","private, no-store");
 if(!["GET","POST","PATCH"].includes(req.method))return methodNotAllowed(res,["GET","POST","PATCH"]);
 const user=await requireUser(req,res);
 if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
  return json(res,403,{error:"forbidden"});
 const body=req.method==="GET"?{}:await readJson(req);
 const params=new URL(req.url||"/","http://localhost").searchParams;
 const companyId=req.method==="GET"?params.get("companyId"):body.companyId;
 if(!isUuid(companyId))return json(res,400,{error:"invalid_company"});
 const db=admin();
 try{
  const scope=await scopeFor(db,ctx,companyId);
  if(scope.error)return json(res,scope.status||404,{error:scope.error});
  if(req.method==="GET") {
   const got=await getRow(db,ctx,params.get("sessionId"),companyId);
   if(got.error)return json(res,404,{error:got.error});
   return json(res,200,{session:view(got.row)});
  }
  if(scope.blocked)return json(res,403,{error:"company_blocked"});
  if(req.method==="POST")return start(db,ctx,user,companyId,body,res);
  return change(db,ctx,user,companyId,body,res);
 }catch(e){return fail(res,e);}
}
