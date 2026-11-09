// Preview read model: no mutations, no snapshots committed to the public repository.
import {json,methodNotAllowed} from '../../lib/http.js';
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {buildLifecycle,selectLifecycle,ACTIVE_STAGES} from '../../lib/sales-company-lifecycle.js';
const cache=new Map();
// Exact-count, deterministic pages. A truncated or changed source must fail, never become zero.
export async function readAll(makeQuery,max=12000,sortColumn="id"){
 const first=await makeQuery().range(0,499);
 if(first.error)throw first.error;
  if(first.count==null||first.count>max||!first.data||first.data.length!==Math.min(first.count,500))throw Error('incomplete_source');
 const rows=[...first.data];
 for(let offset=500;offset<first.count;offset+=2000){
  const tasks=[];for(let i=offset;i<Math.min(offset+2000,first.count);i+=500)tasks.push({i,request:makeQuery().range(i,Math.min(i+499,first.count-1))});
  const pages=await Promise.all(tasks.map(async({i,request})=>{const p=await request;if(p.error||p.count!==first.count||p.data?.length!==Math.min(500,first.count-i))throw Error('incomplete_source');return p.data;}));
  rows.push(...pages.flat());
 }
 if(new Set(rows.map(r=>r.id||r.company_id)).size!==rows.length)throw Error('duplicate_source');return rows;
}
async function modelFor(tenant,fresh=false){
 const cached=cache.get(tenant);if(!fresh&&cached&&cached.until>Date.now())return cached.promise;
 const promise=(async()=>{
  const db=admin();
  const [directory,contacts,proposals,links,sales,employees,broadcasts,classifications,peopleResult]=await Promise.all([
   readAll(()=>db.schema('enger').from('dx2_sales_company_directory_for_tenant').select('id,name,bucket,industry,prefecture,effective_priority,classification_basis,relationship_status,relationship_evidence,needs_contact_review,historical_contact_date,historical_activity_count,si_ses_candidate',{count:'exact'}).eq('tenant_id',tenant).is('directory_hidden_at',null).order(sortColumn)),
   readAll(()=>db.schema('enger').from('companies').select('id,company_no,contact_name,contact_email,phone,contact_form_url,last_contacted_at',{count:'exact'}).is('deleted_at',null).order(sortColumn)),
   readAll(()=>db.schema('enger').from('proposals').select('id,company_id,company,stage,job_id,updated_at',{count:'exact'}).is('deleted_at',null).in('stage',[...ACTIVE_STAGES]).order(sortColumn),5000),
   readAll(()=>db.from('gw_sales_company_links').select('id,source_company_id,company_id',{count:'exact'}).eq('tenant_id',tenant).eq('source_system','enger').order(sortColumn)),
   readAll(()=>db.from('gw_sales_companies').select('id,name,status,phone,emails,form_url,owner_id,next_action,next_action_on,hidden_at,ng_reason,last_contact_at,updated_at',{count:'exact'}).eq('tenant_id',tenant).order(sortColumn)),
   readAll(()=>db.from('gw_employees').select('id,display_name',{count:'exact'}).eq('tenant_id',tenant).order(sortColumn),2000),
   readAll(()=>db.from('gw_sales_enger_company_overrides').select('company_id,blast_target,lifecycle_segment,work_plan',{count:'exact'}).eq('tenant_id',tenant).order('company_id')),
   readAll(()=>db.from('gw_sales_company_classifications')
    .select('company_id,status,org_type,business_types,confidence,suggested_service',{count:'exact'})
    .eq('tenant_id',tenant),12000,'company_id'),
    readAll(()=>db.from('gw_sales_company_people').select('id,company_id,name,department,position,email,phone,source,met_on',{count:'exact'}).eq('tenant_id',tenant).order(sortColumn),20000)
      .then(rows=>({rows,ready:true})).catch(error=>{
        if(['42P01','PGRST205','PGRST204'].includes(error?.code))return {rows:[],ready:false};
        throw error;
      }),
  ]);
  const ids=[...new Set(proposals.map(p=>p.job_id).filter(Boolean))];let jobs=[];
  for(let i=0;i<ids.length;i+=200){const r=await db.schema('enger').from('jobs').select('id,status,deleted_at').in('id',ids.slice(i,i+200));if(r.error||r.data?.length!==ids.slice(i,i+200).length)throw Error('jobs_unavailable');jobs.push(...r.data);}
  return {...buildLifecycle({directory,contacts,proposals,links,sales,employees,jobs,broadcasts,people:peopleResult.rows,peopleReady:peopleResult.ready,classifications}),observedAt:new Date().toISOString()};
 })();
 cache.set(tenant,{until:Date.now()+30000,promise});
 try{return await promise;}catch(error){cache.delete(tenant);throw error;}
}
export default async function handler(req,res){
 res.setHeader?.('Cache-Control','private, no-store');
 const user=await requireUser(req,res);if(!user)return;
 if(req.method!=='GET')return methodNotAllowed(res,['GET']);
 const ctx=await gwContext(user.id);
 if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))return json(res,403,{error:'forbidden'});
 const params=new URL(req.url||'/','http://localhost').searchParams;
 try{
  // Validate before querying any source.
  selectLifecycle({rows:[],activities:[],counts:{}},params);
  const model=await modelFor(ctx.tenantId,params.get('refresh')==='1');
  return json(res,200,{...selectLifecycle(model,params),complete:true,readonly:true,observedAt:model.observedAt,
   note:'再アプローチ・新規開拓は旧区分に基づく候補を含みます。名刺交換・問い合わせは明示的に登録した接点だけです。'});
 }catch(error){return json(res,error.message==='invalid_filter'?400:503,{error:error.message==='invalid_filter'?'invalid_filter':'lifecycle_unavailable',hint:'企業・提案・連絡先の照合を完了できませんでした。再取得してください。'});}
}
