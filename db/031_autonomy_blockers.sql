-- =============================================================================
-- 031: Blocker / 自走レベル / デキル履歴
--      （「EIGHT 自律型事業運営システム 要件定義」§6 §7 §12 §21〜24 §27 §33）
--
-- ■ この番号で入れるもの
--   1) gw_blockers        … §12④ §21 §22 §24。PHASE 1 で残っていた最後の1つ
--   2) 自走レベル         … §6 §7。gw_employees に列を足し、判定の記録を別表に持つ
--   3) gw_growth_history  … §27「デキル履歴」
--
-- ■ Blocker を「困りごと」と別に持つ理由
--   日報の困りごと（tc_nippo.issues）は、その日の記録。翌日には流れる。
--   Blocker は「仕事が止まっていて、誰かが外さないと動かない状態」で、
--   何日も続く。日報の中に閉じ込めると、何日止まっているかが分からない。
--
--   §24 の「管理職の役割は命令ではなく Blocker を外すこと」を成立させるには、
--   止まった時刻と、外れた時刻が要る。
--
-- ■ 自走レベルは AI が決めない
--   §6 は裁量の話で、人の評価ではない。
--   システムは「条件を満たしたか」を数えるところまでやり、
--   上げる・下げるは人が押す。押した人と時刻を残す。
--   日報のAI評価・試用期間・契約更新と同じ扱いにしている。
--
-- 前提: 026（gw_is_internal_staff）、030（gw_action_items）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Blocker（§12④ §21 §22 §24）
--
--    status
--      open      … 止まっている
--      resolved  … 外れた（誰が外したかを残す）
--      dropped   … 止まりではなくなった（別の進め方にした等）
--
--    escalation_level
--      0 本人が抱えている / 1 上司へ / 2 経営者へ
--      長期化したものを自動で上げるのではなく、人が上げる。
--      自動で上げると、上がってきた時点で誰も中身を知らない状態になる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_blockers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,                 -- auth.users.id。止まっている本人

  title       text not null,                 -- 「契約条件について判断待ち」
  description text,

  -- どの仕事が止まっているか。無くてもよい（仕事になる前に止まることがある）
  action_item_id uuid references public.gw_action_items(id) on delete set null,
  -- どの日報から上がったか
  from_nippo_id  uuid,

  status      text not null default 'open'
              check (status in ('open', 'resolved', 'dropped')),
  escalation_level smallint not null default 0
              check (escalation_level between 0 and 2),

  -- いつから止まっているか。§22「Blocker長期化」を数えるのに要る
  blocked_since date not null default (now() at time zone 'Asia/Tokyo')::date,

  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution  text,                          -- どう外れたか。次に同じことで止まらないため

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_blockers_open
  on public.gw_blockers(status, blocked_since);
create index if not exists idx_gw_blockers_user
  on public.gw_blockers(user_id, status, blocked_since desc);

comment on table public.gw_blockers is
  '仕事が止まっている状態。日報の困りごとと違い、外れるまで残る。'
  '管理職の仕事はこれを外すこと（要件定義 §24）';
comment on column public.gw_blockers.blocked_since is
  '止まった日。何日止まっているかを数えるのに使う';
comment on column public.gw_blockers.escalation_level is
  '0=本人 1=上司 2=経営者。自動では上げない。上げるのは人';


-- 日次のAI評価に、止まりそうな困りごとの候補と、そのとき何レベルだったかを残す。
-- レベルは点数には効かせない。効くのは返し方だけだが、
-- 「この評価はどの話し方で出たか」が後から分からないと、基準の見直しができない
alter table public.gw_nippo_ai_evals
  add column if not exists blocker_candidates jsonb;
alter table public.gw_nippo_ai_evals
  add column if not exists autonomy_level smallint;

comment on column public.gw_nippo_ai_evals.blocker_candidates is
  '止まっていそうな困りごとの候補（最大2件）。ここではまだBlockerにしない。上げるのは本人';
comment on column public.gw_nippo_ai_evals.autonomy_level is
  'この評価を出したときの自走レベル。点数には効かない。返し方だけが変わる';


