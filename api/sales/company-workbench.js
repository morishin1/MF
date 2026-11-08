import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {isUuid} from '../../lib/sales.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {profilePatch,profileBatch,planInput,activityInput} from '../../lib/sales-company-workbench.js';
export default async function handler(req,res){
 const user=await requireUser(req,res);if(!user)return;
 if(!['GET','PATCH','POST'].includes(req.method))return methodNotAllowed(res,['GET','PATCH','POST']);
 res.setHeader?.('Cache-Control','private, no-store');
 const ctx=await gwContext(user.id);if(!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:'forbidden'});
 const body=req.method==='GET'?{}:await readJson(req),params=new URL(req.url,'http://localhost').searchParams,id=String(body.id||params.get('id')||'');
 if(!isUuid(id))return json(res,400,{error:'invalid_id'});
 const db=admin(),tenant=ctx.tenantId;
 try{
  const scope=await db.schema('enger').from('dx2_sales_company_directory_for_tenant').select('id,needs_contact_review,directory_hidden_at').eq('tenant_id',tenant).eq('id',id).maybeSingle();
  if(scope.error)throw scope.error;if(!scope.data)return json(res,404,{error:'company_not_found'});
  if(req.method==='GET'){
   const before=params.get('before');if(before&&(!Number.isFinite(Date.parse(before))||before.length>40))return json(res,400,{error:'invalid_cursor'});
   let q=db.from('gw_sales_company_activity').select('id,created_at,actor_name,payload').eq('tenant_id',tenant).eq('company_id',id).order('created_at',{ascending:false}).limit(51);if(before)q=q.lt('created_at',before);
   const [activity,override]=await Promise.all([q,db.from('gw_sales_enger_company_overrides').select('lifecycle_segment,blast_target,work_plan').eq('tenant_id',tenant).eq('company_id',id).maybeSingle()]);
   if(activity.error||override.error)throw Error('read_failed');
   return json(res,200,{activities:activity.data.slice(0,50),nextBefore:activity.data.length>50?activity.data[49].created_at:null,override:override.data||{}});
  }
  const op=req.method==='POST'?'activity':body.operation==='plan'?'plan':body.operation==='profile_batch'?'profile_batch':'profile';let payload;
  try{payload=op==='profile_batch'?profileBatch(body.patch):op==='profile'?profilePatch(body.patch):op==='plan'?{plan:planInput(body.plan,true)}:activityInput(body);}catch(e){return json(res,400,{error:'invalid_input',hint:e.message});}
  if(!isUuid(body.requestKey))return json(res,400,{error:'invalid_request_key'});
  // This endpoint records actions only. Email transport is exclusively company-mail.
  let saved;
  if(op==='profile_batch'){
   const expected=body.expected;
   if(!expected||typeof expected!=='object'||Array.isArray(expected)||
     Object.keys(expected).length!==Object.keys(payload).length||
     Object.keys(payload).some(k=>!Object.hasOwn(expected,k)||
       ![null,'string','boolean'].includes(expected[k]===null?null:typeof expected[k])))
      return json(res,400,{error:'invalid_expected',hint:'企業情報を再読み込みしてから編集してください。'});
   saved=await db.rpc('gw_sales_company_profile_batch_save',{
     p_tenant:tenant,p_company:id,p_actor:user.id,
     p_actor_name:ctx.employee?.display_name||user.email||'営業担当',
     p_request:body.requestKey,p_patch:payload,p_expected:expected,
   });
  }else{
   saved=await db.rpc('gw_sales_company_workbench_save',{
     p_tenant:tenant,p_company:id,p_actor:user.id,
     p_actor_name:ctx.employee?.display_name||user.email||'営業担当',
     p_operation:op,p_payload:payload,p_request:body.requestKey,
   });
  }
  if(saved.error)return json(res,saved.error.code==='P0001'?409:503,{error:'save_failed',hint:saved.error.code==='P0001'?'保存条件が変わりました。企業情報・履歴を再取得してください。':'保存結果を確認できません。同じ内容で再度保存してください。'});
  return json(res,200,{saved:true,result:saved.data});
 }catch{return json(res,503,{error:'workbench_unavailable',hint:'登録情報・履歴の保存状態を確認できません。再取得してください。'});}
}
