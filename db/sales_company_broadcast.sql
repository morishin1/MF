-- Explicit, reversible list classification only; never sends mail or overrides contact stops.
ALTER TABLE public.gw_sales_enger_company_overrides
 ADD COLUMN IF NOT EXISTS blast_target boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS blast_updated_at timestamptz,
 ADD COLUMN IF NOT EXISTS blast_updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.gw_sales_enger_company_overrides.blast_target IS
 'Manual Sales broadcast list membership; not consent, delivery eligibility, or an automatic send.';
CREATE INDEX IF NOT EXISTS gw_sales_enger_broadcast_idx
 ON public.gw_sales_enger_company_overrides(tenant_id,company_id) WHERE blast_target;
