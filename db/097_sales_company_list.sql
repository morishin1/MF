-- =============================================================================
-- 097: /sales 企業一覧のサーバー側ページング・ソート・CSV
--
-- 企業一覧は「DBで絞る → DBで並べる → DBで100件に切る」にする（要件：100件だけ取得する）。
-- そのために、アタックの表から毎回集計していた値のうち、並べ替えに使うものを
-- 企業の行に持たせる（集計結果の写し。正はこれまでどおり gw_sales_approaches）。
--
--   1) gw_sales_companies.last_sent_at … 最後に「送信完了」した日時（max(sent_at)）
--      gw_sales_companies.click_count  … 有効クリックの合計（sum(click_count)）
--      → gw_sales_approaches が変わるたびにトリガーで取り直す（アプリ側で書き忘れても揃う）
--   2) gw_sales_companies.status_rank … ステータスを営業の進み順で並べるための数（生成列）
--   3) gw_sales_company_facets（view）… 絞り込みの候補（業種・地域・商材）を件数つきで。
--      全社を画面へ送らずに候補を作るため。security_invoker なので RLS はそのまま効く
--
-- 何度流しても同じ結果になる。088・096 の後に流す。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 並べ替え用の写し（最終アタック・クリック数）
-- -----------------------------------------------------------------------------
alter table public.gw_sales_companies
  add column if not exists last_sent_at timestamptz,
  add column if not exists click_count  integer not null default 0;

-- 1社ぶんを取り直す。アタックの行数は1社あたり多くても数十なので軽い
create or replace function public.gw_sales_company_rollup(p_company uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.gw_sales_companies c
     set last_sent_at = s.last_sent_at,
         click_count  = s.click_count
    from (select max(a.sent_at) as last_sent_at, coalesce(sum(a.click_count), 0)::int as click_count
            from public.gw_sales_approaches a
           where a.company_id = p_company) s
   where c.id = p_company
     and (c.last_sent_at is distinct from s.last_sent_at or c.click_count is distinct from s.click_count);
$$;
-- 画面・API から直接呼ばせない（トリガーからだけ使う）
revoke all on function public.gw_sales_company_rollup(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.gw_sales_company_rollup(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.gw_sales_company_rollup(uuid) from authenticated;
  end if;
end $$;

create or replace function public.gw_sales_approaches_rollup_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.gw_sales_company_rollup(new.company_id);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.company_id is distinct from new.company_id) then
    perform public.gw_sales_company_rollup(old.company_id);
  end if;
  return null;
end $$;

drop trigger if exists gw_sales_approaches_rollup on public.gw_sales_approaches;
create trigger gw_sales_approaches_rollup
  after insert or delete or update of sent_at, click_count, company_id
  on public.gw_sales_approaches
  for each row execute function public.gw_sales_approaches_rollup_trg();

-- いまある分を埋める（2回流しても同じ値になる）
update public.gw_sales_companies c
   set last_sent_at = s.last_sent_at,
       click_count  = s.click_count
  from (select company_id, max(sent_at) as last_sent_at, coalesce(sum(click_count), 0)::int as click_count
          from public.gw_sales_approaches
         group by company_id) s
 where s.company_id = c.id
   and (c.last_sent_at is distinct from s.last_sent_at or c.click_count is distinct from s.click_count);

-- -----------------------------------------------------------------------------
-- 2) ステータスの並び順（lib/sales.js の STATUSES と同じ順）
-- -----------------------------------------------------------------------------
alter table public.gw_sales_companies
  add column if not exists status_rank smallint generated always as (
    case status
      when 'untouched'     then 0
      when 'attacked'      then 1
      when 'clicked'       then 2
      when 'replied'       then 3
      when 'meeting'       then 4
      when 'proposal'      then 5
      when 'won'           then 6
      when 'reattack_wait' then 7
      when 'lost'          then 8
      when 'excluded'      then 9
      else 10
    end
  ) stored;

-- -----------------------------------------------------------------------------
-- 3) 絞り込みの候補（業種・地域・商材）
-- -----------------------------------------------------------------------------
create or replace view public.gw_sales_company_facets
  with (security_invoker = true)
as
  select tenant_id, 'industry'::text as kind, industry as value, count(*)::int as n
    from public.gw_sales_companies where industry is not null group by tenant_id, industry
  union all
  select tenant_id, 'region'::text, region, count(*)::int
    from public.gw_sales_companies where region is not null group by tenant_id, region
  union all
  select tenant_id, 'service'::text, service, count(*)::int
    from public.gw_sales_companies where service is not null group by tenant_id, service;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on public.gw_sales_company_facets to authenticated;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 索引は足さない。
--   一覧は tenant_id（既存の idx_gw_sales_companies_tenant・idx_gw_sales_companies_hidden）で
--   1テナントの行に絞ってから並べる。1万社・アタック5万件で EXPLAIN ANALYZE した結果は PR に記載。
--   足すなら、実データで遅い並べ方が出てから、その列だけにする。
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 確認用
-- -----------------------------------------------------------------------------
-- select count(*) filter (where last_sent_at is not null) as sent, sum(click_count) as clicks from public.gw_sales_companies;
-- select kind, count(*) from public.gw_sales_company_facets group by kind;

-- =============================================================================
-- ロールバック（戻すときだけ。先にアプリを 097 より前の版へ戻してから）
-- =============================================================================
-- begin;
-- drop view if exists public.gw_sales_company_facets;
-- drop trigger if exists gw_sales_approaches_rollup on public.gw_sales_approaches;
-- drop function if exists public.gw_sales_approaches_rollup_trg();
-- drop function if exists public.gw_sales_company_rollup(uuid);
-- alter table public.gw_sales_companies
--   drop column if exists status_rank, drop column if exists last_sent_at, drop column if exists click_count;
-- commit;
