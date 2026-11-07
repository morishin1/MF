-- ENGER / Sales AI企業サマリー PoC（100社）
-- 既存 gw_sales_ai_analyses（アタック判定）と別用途。既存データには変更を加えない。
-- 本番適用前にステージングで検証し、feature flagを既定OFFにする。
BEGIN;
CREATE TABLE IF NOT EXISTS public.gw_sales_company_summaries (
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','needs_review')),
  summary text,
  markdown text,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  hypotheses jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknowns jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- AIが抽出した需給シグナル。あくまで公開情報・仮説（確認済みの案件・求人として扱わない）。
  match_signals jsonb NOT NULL DEFAULT '{"demand_hypotheses":[],"supply_hypotheses":[]}'::jsonb,
  model text,
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_version text NOT NULL DEFAULT 'company-sales-v1',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id),
  CONSTRAINT sales_company_summary_parent FOREIGN KEY (company_id)
    REFERENCES public.gw_sales_companies(id) ON DELETE CASCADE,
  CONSTRAINT summary_max_length CHECK (length(coalesce(summary,'')) <= 1500 AND length(coalesce(markdown,'')) <= 30000),
  CONSTRAINT summary_sources_array CHECK (jsonb_typeof(sources) = 'array'),
  CONSTRAINT summary_facts_object CHECK (jsonb_typeof(facts) = 'object'),
  CONSTRAINT summary_match_signals_object CHECK (jsonb_typeof(match_signals) = 'object'),
  CONSTRAINT summary_token_usage_object CHECK (jsonb_typeof(token_usage) = 'object')
);
CREATE INDEX IF NOT EXISTS gw_sales_company_summaries_queue_idx
  ON public.gw_sales_company_summaries (status, requested_at)
  WHERE status IN ('pending','failed');
COMMENT ON TABLE public.gw_sales_company_summaries IS
 'ENGER/Sales共通のAI企業調査結果。事実・推定・情報源を区別。既存AI営業判定テーブルと分離。';
ALTER TABLE public.gw_sales_company_summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_summaries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.gw_sales_company_summaries TO authenticated;
-- 書込みは認可済みサーバAPIで tenant を検証し service_role に限定する。
DROP POLICY IF EXISTS sales_company_summaries_read ON public.gw_sales_company_summaries;
CREATE POLICY sales_company_summaries_read
 ON public.gw_sales_company_summaries FOR SELECT TO authenticated
 USING (public.gw_is_sales(tenant_id)
   AND EXISTS (SELECT 1 FROM public.gw_sales_companies c
     WHERE c.id = company_id AND c.tenant_id = gw_sales_company_summaries.tenant_id));
COMMIT;
