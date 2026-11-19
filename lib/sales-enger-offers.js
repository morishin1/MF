// Both ENGER offer ledgers are receipts, not inferred button/UI activity.
const LEGACY='id,company_id,status,created_at,item_type,job_id,candidate_id';
const JOB='id,company_id,created_at,source_job_id,job_title,candidate_id,sales_company_id,sales_proposal_id';
const normalize=row=>({...row,status:'received',item_type:'talent',job_id:row.source_job_id||null,
  title:row.job_title,salesProposalId:row.sales_proposal_id,salesCompanyId:row.sales_company_id});
const checked=r=>{if(r.error)throw r.error;return r.data;};
const sources=[['dx2_company_portal_offers',LEGACY,x=>x],['dx2_company_job_offers',JOB,normalize]];
export async function readEngerOffers(db,tenant,{since,until,ids}={}){
  const batches=await Promise.all(sources.map(async([table,columns,shape])=>{
    const result=[];
    for(let offset=0;;offset+=500){
      let q=db.schema('enger').from(table).select(columns).eq('tenant_id',tenant);
      if(since)q=q.gte('created_at',since);
      if(until)q=q.lte('created_at',until);
      if(ids)q=q.in('id',ids);
      const rows=checked(await q.order('id').range(offset,offset+499));
      result.push(...rows.map(shape));
      if(rows.length<500)return result;
    }
  }));
  const rows=batches.flat(),seen=new Set();
  for(const row of rows){
    if(seen.has(row.id))throw Error('ambiguous_offer_receipt');
    seen.add(row.id);
  }
  return rows;
}
export async function readEngerOffer(db,tenant,id){
  return (await readEngerOffers(db,tenant,{ids:[id]}))[0]||null;
}
