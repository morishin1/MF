// Verified company-to-Sales offer handoff. A portal UI event is never proof
// of a proposal: only the tenant/company-scoped ENGER offer ledger is.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function countPublishedCompanyOffers(offers,published){
 const types=new Map((published||[]).filter(p=>UUID.test(String(p?.id||""))&&
  ["job","talent"].includes(p.item_type)).map(p=>[p.id,p.item_type]));
 const actual=(offers||[]).filter(o=>UUID.test(String(o?.shortlist_id||""))&&
  types.get(o.shortlist_id)===o.item_type);
 return {count:actual.length,jobCount:actual.filter(o=>o.item_type==="job").length,
  talentCount:actual.filter(o=>o.item_type==="talent").length};
}
export async function confirmedCompanyOffers(db,ctx,row){
 const result=await db.schema("enger").from("dx2_company_portal_offers")
  .select("id,shortlist_id,item_type,created_at")
  .eq("tenant_id",ctx.tenantId).eq("company_id",row.company_id)
  .gte("created_at",row.started_at).order("created_at",{ascending:false}).limit(40);
 if(result.error)throw result.error;
 const offers=(result.data||[]).filter(o=>UUID.test(String(o.shortlist_id||"")));
 if(!offers.length)return {count:0,jobCount:0,talentCount:0};
 const shortlist=await db.schema("enger").from("dx2_company_sales_shortlist")
  .select("id,item_type").eq("tenant_id",ctx.tenantId)
  .eq("company_id",row.company_id).eq("status","published")
  .in("id",[...new Set(offers.map(o=>o.shortlist_id))]).limit(40);
 if(shortlist.error)throw shortlist.error;
 return countPublishedCompanyOffers(offers,shortlist.data||[]);
}
