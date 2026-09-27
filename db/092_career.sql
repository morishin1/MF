-- =============================================================================
-- 092: 評価・キャリア（キャリアトラック / Level / 評価基準 / 社員の現在地 / 評価履歴）
--
-- ■ 何をするものか
--   入社後の社員が「いまどのLevelか・次に何ができればよいか・次のLevelの
--   給与レンジ・次回評価はいつか・1年後/3年後の目安」を自分で確かめられるようにする。
--   採用 → 労働条件 → 3か月育成 → 日々の仕事 → できるようになったこと → 評価 →
--   キャリアLevel → 昇格・昇給 を1本につなげるための「上の階層」。
--
-- ■ 自動で昇給・昇格させない
--   システムがするのは、材料を集め・基準に当てはめ・不足を見える化するところまで。
--   Level Up・昇給の判断は人が確定する（gw_career_reviews.status = 'confirmed'）。
--   確定できるのは owner / admin だけ（lib/career.js canDecideCareer）。
--   給与の判断は none / keep / raise の「結果」だけを持つ。新しい金額は契約側
--   （雇用契約 → 契約書作成依頼 → 電子署名 → 新しい active 契約）で決める。
--
-- ■ 既存のものを二重に持たない
--   現在の給与        … gw_contracts（active）を読む。ここにはコピーしない
--   3か月育成         … gw_growth_plans / months / kpis（キャリアに上がるための短期計画）
--   自走レベル        … gw_employees.autonomy_level（任せられる範囲。キャリアLevelとは別物）
--   できるようになったこと … gw_growth_history
--   試用期間          … gw_probation_reviews（本採用判断。キャリア評価そのものではない）
--   評価の「根拠」は、これらを api/career から読んで並べるだけ。
--
-- ■ 職種もLevelも基準も固定しない
--   トラック（エンジニア・営業…）・Level（L1〜）・基準（カテゴリーも含む）は
--   すべて管理画面から足したり直したりできる。初期の型は画面の
--   「共通テンプレートを入れる」で入る（lib/career.js STARTER）。
--
-- ■ 本人に見せる範囲
--   本人は API（api/career/me.js）経由で、自分の現在地と「確定済み」の評価だけを読む。
--   管理者メモ（manager_note・salary_note）・下書きの評価は本人には返さない。
--   書き込みは API（service_role）だけ。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 005（gw_employees・gw_is_hr）
-- =============================================================================

begin;

-- 1) キャリアトラック（職種ごとの道筋）
create table if not exists public.gw_career_tracks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,                 -- エンジニア / 営業 / バックオフィス …
  description     text,
  one_year_goal   text,                          -- 1年後の目安（標準的なもの）
  three_year_goal text,                          -- 3年後の目安
  is_active       boolean not null default true,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists uq_gw_career_tracks_name
  on public.gw_career_tracks(tenant_id, name);

-- 2) Level（トラックごと）
create table if not exists public.gw_career_levels (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  track_id           uuid not null references public.gw_career_tracks(id) on delete cascade,
  level_no           integer not null check (level_no between 1 and 20),
  level_name         text not null,               -- 基本業務習得 / 一人で業務を完結 …
  role_summary       text,                        -- 役割（ひとこと）
  expected_role      text,                        -- 期待される役割（詳しく）
  typical_months     integer,                     -- 標準的な到達の目安（入社からの月数）
  salary_min         integer check (salary_min is null or salary_min >= 0),
  salary_max         integer check (salary_max is null or salary_max >= 0),
  next_level_summary text,                        -- 次のLevelへ上がるために（ひとこと）
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (salary_min is null or salary_max is null or salary_min <= salary_max)
);
create unique index if not exists uq_gw_career_levels_no
  on public.gw_career_levels(tenant_id, track_id, level_no);

comment on column public.gw_career_levels.salary_min is
  '給与レンジ（目安）。保証ではない。実際の給与は評価・役割・契約条件等を確認して決める';

