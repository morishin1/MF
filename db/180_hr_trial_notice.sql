-- HR trial-period labor conditions notice: append-only versions and idempotent mail receipts.
-- Sensitive employment terms: service_role only, with RLS enabled as defense in depth.
begin;
create table if not exists public.gw_hr_trial_notices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  applicant_id uuid not null references public.gw_hr_applicants(id) on delete restrict,
  version integer not null check(version between 1 and 10000),
  issued_on date not null,
  applicant_name text not null,
  company_name text not null,
  values_json jsonb not null check(jsonb_typeof(values_json)='object'),
  content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
  docx_sha256 text,
  state text not null default 'draft' check(state in ('draft','approved','sent')),
  review_evidence text,
  approved_by uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint hr_trial_version_unique unique(tenant_id,applicant_id,version),
  constraint hr_trial_docx_hash_valid check(docx_sha256 is null or docx_sha256 ~ '^[0-9a-f]{64}$'),
  constraint hr_trial_approval_shape check(state='draft' or (docx_sha256 is not null and approved_by is not null and approved_at is not null and review_evidence is not null))
);
create index if not exists hr_trial_notices_tenant_latest on public.gw_hr_trial_notices(tenant_id,applicant_id,version desc);
create table if not exists public.gw_hr_trial_notice_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  notice_id uuid not null references public.gw_hr_trial_notices(id) on delete restrict,
  applicant_id uuid not null references public.gw_hr_applicants(id) on delete restrict,
  request_key uuid not null,
  confirmation_digest text not null check(confirmation_digest ~ '^[0-9a-f]{64}$'),
  docx_sha256 text not null check(docx_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_email text not null,
  status text not null default 'sending' check(status in ('sending','sent','unknown','failed')),
  provider_message_id text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint hr_trial_delivery_key_unique unique(tenant_id,request_key)
);
create index if not exists hr_trial_deliveries_by_notice on public.gw_hr_trial_notice_deliveries(tenant_id,notice_id,created_at desc);
alter table public.gw_hr_trial_notices enable row level security;
alter table public.gw_hr_trial_notice_deliveries enable row level security;
revoke all on public.gw_hr_trial_notices from public, anon, authenticated;
revoke all on public.gw_hr_trial_notice_deliveries from public, anon, authenticated;
grant select,insert,update on public.gw_hr_trial_notices to service_role;
grant select,insert,update on public.gw_hr_trial_notice_deliveries to service_role;
comment on table public.gw_hr_trial_notices is 'Reviewed trial labor conditions Word drafts; never treat unsigned/absent reply as consent.';
comment on table public.gw_hr_trial_notice_deliveries is 'Idempotent recruitment email send attempt: do not blindly retry sending/unknown states.';
commit;
