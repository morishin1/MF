-- EIGHT Slack AI secretary: a separate, opt-in Slack identity link and durable message queue.
-- Apply ONLY after review in Supabase SQL Editor. Existing GW data is unchanged.
-- No anon/authenticated RLS policies: only the server service-role may read/write.
create table if not exists public.gw_slack_ai_users (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slack_team_id text not null,
  slack_user_id text not null,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (slack_team_id, slack_user_id),
  unique (tenant_id, employee_id)
);
alter table public.gw_slack_ai_users enable row level security;

create table if not exists public.gw_slack_ai_events (
  event_id text primary key,
  slack_team_id text not null,
  event_payload jsonb not null,
  state text not null default 'queued' check(state in ('queued','processing','done','failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text
);
create index if not exists gw_slack_ai_events_queue_idx
  on public.gw_slack_ai_events (state, received_at);
alter table public.gw_slack_ai_events enable row level security;

create table if not exists public.gw_slack_ai_escalations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  requester_slack_user_id text not null,
  requester_channel text not null,
  requester_thread_ts text not null,
  requester_knowledge_scopes jsonb,
  owner_dm_ts text,
  question text not null,
  status text not null default 'pending' check(status in (
    'pending', 'approved_pending_delivery', 'delivery_attempted', 'delivery_uncertain', 'review_required', 'answered'
  )),
  approved_answer text,
  delivery_attempted_at timestamptz,
  delivery_error text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
-- Keep this script safe to re-run if the original MVP schema was already created.
alter table public.gw_slack_ai_escalations
  add column if not exists requester_knowledge_scopes jsonb,
  add column if not exists delivery_attempted_at timestamptz,
  add column if not exists delivery_error text;
alter table public.gw_slack_ai_escalations
  drop constraint if exists gw_slack_ai_escalations_status_check;
alter table public.gw_slack_ai_escalations
  add constraint gw_slack_ai_escalations_status_check check(status in (
    'pending', 'approved_pending_delivery', 'delivery_attempted', 'delivery_uncertain', 'review_required', 'answered'
  ));
drop index if exists public.gw_slack_ai_escalations_owner_idx;
create unique index if not exists gw_slack_ai_escalations_owner_msg_uidx
  on public.gw_slack_ai_escalations (owner_dm_ts)
  where owner_dm_ts is not null;
alter table public.gw_slack_ai_escalations enable row level security;
-- Explicit manual linking required; do not infer Slack/GW identity by display name.
-- EXAMPLE (fill verified IDs only, run manually):
-- insert into public.gw_slack_ai_users (tenant_id, slack_team_id, slack_user_id, employee_id)
-- values ('TENANT-UUID', 'T...', 'U...', 'EMPLOYEE-UUID');
notify pgrst, 'reload schema';
