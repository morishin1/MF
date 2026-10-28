-- REVIEW ONLY. Do not run automatically. User/operator applies after review and Preview approval.
-- Existing columns/grants/RLS unchanged; only collision-prevention triggers are added.
-- Separate private bucket: existing broad `hr` policies MUST NOT expose originals.
-- Inspect ALL storage.objects policies with check_proposal_hr_pdf_flow.sql before enabling.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('hr-pdf-flow','hr-pdf-flow',false,5242880,array['application/pdf']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='hr-pdf-flow' and public=false and file_size_limit=5242880 and allowed_mime_types=array['application/pdf']) then raise exception 'private_pdf_bucket_configuration'; end if;
end $$;
create table if not exists public.gw_hr_pdf_flows (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 applicant_id uuid not null references public.gw_hr_applicants(id) on delete restrict,
 phase text not null default 'offer_preparing' check(phase in ('offer_preparing','offer_waiting','terms_preparing','terms_waiting','onboarding','ready','joined','declined','cancelled')),
 version integer not null default 1,
 offer_doc_id uuid,
 terms_doc_id uuid,
 accepted_at timestamptz,
 ready_at timestamptz,
 joined_at timestamptz,
 join_date date,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique(tenant_id,applicant_id)
);
create table if not exists public.gw_hr_pdf_docs (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 flow_id uuid not null references public.gw_hr_pdf_flows(id) on delete restrict,
 kind text not null check(kind in ('offer','terms')),
 version integer not null check(version>0),
 path text not null unique,
 filename text not null,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes integer not null check(size_bytes between 6 and 5242880),
 response_mode text not null,
 delivery_state text not null default 'draft' check(delivery_state in ('draft','sending','sent','failed','unknown')),
 token_hash text unique,
 expires_at timestamptz,
 recipient_name text,
 recipient_email text,
 electronic_delivery jsonb,
 sent_at timestamptz,
 viewed_at timestamptz,
 responded_at timestamptz,
 response_action text,
 response_evidence jsonb,
 superseded_at timestamptz,
 revoked_at timestamptz,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 unique(flow_id,kind,version),
 check((kind='offer' and response_mode='offer_accept') or (kind='terms' and response_mode in ('receipt','contract_agree')))
);
create table if not exists public.gw_hr_pdf_deliveries (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 flow_id uuid not null references public.gw_hr_pdf_flows(id) on delete restrict,
 document_id uuid not null references public.gw_hr_pdf_docs(id) on delete restrict,
 request_key uuid not null,
 confirmation_digest text not null check(confirmation_digest ~ '^[0-9a-f]{64}$'),
 confirmation_snapshot jsonb not null,
 status text not null check(status in ('sending','sent','failed','unknown')),
 created_by uuid not null,
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 provider_message_id text,
 resolution_evidence jsonb,
 unique(tenant_id,request_key)
);
create table if not exists public.gw_hr_pdf_events (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 flow_id uuid not null references public.gw_hr_pdf_flows(id) on delete restrict,
 document_id uuid references public.gw_hr_pdf_docs(id) on delete restrict,
 action text not null,
 actor_id uuid,
 detail jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create table if not exists public.gw_hr_pdf_legacy_migrations (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 applicant_id uuid not null references public.gw_hr_applicants(id) on delete restrict,
 flow_id uuid not null unique references public.gw_hr_pdf_flows(id) on delete restrict,
 request_key uuid not null,
 confirmation_digest text not null check(confirmation_digest ~ '^[0-9a-f]{64}$'),
 reason text not null check(length(reason) between 10 and 1000),
 legacy_snapshot jsonb not null,
 actor_id uuid not null,
 created_at timestamptz not null default now(),
 unique(tenant_id,request_key)
);
alter table public.gw_hr_pdf_flows enable row level security;
alter table public.gw_hr_pdf_docs enable row level security;
alter table public.gw_hr_pdf_deliveries enable row level security;
alter table public.gw_hr_pdf_events enable row level security;
alter table public.gw_hr_pdf_legacy_migrations enable row level security;
revoke all on public.gw_hr_pdf_flows,public.gw_hr_pdf_docs,public.gw_hr_pdf_deliveries,public.gw_hr_pdf_events,public.gw_hr_pdf_legacy_migrations from public,anon,authenticated,service_role;
grant select,insert,update on public.gw_hr_pdf_flows,public.gw_hr_pdf_docs,public.gw_hr_pdf_deliveries to service_role;
grant select,insert on public.gw_hr_pdf_events,public.gw_hr_pdf_legacy_migrations to service_role;

-- Defend tenant/flow/document correlation even against an accidental service insert.
create or replace function public.hr_pdf_scope() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='gw_hr_pdf_flows' then
  if not exists(select 1 from public.gw_hr_applicants where id=new.applicant_id and tenant_id=new.tenant_id) then raise exception 'pdf_scope'; end if;
 else
  if not exists(select 1 from public.gw_hr_pdf_flows where id=new.flow_id and tenant_id=new.tenant_id) then raise exception 'pdf_scope'; end if;
  if tg_table_name in ('gw_hr_pdf_deliveries','gw_hr_pdf_events') then
   if new.document_id is not null and not exists(select 1 from public.gw_hr_pdf_docs where id=new.document_id and flow_id=new.flow_id and tenant_id=new.tenant_id) then raise exception 'pdf_scope'; end if;
  elsif tg_table_name='gw_hr_pdf_legacy_migrations' then
   if not exists(select 1 from public.gw_hr_pdf_flows where id=new.flow_id and tenant_id=new.tenant_id and applicant_id=new.applicant_id) then raise exception 'pdf_scope'; end if;
  end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin foreach t in array array['gw_hr_pdf_flows','gw_hr_pdf_docs','gw_hr_pdf_deliveries','gw_hr_pdf_events','gw_hr_pdf_legacy_migrations'] loop
 execute format('drop trigger if exists hr_pdf_scope on public.%I',t);
 execute format('create trigger hr_pdf_scope before insert on public.%I for each row execute function public.hr_pdf_scope()',t);
end loop; end $$;

create or replace function public.hr_pdf_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or tg_table_name in ('gw_hr_pdf_events','gw_hr_pdf_legacy_migrations') then raise exception 'immutable_pdf_evidence'; end if;
 if tg_table_name='gw_hr_pdf_docs' then
  if (to_jsonb(new)-array['delivery_state','token_hash','expires_at','recipient_name','recipient_email','electronic_delivery','sent_at','viewed_at','responded_at','response_action','response_evidence','superseded_at','revoked_at']) is distinct from (to_jsonb(old)-array['delivery_state','token_hash','expires_at','recipient_name','recipient_email','electronic_delivery','sent_at','viewed_at','responded_at','response_action','response_evidence','superseded_at','revoked_at']) then raise exception 'immutable_pdf_bytes'; end if;
  if old.responded_at is not null and (new.responded_at,new.response_action,new.response_evidence,new.recipient_name,new.recipient_email) is distinct from (old.responded_at,old.response_action,old.response_evidence,old.recipient_name,old.recipient_email) then raise exception 'immutable_pdf_response'; end if;
  if (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) or (old.sent_at is not null and new.sent_at is distinct from old.sent_at) or (old.viewed_at is not null and new.viewed_at is distinct from old.viewed_at) then raise exception 'immutable_pdf_timestamp'; end if;
 elsif tg_table_name='gw_hr_pdf_deliveries' then
  if (to_jsonb(new)-array['status','finished_at','provider_message_id','resolution_evidence']) is distinct from (to_jsonb(old)-array['status','finished_at','provider_message_id','resolution_evidence']) then raise exception 'immutable_delivery_snapshot'; end if;
  if old.status in ('sent','failed') and new is distinct from old then raise exception 'resolved_delivery'; end if;
 elsif tg_table_name='gw_hr_pdf_flows' then
  if (new.id,new.tenant_id,new.applicant_id,new.created_by,new.created_at) is distinct from (old.id,old.tenant_id,old.applicant_id,old.created_by,old.created_at) or (old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at) or (old.joined_at is not null and (new.joined_at,new.join_date) is distinct from (old.joined_at,old.join_date)) then raise exception 'immutable_flow_identity'; end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin foreach t in array array['gw_hr_pdf_flows','gw_hr_pdf_docs','gw_hr_pdf_deliveries','gw_hr_pdf_events','gw_hr_pdf_legacy_migrations'] loop
 execute format('drop trigger if exists hr_pdf_immutable on public.%I',t);
 execute format('create trigger hr_pdf_immutable before update or delete on public.%I for each row execute function public.hr_pdf_immutable()',t);
end loop; end $$;

create or replace function public.hr_pdf_eligible(a jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(a->>'lead_category'='recruitment' and a->>'offer_type' in ('executive_employee','part_time') and coalesce(a->>'employment_type','') !~* '業務委託|委託|副業|フリーランス|スポット|freelance|contractor' and a->>'stage'='offer' and a->>'decision'='hired' and a->>'employee_id' is null and a->>'advance_claimed_at' is null and coalesce(a->>'status','') not in ('accepted','done','declined','passed','position_closed'),false)
$$;

-- Normal start never migrates. Reviewed migration below only revokes pending links.
create or replace function public.gw_hr_pdf_manage(p_tenant uuid,p_actor uuid,p_applicant uuid,p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.gw_hr_applicants; f public.gw_hr_pdf_flows; d public.gw_hr_pdf_docs; s public.gw_hr_pdf_deliveries; c jsonb; nid uuid; n integer; ts timestamptz:=now();
begin
 select * into a from public.gw_hr_applicants where id=p_applicant and tenant_id=p_tenant for update;
 if not found or p_actor is null then raise exception 'scope'; end if;
 select * into f from public.gw_hr_pdf_flows where tenant_id=p_tenant and applicant_id=p_applicant for update;
 if p_action='start' then
  if f.id is not null then return to_jsonb(f); end if;
  if not public.hr_pdf_eligible(to_jsonb(a)) or exists(select 1 from public.gw_hr_offers where tenant_id=p_tenant and applicant_id=p_applicant) then raise exception 'not_eligible'; end if;
  insert into public.gw_hr_pdf_flows(tenant_id,applicant_id,created_by) values(p_tenant,p_applicant,p_actor) returning * into f;
 elsif f.id is null then raise exception 'missing_flow';
 elsif p_action in ('finishSend','resolveDelivery') then
  select * into s from public.gw_hr_pdf_deliveries where id=(p_data->>'deliveryId')::uuid and tenant_id=p_tenant and flow_id=f.id for update;
  if not found then raise exception 'scope'; end if;
  if s.status in ('sent','failed') then return jsonb_build_object('id',s.id,'status',s.status,'replayed',true); end if;
  if p_action='finishSend' and s.status<>'sending' then raise exception 'already_resolving'; end if;
  if p_action='resolveDelivery' and (p_data->>'status' not in ('sent','failed') or length(coalesce(p_data->>'evidence','')) not between 10 and 1000 or (s.status='sending' and s.created_at>ts-interval '5 minutes')) then raise exception 'resolution_required'; end if;
  if p_data->>'status' not in ('sent','failed','unknown') then raise exception 'invalid_status'; end if;
  select * into d from public.gw_hr_pdf_docs where id=s.document_id and flow_id=f.id and tenant_id=p_tenant for update;
  if d.id is null or d.id is distinct from (case when d.kind='offer' then f.offer_doc_id else f.terms_doc_id end) or d.superseded_at is not null or d.revoked_at is not null then raise exception 'stale_delivery'; end if;
  update public.gw_hr_pdf_deliveries set status=p_data->>'status',finished_at=ts,provider_message_id=p_data->>'providerMessageId',resolution_evidence=case when p_action='resolveDelivery' then jsonb_build_object('actor',p_actor,'at',ts,'evidence',p_data->>'evidence') else null end where id=s.id;
  update public.gw_hr_pdf_docs set delivery_state=p_data->>'status',sent_at=case when p_data->>'status'='sent' then coalesce(sent_at,ts) else sent_at end,token_hash=case when p_data->>'status'='failed' then null else token_hash end where id=d.id;
  if p_data->>'status'='sent' then update public.gw_hr_pdf_flows set phase=case when d.kind='offer' then 'offer_waiting' else 'terms_waiting' end,version=version+1 where id=f.id; end if;
 elsif p_action='claimSend' then
  c=p_data->'confirmation';
  select * into s from public.gw_hr_pdf_deliveries where tenant_id=p_tenant and request_key=(p_data->>'requestKey')::uuid for update;
  if found then
   if s.flow_id<>f.id or s.document_id<>(p_data->>'documentId')::uuid or s.confirmation_digest is distinct from c->>'digest' then raise exception 'request_key_conflict'; end if;
   return jsonb_build_object('id',s.id,'status',s.status,'replayed',true);
  end if;
  select * into d from public.gw_hr_pdf_docs where id=(p_data->>'documentId')::uuid and tenant_id=p_tenant and flow_id=f.id for update;
  if d.id is null or d.id is distinct from (case when d.kind='offer' then f.offer_doc_id else f.terms_doc_id end) or d.revoked_at is not null or d.superseded_at is not null or d.responded_at is not null or d.delivery_state in ('sending','unknown') or f.phase in ('ready','joined','declined','cancelled') then raise exception 'stale_document'; end if;
  if (c->>'flowVersion')::int is distinct from f.version or c->>'to' is distinct from a.email or c->>'recipientName' is distinct from a.name or c->>'sha256' is distinct from d.sha256 or (c->>'documentId')::uuid is distinct from d.id or (c->>'version')::int is distinct from d.version or c->>'responseMode' is distinct from d.response_mode then raise exception 'confirmation_changed'; end if;
  if c->'electronicDelivery'->>'requested' is distinct from 'true' or length(coalesce(c->'electronicDelivery'->>'evidence','')) not between 5 and 1000 or (c->'electronicDelivery'->>'requestedAt')::timestamptz is null or (c->'electronicDelivery'->>'requestedAt')::timestamptz>ts or (c->>'expiresAt')::timestamptz is null or (c->>'expiresAt')::timestamptz<=ts or (c->>'expiresAt')::timestamptz>ts+interval '90 days' or coalesce(p_data->>'tokenHash','') !~ '^[0-9a-f]{64}$' then raise exception 'delivery_consent_required'; end if;
  insert into public.gw_hr_pdf_deliveries(tenant_id,flow_id,document_id,request_key,confirmation_digest,confirmation_snapshot,status,created_by) values(p_tenant,f.id,d.id,(p_data->>'requestKey')::uuid,c->>'digest',c,'sending',p_actor) returning * into s;
  update public.gw_hr_pdf_docs set delivery_state='sending',token_hash=p_data->>'tokenHash',expires_at=(c->>'expiresAt')::timestamptz,recipient_name=a.name,recipient_email=a.email,electronic_delivery=c->'electronicDelivery' where id=d.id;
  insert into public.gw_hr_pdf_events(tenant_id,flow_id,document_id,action,actor_id,detail) values(p_tenant,f.id,d.id,p_action,p_actor,jsonb_build_object('deliveryId',s.id));
  return jsonb_build_object('id',s.id,'status','sending','replayed',false);
 else
  if (p_data->>'expectedVersion')::int is distinct from f.version or f.phase in ('joined','declined','cancelled') then raise exception 'stale_flow'; end if;
  if exists(select 1 from public.gw_hr_pdf_docs where flow_id=f.id and delivery_state in ('sending','unknown') and superseded_at is null and revoked_at is null) then raise exception 'unresolved_delivery'; end if;
  if p_action='attach' then
   if p_data->>'kind' not in ('offer','terms') or (p_data->>'kind'='offer' and f.accepted_at is not null) or (p_data->>'kind'='terms' and f.accepted_at is null) or f.phase='ready' or p_data->>'path' not like p_tenant::text||'/pdf-flow/'||p_applicant::text||'/sealed/%.pdf' then raise exception 'invalid_attachment'; end if;
   select coalesce(max(version),0)+1 into n from public.gw_hr_pdf_docs where flow_id=f.id and kind=p_data->>'kind';
   update public.gw_hr_pdf_docs set superseded_at=ts,token_hash=null where id=(case when p_data->>'kind'='offer' then f.offer_doc_id else f.terms_doc_id end);
   insert into public.gw_hr_pdf_docs(tenant_id,flow_id,kind,version,path,filename,sha256,size_bytes,response_mode,created_by) values(p_tenant,f.id,p_data->>'kind',n,p_data->>'path',p_data->>'filename',p_data->>'sha256',(p_data->>'size')::int,p_data->>'responseMode',p_actor) returning id into nid;
   update public.gw_hr_pdf_flows set offer_doc_id=case when p_data->>'kind'='offer' then nid else offer_doc_id end,terms_doc_id=case when p_data->>'kind'='terms' then nid else terms_doc_id end,phase=case when p_data->>'kind'='offer' then 'offer_preparing' else 'terms_preparing' end,version=version+1 where id=f.id;
  elsif p_action='revoke' then
   if length(coalesce(p_data->>'reason','')) not between 5 and 1000 then raise exception 'reason_required'; end if;
   if (p_data->>'documentId')::uuid is distinct from (case when f.accepted_at is null then f.offer_doc_id else f.terms_doc_id end) then raise exception 'stale_document'; end if;
   select * into d from public.gw_hr_pdf_docs where id=(p_data->>'documentId')::uuid and flow_id=f.id and tenant_id=p_tenant for update;
   if d.id is null or d.responded_at is not null or d.revoked_at is not null or d.superseded_at is not null then raise exception 'stale_document'; end if;
   -- Cancel this unanswered invitation only, never the hiring decision or accepted offer.
   update public.gw_hr_pdf_docs set revoked_at=ts,token_hash=null where id=d.id;
   update public.gw_hr_pdf_flows set phase=case when d.kind='offer' then 'offer_preparing' else 'terms_preparing' end,version=version+1 where id=f.id;
  elsif p_action='markReady' then
   if f.phase<>'onboarding' or p_data->'checks'->>'proceduresComplete' is distinct from 'true' or p_data->'checks'->>'documentsConfirmed' is distinct from 'true' then raise exception 'checks_required'; end if;
   update public.gw_hr_pdf_flows set phase='ready',ready_at=ts,version=version+1 where id=f.id;
  elsif p_action='markJoined' then
   if f.phase<>'ready' or p_data->'checks'->>'startConfirmed' is distinct from 'true' or (p_data->>'joinDate')::date is null or (p_data->>'joinDate')::date>(now() at time zone 'Asia/Tokyo')::date then raise exception 'join_checks_required'; end if;
   update public.gw_hr_pdf_flows set phase='joined',joined_at=ts,join_date=(p_data->>'joinDate')::date,version=version+1 where id=f.id;
  else raise exception 'invalid_action'; end if;
 end if;
 insert into public.gw_hr_pdf_events(tenant_id,flow_id,action,actor_id,detail) values(p_tenant,f.id,p_action,p_actor,p_data-array['tokenHash']);
 select * into f from public.gw_hr_pdf_flows where id=f.id;
 return to_jsonb(f);
end $$;

create or replace function public.gw_hr_pdf_respond(p_token text,p_action text,p_document uuid,p_sha256 text,p_evidence jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare f public.gw_hr_pdf_flows; d public.gw_hr_pdf_docs; fid uuid; result text; ts timestamptz:=now();
begin
 select flow_id into fid from public.gw_hr_pdf_docs where token_hash=p_token;
 select * into f from public.gw_hr_pdf_flows where id=fid for update;
 select * into d from public.gw_hr_pdf_docs where token_hash=p_token and flow_id=f.id and tenant_id=f.tenant_id for update;
 if d.id is null or d.id is distinct from p_document or d.sha256 is distinct from p_sha256 or d.id is distinct from (case when d.kind='offer' then f.offer_doc_id else f.terms_doc_id end) or d.revoked_at is not null or d.superseded_at is not null or d.delivery_state<>'sent' or f.phase='cancelled' then raise exception 'invalid_link'; end if;
 if p_action='view' then
  update public.gw_hr_pdf_docs set viewed_at=coalesce(viewed_at,ts) where id=d.id;
  return jsonb_build_object('viewed',true);
 end if;
 result=case when p_action='accept' and d.kind='offer' then 'offer_accept' when p_action='confirm' and d.kind='terms' then d.response_mode when p_action='decline' and d.kind='offer' then 'decline' else null end;
 if result is null then raise exception 'invalid_action'; end if;
 if d.responded_at is not null then
  if d.response_action is distinct from result then raise exception 'already_responded'; end if;
  return jsonb_build_object('response',result,'replayed',true);
 end if;
 if d.expires_at is null or d.expires_at<=ts or f.phase in ('joined','declined') or (d.kind='offer' and (f.accepted_at is not null or f.phase<>'offer_waiting')) or (d.kind='terms' and f.phase<>'terms_waiting') then raise exception 'response_expired'; end if;
 update public.gw_hr_pdf_docs set responded_at=ts,response_action=result,response_evidence=p_evidence where id=d.id;
 update public.gw_hr_pdf_flows set phase=case when result='decline' then 'declined' when result='offer_accept' then 'terms_preparing' else 'onboarding' end,accepted_at=case when result='offer_accept' then ts else accepted_at end,version=version+1 where id=f.id;
 insert into public.gw_hr_pdf_events(tenant_id,flow_id,document_id,action,detail) values(f.tenant_id,f.id,d.id,result,p_evidence);
 return jsonb_build_object('response',result,'replayed',false);
end $$;

-- VOLATILE is intentional: re-read a fresh statement snapshot after waiting for locks.
create or replace function public.gw_hr_pdf_legacy_snapshot(p_tenant uuid,p_applicant uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare r jsonb; begin
 select jsonb_build_object('applicant',(select to_jsonb(a) from public.gw_hr_applicants a where a.tenant_id=p_tenant and a.id=p_applicant),'offers',coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from public.gw_hr_offers o where o.tenant_id=p_tenant and o.applicant_id=p_applicant),'[]'::jsonb),'mail',coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from public.gw_hr_mail_sends m where m.tenant_id=p_tenant and m.applicant_id=p_applicant),'[]'::jsonb),'flow',(select to_jsonb(f) from public.gw_hr_pdf_flows f where f.tenant_id=p_tenant and f.applicant_id=p_applicant)) into r;
 return r;
end $$;
create or replace function public.hr_pdf_legacy_blockers(s jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare b jsonb:='[]'; o jsonb; k text; begin
 if not public.hr_pdf_eligible(s->'applicant') then b=b||jsonb_build_array('採用判断・雇用区分・既存社員状態が対象外です。'); end if;
 if s->'flow' is distinct from 'null'::jsonb then b=b||jsonb_build_array('既に新PDF方式へ移行しています。'); end if;
 if jsonb_array_length(coalesce(s->'offers','[]'))=0 then b=b||jsonb_build_array('旧案内がありません。'); end if;
 for o in select value from jsonb_array_elements(coalesce(s->'offers','[]')) loop
  if not(o ?& array['offer_type','accepted_at','declined_at','accepted_pdf_path','handoff_at','formal_signed_at','formal_sent_at','legalsign_url','formal_contract_ref','formal_evidence','legalsign_doc_id','legalsign_doc_sha256','formal_doc_sha256']) then b=b||jsonb_build_array('契約確認に必要なDB列が不足しています。'); end if;
  foreach k in array array['accepted_at','declined_at','accepted_pdf_path','handoff_at','formal_signed_at','formal_sent_at','legalsign_url','formal_contract_ref','formal_evidence','legalsign_doc_id','legalsign_doc_sha256','formal_doc_sha256'] loop
   if o->k is not null and o->k<>'null'::jsonb and o->k<>'""'::jsonb then b=b||jsonb_build_array('旧案内に本人回答・引継ぎ・外部契約の証跡があります。'); exit; end if;
  end loop;
  if o->>'offer_type' is not null and o->>'offer_type' not in ('executive_employee','part_time') then b=b||jsonb_build_array('旧案内の採用区分が移行対象外です。'); end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'mail','[]')) m where coalesce(m->>'status','unknown') in ('sending','unknown')) then b=b||jsonb_build_array('旧メールの送信結果が未確定です。'); end if;
 return b;
