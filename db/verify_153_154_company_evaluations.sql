-- 森田さん実行用。db/153・154を本人が適用した後だけ実行。未実行。
-- 業務行・ユーザー情報・secretを取得しない。SELECT一結果のmetadata JSON。
-- 期待: 両表RLS=true/authenticated_select=true/直接write=false/anon=false。
-- 各表SELECT policyのみ。tasksはsales AND (manager OR assignee)、その他manager限定。
-- 両RPC EXECUTEはservice_roleのみ。company masterへのFKなし。
BEGIN TRANSACTION READ ONLY;
SELECT jsonb_build_object(
  'project','MF','migration','153+154','captured_at',statement_timestamp(),
  'tables',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.table_name) FROM (
    SELECT n.nspname AS schema_name,c.relname AS table_name,c.relrowsecurity AS rls_enabled,
      has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_select,
      has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS authenticated_any_write,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS anon_any_access,
      has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') AS service_direct_write
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('gw_sales_company_evaluations','gw_sales_company_evaluation_history','gw_sales_company_review_snapshots','gw_sales_company_review_tasks')
  ) x),'[]'::jsonb),
  'columns',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.table_name,x.ordinal_position) FROM (
    SELECT table_name,column_name,data_type,is_nullable,ordinal_position FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN ('gw_sales_company_evaluations','gw_sales_company_evaluation_history','gw_sales_company_review_snapshots','gw_sales_company_review_tasks')
  ) x),'[]'::jsonb),
  'policies',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.tablename,x.policyname) FROM (
    SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('gw_sales_company_evaluations','gw_sales_company_evaluation_history','gw_sales_company_review_snapshots','gw_sales_company_review_tasks')
  ) x),'[]'::jsonb),
  'functions',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
    SELECT p.proname,oidvectortypes(p.proargtypes) AS arguments,p.prosecdef AS security_definer,
      p.proconfig AS function_config,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('gw_sales_save_company_evaluation','gw_sales_apply_company_review_snapshot')
  ) x),'[]'::jsonb),
  'constraints',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.table_name,x.conname) FROM (
    SELECT c.relname AS table_name,con.conname,pg_get_constraintdef(con.oid,true) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('gw_sales_company_evaluations','gw_sales_company_evaluation_history','gw_sales_company_review_snapshots','gw_sales_company_review_tasks')
  ) x),'[]'::jsonb)
) AS company_evaluation_metadata;
COMMIT;
