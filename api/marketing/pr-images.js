// Private PR images, creator-only. No public uploads, URLs or content publishing.
import {json} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,accessOf} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import * as I from '../../lib/marketing-pr-images.js';
export function createHandler(deps={}){
 const D={requireUser,gwContext,accessOf,admin,canonicalImage:I.canonicalImage,...deps};
 return async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 try{
  const user=await D.requireUser(req,res);if(!user)return;
  const ctx=await D.gwContext(user.id);if(!ctx.tenantId||!D.accessOf(ctx).marketing)I.fail(403,'forbidden');
  if(!['GET','POST'].includes(req.method))I.fail(405,'method_not_allowed');
  const q=new URL(req.url||'/','https://localhost').searchParams,b=req.method==='POST'?await I.boundedJson(req):{};
  const id=b.draftId||q.get('draftId'),imageId=b.imageId||q.get('imageId'),sb=D.admin();
  if(!I.UUID.test(imageId||''))I.fail(400,'invalid_image_id');
  const draft=await I.ownedDraft(sb,ctx.tenantId,user.id,id);
  const rows=()=>sb.from(I.TABLE).select('*').eq('tenant_id',ctx.tenantId).eq('created_by',user.id).eq('draft_id',id).eq('id',imageId);
  const rpc=async(name,args)=>{const r=await sb.rpc(name,args);if(r.error)I.fail(['42883','PGRST202','42P01'].includes(r.error.code)?503:409,/image_quota/.test(r.error.message||'')?'image_quota':'image_conflict');return Array.isArray(r.data)?r.data[0]:r.data;};
  if(req.method==='GET'){
   if(!draft.payload?.draft?.images?.some(i=>i.imageId===imageId))I.fail(404,'not_found');
   const {data:row,error}=await rows().eq('state','ready').maybeSingle();if(error)I.fail(503,'not_ready');if(!row)I.fail(404,'not_found');
   const r=await sb.storage.from(I.BUCKET).createSignedUrl(I.objectPath(row),60);if(r.error||!r.data?.signedUrl)I.fail(503,'image_unavailable');
   return json(res,200,{url:r.data.signedUrl,expiresIn:60});
  }
  if(b.action!=='upload')I.fail(400,'invalid_action');
  if(draft.status!=='draft'||draft.version!==b.version||!Number.isSafeInteger(b.version))I.fail(409,'draft_conflict');
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>200||/[\x00-\x1f]/.test(b.name))I.fail(400,'invalid_name');
  const bytes=I.imageBytes(b.base64);
  const args={p_tenant:ctx.tenantId,p_actor:user.id,p_draft:id,p_version:b.version,p_id:imageId};
  const row=await rpc('gw_marketing_pr_image_reserve',{...args,p_name:b.name,p_hash:I.digest(bytes),p_size:bytes.length});
  if(row.state==='ready')return json(res,200,{imageId:row.id,size:row.size_bytes,mime:'image/png'});
  let output;
  try{output=await D.canonicalImage(bytes);}catch(e){await sb.from(I.TABLE).update({state:'failed'}).eq('id',imageId).eq('created_by',user.id).eq('tenant_id',ctx.tenantId).eq('state','pending');throw e;}
  const path=I.objectPath(row),storage=sb.storage.from(I.BUCKET);
  const up=await storage.upload(path,output,{contentType:'image/png',upsert:false});
  if(up.error){
   // An uncertain earlier upload may already exist. Never overwrite; verify its bytes.
   const old=await storage.download(path);if(old.error||!old.data)I.fail(503,'image_store_failed');
   if(I.digest(Buffer.from(await old.data.arrayBuffer()))!==I.digest(output))I.fail(409,'image_conflict');
  }
  const done=await rpc('gw_marketing_pr_image_finish',{...args,p_size:output.length,p_hash:I.digest(output)});
  return json(res,200,{imageId:done.id,size:done.size_bytes,mime:'image/png'});
 }catch(e){return json(res,e.status||500,{error:e.message&&e.status?e.message:'image_error',hint:e.status===503?'画像保存先が未準備または取得できません。管理者に確認してください。':e.message==='image_quota'?'画像保存の上限に達しました。管理者に保管状況の確認を依頼してください。':'画像を保存・取得できませんでした。PNG/JPEG・2MB以下で再確認してください。'});}
 };
}
export default createHandler();
