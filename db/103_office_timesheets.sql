-- =============================================================================
-- 103: 勤務表と日別の稼働データ — gw_timesheets / gw_timesheet_days
--
-- ■ 流れ（AI は下書きを作るだけ。確定は人）
--   勤務表アップロード（gw_submissions）→ AI読取 → 下書き（draft）→ 人が確認・修正 → 確定（confirmed）
--
--   gw_timesheets       … 月 × 人 × 現場契約で1件（gw_billing_progress と同じキー）
--   gw_timesheet_days   … その月の日別データ（日付・開始・終了・休憩・実働・備考・AIの自信・要確認の理由）
--
-- ■ 時刻は「その日の 0:00 からの分」の整数で持つ
--   start_min 540 = 9:00。end_min が 1440 以上なら翌日（1560 = 翌 2:00）。
--   休憩は分。実働は保存しない（拘束 − 休憩 で、いつでも計算できる。食い違いを持ち込まない）。
--   読めない・書かれていない値は null のまま。推測で埋めない。
--   sheet_worked_min は、勤務表に書かれていた実働（AI が読んだ値）。計算値との照合用で、合計には使わない。
--
-- ■ 月の集計（total_minutes など）は、API が日別データから計算して保存する
--   保存のたびに日別から作り直す。確定するとき、丸めの条件（rounding_*）と、使った契約条件（terms_id）を
--   控えとして残す。あとで契約条件が変わっても、確定済みの稼働時間は動かさない。
--
-- ■ 状態
--   draft      … 下書き（AI読取のあと・人が直している間）。まだ稼働時間として使わない
--   confirmed  … 人が確認して確定。稼働時間として使う（月次進捗の「稼働確認」の印もここから立てる）
--   returned   … 提出物に問題があり、再提出を依頼した（return_reason に理由）
--   「未提出」「提出済み・未読取」は行を持たない（gw_submissions と、この表の有無から導く）。
--
-- ■ RLS：読み取りだけを Office 権限（gw_is_office）に絞る
--   書き込みのポリシーは置かない。書き込みは、権限を確かめたあとの API（service_role）だけ。
--   ブラウザから直接書き換えて、「要確認の日を確認済みにする」「確定の条件」「履歴」を飛ばせないようにする。
--
-- ■ 適用の順番（重要）
--   099 → 100 → 101 → 102 → この 103 → アプリのデプロイ。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 076・080、099（gw_is_office）、101（gw_submissions の列）、102（gw_site_contract_terms）
-- =============================================================================

begin;

