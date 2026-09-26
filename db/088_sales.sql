-- =============================================================================
-- 088: 営業アタック管理（/sales） — 企業選定 → 営業文作成 → フォームアタック →
--       履歴保存 → クリック検知 → フォロー → 商談化 まで。
--
-- ■ 企業マスターは1つ（gw_sales_companies）
--   同じ会社を2行にしない。URL（ドメイン）が同じなら同じ会社として扱う
--   （domain 列で一意。API層でも追加前に確かめる）。
--   営業禁止（NG）も別表にせず、この行の ng_reason で持つ。
--   NGの会社はアタックできない（API層で弾く）。
--
-- ■ アタック（gw_sales_approaches）は「1回ごとの営業」。上書きしない
--   誰が・いつ・どの会社へ・どの文章で・何を提案したかを、あとから必ず追えるようにする。
--   本文（body）は送った時点のスナップショット。テンプレートを直しても変わらない。
--
--   専用URL（/r/<token>）は営業文に入れる必要があるので、送る前に発行する
--   （prepared_at だけ立った状態）。「送信完了」を押した時点で sent_at が立つ。
--   一覧・重複チェック・集計は sent_at のあるものだけを数える。
--
-- ■ クリック（gw_sales_click_events）は追記だけ。ログと「有効クリック」を分ける
--   専用URLへのアクセスは、機械のもの（リンクのプレビュー・セキュリティ製品・HEAD・
--   先読み）や短時間の連打も含めて全部残し、人のクリックと判断したものだけ
--   is_valid=true にする。除外した理由は excluded_reason に残す（除外しすぎていたら
--   ログから数え直せる）。件数・初回・最終は有効クリックだけを
--   gw_sales_approaches 側にも持つ（一覧を速く出すため）。
--   IPは保存しない。日ごとに変わる塩を混ぜたハッシュだけ持つ（同じ人の連打を
--   見分けられればよく、個人を追いかける必要はない）。
--
-- ■ ステータスは1本（status）
--   未アタック → アタック済 → クリックあり → 返信あり → 商談 → 提案 → 成約
--   別系統：対象外・失注・再アタック待ち
--
-- ■ 既存のものは壊さない（本番実行前の確認で直したところ）
--   ・既存の表・列・関数・ポリシーは drop も変更もしない。作るのは gw_sales_* と gw_is_sales だけ
--   ・既存の表に触るのは2か所だけ。どちらも CHECK 制約の「許す値」を広げるだけで、狭めない
--       gw_role_grants.role       … 'sales' を足す
--       gw_notifications.kind     … 'sales' を足す
--     いまのDBにある制約の値・表にすでに入っている値・リポジトリの一覧、の和集合に
--     'sales' を足して張り直す。本番で制約を手で広げていた場合でも、その値を消さない
--   ・全体を1つのトランザクションで流す。途中で失敗したら、何も変わらずに元のまま
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 005_groupware_core.sql（gw_employees・gw_role_grants・gw_has_role）・
--       013_notifications.sql（gw_notifications）・081_hr_recruiting.sql（recruiter ロール）
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1) sales ロールを追加（許す値を広げるだけ。ほかの権限は増やさない）
--    いまの制約の値 ∪ 表にある値 ∪ 081までの一覧 ∪ 'sales' で張り直す（狭めない）
-- -----------------------------------------------------------------------------
do $$
declare
  cur  text;
  vals text[];
