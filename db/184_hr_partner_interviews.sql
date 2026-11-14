-- 184: HR パートナー専用面談 (採用面談 gw_hr_interviews と別).
-- 既存応募者、BP企業、人材の各テーブルは変更しない。
create table if not exists public.gw_hr_partner_interviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  partner_id uuid not null,
  status text not null default 'planned' check (status in ('planned','in_progress','completed','cancelled')),
  meeting_kind text not null default 'online' check (meeting_kind in ('online','onsite','phone')),
  current_step smallint not null default 1 check (current_step between 1 and 6),
  step_notes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(step_notes)='object' and length(step_notes::text) <= 7000),
  recommended_programs text[] not null default '{}'::text[]
    check (recommended_programs <@ array['enger','aimachi']::text[]),
  recommended_work_types text[] not null default '{}'::text[]
    check (recommended_work_types <@ array['research','appointment','matching','sales','content','local_support','other']::text[]),
  security_understood boolean not null default false,
  compensation_understood boolean not null default false,
  summary text not null default '' check (char_length(summary)<=1000),
  first_task_hint text not null default '' check (char_length(first_task_hint)<=160),
  decision text check (decision in ('recommend','hold','decline')),
  next_action text not null default '' check (char_length(next_action)<=500),
  interviewed_by uuid references auth.users(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_hr_partner_interview_tenant_fk
    foreign key (partner_id,tenant_id)
      references public.gw_hr_external_partners(id,tenant_id) on delete restrict,
  constraint gw_hr_partner_interview_completion_guard check (
    status <> 'completed' or (
      decision is not null and char_length(trim(summary)) > 0 and
      char_length(trim(next_action)) > 0 and completed_at is not null and
      (
        decision <> 'recommend' or
        (security_understood and compensation_understood and cardinality(recommended_programs)>0)
      )
    )
  )
);
create unique index if not exists gw_hr_partner_interview_one_open
  on public.gw_hr_partner_interviews(tenant_id,partner_id)
  where status in ('planned','in_progress');
create index if not exists gw_hr_partner_interview_tenant_updated
  on public.gw_hr_partner_interviews(tenant_id,updated_at desc);
create index if not exists gw_hr_partner_interview_partner
  on public.gw_hr_partner_interviews(tenant_id,partner_id,created_at desc);

-- 183 の監査台帳で面談イベントも記録できるようにする。
alter table public.gw_hr_partner_audit_events
  drop constraint if exists gw_hr_partner_audit_events_entity_type_check;
alter table public.gw_hr_partner_audit_events
  add constraint gw_hr_partner_audit_events_entity_type_check
    check (entity_type in ('partner','work','budget','interview'));

alter table public.gw_hr_partner_interviews enable row level security;
revoke all on public.gw_hr_partner_interviews from public,anon,authenticated;
grant select,insert,update,delete on public.gw_hr_partner_interviews to service_role;
-- 外部へのAPIアクセスは付与しない。読み書きは社内HR権限/MFAを要求するサーバだけ。
comment on table public.gw_hr_partner_interviews is
  'ENGER/AIまち個人パートナーの30分面談。通常採用面談・雇用評価ではなく、参加業務の適合/安全性/条件確認を記録する。';
notify pgrst,'reload schema';
