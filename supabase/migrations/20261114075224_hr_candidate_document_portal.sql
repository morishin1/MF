-- Review and apply explicitly. Preview shares the production database; never auto-apply.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('hr-candidate-documents','hr-candidate-documents',false,5242880,array['application/pdf']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='hr-candidate-documents' and public=false and file_size_limit=5242880 and allowed_mime_types=array['application/pdf']) then raise exception 'private_bucket_required'; end if;
end $$;
-- No browser table/storage policies. Every read goes through authenticated, scoped APIs.
create table public.gw_hr_candidate_documents (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 applicant_id uuid not null references public.gw_hr_applicants(id) on delete restrict,
 kind text not null check(kind in ('terms','offer','employment_contract','contractor_contract')),
 version integer not null check(version>0),
 filename text not null,
 path text not null unique,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes integer not null check(size_bytes between 6 and 5242880),
 status text not null default 'draft' check(status in ('draft','published','superseded','withdrawn')),
 recipient_email text,
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 published_by uuid references auth.users(id) on delete restrict,
 published_at timestamptz,
 viewed_at timestamptz,
 unique(tenant_id,applicant_id,kind,version),
 unique(tenant_id,applicant_id,id),
 check((status='draft' and published_at is null and recipient_email is null and published_by is null)
    or (status<>'draft' and published_at is not null and recipient_email is not null and published_by is not null)),
 check(recipient_email is null or recipient_email=lower(btrim(recipient_email)))
);
create unique index hr_candidate_current_document on public.gw_hr_candidate_documents(tenant_id,applicant_id,kind) where status='published';
create index hr_candidate_recipient on public.gw_hr_candidate_documents(recipient_email,published_at desc) where status='published';
create table public.gw_hr_candidate_document_events (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,applicant_id uuid not null,document_id uuid not null,
 action text not null check(action in ('attach','publish','withdraw')),actor_id uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 foreign key(tenant_id,applicant_id,document_id) references public.gw_hr_candidate_documents(tenant_id,applicant_id,id) on delete restrict
);
alter table public.gw_hr_candidate_documents enable row level security;
alter table public.gw_hr_candidate_document_events enable row level security;
revoke all on public.gw_hr_candidate_documents,public.gw_hr_candidate_document_events from public,anon,authenticated,service_role;
grant select,insert,update on public.gw_hr_candidate_documents to service_role;
grant select,insert on public.gw_hr_candidate_document_events to service_role;

create function public.hr_candidate_document_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'immutable_document'; end if;
 if not exists(select 1 from public.gw_hr_applicants a where a.id=new.applicant_id and a.tenant_id=new.tenant_id)
  or new.path not like new.tenant_id::text||'/candidates/'||new.applicant_id::text||'/sealed/%.pdf' then raise exception 'document_scope'; end if;
 if tg_op='UPDATE' and (new.id,new.tenant_id,new.applicant_id,new.kind,new.version,new.filename,new.path,new.sha256,new.size_bytes,new.created_by,new.created_at)
  is distinct from (old.id,old.tenant_id,old.applicant_id,old.kind,old.version,old.filename,old.path,old.sha256,old.size_bytes,old.created_by,old.created_at) then raise exception 'immutable_original'; end if;
 if tg_op='UPDATE' and old.published_at is not null and (new.recipient_email,new.published_at,new.published_by) is distinct from (old.recipient_email,old.published_at,old.published_by) then raise exception 'immutable_recipient'; end if;
 return new;
end $$;
create trigger hr_candidate_document_guard before insert or update or delete on public.gw_hr_candidate_documents for each row execute function public.hr_candidate_document_guard();

create function public.gw_hr_candidate_document_manage(p_tenant uuid,p_actor uuid,p_applicant uuid,p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare a public.gw_hr_applicants; d public.gw_hr_candidate_documents; n integer;
begin
 select * into a from public.gw_hr_applicants where id=p_applicant and tenant_id=p_tenant for update;
 if not found or p_actor is null then raise exception 'scope'; end if;
 if p_action<>'withdraw' and a.status in ('passed','declined','position_closed','done') then raise exception 'closed'; end if;
 if p_action='attach' then
  select coalesce(max(version),0)+1 into n from public.gw_hr_candidate_documents where tenant_id=p_tenant and applicant_id=p_applicant and kind=p_data->>'kind';
  insert into public.gw_hr_candidate_documents(tenant_id,applicant_id,kind,version,filename,path,sha256,size_bytes,created_by)
   values(p_tenant,p_applicant,p_data->>'kind',n,p_data->>'filename',p_data->>'path',p_data->>'sha256',(p_data->>'size')::int,p_actor) returning * into d;
 else
  select * into d from public.gw_hr_candidate_documents where tenant_id=p_tenant and applicant_id=p_applicant and id=(p_data->>'documentId')::uuid for update;
  if not found then raise exception 'scope'; end if;
  if p_action='publish' then
   if d.status<>'draft' or a.decision is distinct from 'hired' or d.sha256 is distinct from p_data->>'sha256'
    or nullif(lower(btrim(a.email)),'') is null or lower(btrim(a.email)) is distinct from p_data->>'recipientEmail' then raise exception 'publication_changed'; end if;
   update public.gw_hr_candidate_documents set status='superseded' where tenant_id=p_tenant and applicant_id=p_applicant and kind=d.kind and status='published';
   update public.gw_hr_candidate_documents set status='published',recipient_email=lower(btrim(a.email)),published_at=now(),published_by=p_actor where id=d.id returning * into d;
  elsif p_action='withdraw' then
   if d.status<>'published' then raise exception 'not_published'; end if;
   update public.gw_hr_candidate_documents set status='withdrawn' where id=d.id returning * into d;
  else raise exception 'invalid_action'; end if;
 end if;
 insert into public.gw_hr_candidate_document_events(tenant_id,applicant_id,document_id,action,actor_id) values(p_tenant,p_applicant,d.id,p_action,p_actor);
 return to_jsonb(d);
end $$;
revoke all on function public.hr_candidate_document_guard(),public.gw_hr_candidate_document_manage(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.hr_candidate_document_guard(),public.gw_hr_candidate_document_manage(uuid,uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
