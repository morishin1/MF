-- db/147: 個人情報を一切取得しない確認
select to_regclass('public.gw_hr_inbound_mail') is not null as table_present;
select relrowsecurity as rls_enabled from pg_class where oid=to_regclass('public.gw_hr_inbound_mail');
select policyname,cmd,roles from pg_policies where schemaname='public' and tablename='gw_hr_inbound_mail';
select indexname from pg_indexes where schemaname='public' and tablename='gw_hr_inbound_mail' order by indexname;
select column_name,data_type from information_schema.columns
 where table_schema='public' and table_name='gw_hr_inbound_mail' order by ordinal_position;
