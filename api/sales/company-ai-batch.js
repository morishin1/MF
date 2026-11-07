// One immutable, owner-reviewed batch of 1..10 companies for the cloud AI pilot.
// The row checked in Sales is an ENGER company id. Resolution requires an existing
// tenant-scoped, explicitly recorded ENGER -> Sales link: no name-only joining.
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell,isOwner} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {isUuid} from '../../lib/sales.js';
import {safePilotUrl} from '../../lib/sales-company-ai-pilot.js';
const TABLE='gw_sales_company_ai_pilot_batches';
const rowView=row=>({batchId:row.batch_id,companyIds:row.enger_company_ids,
  salesCompanyIds:row.sales_company_ids,createdAt:row.created_at,limit:10});
export default async function handler(req,res){
  const user=await requireUser(req,res); if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return json(res,403,{error:'forbidden'});
  res.setHeader?.('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
  const db=admin();
  if(req.method==='GET'){
    const result=await db.from(TABLE).select('*').eq('tenant_id',ctx.tenantId).maybeSingle();
    if(result.error)return json(res,503,{error:'batch_table_unavailable'});
    return json(res,200,{batch:result.data?rowView(result.data):null,limit:10,
      enabled:process.env.ENGER_COMPANY_AI_PILOT==='enabled',
      canRun:isOwner(ctx)&&process.env.ENGER_COMPANY_AI_PILOT==='enabled'});
  }
  if(!isOwner(ctx)||process.env.ENGER_COMPANY_AI_PILOT!=='enabled')
    return json(res,403,{error:'owner_preview_only'});
  const body=await readJson(req);
  const ids=body?.companyIds;
  if(!Array.isArray(ids)||ids.length<1||ids.length>10||
    ids.some(id=>typeof id!=='string'||!isUuid(id))||new Set(ids).size!==ids.length)
    return json(res,400,{error:'select_1_to_10_unique_companies'});
  const found=await db.from(TABLE).select('*').eq('tenant_id',ctx.tenantId).maybeSingle();
  if(found.error)return json(res,503,{error:'batch_table_unavailable'});
  if(found.data){
    if(ids.length===found.data.enger_company_ids.length&&
      ids.every(id=>found.data.enger_company_ids.includes(id)))
      return json(res,200,{ok:true,existing:true,batch:rowView(found.data)});
    return json(res,409,{error:'pilot_batch_already_registered',
      hint:'既に試験対象の企業が確定しています。別の企業に変更する場合はレビュー後に管理者が明示的に対象を再設定してください。',
      batch:rowView(found.data)});
  }
  const links=await db.from('gw_sales_company_links')
    .select('company_id,source_company_id,source_system')
    .eq('tenant_id',ctx.tenantId).eq('source_system','enger')
    .in('source_company_id',ids).limit(50);
  if(links.error)return json(res,503,{error:'company_links_unavailable'});
  const linkMap=new Map();
  for(const row of links.data||[]){
    const group=linkMap.get(row.source_company_id)||[];group.push(row.company_id);
    linkMap.set(row.source_company_id,group);
  }
  const unlinked=ids.filter(id=>(linkMap.get(id)||[]).length!==1);
  if(unlinked.length)return json(res,409,{error:'company_link_review_required',unlinked,
    hint:'ENGER企業IDとSales企業マスターの紐づけが一意でない企業が含まれます。AI分析を開始する前に企業IDを照合してください。'});
  const salesIds=ids.map(id=>linkMap.get(id)[0]);
  if(new Set(salesIds).size!==salesIds.length)
    return json(res,409,{error:'duplicate_sales_company_mapping'});
  const companies=await db.from('gw_sales_companies').select('id,name,site_url,hidden_at,ng_reason')
    .eq('tenant_id',ctx.tenantId).in('id',salesIds);
  if(companies.error)return json(res,503,{error:'sales_company_unavailable'});
  const cMap=new Map((companies.data||[]).map(r=>[r.id,r]));
  const invalid=salesIds.filter(id=>{
    const c=cMap.get(id);if(!c||c.hidden_at||c.ng_reason)return true;
    try{const host=new URL(c.site_url).hostname;return !host.includes('.')||!safePilotUrl(c.site_url,host);}
    catch{return true;}
  });
  if(invalid.length)return json(res,409,{error:'official_site_or_ng_review_required',
    salesCompanyIds:invalid,
    hint:'公式サイトHTTPS URLが未登録、または営業禁止・非表示の企業が含まれます。基本情報を整えてから実行してください。'});
  // UNIQUE tenant primary key means two simultaneous enrollments cannot race.
  const insert=await db.from(TABLE).insert({
    tenant_id:ctx.tenantId,enger_company_ids:ids,sales_company_ids:salesIds,created_by:user.id
  }).select('*').single();
  if(insert.error)return json(res,insert.error.code==='23505'?409:503,{
    error:insert.error.code==='23505'?'pilot_batch_already_registered':'batch_registration_failed'});
  return json(res,200,{ok:true,created:true,batch:rowView(insert.data)});
}