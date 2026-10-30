-- Sales提案詳細: ENGERの「人材側 進める/見送り」回答の受信（db/149より後）。
-- 既存の応募者等の個人情報は追加しない。回答コードだけを追加する。
begin;
alter table public.gw_sales_proposal_source_state
  add column if not exists candidate_response text;
alter table public.gw_sales_proposal_source_state
  drop constraint if exists gw_sales_source_candidate_response_chk;
alter table public.gw_sales_proposal_source_state
  add constraint gw_sales_source_candidate_response_chk
  check (candidate_response is null or candidate_response in ('unanswered','proceed','pass'));

create or replace function public.gw_sales_apply_source_state_v2(
  p_tenant uuid, p_source_id text, p_version bigint, p_deleted boolean,
  p_response text, p_candidate_response text, p_observed_at timestamptz, p_event_id text
) returns text language plpgsql security definer set search_path = '' as $$
declare v public.gw_sales_proposal_source_state%rowtype;
begin
  if p_tenant is null or p_source_id is null or p_source_id !~ '^[A-Za-z0-9_.:-]{1,100}$'
    or p_version is null or p_version < 1 or p_deleted is null or p_observed_at is null
    or p_observed_at > now() + interval '10 minutes'
    or (p_response is not null and p_response not in ('unanswered','proceed','pass'))
    or (p_candidate_response is not null and p_candidate_response not in ('unanswered','proceed','pass'))
    or p_event_id is null or p_event_id !~ '^[A-Za-z0-9_.:-]{8,120}$' then
    raise exception 'invalid_source_state' using errcode='22023';
  end if;

  insert into public.gw_sales_proposal_source_state
    (tenant_id,source_proposal_id,source_version,deleted,company_response,candidate_response,observed_at,event_id)
  values (p_tenant,p_source_id,p_version,p_deleted,p_response,p_candidate_response,p_observed_at,p_event_id)
  on conflict (tenant_id,source_proposal_id) do nothing;

  select * into strict v from public.gw_sales_proposal_source_state
  where tenant_id=p_tenant and source_proposal_id=p_source_id for update;
  if v.source_version > p_version then return 'stale'; end if;
  if v.source_version = p_version then
    if v.deleted is distinct from p_deleted
      or v.company_response is distinct from p_response
      or v.candidate_response is distinct from p_candidate_response
      or v.event_id <> p_event_id or v.observed_at <> p_observed_at then
      raise exception 'source_version_conflict' using errcode='22023';
    end if;
    return 'replayed';
  end if;
  update public.gw_sales_proposal_source_state
  set source_version=p_version,deleted=p_deleted,company_response=p_response,
    candidate_response=p_candidate_response,observed_at=p_observed_at,event_id=p_event_id,received_at=now()
  where tenant_id=p_tenant and source_proposal_id=p_source_id;
  return 'updated';
end $$;
revoke all on function public.gw_sales_apply_source_state_v2(uuid,text,bigint,boolean,text,text,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.gw_sales_apply_source_state_v2(uuid,text,bigint,boolean,text,text,timestamptz,text) to service_role;
notify pgrst, 'reload schema';
commit;
