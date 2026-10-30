-- 読み取り専用・1回実行で1行JSON。対象 GW/MF htglvascsuqkixpmclwr のSQL Editorのみ。
-- https://supabase.com/dashboard/project/htglvascsuqkixpmclwr/sql/new
-- 応募者・送信・PDFの実データ、秘密設定値は読みません。結果JSON全体を返してください。
-- expected_project_ref は確認用ラベルで、接続先を自動検証した結果ではありません。
-- Storage policy が未審査の間は、本体02を実行せず HR_PDF_FLOW をOFFのままにしてください。
WITH required(schema_name, table_name, column_name) AS (
 VALUES
 ('public','tenants','id'),
 ('public','gw_hr_applicants','id'),('public','gw_hr_applicants','tenant_id'),
 ('public','gw_hr_applicants','name'),('public','gw_hr_applicants','email'),
 ('public','gw_hr_applicants','stage'),('public','gw_hr_applicants','status'),
 ('public','gw_hr_applicants','decision'),('public','gw_hr_applicants','lead_category'),
 ('public','gw_hr_applicants','offer_type'),('public','gw_hr_applicants','employment_type'),
 ('public','gw_hr_applicants','employee_id'),('public','gw_hr_applicants','advance_claimed_at'),
 ('public','gw_hr_offers','id'),('public','gw_hr_offers','tenant_id'),
 ('public','gw_hr_offers','applicant_id'),('public','gw_hr_offers','version'),
 ('public','gw_hr_offers','offer_type'),('public','gw_hr_offers','token_hash'),
 ('public','gw_hr_offers','revoked_at'),('public','gw_hr_offers','sent_at'),
 ('public','gw_hr_offers','viewed_at'),('public','gw_hr_offers','accepted_at'),
 ('public','gw_hr_offers','declined_at'),('public','gw_hr_offers','accepted_pdf_path'),
 ('public','gw_hr_offers','handoff_at'),('public','gw_hr_offers','formal_signed_at'),
 ('public','gw_hr_offers','formal_sent_at'),('public','gw_hr_offers','legalsign_url'),
 ('public','gw_hr_offers','formal_contract_ref'),('public','gw_hr_offers','formal_evidence'),
 ('public','gw_hr_offers','legalsign_doc_id'),('public','gw_hr_offers','legalsign_doc_sha256'),
 ('public','gw_hr_offers','formal_doc_sha256'),
 ('public','gw_hr_mail_sends','id'),('public','gw_hr_mail_sends','tenant_id'),
 ('public','gw_hr_mail_sends','applicant_id'),('public','gw_hr_mail_sends','status'),
 ('storage','buckets','id'),('storage','buckets','name'),('storage','buckets','public'),
 ('storage','buckets','file_size_limit'),('storage','buckets','allowed_mime_types')
), required_check AS (
 SELECT r.*,c.data_type,c.is_nullable,
        c.column_name IS NOT NULL AS present
 FROM required r LEFT JOIN information_schema.columns c
 ON c.table_schema=r.schema_name AND c.table_name=r.table_name AND c.column_name=r.column_name
), new_tables(name) AS (
 VALUES ('gw_hr_pdf_flows'),('gw_hr_pdf_docs'),('gw_hr_pdf_deliveries'),
        ('gw_hr_pdf_events'),('gw_hr_pdf_legacy_migrations')
), relations AS (
 SELECT n.nspname AS schema_name,c.relname AS table_name,c.relkind,
        c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,c.relacl::text AS acl
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='public' AND c.relname IN
   ('tenants','gw_hr_applicants','gw_hr_offers','gw_hr_mail_sends',
    'gw_hr_pdf_flows','gw_hr_pdf_docs','gw_hr_pdf_deliveries','gw_hr_pdf_events','gw_hr_pdf_legacy_migrations'))
 OR (n.nspname='storage' AND c.relname IN ('buckets','objects'))
)
SELECT jsonb_build_object(
 'check_id','hr_pdf_preflight_single_json_v1',
 'expected_project_ref','htglvascsuqkixpmclwr',
 'database',current_database(),
 'executor_role',current_user,
 'postgres_version',current_setting('server_version'),
 'review_status','PENDING: returned metadata is not approval to apply 02 or enable the feature',
 'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',rolname,'bypass_rls',rolbypassrls) ORDER BY rolname)
    FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')),'[]'::jsonb),
 'gen_random_uuid_available',to_regprocedure('gen_random_uuid()') IS NOT NULL,
 'required_columns',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY schema_name,table_name,column_name) FROM required_check r),'[]'::jsonb),
 'missing_required_columns',COALESCE((SELECT jsonb_agg(schema_name||'.'||table_name||'.'||column_name ORDER BY schema_name,table_name,column_name) FROM required_check WHERE NOT present),'[]'::jsonb),
 'new_table_presence',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',name,'present',to_regclass('public.'||name) IS NOT NULL) ORDER BY name) FROM new_tables),'[]'::jsonb),
 'relations_rls_acl',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY schema_name,table_name) FROM relations r),'[]'::jsonb),
 'new_table_columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'nullable',is_nullable) ORDER BY table_name,ordinal_position)
    FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT name FROM new_tables)),'[]'::jsonb),
 'new_table_grants',COALESCE((SELECT jsonb_agg(jsonb_build_object('table',table_name,'grantee',grantee,'privilege',privilege_type) ORDER BY table_name,grantee,privilege_type)
    FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN (SELECT name FROM new_tables)),'[]'::jsonb),
 'new_table_policies',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname)
    FROM pg_policies p WHERE schemaname='public' AND tablename IN (SELECT name FROM new_tables)),'[]'::jsonb),
 'new_functions',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.proname,'security_definer',p.prosecdef,'volatility',p.provolatile,'acl',p.proacl::text,'arguments',pg_get_function_identity_arguments(p.oid)) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'gw_hr_pdf_%' OR p.proname LIKE 'hr_pdf_%')),'[]'::jsonb),
 'relevant_triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'trigger',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY n.nspname,c.relname,t.tgname)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname='public' AND (c.relname IN ('gw_hr_applicants','gw_hr_offers','gw_hr_mail_sends') OR c.relname IN (SELECT name FROM new_tables))),'[]'::jsonb),
 'pdf_bucket',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'public',public,'file_size_limit',file_size_limit,'allowed_mime_types',allowed_mime_types))
    FROM storage.buckets WHERE id='hr-pdf-flow'),'[]'::jsonb),
 'all_storage_object_policies',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname)
    FROM pg_policies p WHERE schemaname='storage' AND tablename='objects'),'[]'::jsonb),
 'storage_policy_review','MANUAL REVIEW REQUIRED: inspect every USING/WITH CHECK, role and referenced function; private bucket alone is insufficient'
) AS hr_pdf_preflight;
