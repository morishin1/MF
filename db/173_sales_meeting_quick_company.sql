-- 173: Register a verified new corporate entity directly from Sales meeting launch.
-- This adds only an owner/server-callable RPC; no existing company is altered.
-- Idempotent: corporate_number (ENGER unique index) and tenant/request_key audit.
-- The HTTP API verifies government data BEFORE calling this function.
begin;

create or replace function public.gw_sales_register_meeting_company(
  p_tenant uuid,
  p_actor uuid,
  p_actor_name text,
  p_request uuid,
  p_corporate_number text,
  p_name text,
  p_address text,
  p_prefecture text,
  p_website text,
  p_industry text,
  p_source text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_company_id uuid;
  v_sales_id uuid;
  v_company_no bigint;
  v_company_name text;
  v_domain text;
  v_existing_name text;
  v_log public.gw_sales_company_activity%rowtype;
begin
  if p_tenant is null or p_actor is null or p_request is null then
    raise exception 'missing_identity_or_request' using errcode='P0001';
  end if;
  if p_corporate_number !~ '^[0-9]{13}$'
    or nullif(btrim(p_name),'') is null
    or length(p_name)>200 or length(coalesce(p_address,''))>500
    or length(coalesce(p_prefecture,''))>100
    or length(coalesce(p_industry,''))>100
    or length(coalesce(p_website,''))>500
    or p_source not in ('nta_v4','gbiz_api_v2')
  then
    raise exception 'invalid_verified_company' using errcode='P0001';
  end if;
  -- SECURITY INVOKER, callable only by service_role. Tenant and actor are
  -- additionally checked because the caller uses an admin key on the server.
  if not exists(select 1 from public.gw_employees e
    where e.user_id=p_actor and e.tenant_id=p_tenant)
    or not exists(select 1 from public.tenants t where t.id=p_tenant)
  then
    raise exception 'actor_not_in_tenant' using errcode='P0001';
  end if;

  if nullif(p_website,'') is not null then
    if p_website !~ '^https://[a-zA-Z0-9.-]+(/|$|\?)'
      or position('@' in p_website)>0 or position('#' in p_website)>0
      or position(':' in substring(p_website from 9))>0
    then
      raise exception 'invalid_website' using errcode='P0001';
    end if;
    v_domain=lower(substring(p_website from '^https://([^/?:#]+)'));
    v_domain=regexp_replace(v_domain,'^www[.]','');
    if v_domain is null or v_domain !~ '^[a-z0-9-]+([.][a-z0-9-]+)+$'
      or v_domain like '%.local' or v_domain like '%.internal'
      or v_domain ~ '^[0-9]+([.][0-9]+)+$'
    then
      raise exception 'invalid_website_domain' using errcode='P0001';
    end if;
  end if;

  -- Serialise this path by official corporate number and assigned ENGER number.
  perform pg_advisory_xact_lock(173,hashtext(p_corporate_number));
  select * into v_log from public.gw_sales_company_activity
   where tenant_id=p_tenant and request_key=p_request;
  if found then
    if v_log.actor_id is distinct from p_actor
       or v_log.payload->>'corporateNumber' is distinct from p_corporate_number
       or v_log.payload->>'createdByMeeting' is distinct from 'true'
    then
      raise exception 'request_key_conflict' using errcode='P0001';
    end if;
    return jsonb_build_object('created',true,'idempotent',true,
      'companyId',v_log.company_id,'salesCompanyId',v_log.payload->>'salesCompanyId',
      'corporateNumber',p_corporate_number,'name',p_name);
  end if;

  select id,name into v_company_id,v_existing_name
    from enger.companies where corporate_number=p_corporate_number limit 1;
  if found then
    if exists(select 1 from enger.companies where id=v_company_id and deleted_at is not null)
    then raise exception 'soft_deleted_company_review_required' using errcode='P0001'; end if;
    return jsonb_build_object('created',false,'existing',true,
      'companyId',v_company_id,'corporateNumber',p_corporate_number,
      'name',v_existing_name,'nameMismatch',v_existing_name<>p_name);
  end if;

  -- Exact same company name or site already entered with a different number:
  -- do not auto-merge or re-register.
  if exists(select 1 from enger.companies c where c.name=p_name
     and c.deleted_at is null)
  then raise exception 'possible_existing_enger_company' using errcode='P0001'; end if;
  if v_domain is not null and exists(select 1 from public.gw_sales_companies c
       where c.tenant_id=p_tenant and c.domain=v_domain)
  then raise exception 'existing_sales_domain_review_required' using errcode='P0001'; end if;

  perform pg_advisory_xact_lock(173,0);
  select coalesce(max(company_no),0)+1 into v_company_no from enger.companies;
  insert into enger.companies
    (name,company_no,corporate_number,address,prefecture,website,industry,
     status,data_source,data_fetched_at)
  values
    (btrim(p_name),v_company_no,p_corporate_number,nullif(p_address,''),
     nullif(p_prefecture,''),nullif(p_website,''),nullif(p_industry,''),
     '新規','sales_meeting_'||p_source,now())
  returning id into v_company_id;

  insert into public.gw_sales_companies
    (tenant_id,name,domain,site_url,address,region,industry,status,created_by)
  values
    (p_tenant,btrim(p_name),v_domain,nullif(p_website,''),nullif(p_address,''),
     nullif(p_prefecture,''),nullif(p_industry,''),'untouched',p_actor)
  returning id into v_sales_id;

  insert into public.gw_sales_company_links
    (tenant_id,source_system,source_company_id,company_id,method,created_by)
  values
    (p_tenant,'enger',v_company_id::text,v_sales_id,'created',p_actor);

  insert into public.gw_sales_company_activity
    (tenant_id,company_id,request_key,actor_id,actor_name,operation,payload)
  values
    (p_tenant,v_company_id,p_request,p_actor,
     left(coalesce(nullif(p_actor_name,''),'Sales'),80),
     'profile',jsonb_build_object('createdByMeeting',true,'corporateNumber',p_corporate_number,
       'salesCompanyId',v_sales_id,'officialSource',p_source,'companyNumber',v_company_no));

  return jsonb_build_object('created',true,'companyId',v_company_id,
    'salesCompanyId',v_sales_id,'corporateNumber',p_corporate_number,
    'companyNo',v_company_no,'displayId',lpad(v_company_no::text,5,'0'),
    'name',p_name);
end;
$function$;

revoke all on function public.gw_sales_register_meeting_company(
 uuid,uuid,text,uuid,text,text,text,text,text,text,text
) from PUBLIC, anon, authenticated;
grant execute on function public.gw_sales_register_meeting_company(
 uuid,uuid,text,uuid,text,text,text,text,text,text,text
) to service_role;

comment on function public.gw_sales_register_meeting_company(
 uuid,uuid,text,uuid,text,text,text,text,text,text,text
) is 'After an authenticated Sales API verifies NTA/gBiz corporate details, atomically create one ENGER company, one Sales company, their tenant-scoped link and an audit entry.';

commit;
