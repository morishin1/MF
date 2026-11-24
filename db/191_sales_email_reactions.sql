-- Delivery receipts belong to a Sales proposal. ENGER retains the original answer.
create table if not exists public.gw_sales_reaction_deliveries (
  tenant_id uuid not null, proposal_id uuid not null, reaction_id uuid not null,
  channel text not null check (channel in ('bell','mail','slack')),
  status text not null default 'pending' check (status in ('pending','sending','sent','unassigned','not_configured','unknown')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,reaction_id,channel)
);
create index if not exists gw_sales_reaction_delivery_proposal on public.gw_sales_reaction_deliveries(tenant_id,proposal_id);
alter table public.gw_sales_reaction_deliveries enable row level security;
revoke all on public.gw_sales_reaction_deliveries from public,anon,authenticated;
grant select,insert,update on public.gw_sales_reaction_deliveries to service_role;

create or replace function public.gw_sales_proposal_job_numbers(p_tenant uuid,p_ids uuid[],p_job_no bigint)
returns table(sales_id uuid, job_no bigint) language sql stable set search_path='' as $$
  select s.id,j.job_no from public.gw_sales_proposals s
    join enger.proposals p on p.id::text=s.source_proposal_id
    join enger.jobs j on j.id=p.job_id
  where s.tenant_id=p_tenant and p_tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'::uuid
    and s.source_system='enger' and (p_ids is not null or p_job_no is not null)
    and (p_ids is null or s.id=any(p_ids)) and (p_job_no is null or j.job_no=p_job_no)
  order by s.id
$$;
revoke all on function public.gw_sales_proposal_job_numbers(uuid,uuid[],bigint) from public,anon,authenticated;
grant execute on function public.gw_sales_proposal_job_numbers(uuid,uuid[],bigint) to service_role;
notify pgrst,'reload schema';
