-- MF / 森田さん実行用・未実行。154だけを戻す。153を戻す場合はこの後で実行。
-- snapshot/taskが1件でもあれば全体中断。保持履歴を勝手に消さない。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('public.gw_sales_company_review_snapshots') IS NULL
   OR to_regclass('public.gw_sales_company_review_tasks') IS NULL THEN
  RAISE EXCEPTION '154 rollback: both tables must exist; verify metadata first';
 END IF;
END $$;
LOCK TABLE public.gw_sales_company_review_snapshots,public.gw_sales_company_review_tasks IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.gw_sales_company_review_snapshots)
   OR EXISTS(SELECT 1 FROM public.gw_sales_company_review_tasks) THEN
  RAISE EXCEPTION '154 rollback aborted: snapshot/task data exists; no data deleted';
 END IF;
END $$;
DROP FUNCTION public.gw_sales_apply_company_review_snapshot(uuid,uuid,timestamptz,timestamptz,jsonb);
DROP TABLE public.gw_sales_company_review_tasks;
DROP TABLE public.gw_sales_company_review_snapshots;
COMMIT;
