-- =============================================================================
-- 115: /sales 案件（金額・ステージ）と、その履歴
--
-- 番号：main の db/ は 114（114_ai_assistant_seed）まで使っている（099 は3つ、100・101・105 は2つずつ、111 は欠番）。
--       open PR では #45 が 110_career_self_check を使う。111 はかつて社内AI（いまの 113・114）が使っていた番号のため避け、
--       どれとも重ならない 115 にする（旧名 db/100_sales_deals.sql。本番には未適用）。
--
--   1) gw_sales_deals        … 案件。1社に複数あってよい
--        stage   … meeting（商談）→ proposal（提案）→ negotiation（最終調整）→ won（成約）／ lost（失注）
--        amount  … 案件金額（円・税抜の想定。会計上の売上ではない）。未定なら null。成約には 0円より大きい値が必須
--        probability … 成約確率（0〜100）を案件ごとに上書きするとき。null なら画面の既定値
--                      （商談20%・提案50%・最終調整80%）を使う
--        approach_id … この案件のもとになったアタック（案件を作った時点で、その会社に最後に送ったもの）。
--                      作ったあとは一切変えられない（トリガーで止める。null にする更新も止める）。
--                      もとのアタックも消せない（FK は既定の NO ACTION。アプリが消すのは未送信のアタックだけで、
--                      案件が指すのは送信済みのアタックだけなので、ふだんの操作とはぶつからない）
--        owner_id … 担当。同じテナントの社員だけ（トリガーで止める。別テナントの社員・存在しない社員は入れられない）
--   2) gw_sales_deal_history … 作成時と、段階・金額・確率が変わるたびに1行（トリガーが書く。画面・APIからは書けない）
--        effective_probability … その時点で実際に使った成約確率（個別の設定、無ければその時点の既定値。
--                                成約は100・失注は0）。既定値をあとで変えても、過去の見込額を再現できる
--        過去のある時点の見込額・パイプラインを出すのと、段階ごとの実績成約率を出すのに使う
--
-- ■ 会社のステータス（gw_sales_companies.status）はここでは触らない
--   案件の段階に合わせて会社を「商談」「提案」「成約」へ進めるのは API（後ろへは戻さない）。
--   案件が失注しても、会社は失注にしない（ほかの案件・次の提案があるため。会社の失注は人が決める）
--
-- ■ 案件は消さない
--   案件の表には DELETE の権限が無い。会社（company_id）も NO ACTION なので、案件のある会社は DB でも消せない
--   （API の「案件のある企業は削除できない」と同じ）。テナントごと消すときだけ、案件も一緒に消える。
--
-- ■ 金額は営業の案件金額（会計上の売上ではない）。成約は 0円より大きい金額が要る
--   受注額＝期間内に成約した案件の金額の合計／見込額＝進行中の案件の 金額×成約確率／パイプライン＝進行中の案件の金額の合計
--
-- ■ 既存データは埋めない
--   いま「商談」「提案」「成約」の会社があっても、案件は作らない（金額が分からないものを受注額にしない）。
--
-- 何度流しても同じ結果になる。088・090・096・097・098 の後に流す（main の 114 までを流した本番に、そのまま流せる）。
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1) 案件
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_deals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  company_id   uuid not null references public.gw_sales_companies(id),    -- 既定の NO ACTION：案件のある会社は消せない
  approach_id  uuid references public.gw_sales_approaches(id),            -- 同上：もとのアタックは消せない
  owner_id     uuid references public.gw_employees(id) on delete set null,   -- 担当

  title        text not null check (char_length(title) between 1 and 200),  -- 「AI/DX 導入支援」
  service      text check (service is null or char_length(service) <= 100),

  stage        text not null default 'meeting'
    check (stage in ('meeting', 'proposal', 'negotiation', 'won', 'lost')),
  amount       bigint check (amount is null or amount between 0 and 100000000000),   -- 円。上限 1,000億円（案件金額。会計上の売上ではない）
  probability  smallint check (probability is null or probability between 0 and 100),  -- %
  expected_close_on date,                                                   -- 成約見込み日

  won_on       date,        -- 成約日（受注額はこの日で数える。日付は日本時間）
  lost_on      date,        -- 失注日
  lost_reason  text check (lost_reason is null or char_length(lost_reason) <= 500),
  note         text check (note is null or char_length(note) <= 2000),

  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 成約日は成約のときだけ・成約なら必ず。失注日も同じ
  constraint gw_sales_deals_won_on check ((stage = 'won') = (won_on is not null)),
  constraint gw_sales_deals_lost_on check ((stage = 'lost') = (lost_on is not null)),
  -- 金額の分からない成約・0円の成約は作らない（通常の営業案件の受注額に 0円を混ぜない）
  -- （amount > 0 だけだと null のとき CHECK が通ってしまうので、is not null も書く）
  constraint gw_sales_deals_won_amount check (stage <> 'won' or (amount is not null and amount > 0))
);

