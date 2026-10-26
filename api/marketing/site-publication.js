// Registered PR -> explicit public preview confirmation -> existing 8grp news sync -> observed result.
// Never invoked by draft save/register. No workflow dispatch, SMTP, SNS, or credential creation.
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,accessOf} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {UUID,buildPublication,sourceMatches,inspectPublicPage} from '../../lib/marketing-site-publication.js';
const TABLE='gw_marketing_site_publications';
const MISSING=new Set(['42P01','PGRST205','42883','PGRST202']);
const fields='id,tenant_id,created_by,status,version,payload';
const articleFields='id,slug,title,summary,body_html,status,published_on';
const notReady='自社サイト公開の保存先が未準備です。管理者が提案SQLと接続先を確認してください。';
const fail=(res,error)=>json(res,MISSING.has(error?.code)?503:500,{error:MISSING.has(error?.code)?'not_ready':'publication_unavailable',hint:MISSING.has(error?.code)?notReady:'処理結果を確認できません。再取得してから状態を確認してください。'});
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
 const user=await requireUser(req,res);if(!user)return;
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!accessOf(ctx).marketing)return json(res,403,{error:'forbidden',hint:'Marketing利用権限が必要です。'});
 const body=req.method==='POST'?await readJson(req):null;
 const id=req.method==='GET'?new URL(req.url,'https://localhost').searchParams.get('id'):body?.id;
 if(!UUID.test(id||''))return json(res,400,{error:'invalid_id'});
 if(body&&!['publish','verify'].includes(body.action))return json(res,400,{error:'invalid_action'});
 const sb=admin();
 const {data:draft,error:de}=await sb.from('gw_marketing_pr_drafts').select(fields).eq('tenant_id',ctx.tenantId).eq('created_by',user.id).eq('id',id).maybeSingle();
 if(de)return fail(res,de);
 if(!draft)return json(res,404,{error:'not_found'});
 if(draft.status!=='registered')return json(res,409,{error:'registration_required',hint:'保存済み原稿をプレビュー確認し、社内本登録してから進めてください。'});
 let preview;try{preview=buildPublication(draft);}catch{return json(res,422,{error:'invalid_saved_pr',hint:'保存原稿の内容を確認できません。公開せず管理担当者に連絡してください。'});}
 const base={id,version:draft.version,preview,publication:null};
 // news_articles is a shared, non-tenant table. Never infer its owning tenant.
 const tenant=process.env.MARKETING_SITE_PUBLISH_TENANT_ID;
 const role=ctx.isAdmin||(ctx.roles||[]).includes('owner');
 const reason=!role?'自社サイトの公開は、原稿を登録した本人かつ既存のサイト管理者・経営者のみ操作できます。':
  !UUID.test(tenant||'')?'自社サイト公開は未設定です。管理者による公開対象テナントの確認・設定が必要です。':
  tenant.toLowerCase()!==ctx.tenantId.toLowerCase()?'このテナントは自社サイト公開の対象ではありません。':null;
 if(reason){
  if(req.method==='POST')return json(res,403,{error:'publication_disabled',hint:reason});
  return json(res,200,{...base,ready:false,canPublish:false,reason});
 }
 const readPublication=()=>sb.from(TABLE).select('*').eq('tenant_id',ctx.tenantId).eq('draft_id',id).maybeSingle();
 const readArticle=p=>sb.from('news_articles').select(articleFields).eq('id',p.article_id).maybeSingle();
 let {data:publication,error:pe}=await readPublication();
 if(pe){
  if(req.method==='GET'&&MISSING.has(pe.code))return json(res,200,{...base,ready:false,canPublish:false,reason:notReady});
  return fail(res,pe);
 }
 async function reply(){
  let shaped=null;
  if(publication){
   const {data:article,error}=await readArticle(publication);if(error)return fail(res,error);
   const matches=sourceMatches(publication,article);
   shaped={state:!matches?'changed':publication.last_check==='verified'?'verified':'pending',url:preview.publicUrl,
    requestedAt:publication.requested_at,checkedAt:publication.checked_at,verifiedAt:matches?publication.verified_at:null,lastCheck:matches?publication.last_check:'source_changed'};
  }
  return json(res,200,{...base,ready:true,canPublish:true,reason:null,publication:shaped});
 }
 if(req.method==='GET')return reply();
 if(body.action==='publish'){
  if(body.confirmed!==true||body.version!==draft.version||body.previewHash!==preview.hash)
   return json(res,409,{error:'preview_required',hint:'現在の公開内容・公開先をプレビューし、一般公開の確認にチェックしてから実行してください。'});
  const {data,error}=await sb.rpc('gw_marketing_publish_site',{
   p_tenant:ctx.tenantId,p_actor:user.id,p_draft:id,p_version:draft.version,p_hash:preview.hash,
   p_title:preview.title,p_summary:preview.summary,p_body:preview.bodyHtml,p_payload:draft.payload
  });
  if(error){
   if(['PT409','23505'].includes(error.code))return json(res,409,{error:'publication_conflict',hint:'公開原本が変更されたか同じURLが存在します。再取得してください。上書きはしていません。'});
   if(error.code==='42501')return json(res,403,{error:'forbidden',hint:'公開原稿の権限を確認してください。'});
   if(error.code==='23514')return json(res,409,{error:'publication_conflict',hint:'本登録と保存内容を確認し直してください。'});
   return fail(res,error);
  }
  if(!data||data.draft_id!==id||data.tenant_id!==ctx.tenantId||data.content_hash!==preview.hash)return json(res,500,{error:'result_unknown',hint:'公開設定の結果を確認できません。再取得してください。'});
  publication=data;
  return reply();
 }
 if(!publication)return json(res,409,{error:'publication_required',hint:'公開設定がまだありません。先に公開内容を確認してください。'});
 // Verify both current source and public HTML. Stale HTML after source unpublish/edit is not success.
 const {data:before,error:be}=await readArticle(publication);if(be)return fail(res,be);
 let result=sourceMatches(publication,before)?(await inspectPublicPage(publication)).result:'source_changed';
 const {data:after,error:ae}=await readArticle(publication);if(ae)return fail(res,ae);
 if(!sourceMatches(publication,after))result='source_changed';
 const now=new Date().toISOString();
 const {data:saved,error:se}=await sb.from(TABLE).update({checked_at:now,verified_at:result==='verified'?now:null,last_check:result})
  .eq('tenant_id',ctx.tenantId).eq('draft_id',id).eq('content_hash',publication.content_hash).select('*').maybeSingle();
 if(se)return fail(res,se);
 if(!saved)return json(res,409,{error:'publication_conflict',hint:'公開記録が変わりました。再取得してください。'});
 publication=saved;return reply();
}
