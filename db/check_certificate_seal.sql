-- db/122_certificate_seal.sql を流した後の確認（読み取りだけ。何も書き換えません）
-- 【合格条件】
--   1) seal_type の check に certificate が入っている（結果の「certificate を含む」= true）
--   2) gw_retire_company がある・RLS 有効・ポリシーは select の1つだけ
--   3) 既存の印鑑の数が、120/121 の前と変わらない（行は変わっていない）

select pg_get_constraintdef(oid) ilike '%certificate%' as certificate_を含む, pg_get_constraintdef(oid) as 定義
  from pg_constraint
 where conrelid = 'public.gw_seals'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%seal_type%';

select c.relname as 表, c.relrowsecurity as rls有効,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as ポリシー数_期待1
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'gw_retire_company';

select seal_type, count(*) as 件数, count(*) filter (where is_active) as 有効 from public.gw_seals group by seal_type order by seal_type;
