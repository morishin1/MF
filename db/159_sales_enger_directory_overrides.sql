-- Reversible Sales company directory administration and evidence (applied 2026-11-04).
-- The ENGER master and past activities are never deleted by Sales bulk actions.
CREATE TABLE IF NOT EXISTS public.gw_sales_enger_company_overrides (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES enger.companies(id) ON DELETE RESTRICT,
 priority text CHECK(priority IS NULL OR priority IN ('A','B','C','D')),
 relationship_status text NOT NULL DEFAULT 'unknown'
   CHECK(relationship_status IN ('unknown','active','past','none_confirmed')),
 relationship_evidence text,
 hidden_at timestamptz,
 updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id, company_id),
 CONSTRAINT gw_sales_enger_relationship_evidence CHECK (
  relationship_status='unknown' OR length(btrim(coalesce(relationship_evidence,'')))>=10
 )
);
CREATE INDEX IF NOT EXISTS gw_sales_enger_overrides_hidden_idx
 ON public.gw_sales_enger_company_overrides(tenant_id,hidden_at);
ALTER TABLE public.gw_sales_enger_company_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_enger_company_overrides FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.gw_sales_enger_company_overrides TO service_role;
CREATE OR REPLACE VIEW enger.dx2_sales_company_directory_for_tenant WITH (security_invoker=true) AS
SELECT t.id tenant_id,
 d.id,d.name,d.status,d.industry,d.website,d.prefecture,d.data_source,d.created_at,
 d.meeting_done,d.meeting_done_at,d.last_contacted_at,d.is_end_client,d.is_favorite,
 d.source_priority,d.historical_contact_date,d.historical_activity_count,d.needs_contact_review,
 d.classification_basis,d.si_ses_candidate,
 COALESCE(o.priority,d.source_priority) effective_priority,
 o.priority manual_priority,
 COALESCE(o.relationship_status,'unknown') relationship_status,
 o.relationship_evidence, o.hidden_at directory_hidden_at, o.updated_at directory_updated_at,
 CASE WHEN o.relationship_status='active' THEN 'existing'
      WHEN o.relationship_status='past' THEN 'revive'
      WHEN o.relationship_status='none_confirmed' THEN 'new'
      ELSE d.bucket END AS bucket
FROM public.tenants t
CROSS JOIN enger.dx2_sales_company_directory d
LEFT JOIN public.gw_sales_enger_company_overrides o
 ON o.tenant_id=t.id AND o.company_id=d.id;
REVOKE ALL ON enger.dx2_sales_company_directory_for_tenant FROM PUBLIC,anon,authenticated;
GRANT SELECT ON enger.dx2_sales_company_directory_for_tenant TO service_role;