// Uploaded PR originals: private Word/PDF only, linked to a Marketing PR draft.
// Signed upload/download URLs are short lived. No automatic publishing or metric inflation.
import {json,readJson,methodNotAllowed,dbSetupHint} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,accessOf} from "../../lib/gw.js";
import {admin} from "../../lib/supabase.js";
const TABLE="gw_marketing_pr_files",DRAFTS="gw_marketing_pr_drafts",BUCKET="marketing-pr-originals";
const SETUP="db/proposal_marketing_pr_files.sql",UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME={
 pdf:"application/pdf",
 docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};
const LIMIT=8*1024*1024;
const publicFile=f=>({id:f.id,prId:f.pr_id,filename:f.filename,
 mimeType:f.mime_type,sizeBytes:f.size_bytes,uploadedAt:f.confirmed_at});
const owned=(sb,tenant,userId)=>sb.from(TABLE).select("id,pr_id,filename,mime_type,size_bytes,storage_path,confirmed_at")
 .eq("tenant_id",tenant).eq("uploaded_by",userId);
const fail=res=>json(res,503,{error:"not_ready",hint:"Word/PDFの保存先が未準備です。管理者にSQL適用を依頼してください。",sql:SETUP});
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!accessOf(ctx).marketing)return json(res,403,{error:"forbidden"});
 res.setHeader("Cache-Control","no-store");
 const sb=admin();
 if(req.method==="GET"){
  const q=new URL(req.url||"/","https://localhost").searchParams;
  const id=q.get("id");
  if(id){
   if(!UUID.test(id))return json(res,400,{error:"invalid_id"});
   const {data:file,error}=await owned(sb,ctx.tenantId,user.id).eq("pr_id",id).not("confirmed_at","is",null).maybeSingle();
   if(error)return fail(res);
   if(!file)return json(res,404,{error:"not_found"});
   const {data:signed,error:se}=await sb.storage.from(BUCKET).createSignedUrl(file.storage_path,300);
   if(se)return json(res,503,{error:"storage_not_ready",hint:"ファイルの閲覧URLを発行できませんでした"});
   return json(res,200,{ready:true,file:publicFile(file),url:signed.signedUrl,expiresInSec:300});
  }
  const {data,error}=await owned(sb,ctx.tenantId,user.id).not("confirmed_at","is",null)
   .order("confirmed_at",{ascending:false}).limit(100);
  if(error)return fail(res);
  return json(res,200,{ready:true,files:(data||[]).map(publicFile)});
 }
 if(req.method!=="POST")return methodNotAllowed(res,["GET","POST"]);
 const body=await readJson(req);
 if(body?.action==="start"){
  const name=typeof body.filename==="string"?body.filename.trim():"";
  const ext=name.toLowerCase().split(".").pop();
  const size=body.sizeBytes;
  if(!Object.hasOwn(MIME,ext)||!name||name.length>200||MIME[ext]!==body.mimeType||
    !Number.isSafeInteger(size)||size<=0||size>LIMIT)
   return json(res,400,{error:"invalid_file",hint:"Word（.docx）かPDFのみ、8MB以下のファイルを選んでください"});
  const initial={
   draft:{kind:"other",title:name.replace(/\.[^.]+$/,"").slice(0,120)||"無題",
    summary:"",company:"株式会社エイト",features:[],images:[]},
   body_override:"",media:{},tracking:[],source:"upload"
  };
  const {data:pr,error:pe}=await sb.from(DRAFTS)
   .insert({tenant_id:ctx.tenantId,created_by:user.id,updated_by:user.id,status:"draft",payload:initial})
   .select("id,version,status,updated_at,payload").single();
  if(pe)return json(res,503,{error:"draft_not_ready",hint:"PR下書きの保存先が未準備です"});
  const path=`${ctx.tenantId}/${user.id}/${pr.id}.${ext}`;
  const {data:file,error:fe}=await sb.from(TABLE).insert({
   tenant_id:ctx.tenantId,uploaded_by:user.id,pr_id:pr.id,
   filename:name,mime_type:MIME[ext],size_bytes:size,storage_path:path
  }).select("id,pr_id,filename,mime_type,size_bytes,storage_path,confirmed_at").single();
  if(fe){await sb.from(DRAFTS).delete().eq("id",pr.id).eq("tenant_id",ctx.tenantId);return fail(res);}
  const {data:signed,error:se}=await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if(se){
   await sb.from(DRAFTS).delete().eq("id",pr.id).eq("tenant_id",ctx.tenantId);
   return json(res,503,{error:"storage_not_ready",hint:"アップロード先を生成できませんでした"});
  }
  return json(res,200,{ready:true,prId:pr.id,fileId:file.id,uploadUrl:signed.signedUrl,
   expiresInSec:300});
 }
 if(body?.action==="complete"){
  if(!UUID.test(body.prId))return json(res,400,{error:"invalid_reference"});
  const {data:file,error}=await owned(sb,ctx.tenantId,user.id).eq("pr_id",body.prId).maybeSingle();
  if(error)return fail(res);
  if(!file)return json(res,404,{error:"not_found"});
  if(file.confirmed_at)return json(res,200,{ready:true,file:publicFile(file)});
  const {data:stored,error:se}=await sb.storage.from(BUCKET).info(file.storage_path);
  if(se||!stored)return json(res,409,{error:"upload_incomplete",hint:"アップロードがまだ完了していません"});
  // File-size check guards the signed-upload target independently of the client's assertion.
  const actualSize=Number(stored?.metadata?.size??stored?.size);
  if(Number.isFinite(actualSize)&&actualSize!==Number(file.size_bytes))
   return json(res,409,{error:"size_mismatch",hint:"ファイルサイズが一致しません。アップロードをやり直してください"});
  const {data:updated,error:ue}=await sb.from(TABLE).update({confirmed_at:new Date().toISOString()})
   .eq("tenant_id",ctx.tenantId).eq("uploaded_by",user.id).eq("pr_id",body.prId)
   .is("confirmed_at",null).select("id,pr_id,filename,mime_type,size_bytes,storage_path,confirmed_at").maybeSingle();
  if(ue)return fail(res);
  if(!updated)return json(res,409,{error:"conflict"});
  return json(res,200,{ready:true,file:publicFile(updated)});
 }
 if(body?.action==="rename"){
  if(!UUID.test(body.prId)||!Number.isSafeInteger(body.version)||body.version<1)
   return json(res,400,{error:"invalid_reference"});
  const title=typeof body.title==="string"?body.title.trim():"";
  if(!title||title.length>120)return json(res,400,{error:"invalid_title"});
  const {data:file,error:fe}=await owned(sb,ctx.tenantId,user.id).eq("pr_id",body.prId).not("confirmed_at","is",null).maybeSingle();
  if(fe)return fail(res);if(!file)return json(res,404,{error:"not_found"});
  const {data:before,error:be}=await sb.from(DRAFTS).select("payload,status,version")
   .eq("id",body.prId).eq("tenant_id",ctx.tenantId).eq("created_by",user.id).maybeSingle();
  if(be)return fail(res);
  if(!before||before.version!==body.version||before.status!=="draft")
   return json(res,409,{error:"conflict",hint:"本登録済みまたは更新された原稿は編集できません"});
  const payload={...before.payload,draft:{...before.payload.draft,title}};
  const {data:item,error:ue}=await sb.from(DRAFTS).update({payload,version:body.version+1,updated_at:new Date().toISOString(),updated_by:user.id})
   .eq("id",body.prId).eq("tenant_id",ctx.tenantId).eq("created_by",user.id)
   .eq("version",body.version).eq("status","draft").select("id,version,status,updated_at,payload").maybeSingle();
  if(ue)return fail(res);
  if(!item)return json(res,409,{error:"conflict"});
  return json(res,200,{ready:true,item});
 }
 return json(res,400,{error:"invalid_action"});
}
