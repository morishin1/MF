-- Haiku 5.5 company-type classification, separate from relationship/lifecycle status.
-- This table stores no raw website bodies, personal contacts, or secrets.
BEGIN;
CREATE TABLE IF NOT EXISTS public.gw_sales_company_classifications (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES enger.companies(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','processing','completed','needs_review','failed')),
  org_type text NOT NULL DEFAULT 'unknown'
    CHECK(org_type IN ('private','municipality','education','other','unknown')),
  business_types text[] NOT NULL DEFAULT '{}'::text[],
  suggested_service text,
  confidence numeric(4,3),
  rationale text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  source_urls text[] NOT NULL DEFAULT '{}'::text[],
  input_tokens integer NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  origin text NOT NULL DEFAULT 'pilot100' CHECK(origin IN ('pilot100','new_registration','manual')),
  started_at timestamptz,
  classified_at timestamptz,
  last_error text,
  human_override boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,company_id),
  CONSTRAINT sales_classification_tags CHECK (business_types <@ ARRAY['ses','sier','contract_dev','it_products','general','other']::text[]),
  CONSTRAINT sales_classification_evidence_array CHECK (jsonb_typeof(evidence)='array'),
  CONSTRAINT sales_classification_confidence CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1)
);
CREATE INDEX IF NOT EXISTS gw_sales_company_classification_queue
 ON public.gw_sales_company_classifications(tenant_id,status,created_at)
 WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS gw_sales_company_classification_segment
 ON public.gw_sales_company_classifications(tenant_id,org_type,status);
CREATE INDEX IF NOT EXISTS gw_sales_company_classification_tags
 ON public.gw_sales_company_classifications USING gin(business_types);
ALTER TABLE public.gw_sales_company_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_classifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.gw_sales_company_classifications TO service_role;
COMMENT ON TABLE public.gw_sales_company_classifications IS
 'Tenant-scoped, evidence-backed Claude classification of ENGER companies. Independent from sales relationship status. No automatic email or offers.';
COMMIT;