-- -----------------------------------------------------------------------------
-- 2) 自走レベル（§6 §7）
--
--    1 指示実行型 / 2 選択実行型 / 3 自律実行型 / 4 自主経営型
--
--    新しく入った人が 1 から始まるのは、能力が低いという意味ではない。
--    「まだ会社の仕事の進め方を知らない」というだけなので、
--    既定値は 1 にして、上げるのは人が押す。
--
--    レベルは AI の話し方も変える（§17 §18）。
--      L1 … 手順まで出す
--      L2 … 選択肢を出して選ばせる
--      L3 … 原因を先に聞く。答えを全部は出さない
--      L4 … 数字だけ出して、口を出さない
-- -----------------------------------------------------------------------------
alter table public.gw_employees
  add column if not exists autonomy_level smallint not null default 1
    check (autonomy_level between 1 and 4);
alter table public.gw_employees
  add column if not exists autonomy_changed_at timestamptz;
alter table public.gw_employees
  add column if not exists autonomy_changed_by uuid references auth.users(id) on delete set null;

comment on column public.gw_employees.autonomy_level is
  '自走レベル 1〜4。裁量の広さであって、人の評価ではない。'
  'AIの話し方もこれで変わる（L1は手順、L3は問いかけ）';


-- 上げ下げの記録。いつ・誰が・何を根拠にしたか。
-- 上げるだけでなく下げることもあるので、履歴として残す
create table if not exists public.gw_autonomy_reviews (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid,                          -- auth.users.id（集計のため）

  from_level  smallint,
  to_level    smallint not null check (to_level between 1 and 4),

  -- 判定に使った数字。プログラムが数えたもの（AIには数えさせない）
  metrics     jsonb,
  -- 条件を満たしたか。{key: {label, ok, value, need}}
  checks      jsonb,

  -- AIの所見。可否は書かせない。材料の整理だけ
  ai_note     text,
  ai_model    text,

  reason      text,                          -- 人が書く理由
  decided_by  uuid references auth.users(id) on delete set null,
  decided_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_autonomy_reviews_emp
  on public.gw_autonomy_reviews(employee_id, decided_at desc);

comment on table public.gw_autonomy_reviews is
  '自走レベルを上げ下げした記録。可否はAIではなく人が決める。'
  '下げた記録も残す（下がったこと自体が次の材料になる）';


-- -----------------------------------------------------------------------------
-- 3) デキル履歴（§27）
--
--    「昨日より今日、何ができるようになったか」を積み上げる。
--    点数は月が変われば消えるが、できるようになったことは消えない。
--
--    source
--      monthly … 月次AIの「今月できるようになったこと」から
--      manual  … 上司か本人が書いた
--      lms     … 無限道場の修了（§32。連携は PHASE 3）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_history (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                  -- auth.users.id
  happened_on date not null,                 -- できるようになった月（その月の1日でよい）

  title      text not null,                  -- 「問い合わせ営業を一人で実施できるようになった」
  evidence   text,                           -- どの記録から言えるか

  source     text not null default 'manual'
             check (source in ('monthly', 'manual', 'lms')),
  -- どこから来たか。月次から来たものは、その月を消せば作り直せる
  source_ref text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  -- 同じ月の同じ内容を二度入れない（月次を作り直しても増えない）
  unique (user_id, happened_on, title)
);

create index if not exists idx_gw_growth_history_user
  on public.gw_growth_history(user_id, happened_on desc);

comment on table public.gw_growth_history is
  'できるようになったことの積み上げ。この仕組みで一番残したいもの';


-- -----------------------------------------------------------------------------
-- 4) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--    書き込みは service_role の API だけなので insert/update のポリシーは置かない。
--
--    Blocker だけは、社内の誰でも読めてよい。
--    §24 のとおり、外すのは管理職に限らないため
--    （手が空いている人が外せるほうが早い）。
-- -----------------------------------------------------------------------------
alter table public.gw_blockers          enable row level security;
alter table public.gw_autonomy_reviews  enable row level security;
alter table public.gw_growth_history    enable row level security;

drop policy if exists gw_blockers_select on public.gw_blockers;
create policy gw_blockers_select on public.gw_blockers
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_autonomy_reviews_select on public.gw_autonomy_reviews;
create policy gw_autonomy_reviews_select on public.gw_autonomy_reviews
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_growth_history_select on public.gw_growth_history;
create policy gw_growth_history_select on public.gw_growth_history
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select blocked_since, title, status, escalation_level from public.gw_blockers
--    where status = 'open' order by blocked_since;
--   select display_name, autonomy_level, autonomy_changed_at from public.gw_employees
--    order by autonomy_level desc, display_name;
--   select happened_on, title, source from public.gw_growth_history
--    order by happened_on desc limit 20;
