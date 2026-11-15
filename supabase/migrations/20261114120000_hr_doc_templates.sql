-- Word雛形から発行する書類（雇用契約書など）の雛形と発行物。
-- Review and apply explicitly. Preview shares the production database; never auto-apply.
--
-- ■ 決まり
--   ・雛形は版ごとに不変。差し替えは「新しい版を足す」。古い版は archived にするだけで、消さない・書き換えない
--   ・発行物は、使った雛形の版と sha256、差し込んだ値を自分で持つ。後で雛形を変えても、発行済みの書類は変わらない
--   ・発行（作成）と確定は別。本人への送信・合意・Office引継ぎは、ここでは扱わない（既存の手続きで、別の明示操作）
--   ・ブラウザから直接は読めない・書けない。必ず、権限を確かめる API（service_role）経由
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('hr-doc-templates','hr-doc-templates',false,5242880,
  array['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/pdf']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='hr-doc-templates' and public=false) then raise exception 'private_bucket_required'; end if;
end $$;

create table public.gw_hr_doc_templates (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 kind text not null check(kind in ('employment_contract','labor_notice','offer_letter','contractor_contract')),
 category text not null check(category in ('fixed_term_trial','executive_employee','trial_2weeks','part_time','contractor','spot')),
 version integer not null check(version>0),
 name text not null check(length(btrim(name)) between 1 and 120),
 filename text not null,
 path text not null unique,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes integer not null check(size_bytes between 100 and 5242880),
 placeholders jsonb not null check(jsonb_typeof(placeholders)='array' and jsonb_array_length(placeholders)>0),
 status text not null default 'active' check(status in ('active','archived')),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 archived_at timestamptz,
 unique(tenant_id,kind,category,version),
 unique(tenant_id,id),
 check((status='active' and archived_at is null) or (status='archived' and archived_at is not null))
);
-- 雇用形態ごと・書類ごとに、いま使う雛形は1つだけ
create unique index hr_doc_template_current on public.gw_hr_doc_templates(tenant_id,kind,category) where status='active';

create table public.gw_hr_doc_issues (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 applicant_id uuid not null references public.gw_hr_applicants(id) on delete restrict,
 offer_id uuid not null,
 kind text not null check(kind in ('employment_contract','labor_notice','offer_letter','contractor_contract')),
 version integer not null check(version>0),
 template_id uuid not null,
 template_version integer not null check(template_version>0),
 template_sha256 text not null check(template_sha256 ~ '^[0-9a-f]{64}$'),
 field_values jsonb not null check(jsonb_typeof(field_values)='object'),
 docx_path text not null unique,
 docx_sha256 text not null check(docx_sha256 ~ '^[0-9a-f]{64}$'),
 pdf_path text unique,
 pdf_sha256 text check(pdf_sha256 ~ '^[0-9a-f]{64}$'),
 pdf_engine text,
 status text not null default 'draft' check(status in ('draft','confirmed','superseded','void')),
 created_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 confirmed_by uuid references auth.users(id) on delete restrict,
 confirmed_at timestamptz,
 unique(tenant_id,applicant_id,kind,version),
 foreign key(tenant_id,template_id) references public.gw_hr_doc_templates(tenant_id,id) on delete restrict,
 check((pdf_path is null)=(pdf_sha256 is null) and (pdf_path is null)=(pdf_engine is null)),
 check((status in ('draft','void') and confirmed_at is null and confirmed_by is null) or status='superseded'
    or (status='confirmed' and confirmed_at is not null and confirmed_by is not null and pdf_path is not null))
);
-- 応募者ごと・書類ごとに、確定した版は1つだけ
create unique index hr_doc_issue_confirmed on public.gw_hr_doc_issues(tenant_id,applicant_id,kind) where status='confirmed';
create index hr_doc_issue_applicant on public.gw_hr_doc_issues(tenant_id,applicant_id,created_at desc);

