-- =============================================================================
-- db/138（/sales 提案管理）の確認（読み取りだけ。何も書き換えない）
--
-- 表が無い環境でもエラーにならないよう、表を読む行は query_to_xml で実行時に読む。
-- Supabase の SQL Editor に貼って Run。結果は「項目 / 状態 / 詳細」。❌ の行があれば db/138 が当たっていない。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（件数）
-- =============================================================================
with tbl(name) as (
  values ('gw_sales_proposals'), ('gw_sales_proposal_activities'), ('gw_sales_proposal_tasks'),
         ('gw_sales_proposal_settings'), ('gw_sales_proposal_sync_log'), ('gw_sales_company_links')
),
pol as (
  select c.relname as tbl, p.polname, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relname in (select name from tbl)
),
fn(sig) as (
  values ('public.gw_sales_is_manager(uuid)'), ('public.gw_sales_proposal_visible(uuid,uuid)'),
         ('public.gw_sales_proposal_visible_id(uuid)'), ('public.gw_sales_employee_ok(uuid,uuid)')
),
rows(seq, item, ok, detail) as (
  select 1, '6つの表がある',
         (select count(*) = 6 from tbl where to_regclass('public.' || name) is not null),
         (select coalesce(string_agg(name, ', '), '') from tbl where to_regclass('public.' || name) is null)
  union all
  select 2, '6つの表で RLS が有効',
         (select count(*) = 6 from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where c.relname in (select name from tbl) and c.relrowsecurity),
         ''
  union all
  select 3, '判定の関数（4つ）がある',
         (select count(*) = 4 from fn where to_regprocedure(sig) is not null),
         (select coalesce(string_agg(sig, ', '), '') from fn where to_regprocedure(sig) is null)
  union all
  select 4, 'ポリシーは全部 gw_is_sales を通す',
         not exists (select 1 from pol where expr not ilike '%gw_is_sales%') and exists (select 1 from pol),
         (select coalesce(string_agg(tbl || '.' || polname, ', '), '') from pol where expr not ilike '%gw_is_sales%')
  union all
  select 5, '消すポリシーが無い（提案・記録・タスクは消さない）',
         not exists (select 1 from pol where polcmd in ('d', '*')),
         (select coalesce(string_agg(tbl || '.' || polname, ', '), '') from pol where polcmd in ('d', '*'))
  union all
  select 6, '行動の記録に直すポリシーが無い（追記だけ）',
         not exists (select 1 from pol where tbl = 'gw_sales_proposal_activities' and polcmd = 'w'),
         ''
  union all
  select 7, '連携の記録に足すポリシーが無い（書くのはサーバだけ）',
         not exists (select 1 from pol where tbl = 'gw_sales_proposal_sync_log' and polcmd = 'a'),
         ''
  union all
  select 8, '同じ dx.enger の提案は1件（一意索引）',
         to_regclass('public.uq_gw_sales_proposals_source') is not null, ''
  union all
  select 9, '同じ自動タスクは1つ（一意索引）',
         to_regclass('public.uq_gw_sales_proposal_tasks_event') is not null, ''
  union all
  select 10, '同じ連携イベントは1回（一意索引）',
         to_regclass('public.uq_gw_sales_proposal_sync_log_event') is not null, ''
  union all
  select 11, 'タスクの完了は記録が要る（CHECK）',
         exists (select 1 from pg_constraint where conname = 'gw_sales_proposal_tasks_done'), ''
  union all
  select 12, '電話の記録は結果と実施者が要る（CHECK）',
         exists (select 1 from pg_constraint where conname = 'gw_sales_proposal_activities_call'), ''
  union all
  select 13, '見張りのトリガー（提案・記録・タスク）がある',
         (select count(*) = 3 from pg_trigger where tgname in
           ('gw_sales_proposals_guard', 'gw_sales_proposal_activities_guard', 'gw_sales_proposal_tasks_guard') and not tgisinternal),
         ''
  union all
  select 14, '完了なのに記録の無いタスクが無い',
         case when to_regclass('public.gw_sales_proposal_tasks') is null then false
              else (xpath('/row/count/text()', query_to_xml('select count(*) from public.gw_sales_proposal_tasks where status = ''done'' and done_activity_id is null', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 15, 'ℹ 提案の件数（状態ごと）', null,
         case when to_regclass('public.gw_sales_proposals') is null then '表なし'
              else coalesce((xpath('/row/v/text()', query_to_xml(
                     'select string_agg(status || '' '' || n, '' / '' order by status) as v
                        from (select status, count(*) n from public.gw_sales_proposals group by status) s', false, true, '')))[1]::text, '0件') end
  union all
  select 16, 'ℹ 未解決の連携エラー・要確認', null,
         case when to_regclass('public.gw_sales_proposal_sync_log') is null then '表なし'
              else (xpath('/row/count/text()', query_to_xml('select count(*) from public.gw_sales_proposal_sync_log where status <> ''ok'' and resolved_at is null', false, true, '')))[1]::text || ' 件' end
)
select item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
