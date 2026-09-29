-- =============================================================================
-- 098: /sales 企業一覧の「担当者名」「NEXT（実効）」並べ替え
--
-- 097 は本番適用済みなので、097 のファイルは書き換えない。追加・置き換えはすべてここで行う。
--
--   1) gw_sales_companies.last_click_at … 最後の有効クリック日時（max(last_click_at)）の写し。
--      「未対応クリック」（最後のクリックが、クリック対応済み followed_at より後）を DB で判定するため。
--      097 の写し更新関数 gw_sales_company_rollup を置き換えて、この列も一緒に取り直す
--      （トリガーは 097 のまま。関数の中身だけが変わる）
--   2) view gw_sales_company_list … 企業の行に、並べ替え用の列を足したもの（security_invoker）
--        owner_name … 担当者の表示名（画面に出している名前で並べる）
--        next_group … 画面の NEXT（lib/sales.js nextFor）の種類を急ぐ順に数にしたもの
--                     0 未対応クリック（クリックあり・要フォロー）
--                     1 期限つきの NEXT        2 期限なしの NEXT
--                     3 フォームアタック（未アタック・再アタック待ち）
--                     4 NEXTを決める           5 営業禁止・成約・失注・対象外（やること無し）
--        next_due   … 画面に出している NEXT の期限（未対応クリックは、クリック時に決めた期限か今日）
--
-- 何度流しても同じ結果になる。097 の後に流す。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 最後のクリック日時の写し
-- -----------------------------------------------------------------------------
alter table public.gw_sales_companies
  add column if not exists last_click_at timestamptz;

-- 097 の関数を置き換える（引数・戻り値は同じ。last_click_at も取り直すようにする）
create or replace function public.gw_sales_company_rollup(p_company uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.gw_sales_companies c
     set last_sent_at  = s.last_sent_at,
         click_count   = s.click_count,
         last_click_at = s.last_click_at
    from (select max(a.sent_at) as last_sent_at,
                 coalesce(sum(a.click_count), 0)::int as click_count,
                 max(a.last_click_at) as last_click_at
            from public.gw_sales_approaches a
           where a.company_id = p_company) s
   where c.id = p_company
     and (c.last_sent_at is distinct from s.last_sent_at
          or c.click_count is distinct from s.click_count
          or c.last_click_at is distinct from s.last_click_at);
$$;
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

-- クリックは gw_sales_approaches の click_count と last_click_at を同じ UPDATE で変える
-- （api/sales/r.js）。097 のトリガーは click_count の変更で動くので、last_click_at も一緒に写る。

-- いまある分を埋める（2回流しても同じ値になる）
update public.gw_sales_companies c
   set last_click_at = s.last_click_at
  from (select company_id, max(last_click_at) as last_click_at
          from public.gw_sales_approaches
         group by company_id) s
 where s.company_id = c.id
   and c.last_click_at is distinct from s.last_click_at;

-- -----------------------------------------------------------------------------
-- 2) 並べ替え用の view（画面の NEXT と同じ判定。lib/sales.js nextFor と1対1）
-- -----------------------------------------------------------------------------
create or replace view public.gw_sales_company_list
  with (security_invoker = true)
as
  select c.*,
         e.display_name as owner_name,
         case
           when c.ng_reason is not null
             or c.status in ('won', 'lost', 'excluded') then 5
           when c.last_click_at is not null
            and (c.followed_at is null or c.followed_at < c.last_click_at) then 0
           when c.next_action_on is not null then 1
           when c.next_action is not null then 2
           when c.status in ('untouched', 'reattack_wait') then 3
           else 4
         end::smallint as next_group,
         case
           when c.ng_reason is not null
             or c.status in ('won', 'lost', 'excluded') then null
           when c.last_click_at is not null
            and (c.followed_at is null or c.followed_at < c.last_click_at) then
             case when c.next_action = 'クリックあり・要フォロー' and c.next_action_on is not null
                  then c.next_action_on
                  else (now() at time zone 'Asia/Tokyo')::date end
           else c.next_action_on
         end as next_due
    from public.gw_sales_companies c
    left join public.gw_employees e on e.id = c.owner_id;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on public.gw_sales_company_list to authenticated;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 確認用
-- -----------------------------------------------------------------------------
-- select count(*) filter (where last_click_at is not null) as clicked from public.gw_sales_companies;
-- select next_group, count(*) from public.gw_sales_company_list group by next_group order by 1;

-- =============================================================================
-- ロールバック（戻すときだけ。先にアプリを 098 より前の版へ戻してから）
--   関数は 097 の中身（last_click_at を触らない版）に戻す
-- =============================================================================
-- begin;
-- drop view if exists public.gw_sales_company_list;
-- create or replace function public.gw_sales_company_rollup(p_company uuid)
-- returns void language sql security definer set search_path = public as $f$
--   update public.gw_sales_companies c
--      set last_sent_at = s.last_sent_at, click_count = s.click_count
--     from (select max(a.sent_at) as last_sent_at, coalesce(sum(a.click_count), 0)::int as click_count
--             from public.gw_sales_approaches a where a.company_id = p_company) s
--    where c.id = p_company
--      and (c.last_sent_at is distinct from s.last_sent_at or c.click_count is distinct from s.click_count);
-- $f$;
-- alter table public.gw_sales_companies drop column if exists last_click_at;
-- commit;
