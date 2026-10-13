-- =============================================================================
-- db/134（Office「請求・支払」を一般経費に広げる）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は1つの表「# / 項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい
-- 1〜10 がすべて ✅、11〜13 は件数（既存の BP 請求が壊れていないことの確認）。
--
-- db/134 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ（列が無いときは件数を数えない）。
-- psql 専用のコマンド（\set など）は使っていない。
-- =============================================================================

with
want_tables(t) as (
  values ('gw_office_vendors'), ('gw_office_invoice_journals'), ('gw_office_mf_exports'),
         ('gw_office_mf_export_items'), ('gw_office_payables_settings')
),
tbl as (
  select c.relname, c.relrowsecurity as rls,
         (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname in (select t from want_tables)
),
inv_cols as (
  select column_name from information_schema.columns
   where table_schema = 'public' and table_name = 'gw_vendor_invoices'
     and column_name in ('vendor_id', 'invoice_kind', 'invoice_date', 'closing_day', 'payment_terms', 'payment_due_on', 'due_source',
                         'registration_no', 'description', 'payment_method', 'source_account', 'source_sub_account', 'file_path', 'file_name', 'file_mime', 'file_size', 'file_sha256',
                         'journal_status', 'journal_date', 'journal_confirmed_at', 'journal_confirmed_by',
                         'mf_purchase_first_exported_at', 'mf_purchase_last_exported_at')
),
pay_cols as (
  select column_name from information_schema.columns
   where table_schema = 'public' and table_name = 'gw_office_payments'
     and column_name in ('method', 'source_account', 'source_sub_account', 'paid_amount', 'fee_amount', 'memo',
                         'cancel_reason', 'cancelled_at', 'cancelled_by', 'mf_payment_first_exported_at', 'mf_payment_last_exported_at')
),
cons as (
  select conname from pg_constraint
   where conname in ('gw_vendor_invoices_kind_chk', 'gw_vendor_invoices_due_source_chk', 'gw_vendor_invoices_journal_status_chk',
                     'gw_vendor_invoices_closing_day_chk', 'gw_vendor_invoices_method_chk', 'gw_office_payments_method_chk', 'gw_office_payments_amounts_chk')
),
idx as (
  select indexname from pg_indexes where schemaname = 'public'
   and indexname in ('uq_gw_office_vendors_name', 'uq_gw_vendor_invoices_vendor_no', 'uq_gw_office_invoice_journals_line', 'uq_gw_office_mf_exports_code')
),
partner_nullable as (
  select is_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'gw_vendor_invoices' and column_name = 'partner_company_id'
),
bucket as (
  select id, public from storage.buckets where id = 'office-invoices'
)
select * from (
  select 1 as n, '新しい5表がある' as 項目,
         case when (select count(*) from tbl) = 5 then '✅' else '❌' end as 状態,
         (select count(*) from tbl) || ' / 5 表' as 詳細
  union all
  select 2, '新しい5表は RLS 有効・ポリシー無し',
         case when (select count(*) from tbl where rls and policies = 0) = 5 then '✅' else '❌' end,
         coalesce((select string_agg(relname || '(rls=' || rls || ',policies=' || policies || ')', ', ') from tbl), '表なし')
  union all
  select 3, 'gw_vendor_invoices に足した列（23）',
         case when (select count(*) from inv_cols) = 23 then '✅' else '❌' end,
         (select count(*) from inv_cols) || ' / 23 列'
  union all
  select 4, 'gw_office_payments に足した列（11）',
         case when (select count(*) from pay_cols) = 11 then '✅' else '❌' end,
         (select count(*) from pay_cols) || ' / 11 列'
  union all
  select 5, '足した CHECK 制約（7）',
         case when (select count(*) from cons) = 7 then '✅' else '❌' end,
         (select count(*) from cons) || ' / 7 件'
  union all
  select 6, '一意の索引（4）',
         case when (select count(*) from idx) = 4 then '✅' else '❌' end,
         (select count(*) from idx) || ' / 4 件'
  union all
  select 7, 'partner_company_id は nullable のまま（NOT NULL にしていない）',
         case when (select is_nullable from partner_nullable) = 'YES' then '✅' else '❌' end,
         coalesce((select is_nullable from partner_nullable), '列なし')
  union all
  select 8, '「partner か vendor が必須」の CHECK を足していない（足さない方針）',
         case when not exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
                                where t.relname = 'gw_vendor_invoices' and c.contype = 'c'
                                  and pg_get_constraintdef(c.oid) ilike '%partner_company_id%'
                                  and pg_get_constraintdef(c.oid) ilike '%vendor_id%')
              then '✅' else '❌' end,
         'gw_vendor_invoices の CHECK を確認'
  union all
  select 9, 'バケット office-invoices がある（非公開）',
         case when (select count(*) from bucket where not public) = 1 then '✅' else '❌' end,
         coalesce((select 'public=' || public from bucket), 'なし')
  union all
  select 10, 'バケット office-invoices に公開ポリシーが無い',
         case when not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                and (qual ilike '%office-invoices%' or with_check ilike '%office-invoices%'))
              then '✅' else '❌' end,
         'storage.objects のポリシーを確認'
  union all
  -- 11〜13：列があるときだけ件数を数える（query_to_xml）。既存の BP 請求書は invoice_kind='bp' のまま
  select 11, '既存の請求書の件数（invoice_kind=bp）',
         case when (select count(*) from inv_cols where column_name = 'invoice_kind') = 1 then '件数' else '❌' end,
         case when (select count(*) from inv_cols where column_name = 'invoice_kind') = 1
              then (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.gw_vendor_invoices where invoice_kind = ''bp''', false, true, '')))[1]::text
              else '列なし（未適用）' end
  union all
  select 12, '一般請求書の件数（invoice_kind=general。適用直後は 0）',
         case when (select count(*) from inv_cols where column_name = 'invoice_kind') = 1 then '件数' else '❌' end,
         case when (select count(*) from inv_cols where column_name = 'invoice_kind') = 1
              then (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.gw_vendor_invoices where invoice_kind = ''general''', false, true, '')))[1]::text
              else '列なし（未適用）' end
  union all
  select 13, 'BP 請求書で partner 未設定の件数（あっても正常。CHECK で弾かない）',
         '件数',
         (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.gw_vendor_invoices where partner_company_id is null', false, true, '')))[1]::text
) r
order by n;
