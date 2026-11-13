-- Sales meeting step 1 detail storage and company-to-Sales multi-candidate offers.
-- Additive only: existing meeting sessions, proposal history, and company activity stay intact.
begin;

alter table public.gw_sales_live_meeting_sessions
  add column if not exists step_details jsonb not null default '{}'::jsonb;

comment on column public.gw_sales_live_meeting_sessions.step_details is
  'Structured, staff-only answers recorded in Sales meeting steps. Existing notes and checks are preserved.';

create table if not exists enger.dx2_company_job_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  company_id uuid not null,
  member_id uuid not null,
  request_id uuid not null,
  source_kind text not null check (source_kind in ('existing','new')),
  source_job_id uuid,
  private_submission_id uuid,
  job_reference uuid generated always as (coalesce(source_job_id,private_submission_id)) stored,
  job_title text not null check (char_length(btrim(job_title)) between 2 and 160),
  candidate_id uuid not null,
  candidate_initials text not null check (char_length(candidate_initials) between 1 and 20),
  message text check (message is null or char_length(message) <= 1000),
  sales_company_id uuid not null references public.gw_sales_companies(id),
  sales_proposal_id uuid not null references public.gw_sales_proposals(id),
  created_at timestamptz not null default now(),
  constraint dx2_company_job_offers_source_ref check (
    (source_kind='existing' and source_job_id is not null and private_submission_id is null) or
    (source_kind='new' and private_submission_id is not null and source_job_id is null)
  )
);
create unique index if not exists uq_dx2_company_job_offers_request_candidate
  on enger.dx2_company_job_offers(tenant_id,company_id,request_id,candidate_id);
create unique index if not exists uq_dx2_company_job_offers_target_candidate
  on enger.dx2_company_job_offers(tenant_id,company_id,job_reference,candidate_id);
create unique index if not exists uq_dx2_company_job_offers_new_title_candidate
  on enger.dx2_company_job_offers(tenant_id,company_id,lower(btrim(job_title)),candidate_id)
  where source_kind='new';
create index if not exists idx_dx2_company_job_offers_company_created
  on enger.dx2_company_job_offers(tenant_id,company_id,created_at desc);
alter table enger.dx2_company_job_offers enable row level security;
revoke all on enger.dx2_company_job_offers from public,anon,authenticated;
grant select,insert on enger.dx2_company_job_offers to service_role;

create or replace function public.gw_sales_company_job_offer_create(
  p_tenant_id uuid,
  p_company_id uuid,
  p_member_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_job_kind text,
  p_job_id uuid,
  p_submission_id uuid,
  p_job_title text,
  p_candidate_ids uuid[],
  p_message text default null
) returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_member enger.dx2_company_portal_members%rowtype;
  v_sales_company public.gw_sales_companies%rowtype;
  v_candidate enger.candidates%rowtype;
  v_linked_company uuid;
  v_link_count integer;
  v_request_count integer;
  v_prior_ids uuid[];
  v_expected_ids uuid[];
  v_offer_id uuid;
  v_proposal_id uuid;
  v_activity_request uuid;
  v_records jsonb;
  v_note text;
  v_title text;
  v_target uuid;
