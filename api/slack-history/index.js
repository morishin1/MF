// Records only an explicitly checked existing Slack channel post. Does NOT send Slack/mail.
import {requireUser} from '../../lib/auth.js';
import {gwContext} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {TABLE,FIELDS,canRead,canRecord,normalizeReceipt} from '../../lib/slack-history.js';
const missing=e=>['42P01','PGRST205'].includes(e?.code);
function failed(res,e){return json(res,missing(e)?503:500,{error:missing(e)?'not_ready':'history_unavailable',ready:false,message:missing(e)?'Slack通知履歴は準備中です。未設定を通知0件とは扱いません。':'通知履歴を取得・保存できません。'});}
export function createHandler(deps={}){const D={requireUser,gwContext,admin,...deps};return async(req,res)=>{
 res.setHeader('Cache-Control','private,no-store');
 try{
 const user=await D.requireUser(req,res);if(!user)return;
 const ctx=await D.gwContext(user.id);if(!ctx.tenantId)return json(res,403,{error:'forbidden'});
 if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
 const b=req.method==='POST'?await readJson(req):null;
 const dept=b?.department||new URL(req.url||'/', 'http://localhost').searchParams.get('department');
 if(!canRead(ctx,dept))return json(res,403,{error:'forbidden'});
 const sb=D.admin();
 if(req.method==='GET'){
  const {data,error}=await sb.from(TABLE).select(FIELDS).eq('tenant_id',ctx.tenantId).eq('department',dept).order('sent_at',{ascending:false}).limit(100);
  if(error)return failed(res,error);
  return json(res,200,{ready:true,history:data||[],capped:(data||[]).length===100});
 }
 // No generic service credential or client-selected tenant/channel. Owner records verified receipt.
 if(!canRecord(ctx,dept))return json(res,403,{error:'forbidden'});
 const n=normalizeReceipt(b);if(n.error)return json(res,400,{error:n.error});
 const row={...n.row,tenant_id:ctx.tenantId,recorded_by:user.id};
 const {data,error}=await sb.from(TABLE).insert(row).select(FIELDS).single();
 if(error?.code==='23505'){
  const old=await sb.from(TABLE).select('id,receipt_hash').eq('tenant_id',ctx.tenantId).eq('department',dept).eq('target_date',row.target_date).eq('slot',row.slot).eq('revision',row.revision).maybeSingle();
  if(old.error)return failed(res,old.error);
  if(old.data?.receipt_hash===row.receipt_hash)return json(res,200,{ok:true,duplicate:true,id:old.data.id});
  return json(res,409,{error:'receipt_conflict',message:'同じ枠・版またはSlack投稿が登録されています。再送せず履歴を確認してください。'});
 }
 if(error)return failed(res,error);
 return json(res,201,{ok:true,duplicate:false,history:data});
 }catch{return json(res,500,{error:'history_unavailable',ready:false});}
};}
export default createHandler();
