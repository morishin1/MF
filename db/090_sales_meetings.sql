-- =============================================================================
-- 090: 営業面談（/sales Phase 2）— リード → 面談設定 → 日程確定 → 面談予定
--
-- ■ 採用DBと混ぜない
--   営業の面談は gw_hr_interviews（採用）には入れない。この表だけに保存する。
--   共通化するのは仕組み（TimeRex の日程調整・Webhook の受信口・通知）だけ。
--
-- ■ 面談の種類は、まず1つ（初回商談 30分）
--   kind は 'first_meeting' だけを許す。種類を増やすのは実運用で要ると分かってから
--   （check を広げるだけで足せる）。
--
-- ■ 1件の流れ（status）
--   scheduling … 「面談を設定」で TimeRex の日程調整URLを発行した（相手の予約待ち）
--   scheduled  … 日程が決まった（いまは手入力。TimeRex Webhook の実装後は自動）
--   done       … 実施した
--   canceled   … 取りやめ
--
-- ■ TimeRex Webhook の再送で2行にしない
--   (tenant_id, timerex_event_id) で一意（HR の 089 と同じ考え方）。
--   Webhook の受信そのものは、実 payload を確認してから実装する（ここでは保存先だけ）。
--
-- ■ 既存のものは変えない
--   新しい表とその RLS・索引だけを作る。既存の表・関数・ポリシーには触らない。
--   全体を1つのトランザクションで流す。途中で失敗したら何も変わらない。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 088_sales.sql（gw_sales_companies・gw_is_sales）
-- =============================================================================

begin;

create table if not exists public.gw_sales_meetings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  company_id    uuid not null references public.gw_sales_companies(id) on delete cascade,
  owner_id      uuid references public.gw_employees(id) on delete set null,   -- 担当（面談する人）

  kind          text not null default 'first_meeting' check (kind in ('first_meeting')),  -- 初回商談
  duration_min  integer not null default 30,

  status        text not null default 'scheduling'
    check (status in ('scheduling', 'scheduled', 'done', 'canceled')),

  scheduling_url      text,          -- 相手に送った TimeRex の日程調整URL（sales_company_id・sales_meeting_id 付き）
  scheduling_sent_at  timestamptz,   -- 「送付済みにする」を押した時刻

  scheduled_at   timestamptz,        -- 決まった日時
  meeting_url    text,               -- Google Meet などの URL
  timerex_event_id  text,            -- TimeRex の予約ID（Webhook の重複防止キー）
  timerex_synced_at timestamptz,     -- Webhook から最後に反映した時刻（手入力なら null）

  conducted_at   timestamptz,        -- 実施した時刻
  recording_url  text,               -- 録画（外部リンク。このアプリでは保存しない）
  result         jsonb not null default '{}'::jsonb,   -- 面談結果（課題・予算・時期・決裁者・興味・次回）。Phase 3 で使う
  notes          text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_sales_meetings_company
  on public.gw_sales_meetings(company_id, created_at desc);
create index if not exists idx_gw_sales_meetings_tenant
  on public.gw_sales_meetings(tenant_id, status, scheduled_at);
create unique index if not exists uq_gw_sales_meetings_timerex_event
  on public.gw_sales_meetings(tenant_id, timerex_event_id) where timerex_event_id is not null;

comment on table public.gw_sales_meetings is
  '営業面談。採用の gw_hr_interviews とは別。まずは初回商談（30分）だけ';

alter table public.gw_sales_meetings enable row level security;

drop policy if exists gw_sales_meetings_staff on public.gw_sales_meetings;
create policy gw_sales_meetings_staff on public.gw_sales_meetings
  for all using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select c.name, m.status, m.scheduling_sent_at, m.scheduled_at, m.meeting_url
--     from public.gw_sales_meetings m join public.gw_sales_companies c on c.id = m.company_id
--    order by m.created_at desc;