create index if not exists idx_gw_sales_deals_company
  on public.gw_sales_deals(company_id, created_at desc);
create index if not exists idx_gw_sales_deals_tenant_stage
  on public.gw_sales_deals(tenant_id, stage);
create index if not exists idx_gw_sales_deals_tenant_won
  on public.gw_sales_deals(tenant_id, won_on) where won_on is not null;
create index if not exists idx_gw_sales_deals_approach
  on public.gw_sales_deals(approach_id) where approach_id is not null;

comment on table public.gw_sales_deals is
  '営業の案件（金額・段階）。1社に複数可。受注額＝成約案件の金額（won_on で数える）。金額は営業の案件金額で、会計上の売上ではない';
comment on column public.gw_sales_deals.owner_id is
  '担当。同じテナントの社員だけ（gw_sales_deals_guard で止める）';
comment on column public.gw_sales_deals.approach_id is
  '案件のもとになったアタック（作成時点でその会社に最後に送ったもの）。作成後は変えられない（null にもできない）';

-- -----------------------------------------------------------------------------
-- 2) 案件の履歴（段階・金額・確率が変わるたび）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_deal_history (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  deal_id     uuid not null references public.gw_sales_deals(id) on delete cascade,
  company_id  uuid not null references public.gw_sales_companies(id),
  stage       text not null check (stage in ('meeting', 'proposal', 'negotiation', 'won', 'lost')),
  amount      bigint,
  probability smallint,                               -- 案件に個別に設定した確率（無ければ null）
  effective_probability smallint not null
    check (effective_probability between 0 and 100),  -- その時点で実際に使った確率
  changed_at  timestamptz not null default now(),
  changed_by  uuid references auth.users(id) on delete set null
);

create index if not exists idx_gw_sales_deal_history_deal
  on public.gw_sales_deal_history(deal_id, changed_at);
create index if not exists idx_gw_sales_deal_history_tenant
  on public.gw_sales_deal_history(tenant_id, changed_at);

comment on table public.gw_sales_deal_history is
  '案件の段階・金額・確率の履歴。トリガーだけが書く（画面・APIからは読むだけ）';

-- -----------------------------------------------------------------------------
-- 3) 書き込みの見張り（呼び出した人の権限で動く＝他テナントの会社・アタックは見えないので通らない）
--    ・会社とアタックが、案件と同じテナント・同じ会社のものか
--    ・担当（owner_id）が、案件と同じテナントの社員か（作るとき・担当を変えるとき）
--    ・作ったあとは テナント・会社・もとのアタック を変えられない
-- -----------------------------------------------------------------------------

