-- =============================================================================
-- db/140（提案管理の起点をマッチング確定にする）の確認（読み取りだけ。何も書き換えない）
--
-- 流す前でもエラーにならないよう、表・列が無い行は ❌ になるだけ（表を読む行は query_to_xml で実行時に読む）。
-- Supabase の SQL Editor に貼って Run。結果は「項目 / 状態 / 詳細」。❌ の行があれば db/140 が当たっていない。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（件数）
-- =============================================================================
with col(tbl, name) as (
  values ('gw_sales_proposals', 'matched_at'), ('gw_sales_proposals', 'slack_notified_at'),
         ('gw_sales_proposal_settings', 'slack_members')
),
con as (
  select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
   where t.relname in ('gw_sales_proposals', 'gw_sales_proposal_activities', 'gw_sales_proposal_tasks', 'gw_sales_proposal_settings')
),
rows(seq, item, ok, detail) as (
  select 1, '列がある（matched_at・slack_notified_at・slack_members）',
         (select count(*) = 3 from col c join information_schema.columns i
            on i.table_schema = 'public' and i.table_name = c.tbl and i.column_name = c.name),
         (select coalesce(string_agg(c.tbl || '.' || c.name, ', '), '') from col c
           where not exists (select 1 from information_schema.columns i
                              where i.table_schema = 'public' and i.table_name = c.tbl and i.column_name = c.name))
  union all
  select 2, '企業へ提案を送る前は sent_at を空にできる（NOT NULL を外した）',
         exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'gw_sales_proposals'
                  and column_name = 'sent_at' and is_nullable = 'YES'),
         ''
  union all
  select 3, '状態に「マッチング済み・提案待ち」（proposal_wait）がある',
         exists (select 1 from con where conname = 'gw_sales_proposals_status_chk' and def like '%proposal_wait%')
           and not exists (select 1 from con where conname = 'gw_sales_proposals_status_check'),
         ''
  union all
  select 4, '提案待ちは送信日時が空・起点（確定か送信）は必ずある（CHECK）',
         (select count(*) = 2 from con where conname in ('gw_sales_proposals_wait_chk', 'gw_sales_proposals_start_chk')),
         ''
  union all
  select 5, '記録の種類に「マッチング確定」（matched）がある',
         exists (select 1 from con where conname = 'gw_sales_proposal_activities_kind_chk' and def like '%matched%')
           and not exists (select 1 from con where conname = 'gw_sales_proposal_activities_kind_check'),
         ''
  union all
  select 6, 'タスクの種類に「提案準備」（prepare）がある',
         exists (select 1 from con where conname = 'gw_sales_proposal_tasks_kind_chk' and def like '%prepare%')
           and not exists (select 1 from con where conname = 'gw_sales_proposal_tasks_kind_check'),
         ''
  union all
  select 7, '送信日時・確定日時は「空 → 日時」の1回だけ（見張りのトリガー）',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                  where p.proname = 'gw_sales_proposals_guard' and p.prosrc like '%送信日時は変えられません%'
                    and p.prosrc like '%マッチング確定の日時は変えられません%')
           and exists (select 1 from pg_trigger where tgname = 'gw_sales_proposals_guard' and not tgisinternal),
         ''
  union all
  select 8, '提案待ちなのに送信日時が入っている提案が無い',
         case when not exists (select 1 from information_schema.columns where table_schema = 'public'
                                and table_name = 'gw_sales_proposals' and column_name = 'matched_at') then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_sales_proposals where status = ''proposal_wait'' and sent_at is not null', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 9, '提案待ちなのに電話のタスクが開いている提案が無い（30分の期限は提案送信から）',
         case when to_regclass('public.gw_sales_proposal_tasks') is null then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_sales_proposal_tasks t join public.gw_sales_proposals p on p.id = t.proposal_id
                       where p.status = ''proposal_wait'' and t.status = ''open'' and t.kind in (''call'', ''mail'', ''reply_check'', ''refollow'')',
                     false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 10, 'ℹ 提案待ちの提案（うち提案準備の期限超過）', null,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public'
                                and table_name = 'gw_sales_proposals' and column_name = 'matched_at') then '列なし'
              else coalesce((xpath('/row/v/text()', query_to_xml(
                     'select (select count(*) from public.gw_sales_proposals where status = ''proposal_wait'') || '' 件（期限超過 ''
                          || (select count(*) from public.gw_sales_proposal_tasks where kind = ''prepare'' and status = ''open'' and due_at < now())
                          || '' 件）'' as v', false, true, '')))[1]::text, '0件') end
  union all
  select 11, 'ℹ Slack に知らせた提案', null,
         case when not exists (select 1 from information_schema.columns where table_schema = 'public'
                                and table_name = 'gw_sales_proposals' and column_name = 'slack_notified_at') then '列なし'
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_sales_proposals where slack_notified_at is not null', false, true, '')))[1]::text || ' 件' end
)
select item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
