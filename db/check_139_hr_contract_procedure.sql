-- =============================================================================
-- db/139（採用HR 契約手続き：社労士への依頼・正式PDFの受領と承認・版の照合・締結の証跡）の確認（読み取りだけ）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は「項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（件数）
-- db/139 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ（表を読む行は query_to_xml で実行時に読む）。
-- psql 専用のコマンド（\set など）は使っていない。
-- =============================================================================
with
tbl(name) as (values ('gw_hr_attorney_requests'), ('gw_hr_offer_official_docs')),
want_col(name) as (
  values ('doc_route'), ('contract_route'), ('official_doc_id'), ('legalsign_doc_id'), ('legalsign_doc_sha256'),
         ('formal_evidence'), ('formal_contract_ref'), ('formal_doc_sha256')
),
cols as (
  select c.column_name from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'gw_hr_offers' and c.column_name in (select name from want_col)
),
want_con(name) as (
  values ('gw_hr_offers_doc_route_chk'), ('gw_hr_offers_contract_route_chk'), ('gw_hr_offers_contract_text_chk'),
         ('gw_hr_offers_official_sent_chk'), ('gw_hr_offers_official_notice_chk'), ('gw_hr_offers_legalsign_doc_chk'),
         ('gw_hr_offers_formal_doc_chk'), ('gw_hr_offers_formal_evidence_chk'), ('gw_hr_offers_handoff_official_chk'),
         ('gw_hr_offer_official_docs_review_chk'), ('gw_hr_offer_official_docs_return_chk'),
         ('gw_hr_offer_official_docs_file_chk'), ('gw_hr_offer_official_docs_rev_uq')
),
pol as (
  select c.relname as tbl, p.polname, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relname in (select name from tbl)
),
trg(name) as (values ('gw_hr_attorney_requests_guard'), ('gw_hr_offer_official_docs_guard'), ('gw_hr_offers_lock_contract')),
rows(seq, item, ok, detail) as (
  select 1, '2つの表がある（社労士への依頼・正式PDFの受領）',
         (select count(*) = 2 from tbl where to_regclass('public.' || name) is not null),
         (select coalesce(string_agg(name, ', '), '') from tbl where to_regclass('public.' || name) is null)
  union all
  select 2, 'gw_hr_offers に8つの列がある',
         (select count(*) = 8 from cols),
         (select coalesce(string_agg(name, ', '), '') from want_col where name not in (select column_name from cols))
  union all
  select 3, '制約（版の照合・案内前の固定・締結の証跡など13個）がある',
         (select count(*) = 13 from want_con where exists (select 1 from pg_constraint where conname = want_con.name)),
         (select coalesce(string_agg(name, ', '), '') from want_con where not exists (select 1 from pg_constraint where conname = want_con.name))
  union all
  select 4, '正式契約の順番の制約が db/139 の形（正式PDFの版は、同意の前の締結も記録できる）',
         exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_order_chk'
                  and pg_get_constraintdef(oid) like '%doc_route%'),
         ''
  union all
  select 5, '承認した正式PDFは条件の版ごとに1つ（一意索引）',
         to_regclass('public.uq_gw_hr_offer_official_docs_approved') is not null, ''
  union all
  select 6, '書き換えを止めるトリガー（3つ）がある',
         (select count(*) = 3 from trg where exists (select 1 from pg_trigger t where t.tgname = trg.name and not t.tgisinternal)),
         (select coalesce(string_agg(name, ', '), '') from trg where not exists (select 1 from pg_trigger t where t.tgname = trg.name and not t.tgisinternal))
  union all
  select 7, '2つの表で RLS が有効',
         (select count(*) = 2 from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where c.relname in (select name from tbl) and c.relrowsecurity),
         ''
  union all
  select 8, 'ポリシーは読むだけ・gw_is_recruiting を通す（書くのはサーバだけ）',
         exists (select 1 from pol) and not exists (select 1 from pol where polcmd <> 'r' or expr not ilike '%gw_is_recruiting%'),
         (select coalesce(string_agg(tbl || '.' || polname, ', '), '') from pol where polcmd <> 'r' or expr not ilike '%gw_is_recruiting%')
  union all
  select 9, 'ログインした人は2つの表に書けない（権限）',
         not exists (select 1 from information_schema.role_table_grants
                      where table_schema = 'public' and table_name in (select name from tbl)
                        and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
         ''
  union all
  select 10, '正式PDFで案内したのに正式PDFが固定されていない版が無い',
         case when (select count(*) from cols) < 8 then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_hr_offers where doc_route = ''official'' and sent_at is not null and official_doc_id is null',
                     false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 11, 'LegalSign に登録した版・締結した版が、本人へ案内した版と食い違っていない',
         case when (select count(*) from cols) < 8 then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_hr_offers
                       where (legalsign_doc_sha256 is not null and notice_pdf_sha256 is not null and legalsign_doc_sha256 <> notice_pdf_sha256)
                          or (formal_doc_sha256 is not null and formal_doc_sha256 is distinct from notice_pdf_sha256)',
                     false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 12, 'ℹ 正式PDFの受領（状態ごとの件数）', null,
         case when to_regclass('public.gw_hr_offer_official_docs') is null then '表なし'
              else coalesce((xpath('/row/v/text()', query_to_xml(
                     'select string_agg(status || '' '' || n, '' / '' order by status) as v
                        from (select status, count(*) n from public.gw_hr_offer_official_docs group by status) s', false, true, '')))[1]::text, '0件') end
  union all
  select 13, 'ℹ 社労士への依頼の記録', null,
         case when to_regclass('public.gw_hr_attorney_requests') is null then '表なし'
              else (xpath('/row/count/text()', query_to_xml('select count(*) from public.gw_hr_attorney_requests', false, true, '')))[1]::text || ' 件' end
)
select seq as "#", item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