alter table public.gw_hr_doc_templates enable row level security;
alter table public.gw_hr_doc_issues enable row level security;
revoke all on public.gw_hr_doc_templates,public.gw_hr_doc_issues from public,anon,authenticated,service_role;
grant select,insert,update on public.gw_hr_doc_templates,public.gw_hr_doc_issues to service_role;

create function public.hr_doc_template_guard() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'immutable_template'; end if;
 if new.path not like new.tenant_id::text||'/templates/'||new.kind||'/%.docx' then raise exception 'template_scope'; end if;
 if tg_op='UPDATE' then
  if (new.id,new.tenant_id,new.kind,new.category,new.version,new.name,new.filename,new.path,new.sha256,new.size_bytes,new.placeholders,new.created_by,new.created_at)
   is distinct from (old.id,old.tenant_id,old.kind,old.category,old.version,old.name,old.filename,old.path,old.sha256,old.size_bytes,old.placeholders,old.created_by,old.created_at) then raise exception 'immutable_template'; end if;
  if old.status='archived' and new.status<>'archived' then raise exception 'template_archived'; end if;
 end if;
 return new;
end $$;
create trigger hr_doc_template_guard before insert or update or delete on public.gw_hr_doc_templates for each row execute function public.hr_doc_template_guard();

create function public.hr_doc_issue_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare t public.gw_hr_doc_templates;
begin
 if tg_op='DELETE' then raise exception 'immutable_issue'; end if;
 if tg_op='INSERT' then
  if not exists(select 1 from public.gw_hr_applicants a where a.id=new.applicant_id and a.tenant_id=new.tenant_id) then raise exception 'issue_scope'; end if;
  select * into t from public.gw_hr_doc_templates where id=new.template_id and tenant_id=new.tenant_id;
  -- 発行は、いま使う雛形（active）の、その版・その中身からだけ。書類の種類も一致させる
  if t.id is null or t.status<>'active' or t.kind<>new.kind or t.version<>new.template_version or t.sha256<>new.template_sha256 then raise exception 'issue_template_mismatch'; end if;
  if new.status<>'draft' then raise exception 'issue_must_start_draft'; end if;
 end if;
 if new.docx_path not like new.tenant_id::text||'/issues/'||new.applicant_id::text||'/%.docx'
  or (new.pdf_path is not null and new.pdf_path not like new.tenant_id::text||'/issues/'||new.applicant_id::text||'/%.pdf') then raise exception 'issue_scope'; end if;
 if tg_op='UPDATE' then
  if (new.id,new.tenant_id,new.applicant_id,new.offer_id,new.kind,new.version,new.template_id,new.template_version,new.template_sha256,new.field_values,new.docx_path,new.docx_sha256,new.created_by,new.created_at)
   is distinct from (old.id,old.tenant_id,old.applicant_id,old.offer_id,old.kind,old.version,old.template_id,old.template_version,old.template_sha256,old.field_values,old.docx_path,old.docx_sha256,old.created_by,old.created_at) then raise exception 'immutable_issue'; end if;
  -- PDF は1度だけ付けられる（付けたあとは変えられない）
  if old.pdf_path is not null and (new.pdf_path,new.pdf_sha256,new.pdf_engine) is distinct from (old.pdf_path,old.pdf_sha256,old.pdf_engine) then raise exception 'immutable_issue'; end if;
  -- 進められる向きだけ：draft → confirmed / void、confirmed → superseded
  if old.status<>new.status and not ((old.status='draft' and new.status in ('confirmed','void')) or (old.status='confirmed' and new.status='superseded')) then raise exception 'issue_transition'; end if;
  if old.confirmed_at is not null and (new.confirmed_at,new.confirmed_by) is distinct from (old.confirmed_at,old.confirmed_by) then raise exception 'immutable_issue'; end if;
 end if;
 return new;
end $$;
create trigger hr_doc_issue_guard before insert or update or delete on public.gw_hr_doc_issues for each row execute function public.hr_doc_issue_guard();
commit;
