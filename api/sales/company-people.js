// Sales企業ごとの担当者・接点。旧接点やメールアドレスだけでは名刺交換と判定しない。
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {isUuid} from '../../lib/sales.js';

const SOURCES=new Set(['business_card','inquiry','referral','event','meeting','other']);
const FIELDS='id,company_id,name,department,position,email,phone,source,met_on,note,created_at,updated_at';
const textValue=(value,max)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max+1):null;

export function personInput(body){
 const name=textValue(body?.name,120),source=String(body?.source||'');
 if(!name||name.length>120||!SOURCES.has(source))throw Error('担当者名と接点の種類を指定してください。');
 const payload={name,source};
 for(const [key,max] of [['department',120],['position',120],['email',254],['phone',80],['note',2000]]){
  const v=textValue(body[key],max);if(v&&v.length>max)throw Error('入力文字数が上限を超えています。');
  payload[key]=v;
 }
 if(payload.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email))throw Error('メールアドレスの形式を確認してください。');
 const metOn=body.metOn||null;
 if(metOn){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(metOn)||new Date(metOn+'T00:00:00Z').toISOString().slice(0,10)!==metOn)throw Error('接点日を確認してください。');
 }
 payload.met_on=metOn;
 return payload;
}
export default async function handler(req,res){
 res.setHeader?.('Cache-Control','private, no-store');
 const user=await requireUser(req,res);if(!user)return;
 if(!['GET','POST','PATCH'].includes(req.method))return methodNotAllowed(res,['GET','POST','PATCH']);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:'forbidden'});
 const body=req.method==='GET'?{}:await readJson(req);
 const params=new URL(req.url||'/','http://localhost').searchParams;
 const companyId=String(body?.companyId||params.get('companyId')||'');
 if(!isUuid(companyId))return json(res,400,{error:'invalid_company_id'});
 const db=admin(),tenant=ctx.tenantId;
 try{
  // ENGERディレクトリの許可範囲を必ず確認し、会社名では紐づけない。
  const scope=await db.schema('enger').from('dx2_sales_company_directory_for_tenant')
   .select('id').eq('tenant_id',tenant).eq('id',companyId).is('directory_hidden_at',null).maybeSingle();
  if(scope.error)throw scope.error;
  if(!scope.data)return json(res,404,{error:'company_not_found'});
  if(req.method==='GET'){
   const rows=await db.from('gw_sales_company_people').select(FIELDS)
    .eq('tenant_id',tenant).eq('company_id',companyId)
    .order('created_at',{ascending:false}).limit(500);
   if(rows.error)throw rows.error;
   return json(res,200,{people:rows.data,complete:true});
  }
  let input;try{input=personInput(body)}catch(error){return json(res,400,{error:'invalid_input',hint:error.message});}
  if(req.method==='POST'){
   const saved=await db.from('gw_sales_company_people').insert({
    tenant_id:tenant,company_id:companyId,...input,created_by:user.id,updated_by:user.id,
   }).select(FIELDS).single();
   if(saved.error)throw saved.error;
   return json(res,201,{person:saved.data,saved:true});
  }
  if(!isUuid(body.id))return json(res,400,{error:'invalid_person_id'});
  const saved=await db.from('gw_sales_company_people')
   .update({...input,updated_by:user.id,updated_at:new Date().toISOString()})
   .eq('tenant_id',tenant).eq('company_id',companyId).eq('id',body.id)
   .select(FIELDS).maybeSingle();
  if(saved.error)throw saved.error;
  if(!saved.data)return json(res,404,{error:'person_not_found'});
  return json(res,200,{person:saved.data,saved:true});
 }catch(error){
  const missing=['42P01','PGRST205','PGRST204'].includes(error?.code);
  return json(res,503,{error:missing?'people_db_not_ready':'people_unavailable',
   hint:missing?'名刺・担当者の管理テーブルが未適用です。管理者に db/176_sales_company_people.sql の反映を依頼してください。':'担当者情報を保存・取得できませんでした。再取得してください。'});
 }
}
