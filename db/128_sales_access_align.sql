-- =============================================================================
-- 128: Sales の権限判定を API と DB でそろえる（AI営業 PR0）
--
-- ■ 何が問題だったか
--   API（lib/gw.js canSell / canAccessSales）は「経営者（owner ロール）または Sales のアプリ権限」で通す。
--   DB の RLS（gw_is_sales。db/094）は「owner・manager・sales のロール」で通す（アプリ権限を見ない）。
--   そのため、
--     ・Sales のアプリ権限だけの人 … API は通るのに DB で止まる（一覧が空・保存できない）
--     ・manager / sales のロールだけでアプリ権限の無い人 … API では止まるが、PostgREST を直接呼べば DB は通る
--   が起きていた。
--
-- ■ 何を変えるか
--   gw_is_sales を「owner ロール または Sales のアプリ権限」にする（API の canSell と同じ）。
--   ポリシーは変えない（gw_sales_* のポリシーが呼ぶ関数の中身だけを置き換える）。owner の扱いは変わらない。
--   退職者は、これまでどおり gw_has_role / gw_has_app（db/120）が「入れない」と答える。
--
-- ■ フェイルクローズ（判定できないときは権限を広げない）
--   ・前提（db/119 の gw_app_grants・gw_has_app、gw_has_role、db/094 の gw_is_sales）が無ければ、
--     何も変えずにエラーで止まる。「表が無いからロールで代用」「全員 OK」には倒さない。
--   ・実行時に判定の部品が読めなければ、関数がエラーになり、RLS は行を返さない（拒否）。
--
-- ■ 実行順
--   1. docs/sql/ai-sales-prod-check.sql の 06 で、使えるようになる人・使えなくなる人を確かめる
--   2. この db/128 を Supabase の SQL Editor で Run
--   3. db/check_128_sales_access.sql で確認（❌ が無いこと）
--   戻すとき：db/rollback_128_sales_access.sql
-- =============================================================================
begin;

do $$
begin
  if to_regclass('public.gw_app_grants') is null then
    raise exception 'db/128: public.gw_app_grants がありません（先に db/119 を適用してください）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_has_app(uuid,text)') is null then
    raise exception 'db/128: public.gw_has_app(uuid,text) がありません（先に db/119・db/120 を適用してください）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_has_role(uuid,text)') is null then
    raise exception 'db/128: public.gw_has_role(uuid,text) がありません。何も変更していません';
  end if;
  if to_regprocedure('public.gw_is_sales(uuid)') is null then
    raise exception 'db/128: public.gw_is_sales(uuid) がありません（先に db/088・db/094 を適用してください）。何も変更していません';
  end if;
end $$;

create or replace function public.gw_is_sales(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_app(p_tenant, 'sales')
$$;

comment on function public.gw_is_sales(uuid) is
  '営業アタック管理（/sales）を使える人。経営者（owner ロール）または Sales のアプリ権限（gw_app_grants の sales）がある人。'
  '退職者は入れない（gw_has_role / gw_has_app）。lib/gw.js canSell と同じ（db/128。db/094 のロール判定から変更）';

commit;
