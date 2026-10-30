-- MFのみ / 森田さん実行用・未実行。
-- 153の評価・履歴が両方空の場合に限り追加物を戻す。評価が1件でもあれば全体中断。
-- 既存企業・営業・配信・ENGERのテーブルとデータは触らない。CASCADE・DELETEを使わない。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF to_regclass('public.gw_sales_company_review_tasks') IS NOT NULL
    OR to_regclass('public.gw_sales_company_review_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION '153 rollback: rollback 154 first; existing review tasks must be preserved';
  END IF;
  IF to_regclass('public.gw_sales_company_evaluations') IS NULL
    OR to_regclass('public.gw_sales_company_evaluation_history') IS NULL THEN
    RAISE EXCEPTION '153 rollback: both evaluation tables must exist; verify metadata first';
  END IF;
END $$;
-- Prevent a concurrent first save from racing the emptiness check.
LOCK TABLE public.gw_sales_company_evaluations, public.gw_sales_company_evaluation_history IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.gw_sales_company_evaluations)
    OR EXISTS (SELECT 1 FROM public.gw_sales_company_evaluation_history) THEN
    RAISE EXCEPTION '153 rollback aborted: evaluation/history data exists; no data deleted';
  END IF;
END $$;
DROP FUNCTION public.gw_sales_save_company_evaluation(uuid,uuid,uuid,bigint,uuid,jsonb);
DROP TABLE public.gw_sales_company_evaluation_history;
DROP TABLE public.gw_sales_company_evaluations;
COMMIT;
