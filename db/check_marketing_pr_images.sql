-- Read-only verification after an explicitly approved schema application.
select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='marketing-pr-images';
select relrowsecurity from pg_class where oid='public.gw_marketing_pr_images'::regclass;
select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' and tablename='objects';
select has_table_privilege('anon','public.gw_marketing_pr_images','SELECT') anon_read,
 has_table_privilege('authenticated','public.gw_marketing_pr_images','SELECT') authenticated_read,
 has_table_privilege('authenticated','public.gw_marketing_pr_images','INSERT') authenticated_write,
 has_table_privilege('service_role','public.gw_marketing_pr_images','SELECT') server_read;
select proname,prosecdef,proacl from pg_proc where proname in ('gw_marketing_pr_image_reserve','gw_marketing_pr_image_finish');
