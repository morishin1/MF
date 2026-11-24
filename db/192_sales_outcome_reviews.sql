-- Evidence and decisions are append-only. This migration creates no decisions.
create table public.gw_sales_outcome_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  kind text not null check (kind in ('proposal','closing','affiliation','feedback','meeting','terms','clearance')),
  entity_key text not null check (length(entity_key) between 1 and 160),
  revision integer not null check (revision > 0),
  request_id uuid not null,
  actor_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now(),
  unique (tenant_id,request_id),
  unique (tenant_id,kind,entity_key,revision)
);
alter table public.gw_sales_outcome_reviews enable row level security;
revoke all on public.gw_sales_outcome_reviews from public,anon,authenticated,service_role;
grant select on public.gw_sales_outcome_reviews to service_role;

create view public.gw_sales_outcome_current with (security_invoker=true) as
  select r.id,r.tenant_id,r.kind,r.entity_key,r.revision,r.request_id,r.actor_id,
    case when m.id is not null and r.payload->>'status' in ('scheduled','done') then
      r.payload || jsonb_build_object('status',m.status,'meetingAt',coalesce(m.conducted_at,m.scheduled_at))
      else r.payload end payload,r.created_at
  from (select distinct on (tenant_id,kind,entity_key) * from public.gw_sales_outcome_reviews
    order by tenant_id,kind,entity_key,revision desc) r
  left join public.gw_sales_meetings m on r.kind='meeting' and m.id=(r.payload->>'meetingId')::uuid
    and m.tenant_id=r.tenant_id and m.kind='improvement';
revoke all on public.gw_sales_outcome_current from public,anon,authenticated;
grant select on public.gw_sales_outcome_current to service_role;

alter table public.gw_sales_meetings drop constraint gw_sales_meetings_kind_check,
  add constraint gw_sales_meetings_kind_check check(kind in ('first_meeting','improvement'));

create function public.gw_sales_record_outcome(p_tenant uuid,p_kind text,p_entity text,p_expected integer,
  p_request uuid,p_actor uuid,p_payload jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare prior public.gw_sales_outcome_reviews; rev integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_kind||p_entity,0));
  select * into prior from public.gw_sales_outcome_reviews where tenant_id=p_tenant and request_id=p_request;
  if found then
    if (prior.kind,prior.entity_key,prior.actor_id,prior.payload) is distinct from (p_kind,p_entity,p_actor,p_payload)
      then raise exception using errcode='40001',message='request_changed'; end if;
    return prior.revision;
  end if;
  select coalesce(max(revision),0) into rev from public.gw_sales_outcome_reviews
    where tenant_id=p_tenant and kind=p_kind and entity_key=p_entity;
  if p_expected is distinct from rev then raise exception using errcode='40001',message='stale_review'; end if;
  if p_kind='meeting' and p_payload->>'salesCompanyId' is not null then
    if p_payload->>'status'='planned' then
      update public.gw_sales_meetings set status='canceled',updated_at=now()
        where id=(p_payload->>'meetingId')::uuid and tenant_id=p_tenant and kind='improvement' and status='scheduled';
    else
      if not exists(select 1 from public.gw_sales_companies where tenant_id=p_tenant and id=(p_payload->>'salesCompanyId')::uuid
        and hidden_at is null and ng_reason is null and (status not in ('won','lost','excluded') or p_payload->>'status'='done'))
        then raise exception using errcode='P0002',message='company_blocked'; end if;
      insert into public.gw_sales_meetings as m(id,tenant_id,company_id,owner_id,kind,status,scheduled_at,conducted_at,created_by)
        values ((p_payload->>'meetingId')::uuid,p_tenant,(p_payload->>'salesCompanyId')::uuid,(p_payload->>'ownerId')::uuid,
          'improvement',case when p_payload->>'status'='done' then 'done' else 'scheduled' end,(p_payload->>'meetingAt')::timestamptz,
          case when p_payload->>'status'='done' then (p_payload->>'meetingAt')::timestamptz end,p_actor)
        on conflict (id) do update set owner_id=excluded.owner_id,status=excluded.status,scheduled_at=excluded.scheduled_at,
          conducted_at=excluded.conducted_at,updated_at=now()
          where m.tenant_id=excluded.tenant_id and m.company_id=excluded.company_id and m.kind='improvement';
      if not found then raise exception using errcode='40001',message='meeting_changed'; end if;
    end if;
  end if;
  insert into public.gw_sales_outcome_reviews(tenant_id,kind,entity_key,revision,request_id,actor_id,payload)
    values (p_tenant,p_kind,p_entity,rev+1,p_request,p_actor,p_payload);
  return rev+1;