begin
  select pg_get_constraintdef(oid) into cur
    from pg_constraint
   where conrelid = 'public.gw_role_grants'::regclass and conname = 'gw_role_grants_role_check';

  select array_agg(distinct v order by v) into vals from (
    select m[1] as v from regexp_matches(coalesce(cur, ''), '''([^'']+)''', 'g') as m
     where m[1] !~ '[{},]'   -- 配列リテラルの丸ごと（'{a,b}'）は値として拾わない
    union select role from public.gw_role_grants where role is not null
    union select unnest(array['owner', 'hr', 'manager', 'labor_advisor', 'it', 'finance', 'recruiter', 'sales'])
  ) s;

  alter table public.gw_role_grants drop constraint if exists gw_role_grants_role_check;
  -- 081 までと同じ in (…) の形で張る（Postgres は ARRAY['a'::text, …] と表示するので、
  -- 次に流したときも上の正規表現で1つずつ読める。2回流しても値が増えない）
  execute format(
    'alter table public.gw_role_grants add constraint gw_role_grants_role_check check (role in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(vals) as v));
end $$;

comment on column public.gw_role_grants.role is
  'owner=経営者 / hr=人事 / manager=マネージャー / labor_advisor=社労士 / '
  'it=IT担当 / finance=経理 / recruiter=採用担当（採用HR機能だけ） / '
  'sales=営業担当（/sales だけ。人事・会計には届かない）';

-- /sales を使える人。管理者・経営者・マネージャー・営業担当
create or replace function public.gw_is_sales(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant)
      or public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'manager')
      or public.gw_has_role(p_tenant, 'sales')
$$;

comment on function public.gw_is_sales(uuid) is
  '営業アタック管理（/sales）を使える人。管理者・経営者・マネージャー・営業担当。'
  '重複アタックの強行（それでもアタックする）は管理者・経営者のみ（API層）';

-- -----------------------------------------------------------------------------
-- 2) キャンペーン・テンプレート（企業・アタックから参照されるので先に作る）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_campaigns (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,          -- 「2026年9月 AI / DX営業」
  service     text,                   -- 主な提案サービス
  starts_on   date,
  ends_on     date,
  archived_at timestamptz,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_sales_campaigns_tenant
  on public.gw_sales_campaigns(tenant_id, created_at desc);

create table if not exists public.gw_sales_templates (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,      -- 「AI / DX 基本」
  service         text,               -- 対象サービス（AI / DX・PCレンタル 等。自由記述）
  subject         text,               -- 件名（フォームに件名欄があるとき用）
  body            text not null,      -- 本文。{{company}} {{sender}} {{url}} を差し込む
  destination_url text,               -- 専用URLのリダイレクト先（本来のページ）
  archived_at     timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_gw_sales_templates_tenant
  on public.gw_sales_templates(tenant_id, created_at);

-- -----------------------------------------------------------------------------
-- 3) 企業マスター
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_companies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  name          text not null,
  domain        text,          -- site_url から取り出したホスト名（www. は外す）。重複登録の判定に使う
  site_url      text,
  form_url      text,          -- 問い合わせフォームURL
  industry      text,          -- 業種（製造・不動産・士業・医療・小売・その他 など。自由記述）
  region        text,          -- 地域（都道府県など）
  address       text,
  size          text,          -- 企業規模（自由記述）
  phone         text,
  service       text,          -- 何を提案する企業か
  campaign_id   uuid references public.gw_sales_campaigns(id) on delete set null,
  owner_id      uuid references public.gw_employees(id) on delete set null,   -- 担当

  status text not null default 'untouched'
    check (status in (
      'untouched',      -- 未アタック
      'attacked',       -- アタック済
      'clicked',        -- クリックあり
      'replied',        -- 返信あり
      'meeting',        -- 商談
      'proposal',       -- 提案
      'won',            -- 成約
      'excluded',       -- 対象外
      'lost',           -- 失注
      'reattack_wait'   -- 再アタック待ち
    )),

  -- NEXT（次にやること）。すべての会社に1つ持たせる
  next_action    text,         -- 「フォロー」「再アタック」「電話」など
  next_action_on date,

  -- クリックに対応した時刻。これより後のクリックが「未対応クリック」
  followed_at    timestamptz,

  -- 営業禁止（NG）。値が入っていればアタックできない
  ng_reason text check (ng_reason in (
    'no_sales',       -- 営業禁止
    'unsubscribed',   -- 配信停止希望
    'no_form_sales',  -- 問い合わせフォーム営業禁止
    'partner',        -- 取引先
    'customer',       -- 既存顧客
    'competitor',     -- 競合
    'other'           -- その他
  )),
  ng_note text,

  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists uq_gw_sales_companies_domain
  on public.gw_sales_companies(tenant_id, domain) where domain is not null;
create index if not exists idx_gw_sales_companies_tenant
  on public.gw_sales_companies(tenant_id, status, next_action_on);
create index if not exists idx_gw_sales_companies_owner
  on public.gw_sales_companies(owner_id);

comment on table public.gw_sales_companies is
  '営業先の企業マスター。1社1行（domainで一意）。NGもこの行の ng_reason で持つ';

-- -----------------------------------------------------------------------------
-- 4) アタック（1回ごとの営業履歴）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_approaches (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  company_id    uuid not null references public.gw_sales_companies(id) on delete cascade,
  campaign_id   uuid references public.gw_sales_campaigns(id) on delete set null,
  template_id   uuid references public.gw_sales_templates(id) on delete set null,
  employee_id   uuid references public.gw_employees(id) on delete set null,   -- 誰が送ったか

  channel       text not null default 'form' check (channel in ('form')),
  service       text,          -- 提案サービス（送った時点）
  subject       text,
  body          text,          -- 営業文（送った時点のスナップショット）
  form_url      text,          -- 送ったフォームURL（送った時点）

  tracking_token  text not null,   -- /r/<token>。企業ごと・アタックごとに1つ
  destination_url text,            -- クリック後に飛ばす本来のページ

  prepared_at   timestamptz not null default now(),   -- 専用URLを発行した時刻
  sent_at       timestamptz,                          -- 「送信完了」を押した時刻
  forced        boolean not null default false,       -- 直近アタックの警告を押し切ったか（管理者のみ）

  first_click_at timestamptz,
  last_click_at  timestamptz,
  click_count    integer not null default 0,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_gw_sales_approaches_token
  on public.gw_sales_approaches(tracking_token);
create index if not exists idx_gw_sales_approaches_company
  on public.gw_sales_approaches(company_id, sent_at desc);
create index if not exists idx_gw_sales_approaches_tenant
  on public.gw_sales_approaches(tenant_id, sent_at desc);

comment on table public.gw_sales_approaches is
  '1回ごとのアタック。上書きしない。sent_at が空の行は「専用URLだけ発行して、まだ送っていない」';

-- -----------------------------------------------------------------------------
-- 5) クリック（追記だけ）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_click_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  approach_id     uuid not null references public.gw_sales_approaches(id) on delete cascade,
  company_id      uuid not null references public.gw_sales_companies(id) on delete cascade,
  clicked_at      timestamptz not null default now(),
  destination_url text,
  method          text,        -- GET / HEAD
  is_valid        boolean not null default true,   -- 人のクリックとして数えるか
  excluded_reason text check (excluded_reason in ('head', 'prefetch', 'no_ua', 'bot', 'duplicate')),
  click_no        integer,     -- そのアタックで何回目の有効クリックか（無効なものは null）
  user_agent      text,
  referrer        text,
  ip_hash         text         -- 日替わりの塩を混ぜたハッシュ。IPそのものは持たない
);

