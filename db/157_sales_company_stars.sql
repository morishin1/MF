-- db/157_sales_company_stars.sql
-- Individual, manually entered 1-5 star review for a verified Sales company.
-- Distinct from the evidence-backed A-D trade policy. No automatic sales hold.
-- Deploy only to the Supabase project backing gw.8grp.co.jp, after a migration review.
BEGIN;
CREATE TABLE IF NOT EXISTS public.gw_sales_company_stars (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.gw_sales_companies(id) ON DELETE CASCADE,
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id)
);
CREATE INDEX IF NOT EXISTS gw_sales_company_stars_company_idx
 ON public.gw_sales_company_stars (company_id);
ALTER TABLE public.gw_sales_company_stars ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_stars FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.gw_sales_company_stars TO authenticated;
DROP POLICY IF EXISTS gw_sales_company_stars_read ON public.gw_sales_company_stars;
CREATE POLICY gw_sales_company_stars_read ON public.gw_sales_company_stars
 FOR SELECT TO authenticated USING (
   public.gw_is_sales(tenant_id)
   AND EXISTS (SELECT 1 FROM public.gw_sales_companies c
     WHERE c.id=company_id AND c.tenant_id=gw_sales_company_stars.tenant_id)
 );
DROP POLICY IF EXISTS gw_sales_company_stars_insert ON public.gw_sales_company_stars;
CREATE POLICY gw_sales_company_stars_insert ON public.gw_sales_company_stars
 FOR INSERT TO authenticated WITH CHECK (
   public.gw_is_sales(tenant_id) AND updated_by=(SELECT auth.uid())
   AND EXISTS (SELECT 1 FROM public.gw_sales_companies c
     WHERE c.id=company_id AND c.tenant_id=gw_sales_company_stars.tenant_id)
 );
DROP POLICY IF EXISTS gw_sales_company_stars_update ON public.gw_sales_company_stars;
CREATE POLICY gw_sales_company_stars_update ON public.gw_sales_company_stars
 FOR UPDATE TO authenticated
 USING (public.gw_is_sales(tenant_id))
 WITH CHECK (public.gw_is_sales(tenant_id) AND updated_by=(SELECT auth.uid())
   AND EXISTS (SELECT 1 FROM public.gw_sales_companies c
     WHERE c.id=company_id AND c.tenant_id=gw_sales_company_stars.tenant_id));
COMMIT;
