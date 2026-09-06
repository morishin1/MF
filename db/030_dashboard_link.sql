-- =============================================================================
-- 030: ダッシュボード × 日報 × AI評価 をつなぐ
--      （「ダッシュボード × 日報 × AI評価 連動設計」§3① §18 §19 §20 §21）
--
-- ■ 何のための番号か
--   1) 100点の内訳を持つ列   … §18/§19。10か条の単純合計をやめた
--   2) gw_daily_kpis         … §3①。KPIは事前に決めておき、本人は実績だけ入れる
--   3) gw_action_items       … §21。ダッシュボードと日報をつなぐ中心の表
--
-- ■ §19 について
--   10か条を「10項目 × 10点 = 100点」にはしない。
--   成果40 / 行動30 / 成長20 / チーム10 で100点にし、
--   10か条は「なぜその評価なのか」を見るための内訳として残す。
--   その内訳を毎回計算し直さなくて済むよう、列に入れておく。
--   （計算そのものは lib/scoring.js が持つ）
--
-- ■ §21 の循環
--   日報の困りごと・AIの改善提案
--     → action_item ができる
--     → 翌日のダッシュボードの一番上に出る
--     → 本人が実行する
--     → 翌日の日報で「実施済み」
--     → action_item が閉じる
--   この循環が回らないと、日報は書いて終わりになる。
--
-- 前提: 026（gw_is_internal_staff）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 100点の内訳（成果40 / 行動30 / 成長20 / チーム10）
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_ai_evals
  add column if not exists categories         jsonb;
alter table public.gw_nippo_ai_evals
  add column if not exists manager_categories jsonb;

alter table public.tc_weekly_review
  add column if not exists ai_categories   jsonb;
alter table public.tc_weekly_review
  add column if not exists eval_categories jsonb;

comment on column public.gw_nippo_ai_evals.categories is
  '総合点の内訳。成果40/行動30/成長20/チーム10。10か条はこの内訳の理由として使う';
comment on column public.tc_weekly_review.ai_categories is
  '同上（週次）。10項目の単純合計ではない';

-- 025〜027 で書いた説明が「10項目 × 10点 = 100点」のままなので直す。
-- 中身の型は変わっていない（10か条 各0〜10点）。合計の出し方だけが変わった
comment on column public.gw_nippo_ai_evals.total_score is
  '総合点（0〜100）。10か条の合計ではなく 成果40/行動30/成長20/チーム10 の重み付け。'
  '材料不足の条は分母から外して按分する';
comment on column public.tc_weekly_review.ai_total is
  '同上（週次・AIの点）';
comment on column public.tc_weekly_review.eval_total is
  '同上（週次・管理者が確定した点）。本人に見えるのは submitted_at が入ってから';
comment on column public.tc_nippo.daily_flags is
  '10か条それぞれについて、その日の日報から機械的に拾った ○/△/― 。点数ではない';


-- -----------------------------------------------------------------------------
-- 2) KPI（§3①）
--    「営業連絡20件」「商談2件」のように、目標は先に決めておく。
--    本人が毎朝それを考えるところから始めると、日報が目標設定の場になり、
--    数字が後から都合よく動いてしまう。
--
--    ・target は管理者か本人が事前に決める（決めた人を target_set_by に残す）
--    ・actual は本人が日報で入れる
--    ・1人1日1指標1件
-- -----------------------------------------------------------------------------
create table if not exists public.gw_daily_kpis (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- auth.users.id
  work_date  date not null,
  -- 表示順。ダッシュボードには3〜5個までしか出さない（§9②）
  sort_order integer not null default 0,

  label      text not null,                 -- 「営業連絡」「商談」「ENGER登録」
  unit       text,                          -- 「件」「本」「社」
  target     numeric,                       -- 事前に決めた目標
  actual     numeric,                       -- 本人が入れる実績

  -- どこから来た目標か。continued = 前日の設定をそのまま引き継いだもの
  source     text not null default 'manual'
             check (source in ('manual', 'template', 'continued', 'ai')),
  target_set_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, work_date, label)
);

