-- =============================================================================
-- 032: 労働条件通知書 → 3か月育成計画 → 月間KGI/KPI → 今日のKPI
--      （「労働条件通知書連動型 3か月育成・KPI・日報・AIフィードバックシステム」）
--
-- ■ この番号で入れるもの
--   1) gw_contracts に育成条件の列を足す（§3-2 §5 §44 employment_profiles）
--   2) gw_growth_plans   … 3か月計画（§6-9 §44 growth_plans）
--   3) gw_growth_months  … 月間KGI（§10 §44 monthly_goals）
--   4) gw_growth_kpis    … 月間KPI（§11 §12 §44 kpis）
--   5) gw_daily_kpis に kpi_id を足して、日々の実績が月間KPIへ積み上がるようにする（§22）
--
-- ■ 労働条件通知書のための表を新しく作らない
--   §44 は employment_documents / employment_profiles を分けているが、
--   029 の gw_contracts が既に「書類の置き場所 + AIが読んだ項目 + 人が確認して確定」
--   を持っている。同じものを2つ作ると、どちらを見ればよいか分からなくなる。
--   足りない列（育成期間・週所定労働時間・業務範囲）だけを足す。
--
-- ■ 労働条件と評価目標を分ける（§2-1）
--   契約の条件（賃金・労働時間・雇用形態）と、育成の目標（KGI/KPI）は別の表。
--   KPIの達成状況を理由に、賃金や契約条件が動くことがあってはならない。
--   gw_growth_* から gw_contracts へ書き戻す経路は作らない。
--   参照するのは「どんな業務のためのKPIか」を決めるときだけ。
--
-- ■ 3か月KGIは固定、月間KGI/KPIは毎月見直す（§10）
--   3か月の行き先を毎月変えると、何に向かっているか分からなくなる。
--   一方で、月の目標は実績を見て調整できないと、初月の想定のまま
--   達成不能な数字が3か月残る。
--
-- 前提: 029（gw_contracts）、030（gw_daily_kpis）、031（自走レベル）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 労働条件通知書として読む項目を足す（§3-2）
-- -----------------------------------------------------------------------------
-- 雇用契約書と労働条件通知書は書式が違う。どちらとして読んだかを残す
alter table public.gw_contracts
  add column if not exists document_type text
    check (document_type in ('労働条件通知書', '雇用契約書', 'その他'));

-- 試用期間とは別。育成の枠として何か月見るか（例：試用6か月／育成は3か月）
alter table public.gw_contracts add column if not exists training_months integer;
-- 「週29時間モデル」のような、育成期間中の所定労働時間
alter table public.gw_contracts add column if not exists weekly_hours numeric;
alter table public.gw_contracts add column if not exists remote_ok boolean;
-- 雇入れ直後の業務の候補。["バックオフィス","事業推進",…]
alter table public.gw_contracts add column if not exists work_scope jsonb;
-- 業務変更の範囲（書類の文言のまま）
alter table public.gw_contracts add column if not exists scope_change text;
-- 指定研修。["無限道場",…]
alter table public.gw_contracts add column if not exists training_programs jsonb;
-- 育成終了時に何を見るか（書類の文言のまま）
alter table public.gw_contracts add column if not exists training_review_note text;

comment on column public.gw_contracts.training_months is
  '育成期間（月）。試用期間とは別。試用6か月・育成3か月のような組み合わせがある';
comment on column public.gw_contracts.work_scope is
  '雇入れ直後の業務の候補。3か月計画のKPIを決めるときの材料にする';


-- -----------------------------------------------------------------------------
-- 2) 3か月育成計画（§6-9）
--
--    1人につき、期間が重ならない範囲で複数持てる。
--    3か月が終わったら次の3か月を作る（前の計画は残す）。
--
--    ★ AIが作るのはドラフトまで。管理者と本人が確認して確定する（§6）。
--      status が 'draft' のあいだは、KPIは日々の画面に出さない。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_plans (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid,                          -- auth.users.id（日々の集計用）

  -- どの書類から始まったか。労働条件を書き換えることはしない（§2-1）
  contract_id uuid references public.gw_contracts(id) on delete set null,

  start_date date not null,
  end_date   date not null,

  -- 「○○ができるようになる」の形で書く（§7）
  three_month_kgi text,

  status text not null default 'draft'
         check (status in ('draft', 'active', 'done', 'cancelled')),

  -- AIが作ったドラフト。人が直したあとも、元の案を残す
  ai_draft  jsonb,
  ai_model  text,
  ai_prompt_version text,
  ai_status text default 'pending'
            check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_error  text,

  note text,
  created_by  uuid references auth.users(id) on delete set null,
  -- 確定した人。管理者と本人の両方が見た、という運用は画面側で促す
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (end_date > start_date)
);

create index if not exists idx_gw_growth_plans_emp
  on public.gw_growth_plans(employee_id, start_date desc);
create index if not exists idx_gw_growth_plans_user
  on public.gw_growth_plans(user_id, status);

comment on table public.gw_growth_plans is
  '3か月の育成計画。3か月KGIは固定し、月間KGI/KPIは毎月見直す。'
  'AIはドラフトまでで、確定は人が押す';


