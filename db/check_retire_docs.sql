-- db/121_retire_docs.sql を流した後の確認（読み取りだけ。何も書き換えません）
-- Supabase の SQL Editor に貼って Run。
--
-- 【合格条件】
--   1) 表が2つとも「ある」、RLS が「有効」
--   2) ポリシーは select だけ（書き込みのポリシーが無い）
--   3) 制約・索引が揃っている（件数が 期待 と同じ）
--   4) 行数は、最初は 0（新しい表）

select c.relname as 表, c.relrowsecurity as rls有効
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('gw_retire_cases', 'gw_retire_docs')
 order by c.relname;                                                   -- 2行・rls有効 = true

select tablename as 表, policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename in ('gw_retire_cases', 'gw_retire_docs')
 order by tablename;                                                   -- 各表 select の1行だけ

select
  (select count(*) from pg_constraint where conrelid = 'public.gw_retire_docs'::regclass and conname in ('gw_retire_docs_issued_needs_file', 'gw_retire_docs_publish_only_issued')) as 制約_期待2,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname in ('uq_gw_retire_docs_issued_no', 'uq_gw_retire_docs_live')) as 一意索引_期待2,
  (select count(*) from public.gw_retire_cases) as 手続きの行数,
  (select count(*) from public.gw_retire_docs) as 書類の行数;
