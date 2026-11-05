-- Integration test: synthetic records, transaction rollback; no customer changes.
begin;
do $$
declare t uuid:='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'; c uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); k uuid:=gen_random_uuid(); a jsonb; b jsonb; p jsonb;
begin
 insert into enger.companies(id,name) values(c,'__workbench_rollback_test__');
 insert into public.gw_sales_companies(id,tenant_id,name,emails) values(s,t,'__workbench_rollback_test__',array['old@example.test','second@example.test']);
 insert into public.gw_sales_company_links(tenant_id,source_system,source_company_id,company_id,method) values(t,'enger',c,s,'created');
 a:=public.gw_sales_company_workbench_save(t,c,null,'検証','profile','{"contactEmail":"new@example.test"}',k);
 b:=public.gw_sales_company_workbench_save(t,c,null,'検証','profile','{"contactEmail":"new@example.test"}',k);
 assert a->>'id'=b->>'id','idempotent replay';
 assert (select contact_email from enger.companies where id=c)='new@example.test','source persisted';
 assert (select emails from public.gw_sales_companies where id=s)=array['new@example.test','second@example.test'],'linked contact updated and secondary preserved';
 begin
  perform public.gw_sales_company_workbench_save(t,c,null,'検証','profile','{"phone":"0312345678"}',k);
  raise exception using errcode='XX000',message='conflict was not rejected';
 exception when raise_exception then null; end;
 perform public.gw_sales_company_workbench_save(t,c,null,'検証','profile','{"website":"https://www.example.test/contact"}',gen_random_uuid());
 assert (select domain from public.gw_sales_companies where id=s)='example.test','domain synchronization';
 perform public.gw_sales_company_workbench_save(t,c,null,'検証','activity','{"channel":"phone","result":"電話対応：通話できた","note":"検証","plan":{"owner":"担当","nextDate":"2026-11-12","nextAction":"確認"}}',gen_random_uuid());
 assert (select last_contacted_at from enger.companies where id=c) is not null,'contact timestamp';
 assert (select next_action from public.gw_sales_companies where id=s)='確認','linked NEXT persisted';
 perform public.gw_sales_company_workbench_save(t,c,null,'検証','plan','{"plan":{"nextAction":"再確認"}}',gen_random_uuid());
 select work_plan into p from public.gw_sales_enger_company_overrides where tenant_id=t and company_id=c;
 assert p->>'owner'='担当' and p->>'nextDate'='2026-11-12' and p->>'nextAction'='再確認','partial plans preserve existing fields';
 update enger.companies set caution=true where id=c;
 begin
  perform public.gw_sales_company_workbench_save(t,c,null,'検証','activity','{"channel":"phone","result":"電話対応：通話できた","plan":{}}',gen_random_uuid());
  raise exception using errcode='XX000',message='blocked contact was not rejected';
 exception when raise_exception then null; end;
 assert (select count(*) from public.gw_sales_company_activity where tenant_id=t and company_id=c)=4,'failed writes and retries do not add records';
 assert not has_function_privilege('anon','public.gw_sales_company_workbench_save(uuid,uuid,uuid,text,text,jsonb,uuid)','EXECUTE');
 assert not has_function_privilege('authenticated','public.gw_sales_company_workbench_save(uuid,uuid,uuid,text,text,jsonb,uuid)','EXECUTE');
 assert has_function_privilege('service_role','public.gw_sales_company_workbench_save(uuid,uuid,uuid,text,text,jsonb,uuid)','EXECUTE');
 assert not has_table_privilege('authenticated','public.gw_sales_company_activity','SELECT');
end $$;
rollback;
select 'PASS: atomic edit, linked contact, history, idempotency, plans, blocking, permissions; test rows rolled back' as result;