create index if not exists idx_gw_sales_click_events_company
  on public.gw_sales_click_events(company_id, clicked_at desc);
create index if not exists idx_gw_sales_click_events_tenant
  on public.gw_sales_click_events(tenant_id, clicked_at desc);
create index if not exists idx_gw_sales_click_events_approach
  on public.gw_sales_click_events(approach_id, is_valid, clicked_at desc);

-- 以前の版で表だけ先にできていた場合にも、列がそろうようにする（2回目以降は何もしない）
alter table public.gw_sales_click_events
  add column if not exists method          text,
  add column if not exists is_valid        boolean not null default true,
  add column if not exists excluded_reason text;

comment on table public.gw_sales_click_events is
  '専用URLへのアクセスのログ。機械・連打も含めて全部残す。数えるのは is_valid=true だけ';

-- -----------------------------------------------------------------------------
-- 6) 営業履歴（アタック・クリック以外の出来事）
--    フォロー・電話・返信あり・商談・状態の変更・メモ。
--    アタックとクリックはそれぞれの表から時系列に混ぜて出す（二重に書かない）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  company_id  uuid not null references public.gw_sales_companies(id) on delete cascade,
  event_key   text not null,   -- 'follow' / 'call' / 'mail' / 'reply' / 'meeting' / 'status' / 'memo' / 'next'
  label       text not null,   -- 画面に出す短い文（「フォロー」「返信あり」）
  detail      text,
  occurred_at timestamptz not null default now(),
  employee_id uuid references public.gw_employees(id) on delete set null,
  created_by  uuid references auth.users(id) on delete set null
);

