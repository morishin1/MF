// Marketing PR draft -> review -> internal registration. No external publication.
import {json,readJson,methodNotAllowed,dbSetupHint} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,accessOf} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
import {sanitizePRSections,validPRImageKeys} from "../../lib/marketing-pr-content.js";
const TABLE="gw_marketing_pr_drafts",SQL="db/proposal_marketing_pr_drafts.sql";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS=new Set(["service","product","event","campaign","partnership","research","corporate","other"]);
const TRACKING_CHANNELS=new Set(["site","prtimes","x","instagram","facebook","linkedin","line","other"]);
function sanitizeTracking(raw){
 if(raw===undefined||raw===null)return [];
 if(!Array.isArray(raw)||raw.length>TRACKING_CHANNELS.size)return null;
 const seen=new Set(),out=[];
 for(const entry of raw){
  if(!entry||typeof entry!=="object"||Array.isArray(entry)||!TRACKING_CHANNELS.has(entry.channel)||seen.has(entry.channel))return null;
  seen.add(entry.channel);
  const url=entry.url||"",publishedAt=entry.publishedAt||"",status=entry.status||"planned";
  if(!["planned","scheduled","published"].includes(status))return null;
  if(typeof url!=="string"||url.length>1900||!secureUrl(url))return null;
  if(typeof publishedAt!=="string"||publishedAt.length>40||(publishedAt&&!Number.isFinite(Date.parse(publishedAt))))return null;
  const record={channel:entry.channel,status,url,publishedAt};
  for(const metric of ["views","clicks","conversions"]){
   const n=entry[metric];
   if(n===undefined||n===null||n===""){record[metric]=null;continue;}
   if(!Number.isSafeInteger(n)||n<0||n>1_000_000_000)return null;
   record[metric]=n;
  }
  out.push(record);
 }
 return out;
}
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
   // key は本文セクションから写真を指すための参照（UUID）。画像の原本・URL ではない（画像本体は保存しない）
   d.images.push({name:i.name,caption:i.caption,size,...(i.key!==undefined?{key:i.key}:{})});
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
 const tracking=sanitizeTracking(raw.tracking);
 if(tracking===null)return null;
 const clean={draft:d,body_override:override,media:bodies,tracking};
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
 const body=await readJson(req);
 if(!["save","register","tracking","delete"].includes(body?.action))return json(res,400,{error:"invalid_action"});
 if(body.action==="tracking"||body.action==="delete"){
  if(!UUID.test(body.id)||!Number.isSafeInteger(body.version)||body.version<1)
   return json(res,400,{error:"invalid_reference"});
  if(body.action==="delete"){
   // Never delete a registered original, even if an outdated browser thinks it is a draft.
   if(body.confirmed!==true)return json(res,400,{error:"confirmation_required"});
   const {data,error}=await sb.from(TABLE).delete()
    .eq("tenant_id",ctx.tenantId).eq("created_by",user.id).eq("id",body.id)
    .eq("version",body.version).eq("status","draft").select("id").maybeSingle();
   if(error)return errorOut(error);
   if(!data)return json(res,409,{error:"conflict",hint:"削除できません。既に更新・本登録された可能性があります。"});
   return json(res,200,{ready:true,deletedId:data.id});
  }
  const records=sanitizeTracking(body.tracking);
  if(records===null)return json(res,400,{error:"invalid_tracking",hint:"掲載先・日時・URL・実績の入力を確認してください。"});
  const {data:before,error:loadError}=await sb.from(TABLE)
   .select("status,payload,version").eq("tenant_id",ctx.tenantId)
   .eq("created_by",user.id).eq("id",body.id).maybeSingle();
  if(loadError)return errorOut(loadError);
  if(!before)return json(res,404,{error:"not_found"});
  if(before.version!==body.version)return json(res,409,{error:"conflict",hint:"原稿が更新されています。再読込してください。"});
  const nextPayload=sanitize({...before.payload,tracking:records});
  if(!nextPayload)return json(res,422,{error:"invalid_payload"});
  const {data,error}=await sb.from(TABLE).update({
    payload:nextPayload,updated_by:user.id,version:body.version+1,updated_at:new Date().toISOString()
   }).eq("tenant_id",ctx.tenantId).eq("created_by",user.id)
    .eq("id",body.id).eq("version",body.version)
    .select("id,version,status,payload,created_at,updated_at,registered_at").maybeSingle();
  if(error)return errorOut(error);
  if(!data)return json(res,409,{error:"conflict",hint:"原稿が更新されています。再読込してください。"});
  return json(res,200,{ready:true,item:toPublic(data),note:"掲載状況・手入力実績を保存しました。外部配信は行いません。"});
 }
 if(body.action==="save"){
  const payload=sanitize(body.payload);
  if(!payload)return json(res,400,{error:"invalid_payload",hint:"入力内容のサイズ・形式を確認してください"});
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
