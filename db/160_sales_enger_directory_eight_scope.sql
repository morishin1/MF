-- Restrict the privileged ENGER directory view to the Eight tenant only.
-- Other GW tenants never receive cross-tenant ENGER data even under service-role queries.
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
 ON o.tenant_id=t.id AND o.company_id=d.id
WHERE t.id='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'::uuid;
REVOKE ALL ON enger.dx2_sales_company_directory_for_tenant FROM PUBLIC,anon,authenticated;
GRANT SELECT ON enger.dx2_sales_company_directory_for_tenant TO service_role;