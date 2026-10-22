-- HR / スポット人材・体験勤務アンケート（採用HR拡張）
-- 前提 db/081_hr_recruiting.sql。応募者・HR/Office の既存表は変更しない。
begin;
create table if not exists public.gw_hr_spot_talents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  source text not null default 'タイミー' check (char_length(source) between 1 and 80),
  worked_on date not null,
  work_note text check (work_note is null or char_length(work_note) <= 500),
  survey_token_hash text unique,
  survey_expires_at timestamptz,
  survey_sent_at timestamptz,
  survey_answered_at timestamptz,
  survey_answers jsonb,
  survey_email text,
  contact_consent boolean not null default false,
  staff_scores jsonb,
  staff_note text check (staff_note is null or char_length(staff_note) <= 1000),
  scored_by uuid references auth.users(id) on delete set null,
  scored_at timestamptz,
  status text not null default 'registered'
    check (status in ('registered','invited','answered','evaluated','candidate','converted','closed')),
  applicant_id uuid unique references public.gw_hr_applicants(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spot_survey_fields check (
    (survey_token_hash is null and survey_expires_at is null)
    or (survey_token_hash is not null and survey_expires_at is not null)
  ),
  constraint spot_converted_link check (status <> 'converted' or applicant_id is not null)
);
create index if not exists idx_gw_hr_spot_talents_tenant
  on public.gw_hr_spot_talents(tenant_id, worked_on desc, created_at desc);
create index if not exists idx_gw_hr_spot_talents_status
  on public.gw_hr_spot_talents(tenant_id, status);
comment on table public.gw_hr_spot_talents is
  '採用HRのスポット勤務人材。本人の任意アンケートと社内評価を独立管理し、同意後に既存の応募者へ引き継ぐ。';
alter table public.gw_hr_spot_talents enable row level security;
drop policy if exists gw_hr_spot_talents_read on public.gw_hr_spot_talents;
create policy gw_hr_spot_talents_read on public.gw_hr_spot_talents
  for select to authenticated using (public.gw_is_recruiting(tenant_id));
-- 書き込みは認証/テナント確認済み API と、ハッシュ照合済み公開アンケートAPIのみ（service_role）。
revoke all on public.gw_hr_spot_talents from anon, authenticated;
grant select on public.gw_hr_spot_talents to authenticated;
grant all on public.gw_hr_spot_talents to service_role;
notify pgrst, 'reload schema';
commit;
