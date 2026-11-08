// Owner-controlled batch of up to ten companies for cloud AI pilot. A single-company
// analysis click can append one eligible company; all changes retain a strict cap.
// The row checked in Sales is an ENGER company id. Resolution requires an existing
// tenant-scoped, explicitly recorded ENGER -> Sales link: no name-only joining.
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell,isOwner} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {isUuid} from '../../lib/sales.js';
import {safePilotUrl} from '../../lib/sales-company-ai-pilot.js';
import {fetchGbizCompany,sameCompanyName} from '../../lib/sales-company-gbiz.js';
import {randomUUID} from 'node:crypto';
import {ensureSalesCompanyLink} from '../../lib/sales-company-ai-link.js';
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
    const existing=found.data.enger_company_ids||[];
    if(ids.every(id=>existing.includes(id)))return json(res,200,{
      ok:true,existing:true,batch:rowView(found.data)});
    if(body?.action!=='extend')return json(res,409,{
      error:'pilot_batch_already_registered',
      hint:'選択済み企業があります。企業分析からの追加登録または管理者レビューが必要です。',
      batch:rowView(found.data)});
    if(existing.length+ids.filter(id=>!existing.includes(id)).length>10)
      return json(res,409,{error:'pilot_limit_10',
        hint:'今回のAI試験は10社が上限です。別の10社へ変更するにはレビューが必要です。'});
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
  let unlinked=ids.filter(id=>(linkMap.get(id)||[]).length!==1);
  if(unlinked.length===1&&body?.action==='extend'&&ids.length===1){
    const linked=await ensureSalesCompanyLink(db,{
      tenantId:ctx.tenantId,engerCompanyId:ids[0],actorId:user.id});
    if(!linked.salesCompanyId)return json(res,409,{error:linked.error||'company_link_review_required',
      hint:'企業IDと法人情報・公式サイトの照合が必要です。Salesに同じ企業が存在する場合は手動で紐づけを確認してください。'});
    linkMap.set(ids[0],[linked.salesCompanyId]);
    unlinked=[];
  }
  if(unlinked.length)return json(res,409,{error:'company_link_review_required',unlinked,
    hint:'ENGER企業IDとSales企業マスターの紐づけが一意でない企業が含まれます。AI分析を開始する前に企業IDを照合してください。'});
  const salesIds=ids.map(id=>linkMap.get(id)[0]);
  if(new Set(salesIds).size!==salesIds.length)
    return json(res,409,{error:'duplicate_sales_company_mapping'});
  const companies=await db.from('gw_sales_companies').select('id,name,site_url,hidden_at,ng_reason')
    .eq('tenant_id',ctx.tenantId).in('id',salesIds);
  if(companies.error)return json(res,503,{error:'sales_company_unavailable'});
  const cMap=new Map((companies.data||[]).map(r=>[r.id,r]));
  // A company with no website can be researched using its registered
  // corporate number, but only after comparing both linked company names
  // with the official gBizINFO result. Never infer an unlinked company by name.
  const missingSiteEngerIds=ids.filter((_,index)=>!cMap.get(salesIds[index])?.site_url);
  const engerRead=missingSiteEngerIds.length
    ?await db.schema('enger').from('companies')
       .select('id,name,corporate_number').in('id',missingSiteEngerIds).is('deleted_at',null)
    :{data:[],error:null};
  if(engerRead.error)return json(res,503,{error:'registry_company_unavailable'});
  const eMap=new Map((engerRead.data||[]).map(c=>[c.id,c]));
  const checks=await Promise.all(salesIds.map(async(salesId,index)=>{
    const c=cMap.get(salesId);
    if(!c||c.hidden_at||c.ng_reason)return false;
    if(c.site_url){
      try{
        const host=new URL(c.site_url).hostname;
        return host.includes('.')&&Boolean(safePilotUrl(c.site_url,host));
      }catch{return false;}
    }
    const eng=eMap.get(ids[index]);
    if(!eng||!/^\\d{13}$/.test(String(eng.corporate_number||'')))return false;
    const registry=await fetchGbizCompany(eng.corporate_number);
    return Boolean(registry?.name&&sameCompanyName(registry.name,c.name)&&
      sameCompanyName(registry.name,eng.name));
  }));
  const invalid=salesIds.filter((id,index)=>!checks[index]);
  if(invalid.length)return json(res,409,{error:'official_evidence_or_ng_review_required',
    salesCompanyIds:invalid,
    hint:'公式HTTPSサイト、または公的法人番号照合が必要です。照合失敗・連絡禁止・同名企業は管理者が確認してください。'});
  if(found.data){
    const added=ids.filter(id=>!found.data.enger_company_ids.includes(id));
    if(!added.length)return json(res,200,{ok:true,existing:true,batch:rowView(found.data)});
    const map=new Map(ids.map((id,i)=>[id,salesIds[i]]));
    const newBatch=await db.from(TABLE).update({
      batch_id:randomUUID(),
      enger_company_ids:[...found.data.enger_company_ids,...added],
      sales_company_ids:[...found.data.sales_company_ids,...added.map(id=>map.get(id))],
    }).eq('tenant_id',ctx.tenantId).eq('batch_id',found.data.batch_id)
      .select('*').maybeSingle();
    if(newBatch.error||!newBatch.data)return json(res,409,{
      error:'batch_update_conflict',hint:'同時に対象企業が変更されました。最新の結果を取得してください。'});
    return json(res,200,{ok:true,extended:true,batch:rowView(newBatch.data)});
  }
  // UNIQUE tenant primary key prevents two initial enrollments from racing.
  const insert=await db.from(TABLE).insert({
    tenant_id:ctx.tenantId,enger_company_ids:ids,sales_company_ids:salesIds,created_by:user.id
  }).select('*').single();
  if(insert.error)return json(res,insert.error.code==='23505'?409:503,{
    error:insert.error.code==='23505'?'pilot_batch_already_registered':'batch_registration_failed'});
  return json(res,200,{ok:true,created:true,batch:rowView(insert.data)});
}