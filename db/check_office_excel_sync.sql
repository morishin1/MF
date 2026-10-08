-- =============================================================================
-- Office 定例業務の Excel 同期（db/128）の状態確認。読み取りだけ（何も書き換えない）。
-- Supabase の SQL Editor で全体を貼って Run。1つの表で結果が出る（表が無くてもエラーにしない）。
--
-- 結果の見かた（業務の文言・個人名は出さない。件数と日時だけ）
--   ✅/⚠ 1 同期の履歴の表がある（db/128）
--   ✅/⚠ 2 RLS が有効
--   ✅/⚠ 3 ポリシーが0件
--   ✅/⚠ 4 同時実行を止める一意の索引がある
--   ✅/⚠ 5 同期中（applying）のまま残っているものが無い（あれば、途中で止まった同期。もう一度同期すると直る）
--   ℹ 6 最後に完了した同期（期・日時・件数）
--   ℹ 7 Excel 由来のマスター数（有効／停止）と、手動のマスター数
-- =============================================================================
with t as (select to_regclass('public.gw_office_excel_syncs') as rel),
x as (
  select case when (select rel from t) is null then null else
    (query_to_xml($q$select
        (select count(*) from public.gw_office_excel_syncs where status = 'applying') as applying,
        (select period_start || '｜' || to_char(committed_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI')
                || '｜新規' || new_count || '・更新' || update_count || '・変更なし' || unchanged_count
                || '・停止' || stop_count || '・再有効化' || reactivate_count
           from public.gw_office_excel_syncs where status = 'committed' order by committed_at desc limit 1) as last_sync$q$,
      false, false, '')) end as v
)
select '1 同期の履歴の表（db/128）' as 項目,
       case when (select rel from t) is not null then '✅' else '⚠ ありません（db/128 を流してください）' end as 結果
union all
select '2 RLS が有効',
       case when exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relname = 'gw_office_excel_syncs' and c.relrowsecurity) then '✅' else '⚠' end
union all
select '3 ポリシーが0件',
       case when (select rel from t) is null then '⚠（表がありません）'
            when not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_office_excel_syncs') then '✅' else '⚠ ポリシーがあります' end
union all
select '4 同時実行を止める一意の索引',
       case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_gw_office_excel_syncs_lock') then '✅' else '⚠' end
union all
select '5 同期中のまま残っているもの',
       case when (select v from x) is null then '⚠（表がありません）'
            when coalesce((xpath('/row/applying/text()', (select v from x)))[1]::text, '0') = '0' then '✅ 0件'
            else '⚠ ' || (xpath('/row/applying/text()', (select v from x)))[1]::text || '件（もう一度同期すると直ります）' end
union all
select '6 最後に完了した同期',
       'ℹ ' || coalesce((xpath('/row/last_sync/text()', (select v from x)))[1]::text, 'まだありません')
union all
select '7 定例業務マスター',
       case when to_regclass('public.gw_office_recurring_tasks') is null then '⚠ 定例業務の表がありません（db/125）'
       else 'ℹ ' || (xpath('/row/v/text()', query_to_xml($q$select
              'Excel 由来：有効 ' || count(*) filter (where source = 'excel' and is_active)
              || '・停止 ' || count(*) filter (where source = 'excel' and not is_active)
              || '／手動：' || count(*) filter (where source = 'manual') as v
              from public.gw_office_recurring_tasks$q$, false, false, '')))[1]::text end;
