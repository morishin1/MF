-- 164: Sales-curated company meeting favorites; private drafts vs explicit portal-visible shares.
-- Additive schema only. Public/portal reads must use server-side authenticated endpoints.
BEGIN;

CREATE TABLE IF NOT EXISTS enger.dx2_company_sales_shortlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  company_id uuid NOT NULL REFERENCES enger.companies(id),
  item_type text NOT NULL CHECK (item_type IN ('talent','job')),
  candidate_id uuid REFERENCES enger.candidates(id),
  job_id uuid REFERENCES enger.jobs(id),
  status text NOT NULL DEFAULT 'favorite' CHECK (status IN ('favorite','published')),
  created_by uuid,
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dx2_sales_shortlist_exact_one CHECK (
    (item_type='talent' AND candidate_id IS NOT NULL AND job_id IS NULL)
    OR (item_type='job' AND job_id IS NOT NULL AND candidate_id IS NULL)
  ),
  CONSTRAINT dx2_sales_shortlist_pub_consistency CHECK (
    (status='favorite' AND published_at IS NULL)
    OR (status='published' AND published_at IS NOT NULL)
  ),
  CONSTRAINT dx2_sales_shortlist_unique_talent UNIQUE (tenant_id,company_id,candidate_id),
  CONSTRAINT dx2_sales_shortlist_unique_job UNIQUE (tenant_id,company_id,job_id)
);

CREATE INDEX IF NOT EXISTS dx2_sales_shortlist_company_status
  ON enger.dx2_company_sales_shortlist(company_id,status,updated_at DESC);

ALTER TABLE enger.dx2_company_sales_shortlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE enger.dx2_company_sales_shortlist FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE enger.dx2_company_sales_shortlist TO service_role;

COMMENT ON TABLE enger.dx2_company_sales_shortlist IS
 'ENGER Sales company favorites. favorite is private; published is visible only via company-authenticated portal. Never expose raw table or private talent/job columns.';

COMMIT;