begin
  if p_tenant_id is null or p_company_id is null or p_member_id is null or p_actor_id is null or p_request_id is null
     or p_job_kind not in ('existing','new') or char_length(btrim(coalesce(p_job_title,''))) not between 2 and 160
     or p_candidate_ids is null or cardinality(p_candidate_ids) not between 1 and 10
     or cardinality(p_candidate_ids)<>(select count(distinct x) from unnest(p_candidate_ids) x)
     or exists(select 1 from unnest(p_candidate_ids) x where x is null)
     or char_length(coalesce(p_message,''))>1000 then
    raise exception 'invalid_company_job_offer' using errcode='22023';
  end if;
  if (p_job_kind='existing' and (p_job_id is null or p_submission_id is not null)) or
     (p_job_kind='new' and (p_submission_id is null or p_job_id is not null)) then
    raise exception 'invalid_job_reference' using errcode='22023';
  end if;

  select * into v_member from enger.dx2_company_portal_members
   where id=p_member_id and tenant_id=p_tenant_id and company_id=p_company_id
     and auth_user_id=p_actor_id and disabled_at is null;
  if not found then raise exception 'company_member_unavailable' using errcode='42501'; end if;
  if not exists(select 1 from enger.dx2_sales_company_directory_for_tenant
      where tenant_id=p_tenant_id and id=p_company_id
        and coalesce(needs_contact_review,false)=false and directory_hidden_at is null) then
    raise exception 'company_not_in_scope' using errcode='42501';
  end if;

  select count(*),(array_agg(company_id))[1] into v_link_count,v_linked_company
   from public.gw_sales_company_links
   where tenant_id=p_tenant_id and source_system='enger' and source_company_id=p_company_id::text;
  if v_link_count<>1 then raise exception 'sales_company_link_required' using errcode='23514'; end if;
  select * into v_sales_company from public.gw_sales_companies
   where id=v_linked_company and tenant_id=p_tenant_id;
  if not found then raise exception 'sales_company_missing' using errcode='23514'; end if;

  if p_job_kind='existing' then
    if not exists(select 1 from enger.jobs where id=p_job_id and is_published=true
       and coalesce(is_closed,false)=false and deleted_at is null) then
      raise exception 'job_unavailable' using errcode='23514';
    end if;
  else
    select title into v_title from enger.dx2_company_partner_submissions
     where id=p_submission_id and tenant_id=p_tenant_id and company_id=p_company_id
       and item_type='job' and status in ('pending_review','needs_changes');
    if not found or v_title is distinct from btrim(p_job_title) then
      raise exception 'private_job_unavailable' using errcode='23514';
    end if;
  end if;
  v_target:=coalesce(p_job_id,p_submission_id);

  select count(*),array_agg(candidate_id order by candidate_id)
    into v_request_count,v_prior_ids
    from enger.dx2_company_job_offers
   where tenant_id=p_tenant_id and company_id=p_company_id and request_id=p_request_id;
  select array_agg(x order by x) into v_expected_ids from unnest(p_candidate_ids) x;
  if v_request_count>0 then
    if v_request_count<>cardinality(p_candidate_ids) or v_prior_ids is distinct from v_expected_ids or
       exists(select 1 from enger.dx2_company_job_offers o where o.tenant_id=p_tenant_id
         and o.company_id=p_company_id and o.request_id=p_request_id and
         (o.job_reference<>v_target or o.job_title<>btrim(p_job_title) or o.source_kind<>p_job_kind)) then
      raise exception 'request_key_conflict' using errcode='23505';
    end if;
    select jsonb_agg(jsonb_build_object('offerId',id,'proposalId',sales_proposal_id) order by created_at)
      into v_records from enger.dx2_company_job_offers
      where tenant_id=p_tenant_id and company_id=p_company_id and request_id=p_request_id;
    return coalesce(v_records,'[]'::jsonb);
  end if;
  if exists(select 1 from enger.dx2_company_job_offers o where o.tenant_id=p_tenant_id
      and o.company_id=p_company_id and o.job_reference=v_target and o.candidate_id=any(p_candidate_ids)) then
    raise exception 'duplicate_company_job_offer' using errcode='23505';
  end if;

  v_records:='[]'::jsonb;
  foreach v_target in array p_candidate_ids loop
    select * into v_candidate from enger.candidates
     where id=v_target and deleted_at is null and coalesce(is_closed,false)=false
       and coalesce(status,'') not in ('利用停止','停止','一時停止','休止','退会','退職','辞退','NG','クローズ','closed','稼働不可','提案不可','連絡不可','連絡禁止');
    if not found then raise exception 'candidate_unavailable' using errcode='23514'; end if;
    insert into public.gw_sales_proposals(
      tenant_id,source_system,source_company_id,company_id,company_name,service,title,job_title,
      talent_initials,contact_name,contact_email,sent_at,status,created_by,updated_by
    ) values(
      p_tenant_id,'manual',p_company_id::text,v_linked_company,v_sales_company.name,'ENGER',
      left(btrim(p_job_title)||' / '||coalesce(nullif(btrim(v_candidate.initials),''),v_candidate.candidate_no::text,'人材'),200),
      btrim(p_job_title),left(coalesce(nullif(btrim(v_candidate.initials),''),v_candidate.candidate_no::text,'人材'),20),
      left(coalesce(v_member.display_name,''),100),left(coalesce(v_member.email,''),200),clock_timestamp(),'reply_wait',p_actor_id,p_actor_id
    ) returning id into v_proposal_id;
    insert into enger.dx2_company_job_offers(
      tenant_id,company_id,member_id,request_id,source_kind,source_job_id,private_submission_id,
      job_title,candidate_id,candidate_initials,message,sales_company_id,sales_proposal_id
    ) values(
      p_tenant_id,p_company_id,p_member_id,p_request_id,p_job_kind,p_job_id,p_submission_id,
      btrim(p_job_title),v_candidate.id,left(coalesce(nullif(btrim(v_candidate.initials),''),v_candidate.candidate_no::text,'人材'),20),
      nullif(btrim(p_message),''),v_linked_company,v_proposal_id
    ) returning id into v_offer_id;
    v_note:='企業マイページから案件「'||btrim(p_job_title)||'」への人材オファーを受信。識別名：'||
      left(coalesce(nullif(btrim(v_candidate.initials),''),v_candidate.candidate_no::text,'人材'),20)||
      case when coalesce(btrim(p_message),'')='' then '' else '。企業メモ：'||btrim(p_message) end;
    insert into public.gw_sales_proposal_activities(
      tenant_id,proposal_id,company_id,kind,channel,occurred_at,note,detail,source_event,created_by
    ) values(
      p_tenant_id,v_proposal_id,v_linked_company,'reply','other',clock_timestamp(),left(v_note,2000),
      jsonb_build_object('source','enger_business_portal','companyOfferId',v_offer_id),
      'enger-company-offer:'||v_offer_id::text,p_actor_id
    );
    v_records:=v_records||jsonb_build_array(jsonb_build_object('offerId',v_offer_id,'proposalId',v_proposal_id));
  end loop;

  v_activity_request:=substr(md5(p_request_id::text||':company-job-offer'),1,8)||'-'||
    substr(md5(p_request_id::text||':company-job-offer'),9,4)||'-4'||
    substr(md5(p_request_id::text||':company-job-offer'),14,3)||'-a'||
    substr(md5(p_request_id::text||':company-job-offer'),18,3)||'-'||
    substr(md5(p_request_id::text||':company-job-offer'),21,12);
  insert into public.gw_sales_company_activity(
    tenant_id,company_id,request_key,actor_id,actor_name,operation,payload
  ) values(
    p_tenant_id,p_company_id,v_activity_request,p_actor_id,coalesce(nullif(v_member.display_name,''),'企業ご担当者'),
    'activity',jsonb_build_object('channel','memo','result','情報を更新',
      'note','企業マイページから案件「'||btrim(p_job_title)||'」へ人材'||cardinality(p_candidate_ids)||'名のオファーを受信。Sales提案管理へ登録しました。',
      'body','','subject','','plan','{}'::jsonb,'source','enger_business_portal','requestId',p_request_id)
  );
  return v_records;
end;
$$;
revoke all on function public.gw_sales_company_job_offer_create(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text,uuid[],text)
 from public,anon,authenticated;
grant execute on function public.gw_sales_company_job_offer_create(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text,uuid[],text)
 to service_role;
comment on function public.gw_sales_company_job_offer_create(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text,uuid[],text) is
 'Atomically records a company portal job-to-talent offer, a Sales proposal and immutable contact activity; service role only.';

commit;

