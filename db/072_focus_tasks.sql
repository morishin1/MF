-- =============================================================================
-- 072: タスクを「毎日の実行管理」にする
--
-- ■ 何を変えるのか
--
--   これまでの gw_tasks は「たまった仕事の一覧」だった。
--   一覧は増える一方で、今日どれを終わらせるのかは誰も決めていない。
--   登録した数ではなく、毎日3つ終えたかどうかで回るようにする。
--
--     明日の3件を決める → AIが見る → 担当を決める → 人が確定
--     → 日報を書く → 翌朝ダッシュボードに「今日やる3つ」→ 完了
--
-- ■ 表は増やさず、日ごとの「確定」だけ足す
--
--   タスクそのものは gw_tasks のまま。列を足して
--   「どの日の重要タスクか（focus_date / focus_rank）」を持たせる。
--   タスクの置き場所を2つにすると、「どっちに書いたか」を人が覚えることになる。
--
--   日ごとの状態（下書き → AI確認済み → 確定）は1行で持つ（gw_focus_days）。
--   タスクの列に散らすと、3件のうち1件だけ確定、のような状態が作れてしまう。
--
-- ■ 未完了を、黙って翌日へ動かさない
--
--   自動で繰り越すと、終わらないタスクが毎日並んで、見る意味が無くなる。
--   carried_from / carry_count を持ち、決めたときだけ動かす。
--   何度も持ち越されているものは、数が出るので目に入る。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 009_tasks.sql → 044 → 068_task_flow.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) タスクに「その日の重要タスク」であることを持たせる
-- -----------------------------------------------------------------------------
alter table public.gw_tasks
  -- 何日の重要タスクか。null なら、ふつうのタスク（積んであるだけ）
  add column if not exists focus_date  date,
  -- その日の中の順番。1 が最初にやるもの
  add column if not exists focus_rank  smallint,
  -- 誰の「その日の3件」として決めたか。
  --
  -- ■ 担当（assignee_id）と分ける理由
  --   自分の3件のうち1件を、人に渡すことがある。
  --   渡した先では「その人が今日やること」になるが、
  --   決めたのはこちらなので、こちらの3件からは消えない。
  --   1つの列で兼ねると、渡した瞬間に自分の3件が2件になる
  add column if not exists focus_for   uuid references public.gw_employees(id) on delete set null,

  -- なぜやるのか。会社・事業の目標につながっているかを見るために要る
  add column if not exists purpose     text,
  -- 関連KPI・事業。「新規開拓」「ENGER」など
  add column if not exists kpi_link    text,

  -- AIの確認結果 {verdict, reason, fix, checkedAt}
  add column if not exists ai_review   jsonb,
  -- AIが出した担当の案。人が確定するまで assignee_id には入れない
  add column if not exists ai_assignee uuid references public.gw_employees(id) on delete set null,
  add column if not exists ai_assignee_why text,

  -- 持ち越し。決めたときだけ動かす（自動では動かさない）
  add column if not exists carried_from date,
  add column if not exists carry_count  smallint not null default 0,
  -- 終わらなかった理由。次の日に同じことが起きないようにするためのもの
  add column if not exists not_done_reason text;

create index if not exists idx_gw_tasks_focus
  on public.gw_tasks(assignee_id, focus_date, focus_rank);
create index if not exists idx_gw_tasks_focus_for
  on public.gw_tasks(focus_for, focus_date, focus_rank);
create index if not exists idx_gw_tasks_focus_tenant
  on public.gw_tasks(tenant_id, focus_date);

comment on column public.gw_tasks.focus_date is
  'その日の重要タスクとして出す日。null なら、ふつうのタスク';
comment on column public.gw_tasks.focus_for is
  '誰の3件として決めたか。担当を人に渡しても、決めた人の3件からは消えない';
comment on column public.gw_tasks.carry_count is
  '持ち越した回数。多いものは、そもそもやらない判断が要る';


-- -----------------------------------------------------------------------------
-- 2) 日ごとの状態
--
--    draft      … まだ3件そろっていない
--    ready      … 3件そろった。AIはまだ見ていない
--    ai_checked … AIが見た。人の確認待ち
--    confirmed  … 人が確定した。ここで日報が書けるようになる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_focus_days (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,
  focus_date   date not null,

  status       text not null default 'draft'
               check (status in ('draft', 'ready', 'ai_checked', 'confirmed')),

  -- AIの全体評価 {ok, summary, warnings:[], balance}
  ai           jsonb,
  ai_model     text,
  ai_at        timestamptz,

  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,

  -- 前日の未完了を片付けた時刻。ここが空なら、決めていない未完了が残っている
  carry_handled_at timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (employee_id, focus_date)
);

create index if not exists idx_gw_focus_days_tenant
  on public.gw_focus_days(tenant_id, focus_date desc);

comment on table public.gw_focus_days is
  '1人1日の「重要タスク3件」の状態。確定するまで日報は書けない';


-- -----------------------------------------------------------------------------
-- 3) RLS
--
--    本人は自分のぶん。人事・管理者は全員ぶん。
--    書き込みは API（service_role）だけ。画面から直接は書かせない
-- -----------------------------------------------------------------------------
alter table public.gw_focus_days enable row level security;

drop policy if exists gw_focus_days_read on public.gw_focus_days;
create policy gw_focus_days_read on public.gw_focus_days
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or exists (select 1 from public.gw_employees e
               where e.id = employee_id and e.user_id = auth.uid())
  );

notify pgrst, 'reload schema';
