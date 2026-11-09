// Owner-only, explicit AI initiation can create the missing Sales side of a
// VERIFIED ENGER company. Never match a company by name or silently reuse a domain.
import {isIP} from 'node:net';
import {safePilotUrl} from './sales-company-ai-pilot.js';
import {fetchGbizCompany,sameCompanyName} from './sales-company-gbiz.js';
import {companyInScope} from './sales-company-portal-db.js';

export async function ensureSalesCompanyLink(db,{tenantId,engerCompanyId,actorId}){
 const existing=await db.from('gw_sales_company_links')
   .select('company_id').eq('tenant_id',tenantId).eq('source_system','enger')
   .eq('source_company_id',engerCompanyId).limit(2);
 if(existing.error)return {error:'link_unavailable'};
 if(existing.data?.length===1)return {salesCompanyId:existing.data[0].company_id,existing:true};
 if(existing.data?.length>1)return {error:'duplicate_company_links'};
 const scope=await companyInScope(db,tenantId,engerCompanyId);
 if(!scope.ok)return {error:'company_out_of_scope'};
 const result=await db.schema('enger').from('companies')
  .select('id,name,corporate_number,website,industry,prefecture,deleted_at')
  .eq('id',engerCompanyId).is('deleted_at',null).maybeSingle();
 if(result.error||!result.data)return {error:'company_basics_unavailable'};
 const c=result.data,number=String(c.corporate_number||'');
 if(!/^\d{13}$/.test(number))return {error:'corporate_number_required'};
 let u;try{u=new URL(c.website||'');}catch{return {error:'official_website_required'};}
 const domain=u.hostname.toLowerCase().replace(/^www\./,'');
 if(!domain.includes('.')||isIP(domain)||!/^[-a-z0-9.]+$/.test(domain)||
   domain.endsWith('.local')||!safePilotUrl(u.href,u.hostname))
   return {error:'official_website_invalid'};
 // A registry mismatch may indicate a renamed company or a different法人:
 // review it instead of silently creating a wrong Sales master record.
 const registry=await fetchGbizCompany(number);
 if(registry?.name&&!sameCompanyName(registry.name,c.name))
   return {error:'official_company_name_review_required'};
 // Never assume same domain means the same company: leave any existing Sales
 // company to a human to review and link explicitly.
 const possible=await db.from('gw_sales_companies')
   .select('id,name,site_url,domain').eq('tenant_id',tenantId)
   .or('domain.eq.'+domain+',site_url.ilike.%'+domain+'%').limit(3);
 if(possible.error)return {error:'duplicate_check_unavailable'};
 if(possible.data?.length)return {error:'possible_sales_company_review_required'};
 const created=await db.from('gw_sales_companies').insert({
   tenant_id:tenantId,name:String(c.name||'').slice(0,200),
   site_url:u.href,domain,industry:c.industry||null,region:c.prefecture||null,
   created_by:actorId,status:'untouched'
 }).select('id').single();
 if(created.error||!created.data)return {error:'sales_master_creation_failed'};
 const createdId=created.data.id;
 const link=await db.from('gw_sales_company_links').insert({
   tenant_id:tenantId,source_system:'enger',source_company_id:engerCompanyId,
   company_id:createdId,method:'created',created_by:actorId
 }).select('id').single();
 if(link.error||!link.data){
   // Our newly created master has no linked activity; clean up an orphan if
   // another concurrent request won the unique source link constraint.
   await db.from('gw_sales_companies').delete().eq('tenant_id',tenantId).eq('id',createdId);
   const retry=await db.from('gw_sales_company_links').select('company_id')
     .eq('tenant_id',tenantId).eq('source_system','enger')
     .eq('source_company_id',engerCompanyId).limit(2);
   if(!retry.error&&retry.data?.length===1)
     return {salesCompanyId:retry.data[0].company_id,existing:true};
   return {error:'sales_link_creation_failed'};
 }
 return {salesCompanyId:createdId,created:true};
}