end $$;
create or replace function public.gw_hr_pdf_preview_legacy_migration(p_tenant uuid,p_applicant uuid) returns jsonb
language plpgsql volatile security invoker set search_path='' as $$
declare s jsonb; b jsonb; begin
 s=public.gw_hr_pdf_legacy_snapshot(p_tenant,p_applicant); b=public.hr_pdf_legacy_blockers(s);
 return jsonb_build_object('snapshot',s,'blockers',b,'eligible',jsonb_array_length(b)=0);
end $$;
create or replace function public.gw_hr_pdf_migrate_unaccepted_legacy(p_tenant uuid,p_actor uuid,p_applicant uuid,p_request_key uuid,p_digest text,p_reason text,p_expected jsonb,p_confirmed boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s jsonb; f public.gw_hr_pdf_flows; m public.gw_hr_pdf_legacy_migrations; begin
 if p_actor is null or p_request_key is null or p_confirmed is distinct from true or length(coalesce(p_reason,'')) not between 10 and 1000 or coalesce(p_digest,'') !~ '^[0-9a-f]{64}$' then raise exception 'confirmation_required'; end if;
 select * into m from public.gw_hr_pdf_legacy_migrations where tenant_id=p_tenant and request_key=p_request_key;
 if found then
  if (m.applicant_id,m.actor_id,m.reason,m.confirmation_digest) is distinct from (p_applicant,p_actor,p_reason,p_digest) then raise exception 'request_key_conflict'; end if;
  return jsonb_build_object('id',m.flow_id,'replayed',true);
 end if;
 -- Match old offer UPDATE's implicit row lock BEFORE its applicant-lock trigger.
 perform 1 from public.gw_hr_offers where tenant_id=p_tenant and applicant_id=p_applicant order by id for update;
 perform 1 from public.gw_hr_mail_sends where tenant_id=p_tenant and applicant_id=p_applicant order by id for update;
 perform 1 from public.gw_hr_applicants where tenant_id=p_tenant and id=p_applicant for update;
 if not found then raise exception 'scope'; end if;
 select * into m from public.gw_hr_pdf_legacy_migrations where tenant_id=p_tenant and request_key=p_request_key;
 if found then
  if (m.applicant_id,m.actor_id,m.reason,m.confirmation_digest) is distinct from (p_applicant,p_actor,p_reason,p_digest) then raise exception 'request_key_conflict'; end if;
  return jsonb_build_object('id',m.flow_id,'replayed',true);
 end if;
 s=public.gw_hr_pdf_legacy_snapshot(p_tenant,p_applicant);
 if s is distinct from p_expected or jsonb_array_length(public.hr_pdf_legacy_blockers(s))<>0 then raise exception 'migration_changed'; end if;
 -- Legacy token_hash is NOT NULL. Keep it and the PDFs/history; revoked_at invalidates links.
 -- Revoke before inserting new flow so the strict collision trigger allows this transaction.
 update public.gw_hr_offers set revoked_at=coalesce(revoked_at,now()) where tenant_id=p_tenant and applicant_id=p_applicant;
 insert into public.gw_hr_pdf_flows(tenant_id,applicant_id,created_by) values(p_tenant,p_applicant,p_actor) returning * into f;
 insert into public.gw_hr_pdf_legacy_migrations(tenant_id,applicant_id,flow_id,request_key,confirmation_digest,reason,legacy_snapshot,actor_id) values(p_tenant,p_applicant,f.id,p_request_key,p_digest,p_reason,s,p_actor);
 insert into public.gw_hr_pdf_events(tenant_id,flow_id,action,actor_id,detail) values(p_tenant,f.id,'legacy_migration',p_actor,jsonb_build_object('reason',p_reason,'requestKey',p_request_key));
 return jsonb_build_object('id',f.id,'replayed',false);
end $$;

-- Browser legacy writes and service paths share applicant locking; internal notes remain editable.
create or replace function public.hr_pdf_legacy_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare aid uuid; tid uuid; begin
 if tg_table_name='gw_hr_applicants' then
  aid=old.id;tid=old.tenant_id;
  if tg_op='UPDATE' and (to_jsonb(new)-array['note','updated_at','recruiter_id']) is not distinct from (to_jsonb(old)-array['note','updated_at','recruiter_id']) then return new; end if;
 else
  if tg_op='INSERT' then aid=new.applicant_id;tid=new.tenant_id; else aid=old.applicant_id;tid=old.tenant_id; end if;
  perform 1 from public.gw_hr_applicants where id=aid and tenant_id=tid for update;
 end if;
 if exists(select 1 from public.gw_hr_pdf_flows where applicant_id=aid and tenant_id=tid) then raise exception using errcode='PT409',message='pdf_flow_owned'; end if;
 if tg_op='UPDATE' and tg_table_name='gw_hr_offers' then
  if (new.applicant_id,new.tenant_id) is distinct from (old.applicant_id,old.tenant_id) then
   perform 1 from public.gw_hr_applicants where id=new.applicant_id and tenant_id=new.tenant_id for update;
   if exists(select 1 from public.gw_hr_pdf_flows where applicant_id=new.applicant_id and tenant_id=new.tenant_id) then raise exception using errcode='PT409',message='pdf_flow_owned'; end if;
  end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
drop trigger if exists hr_pdf_legacy_guard on public.gw_hr_applicants;
create trigger hr_pdf_legacy_guard before update or delete on public.gw_hr_applicants for each row execute function public.hr_pdf_legacy_guard();
drop trigger if exists hr_pdf_legacy_guard on public.gw_hr_offers;
create trigger hr_pdf_legacy_guard before insert or update or delete on public.gw_hr_offers for each row execute function public.hr_pdf_legacy_guard();
-- Mail table has no offer_id: all old recruiting claims are blocked after adoption.
drop trigger if exists hr_pdf_legacy_mail_claim_guard on public.gw_hr_mail_sends;
create trigger hr_pdf_legacy_mail_claim_guard before insert on public.gw_hr_mail_sends for each row execute function public.hr_pdf_legacy_guard();

revoke all on function public.hr_pdf_scope(),public.hr_pdf_immutable(),public.hr_pdf_eligible(jsonb),public.hr_pdf_legacy_guard(),public.hr_pdf_legacy_blockers(jsonb),public.gw_hr_pdf_manage(uuid,uuid,uuid,text,jsonb),public.gw_hr_pdf_respond(text,text,uuid,text,jsonb),public.gw_hr_pdf_legacy_snapshot(uuid,uuid),public.gw_hr_pdf_preview_legacy_migration(uuid,uuid),public.gw_hr_pdf_migrate_unaccepted_legacy(uuid,uuid,uuid,uuid,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.hr_pdf_eligible(jsonb),public.hr_pdf_legacy_blockers(jsonb),public.gw_hr_pdf_manage(uuid,uuid,uuid,text,jsonb),public.gw_hr_pdf_respond(text,text,uuid,text,jsonb),public.gw_hr_pdf_legacy_snapshot(uuid,uuid),public.gw_hr_pdf_preview_legacy_migration(uuid,uuid),public.gw_hr_pdf_migrate_unaccepted_legacy(uuid,uuid,uuid,uuid,text,text,jsonb,boolean) to service_role;
commit;
