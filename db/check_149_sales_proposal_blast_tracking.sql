-- Salesブラスト導入確認（本文・個人情報は取得しない）
select to_regclass('public.gw_sales_proposal_blasts') is not null as table_present;
select relrowsecurity as rls_enabled from pg_class
 where oid=to_regclass('public.gw_sales_proposal_blasts');
select tgname from pg_trigger where tgrelid=to_regclass('public.gw_sales_proposal_blasts')
 and not tgisinternal order by tgname;
select has_table_privilege('authenticated','public.gw_sales_proposal_blasts','select') as authenticated_select,
 has_table_privilege('authenticated','public.gw_sales_proposal_blasts','delete') as delete_should_be_false,
 has_table_privilege('anon','public.gw_sales_proposal_blasts','select') as anonymous_should_be_false;