create index if not exists idx_gw_sales_events_company
  on public.gw_sales_events(company_id, occurred_at);

-- -----------------------------------------------------------------------------
-- 7) 通知の種類に 'sales' を追加（既存 gw_notifications を再利用）
-- -----------------------------------------------------------------------------
--    ロールと同じく、いまの制約の値 ∪ 表にある値 ∪ 081までの一覧 ∪ 'sales' で張り直す（狭めない）
do $$
declare
  cur  text;
  vals text[];
begin
  if to_regclass('public.gw_notifications') is null then return; end if;

  select pg_get_constraintdef(oid) into cur
    from pg_constraint
   where conrelid = 'public.gw_notifications'::regclass and conname = 'gw_notifications_kind_check';

  select array_agg(distinct v order by v) into vals from (
    select m[1] as v from regexp_matches(coalesce(cur, ''), '''([^'']+)''', 'g') as m
     where m[1] !~ '[{},]'   -- 配列リテラルの丸ごと（'{a,b}'）は値として拾わない
    union select kind from public.gw_notifications where kind is not null
    union select unnest(array['general', 'task_overdue', 'task_assigned', 'notice', 'message',
                              'booking', 'expense', 'request', 'blocker', 'meeting', 'hr', 'sales'])
  ) s;

  alter table public.gw_notifications drop constraint if exists gw_notifications_kind_check;
  -- 081 までと同じ in (…) の形で張る（Postgres は ARRAY['a'::text, …] と表示するので、
  -- 次に流したときも上の正規表現で1つずつ読める。2回流しても値が増えない）
  execute format(
    'alter table public.gw_notifications add constraint gw_notifications_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(vals) as v));
end $$;

-- -----------------------------------------------------------------------------
-- 8) RLS：/sales を使える人（gw_is_sales）だけが読み書きできる。
--    専用URLのクリック（ログイン不要）は service_role（api/sales/r.js）経由でのみ書く
-- -----------------------------------------------------------------------------
alter table public.gw_sales_campaigns     enable row level security;
alter table public.gw_sales_templates     enable row level security;
alter table public.gw_sales_companies     enable row level security;
alter table public.gw_sales_approaches    enable row level security;
alter table public.gw_sales_click_events  enable row level security;
alter table public.gw_sales_events        enable row level security;

drop policy if exists gw_sales_campaigns_staff on public.gw_sales_campaigns;
create policy gw_sales_campaigns_staff on public.gw_sales_campaigns
  for all using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

drop policy if exists gw_sales_templates_staff on public.gw_sales_templates;
create policy gw_sales_templates_staff on public.gw_sales_templates
  for all using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

drop policy if exists gw_sales_companies_staff on public.gw_sales_companies;
create policy gw_sales_companies_staff on public.gw_sales_companies
  for all using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

drop policy if exists gw_sales_approaches_staff on public.gw_sales_approaches;
create policy gw_sales_approaches_staff on public.gw_sales_approaches
  for all using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

-- クリックは読むだけ（書くのは service_role の api/sales/r.js）
drop policy if exists gw_sales_click_events_staff on public.gw_sales_click_events;
create policy gw_sales_click_events_staff on public.gw_sales_click_events
  for select using (public.gw_is_sales(tenant_id));

drop policy if exists gw_sales_events_staff on public.gw_sales_events;
create policy gw_sales_events_staff on public.gw_sales_events
  for all using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認:
--   -- 自分が /sales を使えるか（ログインした状態で）
--   select public.gw_is_sales(tenant_id) as 営業可, display_name
--     from public.gw_employees where user_id = auth.uid();
--
--   -- 反応があった会社
--   select c.name, a.sent_at, a.first_click_at, a.last_click_at, a.click_count
--     from public.gw_sales_approaches a join public.gw_sales_companies c on c.id = a.company_id
--    where a.click_count > 0 order by a.last_click_at desc;
