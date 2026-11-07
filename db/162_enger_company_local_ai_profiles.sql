-- 162: protected append-only matching profiles imported from reviewed local AI JSON.
-- Requires the existing ENGER companies table. No live schema changes until approved.
BEGIN;

CREATE TABLE IF NOT EXISTS enger.dx2_company_local_ai_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES enger.companies(id),
  schema_version text NOT NULL DEFAULT 'enger-company-matching-v1',
  source_digest text NOT NULL,
  payload_digest text NOT NULL,
  profile_json jsonb NOT NULL,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dx2_local_ai_schema_check CHECK (schema_version = 'enger-company-matching-v1'),
  CONSTRAINT dx2_local_ai_source_sha CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dx2_local_ai_payload_sha CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dx2_local_ai_json_object CHECK (jsonb_typeof(profile_json) = 'object'),
  CONSTRAINT dx2_local_ai_json_size CHECK (length(profile_json::text) < 100000),
  CONSTRAINT dx2_local_ai_unique_payload UNIQUE (tenant_id, company_id, payload_digest)
);

CREATE INDEX IF NOT EXISTS dx2_local_ai_company_latest
  ON enger.dx2_company_local_ai_profiles(tenant_id,company_id,approved_at DESC,id DESC);

ALTER TABLE enger.dx2_company_local_ai_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE enger.dx2_company_local_ai_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE enger.dx2_company_local_ai_profiles TO service_role;

COMMENT ON TABLE enger.dx2_company_local_ai_profiles IS
  'Sales-reviewed local AI company matching assumptions. No PII. Append only; no public user access. Actual ENGER jobs/candidates and confirmed needs remain authoritative.';

COMMIT;
