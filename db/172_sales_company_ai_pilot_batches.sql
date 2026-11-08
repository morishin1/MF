-- Company AI preview: one owner-approved selection of at most ten verified-linked ENGER companies.
-- Existing failed pilot summaries remain unchanged; batch enrolment is a separate audit record.
BEGIN;
CREATE TABLE IF NOT EXISTS public.gw_sales_company_ai_pilot_batches (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
 batch_id uuid NOT NULL DEFAULT gen_random_uuid(),
 sales_company_ids uuid[] NOT NULL,
 enger_company_ids uuid[] NOT NULL,
 created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT company_ai_batch_size CHECK (cardinality(sales_company_ids) BETWEEN 1 AND 10),
 CONSTRAINT company_ai_batch_equal_size CHECK (cardinality(sales_company_ids) = cardinality(enger_company_ids))
);
ALTER TABLE public.gw_sales_company_ai_pilot_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_ai_pilot_batches FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.gw_sales_company_ai_pilot_batches TO authenticated;
DROP POLICY IF EXISTS company_ai_pilot_batch_read ON public.gw_sales_company_ai_pilot_batches;
CREATE POLICY company_ai_pilot_batch_read ON public.gw_sales_company_ai_pilot_batches
 FOR SELECT TO authenticated USING (public.gw_is_sales(tenant_id));
COMMENT ON TABLE public.gw_sales_company_ai_pilot_batches IS 'Owner-approved 10-company preview selection. Only server service-role writes, never inferred company matches.';
COMMIT;