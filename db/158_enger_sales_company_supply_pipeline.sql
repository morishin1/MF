-- Sales→ENGER: safe action tracking. Apply in shared Supabase only after reviewing the project.
-- Applied to shared Supabase project on 2026-11-04.
CREATE TABLE IF NOT EXISTS enger.dx2_sales_company_supply_pipeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES enger.companies(id) ON DELETE RESTRICT,
  request_kind text NOT NULL CHECK (request_kind IN ('job','talent','both')),
  stage text NOT NULL DEFAULT 'planned' CHECK (stage IN ('planned','contacted','appointment','awaiting_info','received','registered','closed')),
  next_action_on date,
  note text NOT NULL DEFAULT '' CHECK (length(note)<=2000),
  job_id uuid REFERENCES enger.jobs(id) ON DELETE RESTRICT,
  candidate_id uuid REFERENCES enger.candidates(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dx2_supply_registered_has_real_ids CHECK (
    stage <> 'registered' OR
    (request_kind='job' AND job_id IS NOT NULL) OR
    (request_kind='talent' AND candidate_id IS NOT NULL) OR
    (request_kind='both' AND (job_id IS NOT NULL OR candidate_id IS NOT NULL))
  ),
  CONSTRAINT dx2_supply_no_unconfirmed_links CHECK (
    (stage IN ('received','registered') OR (job_id IS NULL AND candidate_id IS NULL))
  )
);
CREATE INDEX IF NOT EXISTS dx2_supply_pipeline_company_idx
  ON enger.dx2_sales_company_supply_pipeline(tenant_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS dx2_supply_pipeline_open_idx
  ON enger.dx2_sales_company_supply_pipeline(tenant_id,stage,next_action_on);
ALTER TABLE enger.dx2_sales_company_supply_pipeline ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON enger.dx2_sales_company_supply_pipeline FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON enger.dx2_sales_company_supply_pipeline TO service_role;
COMMENT ON TABLE enger.dx2_sales_company_supply_pipeline IS
 'Sales企業から案件/人材を受け取ってENGER本登録まで追跡。認証済みサーバーのみ更新。連絡先・スキルシートは保存しない。';