-- 担当が案件と同じテナントの社員か。社員名簿（gw_employees）の RLS は is_tenant_staff なので、
-- 営業の権限だけの人は名簿を読めないことがある。そのため、この判定だけ security definer で名簿を見る。
-- 返すのは true / false だけ（名前などは返さない）。呼べるのはログインした人とサーバだけ
create or replace function public.gw_sales_deal_owner_ok(p_owner uuid, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_owner is not null and p_tenant is not null and exists (
    select 1 from public.gw_employees e where e.id = p_owner and e.tenant_id = p_tenant)
$$;
revoke all on function public.gw_sales_deal_owner_ok(uuid, uuid) from public;
revoke all on function public.gw_sales_deal_owner_ok(uuid, uuid) from anon;
grant execute on function public.gw_sales_deal_owner_ok(uuid, uuid) to authenticated, service_role;

create or replace function public.gw_sales_deals_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid;
  v_company uuid;
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id or new.company_id is distinct from old.company_id then
      raise exception 'gw_sales_deals: tenant_id / company_id は変えられません' using errcode = '23514';
    end if;
    -- もとのアタックは固定（別のアタックにも null にも変えられない）
    if new.approach_id is distinct from old.approach_id then
      raise exception 'gw_sales_deals: approach_id は案件を作ったあとは変えられません' using errcode = '23514';
    end if;
    -- 担当を変えるときは、同じテナントの社員だけ（null＝未定にするのはよい。社員が消えたときの on delete set null もここを通る）
    if new.owner_id is not null and new.owner_id is distinct from old.owner_id
       and not public.gw_sales_deal_owner_ok(new.owner_id, new.tenant_id) then
      raise exception 'gw_sales_deals: 担当が同じテナントの社員ではありません' using errcode = '23503';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.owner_id is not null and not public.gw_sales_deal_owner_ok(new.owner_id, new.tenant_id) then
    raise exception 'gw_sales_deals: 担当が同じテナントの社員ではありません' using errcode = '23503';
  end if;

  select tenant_id into v_tenant from public.gw_sales_companies where id = new.company_id;
  if v_tenant is null or v_tenant <> new.tenant_id then
    raise exception 'gw_sales_deals: 会社が見つかりません' using errcode = '23503';
  end if;
  if new.approach_id is not null then
    select company_id into v_company from public.gw_sales_approaches
     where id = new.approach_id and tenant_id = new.tenant_id;
    if v_company is null or v_company <> new.company_id then
      raise exception 'gw_sales_deals: アタックがこの会社のものではありません' using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists gw_sales_deals_guard on public.gw_sales_deals;
create trigger gw_sales_deals_guard
  before insert or update on public.gw_sales_deals
  for each row execute function public.gw_sales_deals_guard();

-- 段階ごとの既定の成約確率（%）。lib/sales-deals.js の DEFAULT_PROBABILITY と同じ値にする
-- （test/salesapi.mjs で突き合わせている）。変えるときは、この関数とJSの両方を変える。
-- 変えても、過去の履歴の effective_probability はその時点の値のまま残る
create or replace function public.gw_sales_deal_default_probability(p_stage text)
returns smallint
language sql
immutable
as $$
  select (case p_stage
    when 'meeting'     then 20
    when 'proposal'    then 50
    when 'negotiation' then 80
    when 'won'         then 100
    when 'lost'        then 0
  end)::smallint
$$;

-- 履歴を書く。履歴の表には画面・APIからの書き込み権限が無いので、ここだけ security definer
create or replace function public.gw_sales_deals_history_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.stage is distinct from old.stage
     or new.amount is distinct from old.amount
     or new.probability is distinct from old.probability then
    insert into public.gw_sales_deal_history
      (tenant_id, deal_id, company_id, stage, amount, probability, effective_probability, changed_by)
    values (new.tenant_id, new.id, new.company_id, new.stage, new.amount, new.probability,
            -- 成約・失注は 100・0。進行中は個別の設定、無ければその時点の既定値
            case when new.stage in ('won', 'lost') then public.gw_sales_deal_default_probability(new.stage)
                 else coalesce(new.probability, public.gw_sales_deal_default_probability(new.stage)) end,
            coalesce(new.updated_by, new.created_by));
  end if;
  return null;
end $$;
revoke all on function public.gw_sales_deals_history_trg() from public;

drop trigger if exists gw_sales_deals_history on public.gw_sales_deals;
create trigger gw_sales_deals_history
  after insert or update of stage, amount, probability on public.gw_sales_deals
  for each row execute function public.gw_sales_deals_history_trg();

-- -----------------------------------------------------------------------------
-- 4) RLS（ほかの /sales の表と同じ gw_is_sales。テナントごとに分かれる）
--    案件は 読む・作る・直す だけ。消すことはできない（履歴を残すため。間違いは「失注」か金額の修正で）
--    履歴は 読むだけ
-- -----------------------------------------------------------------------------
alter table public.gw_sales_deals        enable row level security;
alter table public.gw_sales_deal_history enable row level security;

drop policy if exists gw_sales_deals_select on public.gw_sales_deals;
create policy gw_sales_deals_select on public.gw_sales_deals
  for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_deals_insert on public.gw_sales_deals;
create policy gw_sales_deals_insert on public.gw_sales_deals
  for insert with check (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_deals_update on public.gw_sales_deals;
create policy gw_sales_deals_update on public.gw_sales_deals
  for update using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

drop policy if exists gw_sales_deal_history_select on public.gw_sales_deal_history;
create policy gw_sales_deal_history_select on public.gw_sales_deal_history
  for select using (public.gw_is_sales(tenant_id));

commit;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- 確認用
-- -----------------------------------------------------------------------------
-- select stage, count(*), sum(amount) from public.gw_sales_deals group by stage order by 1;
-- select count(*) from public.gw_sales_deal_history;
-- 担当が別テナントの社員になっている案件（0件のはず）
-- select count(*) from public.gw_sales_deals d join public.gw_employees e on e.id = d.owner_id where e.tenant_id <> d.tenant_id;

-- =============================================================================
-- ロールバック（戻すときだけ。先にアプリを 115 より前の版へ戻してから。案件と履歴は消えます）
-- =============================================================================
-- begin;
-- drop table if exists public.gw_sales_deal_history;
-- drop table if exists public.gw_sales_deals;
-- drop function if exists public.gw_sales_deals_history_trg();
-- drop function if exists public.gw_sales_deals_guard();
-- drop function if exists public.gw_sales_deal_owner_ok(uuid, uuid);
-- drop function if exists public.gw_sales_deal_default_probability(text);
-- commit;
