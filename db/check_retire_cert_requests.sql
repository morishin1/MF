-- =============================================================================
-- db/127（退職証明書の本人申請）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor に貼って Run。結果は「項目 / 状態 / 詳細」。❌ の行があれば db/127 が当たっていない。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（件数）
-- 申請の中身（氏名・選んだ項目・誓約の接続元）は出さない。件数だけ。
-- =============================================================================

with t as (select to_regclass('public.gw_retire_cert_requests') as oid),
rows(seq, item, ok, detail) as (
  select 1, '表 gw_retire_cert_requests がある', (select oid from t) is not null, ''
  union all
  select 2, 'RLS が有効（ログインした人は直接読み書きできない）',
         coalesce((select c.relrowsecurity from pg_class c where c.oid = (select oid from t)), false), ''
  union all
  select 3, 'ポリシーが 0（読み書きは API だけ）',
         (select oid from t) is not null and (select count(*) from pg_policy p where p.polrelid = (select oid from t)) = 0, ''
  union all
  select 4, '申請中は1人1件（uq_gw_retire_cert_requests_open）',
         exists (select 1 from pg_indexes where tablename = 'gw_retire_cert_requests' and indexname = 'uq_gw_retire_cert_requests_open'), ''
)
select item as 項目, case when ok then '✅' else '❌' end as 状態, detail as 詳細 from rows
union all
-- 件数（表が無いときも、このSQLはエラーにしない。query_to_xml で、表があるときだけ数える）
select 'ℹ 申請中の件数', 'ℹ', case when to_regclass('public.gw_retire_cert_requests') is null then '表なし'
  else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.gw_retire_cert_requests where status = ''requested''', false, true, '')))[1]::text end
union all
select 'ℹ 発行済みの件数', 'ℹ', case when to_regclass('public.gw_retire_cert_requests') is null then '表なし'
  else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.gw_retire_cert_requests where status = ''issued''', false, true, '')))[1]::text end;