create table if not exists public.gw_timesheets (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  employee_id         uuid not null references public.gw_employees(id) on delete cascade,
  site_contract_id    uuid not null references public.gw_site_contracts(id) on delete cascade,
  target_month        text not null
    check (target_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  submission_id       uuid references public.gw_submissions(id) on delete set null,

  status              text not null default 'draft'
    check (status in ('draft', 'confirmed', 'returned')),

  read_state          text not null default 'none'
    check (read_state in ('none', 'ok', 'failed')),
  ai_model            text,
  ai_read_at          timestamptz,
  ai_message          text,
  sheet_total_min     integer
    check (sheet_total_min is null or (sheet_total_min >= 0 and sheet_total_min <= 44640)),

  raw_minutes         integer,
  total_minutes       integer,
  work_days           integer,
  unresolved_count    integer not null default 0,
  flagged_count       integer not null default 0,
  spill_minutes       integer not null default 0,
  carry_in_minutes    integer not null default 0,

  terms_id            uuid references public.gw_site_contract_terms(id) on delete set null,
  rounding_unit       integer,
  rounding_mode       text,
  rounding_scope      text,

  confirmed_at        timestamptz,
  confirmed_by        uuid references auth.users(id) on delete set null,
  return_reason       text,
  returned_at         timestamptz,
  returned_by         uuid references auth.users(id) on delete set null,

  review_seconds      integer not null default 0
    check (review_seconds >= 0),
  edit_count          integer not null default 0
    check (edit_count >= 0),

  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (employee_id, target_month, site_contract_id)
);

comment on table public.gw_timesheets is
  '月 × 人 × 現場契約の勤務表。AI読取は下書き（draft）を作るだけで、確定（confirmed）は人が確認したあと。'
  '月の集計は日別（gw_timesheet_days）から API が計算して保存する';
comment on column public.gw_timesheets.review_seconds is
  '人が確認画面に費やした秒数（AIの精度ではなく、確認にかかる時間を測るため）';
comment on column public.gw_timesheets.edit_count is
  'AI の読取結果を、人が直した回数（項目単位）';

create index if not exists idx_gw_timesheets_month
  on public.gw_timesheets(tenant_id, target_month);
create index if not exists idx_gw_timesheets_contract
  on public.gw_timesheets(site_contract_id, target_month);
create index if not exists idx_gw_timesheets_submission
  on public.gw_timesheets(submission_id) where submission_id is not null;

create table if not exists public.gw_timesheet_days (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  timesheet_id      uuid not null references public.gw_timesheets(id) on delete cascade,
  work_date         date not null,

  kind              text
    check (kind is null or kind in ('work', 'off')),
  start_min         integer
    check (start_min is null or (start_min >= 0 and start_min < 1440)),
  end_min           integer
    check (end_min is null or (end_min >= 0 and end_min < 2880)),
  break_min         integer
    check (break_min is null or (break_min >= 0 and break_min <= 1440)),
  sheet_worked_min  integer
    check (sheet_worked_min is null or (sheet_worked_min >= 0 and sheet_worked_min <= 1440)),
  note              text,

  source            text not null default 'ai'
    check (source in ('ai', 'manual')),
  ai_confidence     text
    check (ai_confidence is null or ai_confidence in ('high', 'mid', 'low')),
  ai_flags          jsonb not null default '[]'::jsonb,
  ai_snapshot       jsonb,
  edited            boolean not null default false,
  reviewed_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (timesheet_id, work_date)
);

comment on table public.gw_timesheet_days is
  '勤務表の日別データ。start_min・end_min は 0:00 からの分（end_min 1440 以上は翌日）。'
  '読めない値は null のまま。実働は保存しない（拘束 − 休憩 で計算する）';
comment on column public.gw_timesheet_days.ai_flags is
  'AI・サーバーが付けた「要確認の理由」の配列 [{code, text}]。人が確認済みにするまで確定できない';
comment on column public.gw_timesheet_days.ai_snapshot is
  'AI が読み取った元の値（kind・start_min・end_min・break_min・sheet_worked_min・note）。人が直したかの比較用';
comment on column public.gw_timesheet_days.reviewed_at is
  '人が「この日を確認した」とした日時。要確認の日は、これが入るまで確定できない';

create index if not exists idx_gw_timesheet_days_sheet
  on public.gw_timesheet_days(timesheet_id, work_date);
create index if not exists idx_gw_timesheet_days_tenant
  on public.gw_timesheet_days(tenant_id);

alter table public.gw_timesheets     enable row level security;
alter table public.gw_timesheet_days enable row level security;

drop policy if exists gw_timesheets_office_select on public.gw_timesheets;
create policy gw_timesheets_office_select on public.gw_timesheets
  for select using (public.gw_is_office(tenant_id));

drop policy if exists gw_timesheet_days_office_select on public.gw_timesheet_days;
create policy gw_timesheet_days_office_select on public.gw_timesheet_days
  for select using (public.gw_is_office(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後）: 2表のポリシーが「読み取りだけ・Office 権限」か
--
--   select tablename, policyname, cmd, qual from pg_policies
--    where schemaname = 'public' and tablename in ('gw_timesheets', 'gw_timesheet_days');
--
-- 確認2（運用後）: 確定した勤務表の稼働時間
--
--   select e.display_name, t.target_month, t.status, t.total_minutes / 60.0 as hours,
--          t.work_days, t.review_seconds, t.edit_count
--     from public.gw_timesheets t
--     join public.gw_employees e on e.id = t.employee_id
--    order by t.target_month desc, e.display_name;
