-- =============================================================================
-- 042: 週のゴールと、その日の行動案
--
-- ■ 変えたいこと
--   これまでの日報は、朝に本人が「今日の最優先」と「やること3つ」を
--   自分で考えて書く形だった。
--   考えること自体が仕事の中身なら良いが、実際には
--   「何を書けばいいか分からない」で止まる時間のほうが長い。
--
--   会社の目標 → その日の行動 までを先に落としておき、
--   本人は 実行する ことと 結果を返す ことに集中してもらう。
--
--     管理者が週のゴールを決める（gw_week_goals）
--       ↓ AIが月〜金の行動に分ける
--     その日の行動案（gw_day_plans）
--       ↓ 本人は「今日を始める」を押すだけ
--     実行 → 夜は できた/できなかった と 実績だけ返す
--       ↓ AIが評価して
--     翌日の行動案を作り直す
--
-- ■ 日報そのものの形は変えない
--   朝の「今日を始める」は、これまでの朝の保存（tc_nippo）と同じ形に落とす。
--   top_priority ／ work_items ／ goal_image に入る。
--   夜の日報も、これまでどおり work_items に結果を書く。
--   表を新しくすると、過去の日報と地続きでなくなる。
--
-- ■ 案は上書きしない
--   AIが作った案（gw_day_plans）と、実際にやったこと（tc_nippo）は別に残す。
--   同じ場所に書くと「案のとおりだったのか、変えたのか」が分からなくなる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 週のゴール。管理者が決める
-- -----------------------------------------------------------------------------
create table if not exists public.gw_week_goals (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,
  week_start    date not null,                    -- 月曜

  kgi           text,                             -- 今週、何が終わっていれば良いか
  kpis          jsonb not null default '[]'::jsonb, -- [{name, target, unit}]
  deadline      text,                             -- 期限（「金曜17時まで」など）
  priority_work text,                             -- 優先業務
  note          text,                             -- 管理者から本人への一言

  -- draft … 作りかけ（本人には出ない）
  -- active … 本人の朝の画面に出る
  status        text not null default 'draft'
                check (status in ('draft','active')),

  ai_model      text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (employee_id, week_start)
);

create index if not exists idx_gw_week_goals_week
  on public.gw_week_goals(tenant_id, week_start);

comment on table public.gw_week_goals is
  '週のゴール。管理者が決め、AIが日ごとの行動に分ける';


-- -----------------------------------------------------------------------------
-- 2) その日の行動案。AIが作る
-- -----------------------------------------------------------------------------
create table if not exists public.gw_day_plans (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade,
  work_date     date not null,
  week_start    date not null,

  -- ① 今日が最高に終わった状態。1文
  success_line  text,
  -- ② 今日の最優先。1つ
  top_priority  text,
  -- ③ 今日やること3つ。[{task, target, unit, done_when}]
  --    数値と「何をもって終わりか」まで入れる。
  --    「頑張る」で終わらせない
  actions       jsonb not null default '[]'::jsonb,
  -- ④ 今日意識するエイトの行動2つ。[{key, label, how}]
  --    10か条から2つ選び、今日の場面に合わせた具体的な行動にする
  focus         jsonb not null default '[]'::jsonb,

  -- week_goal … 週のゴールから分けたもの
  -- carry_over … 前日の結果から作り直したもの
  -- manual … 人が直したもの
  source        text not null default 'week_goal'
                check (source in ('week_goal','carry_over','manual')),

  -- 本人が「今日を始める」を押したか
  started_at    timestamptz,

  ai_model      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (employee_id, work_date)
);

create index if not exists idx_gw_day_plans_date
  on public.gw_day_plans(tenant_id, work_date);

comment on column public.gw_day_plans.actions is
  '[{task, target, unit, done_when}]。朝に押すと tc_nippo.work_items へ写る';


-- -----------------------------------------------------------------------------
-- 3) 日報の各行に「実績の数値」を持たせる
--    work_items は jsonb なので DDL は要らない。書き方だけ決めておく:
--      { task, target, unit, done_when, result, actual, undone_reason }
--    朝に task / target / unit / done_when が入り、
--    夜に result（できたこと）か undone_reason（できなかった理由）と
--    actual（実績の数値）が入る
-- -----------------------------------------------------------------------------
comment on column public.tc_nippo.work_items is
  '朝に task / target / unit / done_when、夜に result か undone_reason と actual。'
  '最大3件。朝の案は gw_day_plans にも残す（案と実際を分けて見るため）';


-- -----------------------------------------------------------------------------
-- 4) RLS
--    本人は自分のぶんを読む。管理者・責任者は全員ぶん。
--    書き込みは service_role の API だけ（AIの出力を画面から差し替えられない）
-- -----------------------------------------------------------------------------
alter table public.gw_week_goals enable row level security;
alter table public.gw_day_plans  enable row level security;

drop policy if exists gw_week_goals_read on public.gw_week_goals;
create policy gw_week_goals_read on public.gw_week_goals
  for select to authenticated
  using (
    employee_id = public.gw_employee_id(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_has_role(tenant_id, 'manager')
  );

drop policy if exists gw_day_plans_read on public.gw_day_plans;
create policy gw_day_plans_read on public.gw_day_plans
  for select to authenticated
  using (
    employee_id = public.gw_employee_id(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_has_role(tenant_id, 'manager')
  );


notify pgrst, 'reload schema';

-- 確認:
--   -- 今週のゴール
--   select e.display_name, g.week_start, g.status, g.kgi, g.kpis
--     from public.gw_week_goals g
--     join public.gw_employees e on e.id = g.employee_id
--    order by g.week_start desc, e.display_name;
--
--   -- 今日の行動案
--   select e.display_name, p.work_date, p.top_priority, p.actions, p.started_at
--     from public.gw_day_plans p
--     join public.gw_employees e on e.id = p.employee_id
--    where p.work_date = current_date;
