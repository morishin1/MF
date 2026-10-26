-- Read-only prerequisite/ACL check. Apply no changes. No customer content returned.
select
 to_regclass('public.news_articles') is not null as existing_target,
 to_regclass('public.gw_marketing_pr_drafts') is not null as registered_pr_source,
 to_regclass('public.gw_marketing_site_publications') is not null as publication_table,
 to_regprocedure('public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text,jsonb)') is not null as atomic_publish_rpc,
 to_regprocedure('public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text)') is null as unsafe_old_overload_absent;
select c.relrowsecurity as rls_enabled,
 not has_table_privilege('anon',c.oid,'SELECT') as anon_read_denied,
 not has_table_privilege('authenticated',c.oid,'SELECT') as browser_read_denied,
 not has_table_privilege('authenticated',c.oid,'INSERT') as browser_insert_denied,
 not has_table_privilege('authenticated',c.oid,'UPDATE') as browser_update_denied,
 not has_table_privilege('authenticated',c.oid,'DELETE') as browser_delete_denied,
 has_table_privilege('service_role',c.oid,'SELECT') as server_read,
 has_table_privilege('service_role',c.oid,'INSERT') as server_insert,
 has_column_privilege('service_role',c.oid,'checked_at','UPDATE')
 and has_column_privilege('service_role',c.oid,'verified_at','UPDATE')
 and has_column_privilege('service_role',c.oid,'last_check','UPDATE') as server_verify_update,
 not has_column_privilege('service_role',c.oid,'body_html','UPDATE') as snapshot_update_denied,
 not has_table_privilege('service_role',c.oid,'DELETE') as server_delete_denied
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname='gw_marketing_site_publications';
select not p.prosecdef as invoker_only,p.proconfig,
 not has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute_denied,
 not has_function_privilege('authenticated',p.oid,'EXECUTE') as browser_execute_denied,
 has_function_privilege('service_role',p.oid,'EXECUTE') as server_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='gw_marketing_publish_site';
-- Existing target privileges must already support the established site-news API.
-- This proposal never grants them. False means stop and inspect the existing setup.
select has_table_privilege('service_role','public.news_articles','SELECT') as target_read,
 has_table_privilege('service_role','public.news_articles','INSERT') as target_insert,
 has_table_privilege('service_role','public.news_articles','UPDATE') as target_lock,
 has_table_privilege('service_role','public.gw_marketing_pr_drafts','SELECT') as draft_read,
 has_table_privilege('service_role','public.gw_marketing_pr_drafts','UPDATE') as draft_lock;