-- -----------------------------------------------------------------------------
-- 3) 月間KGI（§10 §11）
--    3か月を3段階に分ける（§8）。
--      MONTH 1 基本業務を安定して実行できる
--      MONTH 2 自分で優先順位を決めて進める
--      MONTH 3 自分で考え、改善までできる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_months (
  id       uuid primary key default gen_random_uuid(),
  plan_id  uuid not null references public.gw_growth_plans(id) on delete cascade,
  user_id  uuid,

  month_no smallint not null check (month_no between 1 and 12),
  month    date not null,                    -- その月の1日

  kgi   text,
  -- その月に想定している自走レベル。判定そのものは 031 が持つ
  target_level smallint check (target_level between 1 and 4),

  status text not null default 'planned'
         check (status in ('planned', 'active', 'reviewed')),

  -- 月末の振り返り。gw_nippo_monthly とは別で、こちらは目標に対する結果
  review_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, month_no)
);

create index if not exists idx_gw_growth_months_user
  on public.gw_growth_months(user_id, month);


-- -----------------------------------------------------------------------------
-- 4) 月間KPI（§11 §12）
--
--    kind（§12）
--      number    数値      例：営業20件
--      rate      達成率    例：業務完了率90%
--      count     回数      例：AI活用12回
--      output    成果物    例：マニュアル2本
--      onoff     ON/OFF    例：成果発表 実施
--      score     評価      例：上長レビュー80点
--
--    集め方（roll）… 日々の実績をどう月の実績にするか。ここが型ごとに違う。
--      sum   足す（回数・成果物・数値）
--      last  最後の値（達成率・評価。日ごとに足しても意味がない）
--      any   1日でもあれば達成（ON/OFF）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_kpis (
  id       uuid primary key default gen_random_uuid(),
  month_id uuid not null references public.gw_growth_months(id) on delete cascade,
  user_id  uuid,

  sort_order smallint not null default 0,
  name  text not null,
  kind  text not null default 'number'
        check (kind in ('number', 'rate', 'count', 'output', 'onoff', 'score')),
  target_value numeric,
  unit  text,
  -- 重み。月間KGIの進捗を出すときに使う。全部同じでよければ 1 のまま
  weight numeric not null default 1,

  -- 日々の実績から積み上げるか、月末に人が入れるか。
  -- 「上長レビュー80点」のようなものは、日々の日報からは出ない
  from_daily boolean not null default true,
  -- 月末に人が入れた値（from_daily = false のとき使う）
  manual_value numeric,

  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_growth_kpis_month
  on public.gw_growth_kpis(month_id, sort_order);
create index if not exists idx_gw_growth_kpis_user
  on public.gw_growth_kpis(user_id);

comment on column public.gw_growth_kpis.kind is
  '数値/達成率/回数/成果物/ON-OFF/評価。型によって、日々の実績の積み上げ方が変わる';
comment on column public.gw_growth_kpis.from_daily is
  'false なら日報からは積み上げず、月末に人が入れる（上長レビュー点など）';


-- -----------------------------------------------------------------------------
-- 5) 日々のKPIを、月間KPIにつなぐ（§22）
--
--    日報の実績が、そのまま月間KPIの進捗になる。
--    つないでおかないと、同じ数字を2回入れることになる。
-- -----------------------------------------------------------------------------
alter table public.gw_daily_kpis
  add column if not exists kpi_id uuid references public.gw_growth_kpis(id) on delete set null;

create index if not exists idx_gw_daily_kpis_kpi
  on public.gw_daily_kpis(kpi_id, work_date);

comment on column public.gw_daily_kpis.kpi_id is
  '月間KPIへの紐づけ。入っていれば、日々の実績がそのまま月の進捗になる';

-- source に 'plan'（3か月計画から降りてきたもの）を足す
alter table public.gw_daily_kpis drop constraint if exists gw_daily_kpis_source_check;
alter table public.gw_daily_kpis add constraint gw_daily_kpis_source_check
  check (source in ('manual', 'template', 'continued', 'ai', 'plan'));


-- -----------------------------------------------------------------------------
-- 6) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--    書き込みは service_role の API だけなので insert/update のポリシーは置かない。
-- -----------------------------------------------------------------------------
alter table public.gw_growth_plans  enable row level security;
alter table public.gw_growth_months enable row level security;
alter table public.gw_growth_kpis   enable row level security;

drop policy if exists gw_growth_plans_select on public.gw_growth_plans;
create policy gw_growth_plans_select on public.gw_growth_plans
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_growth_months_select on public.gw_growth_months;
create policy gw_growth_months_select on public.gw_growth_months
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_growth_kpis_select on public.gw_growth_kpis;
create policy gw_growth_kpis_select on public.gw_growth_kpis
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select p.start_date, p.end_date, p.status, e.display_name, p.three_month_kgi
--     from public.gw_growth_plans p
--     join public.gw_employees e on e.id = p.employee_id
--    order by p.start_date desc;
--   select m.month_no, m.month, m.kgi, k.name, k.kind, k.target_value, k.unit
--     from public.gw_growth_months m
--     left join public.gw_growth_kpis k on k.month_id = m.id
--    order by m.month, k.sort_order;
