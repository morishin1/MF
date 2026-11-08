-- 165 / 企業別商談5ステップ同期。外部に公開されるのは商談進行と公開済み候補IDだけ。
begin;

create table if not exists public.gw_sales_live_meeting_sessions (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 company_id uuid not null,
 selected_keys jsonb not null default '[]'::jsonb,
 stage smallint not null default 0 check (stage between 0 and 4),
 status text not null default 'active' check (status in ('active','closed')),
 version integer not null default 1 check (version >= 1),
 started_by uuid not null references auth.users(id) on delete cascade,
 updated_by uuid references auth.users(id) on delete set null,
 started_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 closed_at timestamptz,
 constraint live_session_selection_array check (
   jsonb_typeof(selected_keys)='array' and
   jsonb_array_length(selected_keys) between 1 and 10
 )
);
create unique index if not exists gw_sales_live_meeting_one_active
 on public.gw_sales_live_meeting_sessions(tenant_id,company_id)
 where status='active';
create index if not exists gw_sales_live_meeting_company_date
 on public.gw_sales_live_meeting_sessions(tenant_id,company_id,started_at desc);

create table if not exists public.gw_sales_live_meeting_stage_events (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null references public.gw_sales_live_meeting_sessions(id) on delete cascade,
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 company_id uuid not null,
 from_stage smallint not null check (from_stage between 0 and 4),
 to_stage smallint not null check (to_stage between 0 and 4),
 actor_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(),
 constraint stage_movement_adjacent check (abs(to_stage-from_stage)=1)
);
create index if not exists gw_sales_live_meeting_stage_events_session
 on public.gw_sales_live_meeting_stage_events(session_id,created_at);

alter table public.gw_sales_live_meeting_sessions enable row level security;
alter table public.gw_sales_live_meeting_stage_events enable row level security;
revoke all on public.gw_sales_live_meeting_sessions from public,anon,authenticated;
revoke all on public.gw_sales_live_meeting_stage_events from public,anon,authenticated;
grant select,insert,update,delete on public.gw_sales_live_meeting_sessions to service_role;
grant select,insert,update,delete on public.gw_sales_live_meeting_stage_events to service_role;
commit;
notify pgrst,'reload schema';