create index if not exists idx_gw_daily_kpis_user
  on public.gw_daily_kpis(user_id, work_date desc);

comment on table public.gw_daily_kpis is
  'KPIは事前に決めておき、本人は実績だけ入れる。目標を毎朝本人が決める形にしない';


-- 毎日の入力を減らすための、その人の定番KPI。
-- 翌日ぶんを作るとき、ここから写す。
create table if not exists public.gw_kpi_templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  sort_order integer not null default 0,
  label      text not null,
  unit       text,
  target     numeric,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, label)
);

comment on table public.gw_kpi_templates is
  'その人の定番KPI。翌日のKPIを作るときの雛形';


-- -----------------------------------------------------------------------------
-- 3) 次にやること（§21）
--
--    出どころ（source）で分ける。
--      ai       … AIが日報から作った（tomorrow_advice / improvement_points）
--      self     … 本人が日報の「明日の最優先」に書いた
--      manager  … 上司が指示した
--
--    ひとつだけ priority = 1 にして、ダッシュボードの一番上に大きく出す（最重要UI）。
--
--    閉じ方は2通り。
--      done      … 実行した
--      dropped   … やらないと決めた（消さずに残す。判断も記録のうち）
--    消さないのは、「AIの提案がどれくらい実行されたか」を後から見るため。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_action_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- auth.users.id
  title      text not null,                 -- 「営業文章を改善する」
  detail     text,

  source     text not null default 'self'
             check (source in ('ai', 'self', 'manager')),
  -- どの日報・どの評価から生まれたか。たどれるようにしておく
  from_nippo_id uuid,
  from_eval_id  uuid references public.gw_nippo_ai_evals(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,

  -- いつのダッシュボードに出すか。既定は翌営業日
  due_date   date,
  -- 1 = 今日の最優先（1人1日ひとつだけ）。2以降はその下に並べる
  priority   integer not null default 5,

  status     text not null default 'open'
             check (status in ('open', 'done', 'dropped')),
  -- 完了を報告した日報。日報で「実施済み」にすると入る
  done_nippo_id uuid,
  done_note  text,
  done_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_action_items_open
  on public.gw_action_items(user_id, status, due_date);
create index if not exists idx_gw_action_items_nippo
  on public.gw_action_items(from_nippo_id);

-- 「今日の最優先」は1人1日ひとつ。2つあると、一番上に何を出すか決まらない
create unique index if not exists uq_gw_action_items_top
  on public.gw_action_items(user_id, due_date)
  where priority = 1 and status = 'open';

comment on table public.gw_action_items is
  'ダッシュボードと日報をつなぐ表。日報の課題 → 翌日の最優先 → 実行 → 日報で完了';
comment on column public.gw_action_items.status is
  'dropped も残す。やらないと決めたことも判断の記録';


-- -----------------------------------------------------------------------------
-- 4) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--
--    KPIの実績（actual）と、次にやることの完了は本人が自分で書く。
--    ただし RLS は列を絞れないので、本人に update を許すと
--    target まで書き換えられる（目標を下げれば達成率が上がってしまう）。
--    そのため書き込みは service_role の API だけにして、
--    「本人が触ってよい列か」は API 側で見る。
-- -----------------------------------------------------------------------------
alter table public.gw_daily_kpis    enable row level security;
alter table public.gw_kpi_templates enable row level security;
alter table public.gw_action_items  enable row level security;

drop policy if exists gw_daily_kpis_select on public.gw_daily_kpis;
create policy gw_daily_kpis_select on public.gw_daily_kpis
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_kpi_templates_select on public.gw_kpi_templates;
create policy gw_kpi_templates_select on public.gw_kpi_templates
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_action_items_select on public.gw_action_items;
create policy gw_action_items_select on public.gw_action_items
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select work_date, label, target, actual from public.gw_daily_kpis
--    order by work_date desc, sort_order limit 20;
--   select due_date, priority, status, source, title from public.gw_action_items
--    order by due_date desc, priority limit 20;
--   select work_date, total_score, categories from public.gw_nippo_ai_evals
--    order by work_date desc limit 5;
