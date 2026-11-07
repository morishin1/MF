-- 171: Formal company portal offers, separate from "interested" inquiries.
-- Service-role only. API verifies membership and company-scoped publication.
BEGIN;
CREATE TABLE IF NOT EXISTS enger.dx2_company_portal_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  company_id uuid NOT NULL REFERENCES enger.companies(id),
  member_id uuid NOT NULL REFERENCES enger.dx2_company_portal_members(id),
  shortlist_id uuid NOT NULL REFERENCES enger.dx2_company_sales_shortlist(id),
  item_type text NOT NULL CHECK (item_type IN ('talent','job')),
  candidate_id uuid REFERENCES enger.candidates(id),
  job_id uuid REFERENCES enger.jobs(id),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacting','meeting','negotiating','won','lost')),
  message text NOT NULL DEFAULT '' CHECK (char_length(message)<=500),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dx2_portal_offer_single_target CHECK (
    (item_type='talent' AND candidate_id IS NOT NULL AND job_id IS NULL)
    OR (item_type='job' AND job_id IS NOT NULL AND candidate_id IS NULL)
  ),
  CONSTRAINT dx2_portal_offer_company_member_unique UNIQUE (tenant_id,company_id,member_id,shortlist_id)
);
CREATE INDEX IF NOT EXISTS dx2_portal_offer_tenant_status
  ON enger.dx2_company_portal_offers(tenant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS dx2_portal_offer_company
  ON enger.dx2_company_portal_offers(tenant_id,company_id,created_at DESC);
ALTER TABLE enger.dx2_company_portal_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON enger.dx2_company_portal_offers FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON enger.dx2_company_portal_offers TO service_role;
COMMENT ON TABLE enger.dx2_company_portal_offers IS
  'Formal business-submitted offers against explicitly published Sales shortlists. No implied acceptance, hiring or revenue. Contact and status are staff-reviewed.';
COMMIT;