// ENGER IDs stay stable. Sales keeps the working contact details, owner and NEXT.
import {createHash} from "node:crypto";
import {domainOf, safeUrl, STATUS_LABEL} from "./sales.js";

export const workingCompanyId=(tenant,id)=>{
 const hex=createHash("sha256").update(`sales:enger:${tenant}:${id.toLowerCase()}`).digest("hex");
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
const checked=result=>{if(result.error)throw result.error;return result.data;};
export const SALES_FIELDS="id,name,phone,emails,site_url,form_url,status,owner_id,next_action,next_action_on,hidden_at,ng_reason,industry,region,service,campaign_id,last_sent_at,current_contact_channel,click_count";
export function salesSummary(c,ownerName=null){
 return c?{id:c.id,phone:c.phone,emails:c.emails||[],website:c.site_url,formUrl:c.form_url,
  industry:c.industry,region:c.region,service:c.service,campaignId:c.campaign_id,lastSentAt:c.last_sent_at,contactChannel:c.current_contact_channel,clickCount:c.click_count,
  status:c.status,statusLabel:STATUS_LABEL[c.status]||c.status,ownerName,
  nextAction:c.next_action,nextActionOn:c.next_action_on,hidden:Boolean(c.hidden_at),ngReason:c.ng_reason}:null;
}
// Bounded queries for the current page, rather than one request per row.
export async function readSalesCompanies(db,tenant,ids){
 const result=new Map();if(!ids.length)return result;
 const links=checked(await db.from("gw_sales_company_links").select("source_company_id,company_id")
  .eq("tenant_id",tenant).eq("source_system","enger").in("source_company_id",ids));
 if(!links.length)return result;
 const companies=checked(await db.from("gw_sales_companies").select(SALES_FIELDS)
  .eq("tenant_id",tenant).in("id",[...new Set(links.map(l=>l.company_id))]));
 const owners=[...new Set(companies.map(c=>c.owner_id).filter(Boolean))];
 const employees=owners.length?checked(await db.from("gw_employees").select("id,display_name")
  .eq("tenant_id",tenant).in("id",owners)):[];
 const names=new Map(employees.map(e=>[e.id,e.display_name]));
 const campaignIds=[...new Set(companies.map(c=>c.campaign_id).filter(Boolean))];
 const campaigns=campaignIds.length?checked(await db.from("gw_sales_campaigns").select("id,name").eq("tenant_id",tenant).in("id",campaignIds)):[];
 const campaignNames=new Map(campaigns.map(c=>[c.id,c.name]));
 const byId=new Map(companies.map(c=>[c.id,{...salesSummary(c,names.get(c.owner_id)),campaignName:campaignNames.get(c.campaign_id)||null}]));
 for(const l of links){if(!byId.has(l.company_id))throw Error("linked_company_unavailable");result.set(l.source_company_id,byId.get(l.company_id));}
 return result;
}

// Called only when the user chooses an action, never by hover or list reads.
// Deterministic primary key + unique source link make retries/concurrent clicks idempotent.
export async function ensureSalesCompany(db,ctx,user,source){
 const tenant=ctx.tenantId;
 const readLink=async()=>checked(await db.from("gw_sales_company_links").select("company_id")
  .eq("tenant_id",tenant).eq("source_system","enger").eq("source_company_id",source.id).maybeSingle());
 let link=await readLink();
 if(!link){
  const site=safeUrl(source.website)||null,domain=site?domainOf(site):null;
  const findDomain=async()=>domain?checked(await db.from("gw_sales_companies").select("id")
   .eq("tenant_id",tenant).eq("domain",domain).maybeSingle()):null;
  let target=await findDomain(),method=target?"domain":"created";
  if(!target){
   const id=workingCompanyId(tenant,source.id);
   const email=String(source.contact_email||"").trim();
   const record={id,tenant_id:tenant,name:source.name,site_url:site,domain,
    form_url:safeUrl(source.contact_form_url)||null,phone:source.phone||null,
    emails:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?[email.toLowerCase()]:[],
    industry:source.industry||null,region:source.prefecture||null,address:source.address||null,
    status:"untouched",owner_id:ctx.employee?.id||null,created_by:user.id,
    next_action:"連絡先を確認してアタック",note:source.note||null};
   // Never overwrite a previously edited Sales company on a retry.
   const created=await db.from("gw_sales_companies").insert(record);
   if(created.error){
    if(created.error.code!=="23505")throw created.error;
    target=checked(await db.from("gw_sales_companies").select("id").eq("tenant_id",tenant).eq("id",id).maybeSingle());
    if(!target){target=await findDomain();method="domain";}
    if(!target)throw created.error;
   }else target={id};
  }
  const saved=await db.from("gw_sales_company_links").insert({tenant_id:tenant,source_system:"enger",
   source_company_id:source.id,company_id:target.id,method,created_by:user.id});
  if(saved.error&&saved.error.code!=="23505")throw saved.error;
  link=await readLink();if(!link)throw Error("link_not_saved");
 }
 const company=checked(await db.from("gw_sales_companies").select(SALES_FIELDS)
  .eq("tenant_id",tenant).eq("id",link.company_id).maybeSingle());
 if(!company)throw Error("linked_company_unavailable");
 return company;
}