-- 3) 評価基準（そのLevelに「なる」ための条件）
create table if not exists public.gw_career_criteria (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  level_id       uuid not null references public.gw_career_levels(id) on delete cascade,
  category       text not null,                   -- 業務遂行 / 専門スキル / 顧客・品質 …（固定しない）
  title          text not null,                   -- 担当タスクを期限内に完了できる
  description    text,
  required_level integer,                         -- 自走レベルの基準など、数値で見るときの下限
  required       boolean not null default true,   -- 必須か（false は加点）
  weight         numeric not null default 1,
  evidence_type  text not null default 'manager'
                 check (evidence_type in ('kpi', 'nippo', 'growth_history', 'autonomy',
                                          'tasks', 'goals', 'probation', 'manager')),
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_gw_career_criteria_level
  on public.gw_career_criteria(level_id, sort_order);

-- 4) 社員のキャリア（現在地）。1人につき active は1つ
create table if not exists public.gw_employee_careers (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  employee_id            uuid not null references public.gw_employees(id) on delete cascade,
  track_id               uuid not null references public.gw_career_tracks(id),
  current_level_id       uuid not null references public.gw_career_levels(id),
  target_level_id        uuid references public.gw_career_levels(id),
  started_at             date,                    -- このキャリアを始めた日（入社日など）
  next_review_on         date,                    -- 次回評価
  one_year_target_note   text,                    -- 本人と合意した1年後の方向性
  three_year_target_note text,                    -- 本人と合意した3年後の方向性
  employee_wish          text,                    -- 本人がやりたいこと（初回キャリア面談）
  manager_note           text,                    -- 管理者だけの内部メモ（本人には出さない）
  agreed_at              timestamptz,             -- 初回キャリア面談で本人と上長が合意した日時
  is_active              boolean not null default true,
  updated_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists uq_gw_employee_careers_active
  on public.gw_employee_careers(employee_id) where is_active;
create index if not exists idx_gw_employee_careers_tenant
  on public.gw_employee_careers(tenant_id, next_review_on);

-- 5) 評価履歴
create table if not exists public.gw_career_reviews (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  employee_id        uuid not null references public.gw_employees(id) on delete cascade,
  career_id          uuid not null references public.gw_employee_careers(id) on delete cascade,
  from_level_id      uuid references public.gw_career_levels(id),
  target_level_id    uuid references public.gw_career_levels(id),
  review_period_from date,
  review_period_to   date,
  -- [{criterionId, category, title, result: achieved|in_progress|not_yet|na, note}]
  criterion_results  jsonb not null default '[]'::jsonb,
  -- 評価したときに見ていた材料の要約（件数など）。数字＝評価結果にはしない
  evidence_summary   jsonb,
  -- システム判定（参考）。最終判断ではない
  system_judgement   jsonb,
  employee_comment   text,
  manager_comment    text,                        -- 本人に見せる上長コメント
  result             text check (result in ('continue', 'level_up', 'hold')),
  salary_decision    text not null default 'none' check (salary_decision in ('none', 'keep', 'raise')),
  salary_note        text,                        -- 社内の給与調整メモ（本人には出さない）
  status             text not null default 'draft' check (status in ('draft', 'confirmed')),
  created_by         uuid references auth.users(id) on delete set null,
  decided_by         uuid references auth.users(id) on delete set null,
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_gw_career_reviews_emp
  on public.gw_career_reviews(employee_id, created_at desc);

comment on table public.gw_career_reviews is
  'キャリア評価。status=confirmed だけが本人に見える。Level Up・昇給の判断は人が確定する。'
  '給与は結果（none/keep/raise）だけ。新しい金額は契約（gw_contracts）で決める';

-- 6) RLS。読むのは社内の人事・管理者、本人は自分の分（確定済みの評価だけ）。書き込みは API のみ
alter table public.gw_career_tracks    enable row level security;
alter table public.gw_career_levels    enable row level security;
alter table public.gw_career_criteria  enable row level security;
alter table public.gw_employee_careers enable row level security;
alter table public.gw_career_reviews   enable row level security;

drop policy if exists gw_career_tracks_read on public.gw_career_tracks;
create policy gw_career_tracks_read on public.gw_career_tracks
  for select to authenticated using (public.gw_is_hr(tenant_id));
drop policy if exists gw_career_levels_read on public.gw_career_levels;
create policy gw_career_levels_read on public.gw_career_levels
  for select to authenticated using (public.gw_is_hr(tenant_id));
drop policy if exists gw_career_criteria_read on public.gw_career_criteria;
create policy gw_career_criteria_read on public.gw_career_criteria
  for select to authenticated using (public.gw_is_hr(tenant_id));

drop policy if exists gw_employee_careers_read on public.gw_employee_careers;
create policy gw_employee_careers_read on public.gw_employee_careers
  for select to authenticated using (public.gw_is_hr(tenant_id));

drop policy if exists gw_career_reviews_read on public.gw_career_reviews;
create policy gw_career_reviews_read on public.gw_career_reviews
  for select to authenticated using (public.gw_is_hr(tenant_id));
-- 本人の閲覧は api/career/me.js（service_role）で、確定済みだけ・内部メモを除いて返す。
-- 行のポリシーでは列（manager_note・salary_note）を隠せないため、本人向けの select ポリシーは置かない

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select t.name, l.level_no, l.level_name, l.salary_min, l.salary_max
--     from public.gw_career_levels l join public.gw_career_tracks t on t.id = l.track_id
--    order by t.sort_order, l.level_no;
