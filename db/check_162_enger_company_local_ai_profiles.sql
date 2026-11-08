-- Read-only verification for db/162_enger_company_local_ai_profiles.sql.
SELECT
  to_regclass('enger.dx2_company_local_ai_profiles') IS NOT NULL AS has_table,
  (SELECT relrowsecurity FROM pg_class WHERE oid='enger.dx2_company_local_ai_profiles'::regclass) AS rls_enabled,
  NOT has_table_privilege('anon','enger.dx2_company_local_ai_profiles','SELECT') AS anon_select_denied,
  NOT has_table_privilege('authenticated','enger.dx2_company_local_ai_profiles','SELECT') AS authenticated_select_denied,
  NOT has_table_privilege('anon','enger.dx2_company_local_ai_profiles','INSERT') AS anon_insert_denied,
  NOT has_table_privilege('authenticated','enger.dx2_company_local_ai_profiles','INSERT') AS authenticated_insert_denied,
  has_table_privilege('service_role','enger.dx2_company_local_ai_profiles','SELECT') AS service_read_enabled,
  has_table_privilege('service_role','enger.dx2_company_local_ai_profiles','INSERT') AS service_insert_enabled,
  NOT has_table_privilege('service_role','enger.dx2_company_local_ai_profiles','UPDATE') AS service_update_denied;
-- No RLS allow-policies are expected. Server-only + explicit Sales auth/scope in the API.
SELECT COUNT(*) AS policies_count FROM pg_policies
 WHERE schemaname='enger' AND tablename='dx2_company_local_ai_profiles';
