-- SQL148 読み取り専用チェック。個人情報の内容を取得しない。
select to_regclass('public.gw_hr_inbound_mail') is not null as table_present;
select relrowsecurity as rls_enabled from pg_class
 where oid=to_regclass('public.gw_hr_inbound_mail');
select column_name from information_schema.columns
 where table_schema='public' and table_name='gw_hr_inbound_mail'
 and column_name in ('deleted_at','spot_talent_id') order by column_name;
select to_regprocedure('public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid)') is not null as bulk_rpc_exists;
select has_function_privilege('service_role','public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid)','execute') as service_allowed,
 has_function_privilege('authenticated','public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid)','execute') as member_denied_should_be_false,
 has_function_privilege('anon','public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid)','execute') as anonymous_denied_should_be_false;
