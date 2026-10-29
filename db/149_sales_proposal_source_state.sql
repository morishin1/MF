-- ENGER source snapshots. Additive: never deletes/archives a Sales proposal.
-- Apply before enabling the ENGER outbox trigger migration.
begin;
create table if not exists public.gw_sales_proposal_source_state (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_proposal_id text not null check (source_proposal_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  source_version bigint not null check (source_version > 0),
  deleted boolean not null,
  company_response text check (company_response in ('unanswered','proceed','pass')),
  observed_at timestamptz not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key (tenant_id, source_proposal_id)
);
alter table public.gw_sales_proposal_source_state enable row level security;
revoke all on public.gw_sales_proposal_source_state from public, anon, authenticated;
grant select on public.gw_sales_proposal_source_state to authenticated;
grant select, insert, update on public.gw_sales_proposal_source_state to service_role;
drop policy if exists gw_sales_source_state_read on public.gw_sales_proposal_source_state;
create policy gw_sales_source_state_read on public.gw_sales_proposal_source_state
  for select to authenticated using (public.gw_is_sales(tenant_id));

-- One locked row per source proposal: late delivery cannot resurrect a trashed row
-- or replace a newer reply. State can arrive before the Sales proposal exists.
create or replace function public.gw_sales_apply_source_state(
  p_tenant uuid, p_source_id text, p_version bigint, p_deleted boolean,
  p_response text, p_observed_at timestamptz, p_event_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare v public.gw_sales_proposal_source_state%rowtype;
begin
  if p_tenant is null or p_source_id is null or p_source_id !~ '^[A-Za-z0-9_.:-]{1,100}$'
    or p_version is null or p_version < 1 or p_deleted is null or p_observed_at is null
    or p_observed_at > now() + interval '10 minutes'
    or (p_response is not null and p_response not in ('unanswered','proceed','pass'))
    or p_event_id is null or p_event_id !~ '^[A-Za-z0-9_.:-]{8,120}$' then
    raise exception 'invalid_source_state' using errcode='22023';
  end if;
  insert into public.gw_sales_proposal_source_state
    (tenant_id,source_proposal_id,source_version,deleted,company_response,observed_at,event_id)
    values (p_tenant,p_source_id,p_version,p_deleted,p_response,p_observed_at,p_event_id)
    on conflict (tenant_id,source_proposal_id) do nothing;
  select * into strict v from public.gw_sales_proposal_source_state
    where tenant_id=p_tenant and source_proposal_id=p_source_id for update;
  if v.source_version > p_version then return 'stale'; end if;
  if v.source_version = p_version then
    if v.deleted is distinct from p_deleted or v.company_response is distinct from p_response
      or v.event_id <> p_event_id or v.observed_at <> p_observed_at then
      raise exception 'source_version_conflict' using errcode='22023';
    end if;
    return 'replayed';
  end if;
  update public.gw_sales_proposal_source_state set source_version=p_version,deleted=p_deleted,
    company_response=p_response,observed_at=p_observed_at,event_id=p_event_id,received_at=now()
    where tenant_id=p_tenant and source_proposal_id=p_source_id;
  return 'updated';
end $$;
revoke all on function public.gw_sales_apply_source_state(uuid,text,bigint,boolean,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.gw_sales_apply_source_state(uuid,text,bigint,boolean,text,timestamptz,text) to service_role;
notify pgrst, 'reload schema';
commit;
