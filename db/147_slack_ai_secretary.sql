-- EIGHT Slack AI secretary: a separate, opt-in Slack identity link and durable message queue.
-- Apply ONLY after review in Supabase SQL Editor. Existing GW data is unchanged.
-- No anon/authenticated RLS policies: only the server service-role may read/write.
-- 前提: schema.sql（tenants）、005_groupware_core.sql（gw_employees）。
--       実行時の回答は 113_ai_assistant.sql（gw_ai_knowledge）を読むが、この SQL 自体は 113 を参照しない。
-- 確認: db/check_147_slack_ai_secretary.sql（読み取りのみ）／戻し: db/rollback_147_slack_ai_secretary.sql
begin;
create table if not exists public.gw_slack_ai_users (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slack_team_id text not null,
  slack_user_id text not null,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (slack_team_id, slack_user_id),
  unique (tenant_id, employee_id)
);
-- 紐付けの失効（行を消さずに止める）。revoked_at が入った紐付けでは回答しない。
alter table public.gw_slack_ai_users add column if not exists revoked_at timestamptz;
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
-- 同じ Slack メッセージ（channel:ts）が別の event_id で届いても1回しか受け付けない。
alter table public.gw_slack_ai_events add column if not exists message_key text;
create unique index if not exists gw_slack_ai_events_message_key_uidx
  on public.gw_slack_ai_events (message_key) where message_key is not null;
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
  add column if not exists delivery_error text,
  -- 代表の承認を「判断依頼を送った代表DM」「承認メッセージ」「本文・宛先」に結び付ける。
  add column if not exists owner_dm_channel text,
  add column if not exists approval_ts text,
  add column if not exists approved_at timestamptz,
  add column if not exists approval_hash text,
  add column if not exists approval_invalidated_ts text,
  -- 自動回答 OFF（既定）のとき、資料に基づく AI 回答案を代表の承認用に保持する（社員へは未送信）。
  add column if not exists ai_draft_answer text;
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
-- 1つの承認メッセージは1件の依頼にだけ結び付く。
create unique index if not exists gw_slack_ai_escalations_approval_msg_uidx
  on public.gw_slack_ai_escalations (owner_dm_channel, approval_ts)
  where approval_ts is not null;
-- 承認済み（送信待ち）は、本文・承認メッセージ・結び付けハッシュがそろっていなければならない。
-- 旧データには適用しない（not valid）。旧データはアプリ側で送信せず review_required にする。
alter table public.gw_slack_ai_escalations
  drop constraint if exists gw_slack_ai_escalations_approval_bound_check;
alter table public.gw_slack_ai_escalations
  add constraint gw_slack_ai_escalations_approval_bound_check check(
    status <> 'approved_pending_delivery'
    or (approved_answer is not null and approval_ts is not null and approval_hash is not null and approved_at is not null)
  ) not valid;
alter table public.gw_slack_ai_escalations enable row level security;
-- RLS に加え、ブラウザ側のロールからの直接操作の権限そのものを外す（service_role だけが使う）。
revoke all on table public.gw_slack_ai_users, public.gw_slack_ai_events, public.gw_slack_ai_escalations
  from anon, authenticated;
-- Explicit manual linking required; do not infer Slack/GW identity by display name.
-- EXAMPLE (fill verified IDs only, run manually):
-- insert into public.gw_slack_ai_users (tenant_id, slack_team_id, slack_user_id, employee_id)
-- values ('TENANT-UUID', 'T...', 'U...', 'EMPLOYEE-UUID');
-- 失効: update public.gw_slack_ai_users set revoked_at = now() where slack_team_id = 'T...' and slack_user_id = 'U...';
notify pgrst, 'reload schema';
commit;
