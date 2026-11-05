import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {isUuid,domainOf,safeUrl} from '../../lib/sales.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {salesMailConfig,mailInput,mailFingerprint,deliverSalesMail,MAIL_COLUMNS} from '../../lib/sales-mail.js';
const checked=r=>{if(r.error)throw r.error;return r.data;};
export function createHandler(deps={}){
 const D={requireUser,gwContext,canSell,admin,salesMailConfig,deliverSalesMail,...deps};
 return async function handler(req,res){
  const user=await D.requireUser(req,res);if(!user)return;
  if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
  res.setHeader('Cache-Control','private, no-store');
  const ctx=await D.gwContext(user.id);
  if(!D.canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:'forbidden'});
  const body=req.method==='POST'?await readJson(req):{};
  const id=String(req.method==='POST'?body.id:new URL(req.url,'http://localhost').searchParams.get('id')).toLowerCase();
  if(!isUuid(id))return json(res,400,{error:'invalid_id'});
  try{
   const db=D.admin(),tenant=ctx.tenantId;
   const scope=checked(await db.schema('enger').from('dx2_sales_company_directory_for_tenant').select('id,needs_contact_review,directory_hidden_at').eq('tenant_id',tenant).eq('id',id).maybeSingle());
   const company=checked(await db.schema('enger').from('companies').select('id,contact_email,website').eq('id',id).is('deleted_at',null).maybeSingle());
   if(!scope||!company)return json(res,404,{error:'company_not_found'});
   const cfg=D.salesMailConfig();
   const table=()=>db.from('gw_sales_company_mail');
   if(req.method==='GET'){
    const before=new URL(req.url,'http://localhost').searchParams.get('before');
    if(before&&(!Number.isFinite(Date.parse(before))||before.length>40))return json(res,400,{error:'invalid_cursor'});
    let q=table().select(MAIL_COLUMNS).eq('tenant_id',tenant).eq('company_id',id).order('created_at',{ascending:false}).limit(31);
    if(before)q=q.lt('created_at',before);
    const rows=checked(await q);
    return json(res,200,{config:{configured:cfg.configured,from:cfg.from,hint:cfg.hint,actorId:user.id},messages:rows.slice(0,30),nextBefore:rows.length>30?rows[29].created_at:null});
   }
   let msg;try{msg=mailInput(body);}catch(e){return json(res,400,{error:'invalid_mail',hint:e.message});}
   const key=String(body.requestKey||'');if(!isUuid(key))return json(res,400,{error:'invalid_request_key'});
   const fingerprint=mailFingerprint(id,msg);
   const previous=async()=>checked(await table().select(MAIL_COLUMNS).eq('tenant_id',tenant).eq('request_key',key).maybeSingle());
   const replay=entry=>entry.company_id===id&&entry.fingerprint===fingerprint
    ?json(res,200,{message:entry,replayed:true}):json(res,409,{error:'request_conflict',hint:'送信処理中の内容は変更できません。履歴で結果を確認してください。'});
   const existing=await previous();if(existing)return replay(existing);
   if(!cfg.configured)return json(res,409,{error:'mail_not_configured',hint:cfg.hint});
   if(body.expectedFrom!==cfg.from)return json(res,409,{error:'sender_changed',hint:'送信元が変更されました。モーダルを開き直してください。'});
   if(scope.needs_contact_review||scope.directory_hidden_at)return json(res,409,{error:'contact_blocked',hint:'連絡停止・確認が必要な企業です。'});
   const links=checked(await db.from('gw_sales_company_links').select('company_id').eq('tenant_id',tenant).eq('source_system','enger').eq('source_company_id',id).limit(2));
   if(links.length>1)return json(res,409,{error:'ambiguous_company',hint:'企業IDの照合を確認してください。'});
   let sales=null;
   if(links.length){sales=checked(await db.from('gw_sales_companies').select('id,emails,hidden_at,ng_reason').eq('tenant_id',tenant).eq('id',links[0].company_id).single());}
   // An unlinked source must still respect existing opt-outs for its exact domain.
   const domain=safeUrl(company.website)?domainOf(company.website):null;
   if(domain){const matches=checked(await db.from('gw_sales_companies').select('id,hidden_at,ng_reason').eq('tenant_id',tenant).eq('domain',domain));
    if(matches.some(c=>c.hidden_at||c.ng_reason))return json(res,409,{error:'contact_blocked',hint:'営業禁止・非表示の企業です。'});}
   if(sales?.hidden_at||sales?.ng_reason)return json(res,409,{error:'contact_blocked',hint:'営業禁止・非表示の企業です。'});
   const addresses=sales?(sales.emails||[]):[company.contact_email];
   if(!addresses.some(a=>String(a||'').trim().toLowerCase()===msg.to.toLowerCase()))return json(res,409,{error:'recipient_changed',hint:'登録済みの宛先を選んでください。連絡先が変更された場合は企業情報を更新してください。'});
   const entry={tenant_id:tenant,company_id:id,sales_company_id:sales?.id||null,request_key:key,fingerprint,
    to_email:msg.to,from_email:cfg.from,subject:msg.subject,body_text:msg.text,
    actor_id:user.id,actor_name:ctx.employee?.display_name||user.email||'営業担当',status:'sending'};
   const claim=await table().insert(entry).select(MAIL_COLUMNS).single();
   if(claim.error?.code==='23505'){const prior=await previous();if(prior)return replay(prior);throw claim.error;}
   checked(claim);if(!claim.data?.id)throw Error('claim_failed');
   let delivered;try{delivered=await D.deliverSalesMail(msg,cfg);}catch{delivered={status:'unknown'};}
   const status=['accepted','not_sent'].includes(delivered.status)?delivered.status:'unknown';
   let saved;try{saved=await table().update({status,provider_message_id:delivered.providerMessageId||null,finished_at:new Date().toISOString()}).eq('tenant_id',tenant).eq('id',claim.data.id).select(MAIL_COLUMNS).single();}catch{saved={error:true};}
   // Keep the durable sending reservation if SMTP succeeded but the audit update failed.
   // Neither transport exceptions nor audit failures can automatically retry SMTP.
   if(saved.error||!saved.data)return json(res,200,{message:{...claim.data,status:'unknown'},warning:'送信結果を確定できません。再送せず履歴を確認してください。'});
   return json(res,200,{message:saved.data});
  }catch{return json(res,503,{error:'mail_unavailable',hint:'送信・履歴の状態を確認できません。同じ画面で結果を再確認してください。'});}
 };
}
export default createHandler();
