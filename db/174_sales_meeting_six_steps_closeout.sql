-- 174: Six-step, 30-minute Sales meeting navigator and closing.
-- External company users still have read-only access to the stage.
begin;
alter table public.gw_sales_live_meeting_sessions
  drop constraint if exists gw_sales_live_meeting_sessions_stage_check;
alter table public.gw_sales_live_meeting_sessions
  add constraint gw_sales_live_meeting_sessions_stage_check
  check (stage between 0 and 5);
alter table public.gw_sales_live_meeting_stage_events
  drop constraint if exists gw_sales_live_meeting_stage_events_from_stage_check;
alter table public.gw_sales_live_meeting_stage_events
  drop constraint if exists gw_sales_live_meeting_stage_events_to_stage_check;
alter table public.gw_sales_live_meeting_stage_events
  add constraint gw_sales_live_meeting_stage_events_from_stage_check
  check (from_stage between 0 and 5);
alter table public.gw_sales_live_meeting_stage_events
  add constraint gw_sales_live_meeting_stage_events_to_stage_check
  check (to_stage between 0 and 5);
alter table public.gw_sales_live_meeting_sessions
  add column if not exists staff_notes jsonb not null default '{}'::jsonb,
  add column if not exists step_checks jsonb not null default '{}'::jsonb,
  add column if not exists closeout_outcome text,
  add column if not exists closeout_next_action text,
  add column if not exists closeout_next_due date;
create table if not exists public.gw_sales_meeting_closeouts (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 company_id uuid not null,
 session_id uuid not null unique references public.gw_sales_live_meeting_sessions(id) on delete cascade,
 recipient_email text not null,
 contact_name text not null default '',
 outcome text not null check (outcome in ('offer','reproposal','considering','declined')),
 next_action text not null,
 next_due date,
 mail_status text not null default 'preparing' check (mail_status in ('preparing','sent','failed')),
 mail_provider text,
 mail_message_id text,
 portal_login_id text,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 mail_sent_at timestamptz
);
create index if not exists gw_sales_meeting_closeouts_company
 on public.gw_sales_meeting_closeouts(tenant_id,company_id,created_at desc);
alter table public.gw_sales_meeting_closeouts enable row level security;
revoke all on public.gw_sales_meeting_closeouts from PUBLIC,anon,authenticated;
grant select,insert,update on public.gw_sales_meeting_closeouts to service_role;
comment on table public.gw_sales_meeting_closeouts is
 'Sent proposal email and closing outcome for a Sales meeting. Never store a plaintext temporary password.';
commit;