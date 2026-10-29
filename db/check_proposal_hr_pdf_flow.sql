-- READ-ONLY operator review. Not executed by the assistant. Check before/after applying proposal.
select current_database(),current_user,version();
select table_name,column_name,data_type from information_schema.columns where table_schema='public' and table_name like 'gw_hr_pdf_%' order by table_name,ordinal_position;
select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'gw_hr_pdf_%';
select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='public' and table_name like 'gw_hr_pdf_%' order by table_name,grantee,privilege_type;
select p.proname,p.prosecdef,p.provolatile,p.proacl,pg_get_function_identity_arguments(p.oid) as arguments from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'gw_hr_pdf_%' or p.proname like 'hr_pdf_%');
select c.relname,t.tgname,pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname like 'hr_pdf_%';
select id,name,public,file_size_limit,allowed_mime_types from storage.buckets where id='hr-pdf-flow';
-- MUST inspect every policy: generic bucket policies can leak PDF originals despite bucket private=true.
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='storage' and tablename='objects';
select column_name from information_schema.columns where table_schema='public' and table_name='gw_hr_offers' and column_name in ('accepted_at','declined_at','accepted_pdf_path','handoff_at','formal_signed_at','formal_sent_at','legalsign_url','formal_contract_ref','formal_evidence','legalsign_doc_id','legalsign_doc_sha256','formal_doc_sha256') order by column_name;
-- Required staging acceptance (operator-owned, not performed here): real PostgreSQL transaction
-- races replace/respond, duplicate accept, migrate/legacy respond, migrate/mail INSERT and changed
-- snapshot after lock wait. Mock/static tests are NOT evidence of SQL runtime correctness.
