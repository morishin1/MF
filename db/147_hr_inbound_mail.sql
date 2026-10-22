-- HR採用メールの新着受付台帳（Phase 1）。メールを取り込んでも応募者は作らない。
-- Gmailの実取得・自動ジョブは別PR。service_role経由の認証済みHR APIのみが書き込み。
begin;
create table if not exists public.gw_hr_inbound_mail (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider in ('gmail','manual')),
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 200),
  recipient text not null check (recipient = 'saiyou@8grp.co.jp'),
  received_at timestamptz not null,
  subject text not null default '' check (char_length(subject) <= 300),
  sender_address text not null default '' check (char_length(sender_address) <= 254),
  reply_to text check (reply_to is null or char_length(reply_to) <= 254),
  body_text text check (body_text is null or char_length(body_text) <= 5000),
  source_guess text check (source_guess is null or char_length(source_guess) <= 80),
  candidate_name_guess text check (candidate_name_guess is null or char_length(candidate_name_guess) <= 100),
  job_title_guess text check (job_title_guess is null or char_length(job_title_guess) <= 180),
  status text not null default 'new' check (status in ('new','review','linked','ignored')),
  applicant_id uuid references public.gw_hr_applicants(id) on delete restrict,
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_hr_inbound_mail_link_guard check ((status='linked')=(applicant_id is not null)),
  unique(tenant_id,provider,provider_message_id)
);
create index if not exists gw_hr_inbound_mail_tenant_status_at
  on public.gw_hr_inbound_mail (tenant_id,status,received_at desc);
create index if not exists gw_hr_inbound_mail_applicant
  on public.gw_hr_inbound_mail (tenant_id,applicant_id);
alter table public.gw_hr_inbound_mail enable row level security;
drop policy if exists gw_hr_inbound_mail_read on public.gw_hr_inbound_mail;
create policy gw_hr_inbound_mail_read on public.gw_hr_inbound_mail
  for select to authenticated using (public.gw_is_recruiting(tenant_id));
revoke all on public.gw_hr_inbound_mail from anon,authenticated;
grant select on public.gw_hr_inbound_mail to authenticated;
grant all on public.gw_hr_inbound_mail to service_role;
comment on table public.gw_hr_inbound_mail is
  '採用メール新着受付。候補を保存して人が確定し、採用応募者に明示紐づけする。本文はHR限定。';
notify pgrst,'reload schema';
commit;
