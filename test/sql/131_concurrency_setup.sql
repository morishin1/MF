-- run.sh の「131 並列」の準備（088・094・119・120・130・131 はこの前に流してある）
-- テナント1つ・AI営業を有効・月の上限 1.00 ドル（日の上限は広げて、月の上限だけで止まるようにする）
insert into public.tenants(id, name) values ('88888888-8888-8888-8888-888888888888', 'T8');
insert into public.gw_sales_ai_settings(tenant_id, enabled, monthly_cap_usd, daily_cap_usd, hourly_call_limit)
  values ('88888888-8888-8888-8888-888888888888', true, 1.00, 10, 1000);
