-- 167: Reviewable historical ENGER references for Sales company meeting management.
-- Records a staff-confirmed relation without rewriting historical imports or inventing receipts.
BEGIN;
CREATE TABLE IF NOT EXISTS enger.dx2_sales_company_history_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  company_id uuid NOT NULL REFERENCES enger.companies(id),
  entity_type text NOT NULL CHECK(entity_type IN ('job','talent','proposal')),
  entity_id uuid NOT NULL,
  source_kind text NOT NULL CHECK(source_kind IN ('sender_domain','company_name','historical_proposal')),
  confirmed_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dx2_sales_company_history_unique UNIQUE(tenant_id,company_id,entity_type,entity_id)
);
CREATE INDEX IF NOT EXISTS dx2_sales_company_history_lookup
  ON enger.dx2_sales_company_history_links(tenant_id,company_id,entity_type,linked_at DESC);
ALTER TABLE enger.dx2_sales_company_history_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE enger.dx2_sales_company_history_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE enger.dx2_sales_company_history_links TO service_role;
COMMENT ON TABLE enger.dx2_sales_company_history_links IS
  'Staff-confirmed company ownership of older imported ENGER jobs, talents and proposal references. Not a received supply request; not automatically shareable. Never auto-link from name alone.';
COMMIT;