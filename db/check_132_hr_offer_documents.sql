-- =============================================================================
-- db/132（採用HR：条件通知書PDF・電子承諾記録・LegalSign 正式契約）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は1つの表「# / 項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい
-- 1〜9 がすべて ✅、10 は件数（流した直後はどれも 0件）、11 は ✅ 0件 なら OK。
--
-- db/132 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ
-- （列が無いときは件数を数えない。件数は query_to_xml で「列があるときだけ」数える）。
-- psql 専用のコマンド（\set など）は使っていない。
-- =============================================================================

with
want(column_name, data_type) as (
  values ('notice_title', 'text'), ('notice_pdf_path', 'text'), ('notice_pdf_sha256', 'text'),
         ('accept_name', 'text'), ('accept_email', 'text'), ('accept_ip', 'text'), ('accept_ua', 'text'),
         ('accept_text', 'text'), ('accepted_pdf_path', 'text'), ('accepted_pdf_sha256', 'text'),
         ('legalsign_url', 'text'), ('formal_sent_at', 'timestamp with time zone'), ('formal_sent_by', 'uuid'),
         ('formal_signed_at', 'timestamp with time zone'), ('formal_signed_by', 'uuid')
),
cols as (
  select c.column_name, c.data_type
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'gw_hr_offers'
     and c.column_name in (select column_name from want)
),
cons as (
  select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid and t.relname = 'gw_hr_offers'
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
   where c.contype = 'c'
     and c.conname in ('gw_hr_offers_notice_sha_chk', 'gw_hr_offers_accepted_sha_chk', 'gw_hr_offers_accepted_pdf_chk',
                       'gw_hr_offers_accept_record_chk', 'gw_hr_offers_legalsign_url_chk', 'gw_hr_offers_formal_order_chk')
),
trg as (
  select t.tgname, t.tgenabled, p.proname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid and c.relname = 'gw_hr_offers'
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and t.tgname = 'gw_hr_offers_lock_documents'
),
has as (
  select (select count(*) from want w join cols c using (column_name, data_type)) = 15 as all_cols,
         (select count(*) from cols) as n_cols
),
-- 件数。列が無い環境でもエラーにしないよう、列がそろっているときだけ問い合わせる（CASE の外れた側は実行されない）
cnt as (
  select
    (select count(*) from public.gw_hr_offers) as o_total,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where notice_pdf_path is not null', false, true, '')))[1]::text::bigint end as with_notice,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where accepted_pdf_path is not null', false, true, '')))[1]::text::bigint end as with_accepted_pdf,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where legalsign_url is not null', false, true, '')))[1]::text::bigint end as with_url,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where formal_signed_at is not null', false, true, '')))[1]::text::bigint end as signed,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers
        where (notice_pdf_sha256 is not null and notice_pdf_sha256 !~ ''^[0-9a-f]{64}$'')
           or (accepted_pdf_sha256 is not null and accepted_pdf_sha256 !~ ''^[0-9a-f]{64}$'')
           or (legalsign_url is not null and legalsign_url !~ ''^https://'')
           or (formal_sent_at is not null and legalsign_url is null)
           or (formal_signed_at is not null and accepted_at is null)', false, true, '')))[1]::text::bigint end as bad
  from has h
),
rows(seq, item, ok, detail) as (
  select 1, 'gw_hr_offers に 15 列がある（型も一致）',
         h.all_cols,
         case when h.all_cols then '15 / 15 列'
              else h.n_cols || ' / 15 列（足りない：' || coalesce((select string_agg(w.column_name, '・' order by w.column_name)
                     from want w where not exists (select 1 from cols c where c.column_name = w.column_name and c.data_type = w.data_type)), '') || '）' end
    from has h
  union all
  select 2, '条件通知書PDF の SHA-256 の形（gw_hr_offers_notice_sha_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_notice_sha_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_notice_sha_chk'), '制約がありません')
  union all
  select 3, '承諾済みPDF の SHA-256 の形（gw_hr_offers_accepted_sha_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_accepted_sha_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_accepted_sha_chk'), '制約がありません')
  union all
  select 4, '承諾済みPDF は条件通知書PDF・承諾がある版だけ（gw_hr_offers_accepted_pdf_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_accepted_pdf_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_accepted_pdf_chk'), '制約がありません')
  union all
  select 5, '承諾の記録は承諾した版だけ（gw_hr_offers_accept_record_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_accept_record_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_accept_record_chk'), '制約がありません')
  union all
  select 6, 'LegalSign URL は https:// だけ（gw_hr_offers_legalsign_url_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_legalsign_url_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_legalsign_url_chk'), '制約がありません')
  union all
  select 7, '正式契約の順番（案内は URL のあと・正式契約済みは承諾のあと。gw_hr_offers_formal_order_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_formal_order_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_formal_order_chk'), '制約がありません')
  union all
  select 8, '書き換え防止の関数（gw_hr_offers_lock_documents）',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                  where p.proname = 'gw_hr_offers_lock_documents'),
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                            where p.proname = 'gw_hr_offers_lock_documents')
              then 'あります' else '関数がありません' end
  union all
  select 9, '書き換え防止の trigger が有効（BEFORE UPDATE）',
         exists (select 1 from trg where tgenabled = 'O' and proname = 'gw_hr_offers_lock_documents'),
         coalesce((select '有効（' || tgname || ' → ' || proname || '）' from trg where tgenabled = 'O'),
                  (select '無効になっています（tgenabled = ' || tgenabled::text || '）' from trg),
                  'trigger がありません')
  union all
  select 10, '既存データ：条件通知書・承諾済みPDF・LegalSign・正式契約済みの件数',
         h.all_cols,
         case when h.all_cols
              then '条件通知書あり ' || c.with_notice || '件 / 承諾済みPDFあり ' || c.with_accepted_pdf || '件 / LegalSign URL あり '
                || c.with_url || '件 / 正式契約済み ' || c.signed || '件 / オファー全 ' || c.o_total || '件'
              else '列が無いため数えていません（オファー全 ' || c.o_total || '件）' end
    from has h, cnt c
  union all
  select 11, '形・順番のおかしい行が 0件',
         h.all_cols and c.bad = 0,
         case when h.all_cols then 'おかしい行 ' || c.bad || '件' else '列が無いため数えていません' end
    from has h, cnt c
)
select seq as "#", item as 項目, case when ok then '✅' else '❌' end as 状態, detail as 詳細
  from rows
 order by seq;
