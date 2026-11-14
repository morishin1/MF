-- Additive integration. Existing applications, offers, Office handoffs and Slack history are preserved.
begin;
create table if not exists public.gw_hr_people (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  email text not null,
  created_at timestamptz not null default now(),
  unique(tenant_id,email),
  unique(id,tenant_id),
  check(email=lower(trim(email)))
);
alter table public.gw_hr_people enable row level security;
revoke all on public.gw_hr_people from anon,authenticated;
grant select on public.gw_hr_people to authenticated;
grant all on public.gw_hr_people to service_role;
create policy gw_hr_people_read on public.gw_hr_people for select to authenticated using(public.gw_is_recruiting(tenant_id));
alter table public.gw_hr_applicants add column if not exists person_id uuid;
alter table public.gw_hr_applicants add column if not exists talent_category text check(talent_category in ('recruitment','contractor','mugendojo'));
alter table public.gw_hr_applicants add constraint gw_hr_applicant_person_fk foreign key(person_id,tenant_id) references public.gw_hr_people(id,tenant_id);
create table if not exists public.gw_hr_mail_analysis (
  mail_id uuid primary key references public.gw_hr_inbound_mail(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  classification text not null default 'unknown' check(classification in ('application','reply','schedule','registration','advertisement','system','unknown')),
  fields jsonb not null default '{}',
  reason text not null default '',
  method text not null default 'rule',
  state text not null default 'processing' check(state in ('processing','review','processed','error')),
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_yen numeric not null default 0,
  reserved_yen numeric not null default 0,
  budget_month date not null default date_trunc('month',now() at time zone 'Asia/Tokyo')::date,
  budget_settled boolean not null default false,
  auto_registered boolean not null default false,
  processed_at timestamptz,
  corrected_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index gw_hr_mail_analysis_tenant on public.gw_hr_mail_analysis(tenant_id,state);
alter table public.gw_hr_mail_analysis enable row level security;
revoke all on public.gw_hr_mail_analysis from anon,authenticated;
grant select on public.gw_hr_mail_analysis to authenticated;
grant all on public.gw_hr_mail_analysis to service_role;
create policy gw_hr_mail_analysis_read on public.gw_hr_mail_analysis for select to authenticated using(public.gw_is_recruiting(tenant_id));
create table public.gw_hr_intake_budget (
  tenant_id uuid not null references public.tenants(id),
  month date not null,
  committed_yen numeric not null default 0,
  budget_yen numeric not null default 1000 check(budget_yen between 0 and 1000),
  primary key(tenant_id,month)
);
alter table public.gw_hr_intake_budget enable row level security;
revoke all on public.gw_hr_intake_budget from anon,authenticated;
grant all on public.gw_hr_intake_budget to service_role;
create table public.gw_hr_applicant_reads (
  tenant_id uuid not null references public.tenants(id),
  applicant_id uuid not null references public.gw_hr_applicants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null,
  read_at timestamptz not null default now(),
  primary key(applicant_id,user_id)
);
alter table public.gw_hr_applicant_reads enable row level security;
revoke all on public.gw_hr_applicant_reads from anon,authenticated;
grant all on public.gw_hr_applicant_reads to service_role;
create table public.gw_hr_document_reviews (
  document_id uuid primary key references public.gw_hr_documents(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  state text not null check(state in ('confirmed','defective')),
  note text not null default '',
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now()
);
alter table public.gw_hr_document_reviews enable row level security;
revoke all on public.gw_hr_document_reviews from anon,authenticated;
grant select on public.gw_hr_document_reviews to authenticated;
grant all on public.gw_hr_document_reviews to service_role;
create policy gw_hr_document_reviews_read on public.gw_hr_document_reviews for select to authenticated using(public.gw_is_recruiting(tenant_id));
create table public.gw_hr_application_keys (
  tenant_id uuid not null references public.tenants(id),
  source_key text not null,
  application_key text not null,
  applicant_id uuid not null references public.gw_hr_applicants(id),
  primary key(tenant_id,source_key,application_key)
);
alter table public.gw_hr_application_keys enable row level security;
revoke all on public.gw_hr_application_keys from public,anon,authenticated;
grant all on public.gw_hr_application_keys to service_role;
-- All RPCs are invoker and service-only: no SECURITY DEFINER or caller-selected tenant from the browser.
create function public.gw_hr_intake_claim(p_tenant uuid,p_mail uuid,p_reserve numeric) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare inserted uuid; mon date:=date_trunc('month',now() at time zone 'Asia/Tokyo')::date; amount numeric; maximum numeric;
begin
 if not exists(select 1 from gw_hr_inbound_mail where id=p_mail and tenant_id=p_tenant and status in ('new','review')) then return jsonb_build_object('claimed',false);end if;
 if p_reserve not between 0 and 2 then raise exception 'invalid reserve';end if;
 insert into gw_hr_mail_analysis(mail_id,tenant_id,budget_month) values(p_mail,p_tenant,mon) on conflict do nothing returning mail_id into inserted;
 if inserted is null then return jsonb_build_object('claimed',false);end if;
 insert into gw_hr_intake_budget(tenant_id,month) values(p_tenant,mon) on conflict do nothing;
 select committed_yen,budget_yen into amount,maximum from gw_hr_intake_budget where tenant_id=p_tenant and month=mon for update;
 if amount+p_reserve>maximum then return jsonb_build_object('claimed',true,'budget_ok',false);end if;
 update gw_hr_intake_budget set committed_yen=committed_yen+p_reserve where tenant_id=p_tenant and month=mon;
 update gw_hr_mail_analysis set reserved_yen=p_reserve where mail_id=p_mail and tenant_id=p_tenant;
 return jsonb_build_object('claimed',true,'budget_ok',true);
end $$;
create function public.gw_hr_intake_finish(p_tenant uuid,p_mail uuid,p_actor uuid,p_auto boolean) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare m gw_hr_inbound_mail; a gw_hr_mail_analysis; candidate uuid; person uuid; matches integer; em text; nm text; job text; cat text; created boolean:=false; existing_key uuid; app_key text; src_key text;
begin
 select * into m from gw_hr_inbound_mail where id=p_mail and tenant_id=p_tenant for update;
 select * into a from gw_hr_mail_analysis where mail_id=p_mail and tenant_id=p_tenant for update;
 if m.id is null or a.mail_id is null then raise exception 'not found';end if;
 if p_actor is null and a.corrected_by is not null then p_auto:=false;end if;
 if m.applicant_id is not null or a.state='processed' then return jsonb_build_object('duplicate',true,'applicantId',m.applicant_id);end if;
 if not a.budget_settled then
  update gw_hr_intake_budget set committed_yen=greatest(0,committed_yen-a.reserved_yen+a.estimated_yen) where tenant_id=p_tenant and month=a.budget_month;
  update gw_hr_mail_analysis set budget_settled=true,reserved_yen=0 where mail_id=p_mail;
 end if;
 em:=lower(trim(coalesce(a.fields->>'email','')));nm:=trim(coalesce(a.fields->>'name',''));job:=trim(coalesce(a.fields->>'jobTitle',''));
 app_key:=nullif(trim(a.fields->>'applicationId'),'');src_key:=lower(split_part(m.sender_address,'@',2))||':'||coalesce(a.fields->>'source','');
 cat:=case when a.fields->>'service'='contractor' then 'contractor' else 'recruitment' end;
 if a.classification in ('reply','schedule') and em='' then em:=lower(coalesce(nullif(m.reply_to,''),m.sender_address));end if;
 -- Serializes check/create for the same candidate across distinct concurrent messages.
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||em,0));
 if a.classification in ('reply','schedule') and em<>'' then
  select count(*),min(id::text)::uuid into matches,candidate from gw_hr_applicants where tenant_id=p_tenant and lower(trim(email))=em;
  if matches<>1 then candidate:=null;end if;
 elsif a.classification='application' and p_auto and length(nm) between 1 and 100 and length(job) between 1 and 180
  and em ~ '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$' and coalesce(a.fields->>'service','recruitment') in ('recruitment','contractor') then
  if app_key is not null then
   perform pg_advisory_xact_lock(hashtextextended(p_tenant::text||':application:'||src_key||':'||app_key,0));
   select applicant_id into existing_key from gw_hr_application_keys where tenant_id=p_tenant and source_key=src_key and application_key=app_key;
  end if;
  if existing_key is not null then
   select count(*),min(id::text)::uuid into matches,candidate from gw_hr_applicants where tenant_id=p_tenant and id=existing_key and lower(trim(email))=em and lower(trim(job_title))=lower(job);
   if matches=0 then matches:=2;end if;
  else
   select count(*),min(id::text)::uuid into matches,candidate from gw_hr_applicants where tenant_id=p_tenant and lower(trim(email))=em and lower(trim(job_title))=lower(job);
  end if;
  if matches>1 then candidate:=null;
  elsif matches=0 then
   insert into gw_hr_people(tenant_id,name,email) values(p_tenant,nm,em) on conflict(tenant_id,email) do update set email=excluded.email returning id into person;
   insert into gw_hr_applicants(tenant_id,name,email,phone,job_title,source,stage,status,created_by,person_id,talent_category)
    values(p_tenant,nm,em,nullif(a.fields->>'phone',''),job,nullif(a.fields->>'source',''),'applied','todo',p_actor,person,cat) returning id into candidate;
   insert into gw_hr_timeline(tenant_id,applicant_id,event_key,label,detail,created_by)
    values(p_tenant,candidate,'applied','応募','採用メール受付ID: '||p_mail::text,p_actor);
   created:=true;
  end if;
  if candidate is not null and app_key is not null then
   insert into gw_hr_application_keys(tenant_id,source_key,application_key,applicant_id) values(p_tenant,src_key,app_key,candidate) on conflict do nothing;
  end if;
 end if;
 update gw_hr_inbound_mail set status=case when candidate is not null then 'linked' when a.classification in ('advertisement','system') then 'ignored' else 'review' end,
  applicant_id=candidate,source_guess=nullif(a.fields->>'source',''),candidate_name_guess=nullif(nm,''),job_title_guess=nullif(job,''),
  review_note=left(a.reason,1000),reviewed_by=p_actor,reviewed_at=now(),updated_at=now() where id=p_mail and tenant_id=p_tenant;
 update gw_hr_mail_analysis set state=case when candidate is not null or a.classification in ('advertisement','system') then 'processed' when a.state='error' then 'error' else 'review' end,
 auto_registered=created and p_actor is null,updated_at=now() where mail_id=p_mail and tenant_id=p_tenant;
 return jsonb_build_object('created',created,'applicantId',candidate,'review',candidate is null);
end $$;
revoke all on function public.gw_hr_intake_claim(uuid,uuid,numeric),public.gw_hr_intake_finish(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.gw_hr_intake_claim(uuid,uuid,numeric),public.gw_hr_intake_finish(uuid,uuid,uuid,boolean) to service_role;
create function public.gw_hr_intake_pending(p_tenant uuid) returns table(id uuid)
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 update gw_hr_mail_analysis set state='error',reason='分類処理が中断しました。自動再解析せず原文を確認してください',estimated_yen=reserved_yen,reserved_yen=0,budget_settled=true
 where tenant_id=p_tenant and state='processing' and updated_at<now()-interval '5 minutes';
 update gw_hr_inbound_mail m set status='review',updated_at=now() from gw_hr_mail_analysis a
 where m.id=a.mail_id and m.tenant_id=p_tenant and a.tenant_id=p_tenant and a.state='error' and m.status='new';
 return query select m.id from gw_hr_inbound_mail m left join gw_hr_mail_analysis a on a.mail_id=m.id
 where m.tenant_id=p_tenant and m.status='new' and a.mail_id is null order by m.received_at limit 3;
end $$;
revoke all on function public.gw_hr_intake_pending(uuid) from public,anon,authenticated;
grant execute on function public.gw_hr_intake_pending(uuid) to service_role;
notify pgrst,'reload schema';
commit;
