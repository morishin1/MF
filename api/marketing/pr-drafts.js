// Marketing PR draft -> review -> internal registration. No external publication.
import {json,methodNotAllowed,dbSetupHint} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,accessOf} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
import {verifyImageRefs,boundedJson,UUID as IMAGE_UUID} from "../../lib/marketing-pr-images.js";
import {sanitizePRSections,validPRImageKeys} from "../../lib/marketing-pr-content.js";
const TABLE="gw_marketing_pr_drafts",SQL="db/proposal_marketing_pr_drafts.sql";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS=new Set(["service","product","event","campaign","partnership","research","corporate","other"]);
const FIELDS={
 kind:30,title:120,subtitle:120,summary:600,background:6000,future:5000,
 event_on:20,event_end_on:20,event_start:10,event_end:10,event_date:150,venue:40,
 venue_name:200,venue_address:500,fee_type:12,fee_amount:30,fee_tax:10,
 partner:600,target:500,url:1800,company:200,company_kana:200,representative:200,
 founded:200,location:600,business:2000,company_url:1800,
 contact_dept:200,contact_name:200,contact_tel:100,contact_email:250,contact_hours:200
};
const featureFields=["title","body"];
const asText=(x,n)=>typeof x==="string"&&x.length<=n?x:null;
function sanitize(raw){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const src=raw.draft;
 if(!src||typeof src!=="object"||Array.isArray(src))return null;
 const d={};
 for(const [key,len] of Object.entries(FIELDS)){
  const value=src[key];
  if(value!==undefined&&value!==null){
   const s=asText(value,len);
   if(s===null)return null;
   d[key]=s;
  }else d[key]="";
 }
 for(const key of ["event_allday","event_time_tbd"])d[key]=src[key]===true;
 if(d.kind&&!KINDS.has(d.kind))return null;
 if(src.features!==undefined){
  if(!Array.isArray(src.features)||src.features.length>3)return null;
  d.features=[];
  for(const feature of src.features){
   if(!feature||typeof feature!=="object")return null;
   if(asText(feature.title,120)===null||asText(feature.body,3000)===null)return null;
   d.features.push({title:feature.title,body:feature.body});
  }
 }else d.features=[];
 if(src.images!==undefined){
  if(!Array.isArray(src.images)||src.images.length>10)return null;
  d.images=[];
  for(const i of src.images){
   if(!i||typeof i!=="object"||asText(i.name,200)===null||asText(i.caption,600)===null)return null;
   const size=Number(i.size);
   if(!Number.isFinite(size)||size<0||size>10*1024*1024)return null;
   if(i.imageId!==undefined&&!IMAGE_UUID.test(i.imageId))return null;
   d.images.push({name:i.name,caption:i.caption,size,...(i.key!==undefined?{key:i.key}:{}),...(i.imageId!==undefined?{imageId:i.imageId}:{})});
  }
 }else d.images=[];
 if(!validPRImageKeys(d.images))return null;
 d.sections=sanitizePRSections(src.sections,d.images);if(d.sections===null)return null;
 const override=raw.body_override==null?"":asText(raw.body_override,20000);
 if(override===null)return null;
 const media=raw.media&&typeof raw.media==="object"&&!Array.isArray(raw.media)?raw.media:{};
 const bodies={};
 for(const [name,value]of Object.entries(media)){
  if(!["corp","dojo","space","machi","x","instagram","facebook","line","blastmail"].includes(name))return null;
  if(asText(value,12000)===null)return null;
  bodies[name]=value;
 }
 const clean={draft:d,body_override:override,media:bodies};
 return Buffer.byteLength(JSON.stringify(clean))<=120000?clean:null;
}
function secureUrl(value){
 if(!value)return true;
 try{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password&&u.href.length<=1900;}
 catch{return false;}
}
function validateRegistration(p){
 const d=p.draft,missing=[];
 if(!d.title.trim())missing.push("タイトル");
 if(!d.summary.trim())missing.push("概要");
 if(!d.company.trim())missing.push("会社・団体名");
 if(!d.features.some(x=>x.title.trim()||x.body.trim()))missing.push("ポイント・特徴");
 if(!d.contact_email.trim()&&!d.contact_tel.trim())missing.push("問い合わせ先");
 if(!KINDS.has(d.kind))missing.push("リリース種別");
 if(missing.length)return {error:"missing_required",hint:"必須項目："+missing.join("・")};
 for(const key of ["url","company_url"]){
  if(!secureUrl(d[key]))return {error:"invalid_url",hint:"URLはhttps://から入力してください"};
 }
 if(d.fee_type==="paid"&&!(Number(d.fee_amount)>0))
  return {error:"invalid_fee",hint:"有料の場合は金額を設定してください"};
 if(d.event_on&&d.event_end_on&&d.event_end_on<d.event_on)
  return {error:"invalid_dates",hint:"終了日は開始日以降に設定してください"};
 if(d.images.some(i=>!i.imageId))return {error:"image_upload_required",hint:"画像原本が未保存です。画像を再選択して下書き保存するか、原稿から外してください。"};
 if(d.images.some(i=>!i.caption.trim()))
  return {error:"image_caption",hint:"画像説明を入力してください"};
 return null;
}
const toPublic=row=>({
 id:row.id,version:row.version,status:row.status,createdAt:row.created_at,
 updatedAt:row.updated_at,registeredAt:row.registered_at,
 payload:row.payload
});
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!accessOf(ctx).marketing)return json(res,403,{error:"forbidden"});
 res.setHeader("Cache-Control","no-store");
 const sb=admin();
 const errorOut=e=>{
  if(dbSetupHint(e,SQL))return json(res,503,{error:"not_ready",hint:"PRの保存先が未準備です。管理者がSQLを適用するまで一時草案のみ利用できます。",sql:SQL});
  return json(res,500,{error:"db_error",hint:"処理できませんでした。再確認してください。"});
 };
 if(req.method==="GET"){
  const q=new URL(req.url||"/","https://localhost").searchParams;
  const id=q.get("id");
  let query=sb.from(TABLE).select("id,version,status,payload,created_at,updated_at,registered_at")
    .eq("tenant_id",ctx.tenantId).eq("created_by",user.id);
  if(id){
   if(!UUID.test(id))return json(res,400,{error:"invalid_id"});
   const {data,error}=await query.eq("id",id).maybeSingle();
   if(error)return errorOut(error);
   if(!data)return json(res,404,{error:"not_found"});
   return json(res,200,{ready:true,item:toPublic(data)});
  }
  const {data,error}=await query.order("updated_at",{ascending:false}).limit(40);
  if(error)return errorOut(error);
  return json(res,200,{ready:true,items:(data||[]).map(toPublic)});
 }
 if(req.method!=="POST")return methodNotAllowed(res,["GET","POST"]);
 let body;try{body=await boundedJson(req,150000);}catch{return json(res,413,{error:"payload_too_large"});}
 if(body?.action!=="save"&&body?.action!=="register")return json(res,400,{error:"invalid_action"});
 if(body.action==="save"){
  const payload=sanitize(body.payload);
  if(!payload)return json(res,400,{error:"invalid_payload",hint:"入力内容のサイズ・形式を確認してください"});
  try{if(!await verifyImageRefs(sb,ctx.tenantId,user.id,body.id,payload.draft.images))return json(res,400,{error:"invalid_image_reference"});}catch{return json(res,503,{error:"not_ready",hint:"画像原本を確認できません。保存は行っていません。"});}
  if(!body.id){
   const {data,error}=await sb.from(TABLE).insert({tenant_id:ctx.tenantId,created_by:user.id,updated_by:user.id,status:"draft",payload})
    .select("id,version,status,payload,created_at,updated_at,registered_at").single();
   if(error)return errorOut(error);
   return json(res,200,{ready:true,item:toPublic(data)});
  }
  if(!UUID.test(body.id)||!Number.isSafeInteger(body.version)||body.version<1)
   return json(res,400,{error:"invalid_reference"});
  const {data,error}=await sb.from(TABLE)
   .update({payload,updated_by:user.id,version:body.version+1,updated_at:new Date().toISOString()})
   .eq("tenant_id",ctx.tenantId).eq("created_by",user.id)
   .eq("id",body.id).eq("version",body.version).eq("status","draft")
   .select("id,version,status,payload,created_at,updated_at,registered_at").maybeSingle();
  if(error)return errorOut(error);
  if(!data)return json(res,409,{error:"conflict",hint:"他の編集または本登録が行われています。原稿を読み直してください。"});
  return json(res,200,{ready:true,item:toPublic(data)});
 }
 if(!UUID.test(body.id)||!Number.isSafeInteger(body.version)||body.version<1||body.confirmed!==true)
  return json(res,400,{error:"preview_required",hint:"保存済み草案をプレビュー確認してから登録してください"});
 const {data:before,error:loadError}=await sb.from(TABLE).select("status,payload,version")
  .eq("tenant_id",ctx.tenantId).eq("created_by",user.id).eq("id",body.id).maybeSingle();
 if(loadError)return errorOut(loadError);
 if(!before)return json(res,404,{error:"not_found"});
 if(before.status!=="draft"||before.version!==body.version)
  return json(res,409,{error:"conflict",hint:"草案が変更・本登録されています。読み直してください。"});
 const validPayload=sanitize(before.payload);
 if(!validPayload)return json(res,422,{error:"invalid_payload",hint:"保存された内容が読み取れません"});
 try{if(!await verifyImageRefs(sb,ctx.tenantId,user.id,body.id,validPayload.draft.images))return json(res,422,{error:"invalid_image_reference"});}catch{return json(res,503,{error:"not_ready"});}
 const invalid=validateRegistration(validPayload);
 if(invalid)return json(res,422,invalid);
 const {data,error}=await sb.from(TABLE)
  .update({status:"registered",registered_at:new Date().toISOString(),registered_by:user.id,updated_by:user.id,
   version:body.version+1,updated_at:new Date().toISOString()})
  .eq("tenant_id",ctx.tenantId).eq("created_by",user.id).eq("id",body.id)
  .eq("version",body.version).eq("status","draft")
  .select("id,version,status,payload,created_at,updated_at,registered_at").maybeSingle();
 if(error)return errorOut(error);
 if(!data)return json(res,409,{error:"conflict",hint:"登録状態を確認できません。再読込してください。"});
 return json(res,200,{ready:true,item:toPublic(data),note:"社内PRの本登録が完了しました。PR TIMESへの投稿・公開ではありません。"});
}
