-- =============================================================================
-- 100: /sales 案件（金額・ステージ）と、その履歴
--
-- 番号：097 は本番で2つ（097_sales_company_list・097_sign_contract_link）使われ、
--       099 は 097_sign_contract_link の付け直し（別PR）で使う予定のため、100 にする。
--
--   1) gw_sales_deals        … 案件。1社に複数あってよい
--        stage   … meeting（商談）→ proposal（提案）→ negotiation（最終調整）→ won（成約）／ lost（失注）
--        amount  … 案件金額（円・税抜の想定）。未定なら null。成約には必須
--        probability … 成約確率（0〜100）を案件ごとに上書きするとき。null なら画面の既定値
--                      （商談20%・提案50%・最終調整80%）を使う
--        approach_id … この案件のもとになったアタック（案件を作った時点で、その会社に最後に送ったもの）。
--                      作ったあとは変えられない（トリガーで止める。アタックが消えたときの null だけは通す）
--   2) gw_sales_deal_history … 段階・金額・確率が変わるたびに1行（トリガーが書く。画面・APIからは書けない）
--        過去のある時点の見込売上・パイプラインを出すのと、段階ごとの実績成約率を出すのに使う
--
-- ■ 会社のステータス（gw_sales_companies.status）はここでは触らない
--   案件の段階に合わせて会社を「商談」「提案」「成約」へ進めるのは API（後ろへは戻さない）。
--   案件が失注しても、会社は失注にしない（ほかの案件・次の提案があるため。会社の失注は人が決める）
--
-- ■ 既存データは埋めない
--   いま「商談」「提案」「成約」の会社があっても、案件は作らない（金額が分からないものを売上にしない）。
--
-- 何度流しても同じ結果になる。088・090・096・097・098 の後に流す。
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1) 案件
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_deals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  company_id   uuid not null references public.gw_sales_companies(id) on delete cascade,
  approach_id  uuid references public.gw_sales_approaches(id) on delete set null,
  owner_id     uuid references public.gw_employees(id) on delete set null,   -- 担当

  title        text not null check (char_length(title) between 1 and 200),  -- 「AI/DX 導入支援」
  service      text check (service is null or char_length(service) <= 100),

  stage        text not null default 'meeting'
    check (stage in ('meeting', 'proposal', 'negotiation', 'won', 'lost')),
  amount       bigint check (amount is null or amount between 0 and 100000000000),   -- 円。上限 1,000億円
  probability  smallint check (probability is null or probability between 0 and 100),  -- %
  expected_close_on date,                                                   -- 成約見込み日

  won_on       date,        -- 成約日（売上はこの日で数える）
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
  -- 金額の分からない成約は作らない（売上に「0円の成約」を混ぜない）
  constraint gw_sales_deals_won_amount check (stage <> 'won' or amount is not null)
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
  '営業の案件（金額・段階）。1社に複数可。売上＝成約案件の金額（won_on で数える）';
comment on column public.gw_sales_deals.approach_id is
  '案件のもとになったアタック（作成時点でその会社に最後に送ったもの）。作成後は変えない';

-- -----------------------------------------------------------------------------
-- 2) 案件の履歴（段階・金額・確率が変わるたび）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_deal_history (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  deal_id     uuid not null references public.gw_sales_deals(id) on delete cascade,
  company_id  uuid not null references public.gw_sales_companies(id) on delete cascade,
  stage       text not null check (stage in ('meeting', 'proposal', 'negotiation', 'won', 'lost')),
  amount      bigint,
  probability smallint,
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
--    ・作ったあとは テナント・会社・もとのアタック を変えられない
-- -----------------------------------------------------------------------------
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
    -- もとのアタックは固定。アタックが消えて null になる（on delete set null）ときだけ通す
    if new.approach_id is not null and new.approach_id is distinct from old.approach_id then
      raise exception 'gw_sales_deals: approach_id は案件を作ったあとは変えられません' using errcode = '23514';
    end if;
    new.updated_at := now();
    return new;
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
    insert into public.gw_sales_deal_history (tenant_id, deal_id, company_id, stage, amount, probability, changed_by)
    values (new.tenant_id, new.id, new.company_id, new.stage, new.amount, new.probability,
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

-- =============================================================================
-- ロールバック（戻すときだけ。先にアプリを 100 より前の版へ戻してから。案件と履歴は消えます）
-- =============================================================================
-- begin;
-- drop table if exists public.gw_sales_deal_history;
-- drop table if exists public.gw_sales_deals;
-- drop function if exists public.gw_sales_deals_history_trg();
-- drop function if exists public.gw_sales_deals_guard();
-- commit;
