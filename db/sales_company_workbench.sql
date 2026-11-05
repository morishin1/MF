-- Service-only company editing and action ledger. Existing relationship evidence is untouched.
alter table public.gw_sales_enger_company_overrides
 add column if not exists lifecycle_segment text check (lifecycle_segment in ('current','past','future')),
 add column if not exists work_plan jsonb not null default '{}'::jsonb;
create table if not exists public.gw_sales_company_activity (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 company_id uuid not null references enger.companies(id),
 request_key uuid not null,
 actor_id uuid references auth.users(id) on delete set null,
 actor_name text not null,
 operation text not null check (operation in ('profile','plan','activity')),
 payload jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,request_key)
);
create index if not exists gw_sales_company_activity_history on public.gw_sales_company_activity(tenant_id,company_id,created_at desc);
alter table public.gw_sales_company_activity enable row level security;
revoke all on public.gw_sales_company_activity from public,anon,authenticated;
grant select,insert on public.gw_sales_company_activity to service_role;

create or replace function public.gw_sales_company_workbench_save(
 p_tenant uuid,p_company uuid,p_actor uuid,p_actor_name text,p_operation text,p_payload jsonb,p_request uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 prior public.gw_sales_company_activity%rowtype;
 saved public.gw_sales_company_activity%rowtype;
 field text; col text; sval text; linked uuid; links integer; blocked boolean;
 plan jsonb; source_record enger.companies%rowtype;
begin
 -- Only the service API has EXECUTE. Tenant and user roles are checked by that API.
 if not exists(select 1 from enger.dx2_sales_company_directory_for_tenant where tenant_id=p_tenant and id=p_company) then raise exception 'company_not_in_scope'; end if;
 select * into source_record from enger.companies where id=p_company and deleted_at is null for update;
 if not found then raise exception 'company_not_found'; end if;
 select * into prior from public.gw_sales_company_activity where tenant_id=p_tenant and request_key=p_request;
 if found then
  if prior.company_id<>p_company or prior.operation<>p_operation or prior.payload<>p_payload or prior.actor_id is distinct from p_actor then raise exception 'request_conflict'; end if;
  return to_jsonb(prior);
 end if;
 select count(*),(array_agg(company_id))[1] into links,linked from public.gw_sales_company_links where tenant_id=p_tenant and source_system='enger' and source_company_id=p_company::text;
 if links>1 then raise exception 'ambiguous_company_link'; end if;
 if linked is not null and not exists(select 1 from public.gw_sales_companies where id=linked and tenant_id=p_tenant) then raise exception 'sales_company_missing'; end if;
 if p_operation='profile' then
  if jsonb_typeof(p_payload)<>'object' or (select count(*) from jsonb_object_keys(p_payload))<>1 then raise exception 'invalid_patch'; end if;
  select key into field from jsonb_object_keys(p_payload) key;
  col:=case field when 'name' then 'name' when 'contactName' then 'contact_name' when 'contactEmail' then 'contact_email' when 'phone' then 'phone' when 'address' then 'address' when 'industry' then 'industry' when 'website' then 'website' when 'formUrl' then 'contact_form_url' when 'status' then 'status' when 'note' then 'note' when 'isFavorite' then 'is_favorite' when 'isEndClient' then 'is_end_client' else null end;
  if col is null then raise exception 'invalid_field'; end if;
  sval:=p_payload->>field;
  if field in ('isFavorite','isEndClient') then
   execute format('update enger.companies set %I=$1 where id=$2',col) using sval::boolean,p_company;
  else
   execute format('update enger.companies set %I=$1 where id=$2',col) using sval,p_company;
  end if;
  -- Keep the verified Sales link's working contact in sync; never match by name.
  if linked is not null then
   if field='website' then
    update public.gw_sales_companies set site_url=sval,domain=regexp_replace(lower(substring(sval from '^https?://([^/:?#]+)')),'^www[.]',''),updated_at=now() where tenant_id=p_tenant and id=linked;
   elsif field='contactEmail' then
    update public.gw_sales_companies set emails=case when sval is null then array_remove(emails,emails[1]) else array_prepend(sval,array_remove(array_remove(emails,emails[1]),sval)) end,updated_at=now() where tenant_id=p_tenant and id=linked;
   else
    col:=case field when 'name' then 'name' when 'phone' then 'phone' when 'address' then 'address' when 'industry' then 'industry' when 'website' then 'site_url' when 'formUrl' then 'form_url' when 'note' then 'note' else null end;
    if col is not null then execute format('update public.gw_sales_companies set %I=$1,updated_at=now() where tenant_id=$2 and id=$3',col) using sval,p_tenant,linked; end if;
   end if;
  end if;
 elsif p_operation in ('plan','activity') then
  plan:=coalesce(p_payload->'plan','{}'::jsonb);
  if jsonb_typeof(plan)<>'object' or exists(select 1 from jsonb_object_keys(plan) k where k not in ('owner','nextDate','nextAction')) then raise exception 'invalid_plan'; end if;
  if p_operation='activity' then
   if p_payload->>'channel' not in ('phone','form','memo') or coalesce(p_payload->>'result','')='' then raise exception 'invalid_channel'; end if;
   select coalesce(needs_contact_review,false) or directory_hidden_at is not null into blocked from enger.dx2_sales_company_directory_for_tenant where tenant_id=p_tenant and id=p_company;
   if p_payload->>'channel'<>'memo' and (blocked or exists(select 1 from public.gw_sales_companies where tenant_id=p_tenant and id=linked and (hidden_at is not null or ng_reason is not null))) then raise exception 'contact_blocked'; end if;
   if p_payload->>'channel'='phone' or (p_payload->>'channel'='form' and p_payload->>'result' like 'フォーム送信完了%') then
    update enger.companies set last_contacted_at=now() where id=p_company;
   end if;
  end if;
  insert into public.gw_sales_enger_company_overrides(tenant_id,company_id,work_plan,updated_by,updated_at) values(p_tenant,p_company,plan,p_actor,now())
  on conflict(tenant_id,company_id) do update set work_plan=public.gw_sales_enger_company_overrides.work_plan||excluded.work_plan,updated_by=p_actor,updated_at=now();
  if linked is not null then
   update public.gw_sales_companies set next_action=case when plan?'nextAction' then nullif(plan->>'nextAction','') else next_action end,next_action_on=case when plan?'nextDate' then nullif(plan->>'nextDate','')::date else next_action_on end,updated_at=now() where id=linked and tenant_id=p_tenant;
  end if;
 else raise exception 'invalid_operation';
 end if;
 insert into public.gw_sales_company_activity(tenant_id,company_id,request_key,actor_id,actor_name,operation,payload) values(p_tenant,p_company,p_request,p_actor,p_actor_name,p_operation,p_payload) returning * into saved;
 return to_jsonb(saved);
end;
$$;
revoke all on function public.gw_sales_company_workbench_save(uuid,uuid,uuid,text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.gw_sales_company_workbench_save(uuid,uuid,uuid,text,text,jsonb,uuid) to service_role;
