-- REVIEW ONLY: operator applies. No mail ingestion, sending, deletion or private-DM storage.
begin;
-- Abort on any name collision; never modify an existing table or its grants.
do $$ begin
 if to_regclass('public.gw_slack_notification_history') is not null or to_regclass('public.gw_slack_history_scope_time') is not null then
  raise exception 'slack_history_name_collision_review_required';
 end if;
end $$;
create table public.gw_slack_notification_history (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 department text not null check(department in ('hr','sales','office')),
 target_date date not null,
 slot text not null check(slot in ('08','12','17')),
 revision integer not null check(revision>0),
 summary text not null check(char_length(summary) between 1 and 2000),
 sent_at timestamptz not null,
 slack_channel text not null,
 slack_ts text not null check(slack_ts ~ '^[0-9]{10}\.[0-9]{6}$'),
 slack_permalink text not null,
 coverage_status text not null check(coverage_status in ('complete','partial','unavailable')),
 coverage_note text not null default '' check(char_length(coverage_note)<=500),
 period_start timestamptz not null,
 period_end timestamptz not null check(period_end>period_start),
 source text not null,
 source_ids jsonb not null default '[]'::jsonb check(jsonb_typeof(source_ids)='array' and jsonb_array_length(source_ids)<=500),
 receipt_hash text not null check(receipt_hash ~ '^[0-9a-f]{64}$'),
 recorded_by uuid not null references auth.users(id) on delete restrict,
 created_at timestamptz not null default now(),
 check(period_end<=sent_at),
 check(coverage_status='complete' or char_length(coverage_note)>0),
 check((department='hr' and slack_channel='C0CCSBTDB1S' and source='hr-mailbox') or
       (department='sales' and slack_channel='C0CCQHQN3SM' and source='sales-mailbox') or
       (department='office' and slack_channel='C0CCLMUQZ7G' and source='office-gw')),
 check(slack_permalink='https://8grp.slack.com/archives/'||slack_channel||'/p'||replace(slack_ts,'.','')),
 unique(tenant_id,department,target_date,slot,revision),
 unique(tenant_id,slack_channel,slack_ts)
);
create index gw_slack_history_scope_time on public.gw_slack_notification_history(tenant_id,department,sent_at desc);
alter table public.gw_slack_notification_history enable row level security;
-- Browser direct access is denied; authenticated scoped API is the only route.
revoke all on public.gw_slack_notification_history from public,anon,authenticated,service_role;
grant select,insert on public.gw_slack_notification_history to service_role;
comment on table public.gw_slack_notification_history is 'Owner-confirmed sent channel-post receipts only; Slack API existence is not independently verified. Never private DM or raw mail. API tenant/department checks required.';
notify pgrst,'reload schema';
commit;