end $$;
revoke all on function public.gw_sales_record_outcome(uuid,text,text,integer,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.gw_sales_record_outcome(uuid,text,text,integer,uuid,uuid,jsonb) to service_role;

-- Only confirmed operational decisions for Eight's own proposals can restrict a new individual proposal.
create function public.gw_sales_check_new_proposal(p enger.proposals) returns void
language plpgsql security definer set search_path='' as $$
declare tenant constant uuid := '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'; ids uuid[]; policy record; company_name text;
begin
  if p.dx2_is_blast is true or p.partner_organization_id is not null or nullif(btrim(p.owner_company),'') is not null then return; end if;
  if not exists(select 1 from public.gw_sales_outcome_current where tenant_id=tenant and kind='terms'
    and payload->>'grade' in ('C','D')) then return; end if;
  select array_agg(distinct x) into ids from (
    select p.company_id x union all select company_id from enger.dx2_sales_company_history_links
    where tenant_id=tenant and ((entity_type='proposal' and entity_id=p.id) or (entity_type='job' and entity_id=p.job_id))
    union all select substring(a.payload->>'company' from 7)::uuid from public.gw_sales_outcome_current a
      where p.company_id is null and a.tenant_id=tenant and a.kind='clearance' and a.entity_key=p.job_id::text
  ) s where x is not null;
  select client_name into company_name from enger.jobs where id=p.job_id;
  for policy in select r.entity_key,r.payload,r.revision,c.name from public.gw_sales_outcome_current r
    join enger.companies c on r.entity_key='enger:'||c.id::text
    where r.tenant_id=tenant and r.kind='terms' and r.payload->>'grade' in ('C','D')
    and (c.id=any(ids) or (ids is null and c.deleted_at is null and btrim(c.name) in (btrim(p.company),btrim(company_name))))
  loop
    if coalesce(cardinality(ids),0)<>1 then
      raise exception '取引条件を確認するため、提案先の企業IDを照合してください。'; end if;
    if policy.payload->>'grade'='D' then raise exception 'この企業の新規個別提案は停止中です。Salesで改善商談と取引条件を確認してください。'; end if;
    if not exists(select 1 from public.gw_sales_outcome_current a where a.tenant_id=tenant and a.kind='clearance'
      and a.entity_key=p.job_id::text and a.payload->>'company'=policy.entity_key
      and a.payload->>'termsRevision'=policy.revision::text and (a.payload->>'until')::date >= (now() at time zone 'Asia/Tokyo')::date)
      then raise exception 'この案件は個別提案前にSalesで企業との合意条件を確認してください。'; end if;
  end loop;
end $$;
revoke all on function public.gw_sales_check_new_proposal(enger.proposals) from public,anon,authenticated;
grant execute on function public.gw_sales_check_new_proposal(enger.proposals) to service_role;

create function public.gw_sales_guard_proposal_insert() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.gw_sales_check_new_proposal(new); return new; end $$;
revoke all on function public.gw_sales_guard_proposal_insert() from public,anon,authenticated;
create trigger gw_sales_individual_proposal_terms before insert on enger.proposals
  for each row execute function public.gw_sales_guard_proposal_insert();

-- Apply the same condition before the first job-side delivery of an already registered draft.
-- Keep the existing token lock, round handling and return contract of dx2_email_prepare.
CREATE OR REPLACE FUNCTION enger.dx2_email_prepare(p_id uuid, p_side text, p_new_token text)
 RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
declare p enger.proposals; token text; number bigint;
begin
  if p_side not in ('job','cand') or p_new_token !~ '^[0-9a-f]{48}$' then raise exception 'invalid email context'; end if;
  select * into strict p from enger.proposals where id=p_id and deleted_at is null for update;
  if p_side='job' and p.mail_sent_at is null and exists(select 1 from public.gw_sales_outcome_current
    where tenant_id='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac' and kind='terms' and payload->>'grade' in ('C','D'))
    and not exists(select 1 from enger.dx2_proposal_email_rounds where proposal_id=p_id and side='job')
    and not exists(select 1 from enger.mail_sent where related_kind='proposal' and related_id=p_id::text and audience='job') then
    perform public.gw_sales_check_new_proposal(p);
  end if;
  token := case when p_side='job' then p.job_action_token else p.cand_action_token end;
  if token is null then
    token := p_new_token;
    if p_side='job' then update enger.proposals set job_action_token=token where id=p_id;
    else update enger.proposals set cand_action_token=token where id=p_id; end if;
  end if;
  select job_no into number from enger.jobs where id=p.job_id;
  return jsonb_build_object('token',token,'jobNo',number);
end $function$;

notify pgrst,'reload schema';
