-- 145 スポット人材：適用後の読み取り専用確認
select 'table' as check_name, to_regclass('public.gw_hr_spot_talents') is not null as ok;
select 'rls' as check_name, relrowsecurity as ok
  from pg_class where oid='public.gw_hr_spot_talents'::regclass;
select 'read_policy' as check_name, policyname, roles, cmd, qual
  from pg_policies where schemaname='public' and tablename='gw_hr_spot_talents';
select 'columns' as check_name, column_name, data_type
  from information_schema.columns where table_schema='public' and table_name='gw_hr_spot_talents'
  order by ordinal_position;
-- このSQLは個人情報データをSELECTしない。テーブルが作成されていなければ後続の::regclassが失敗するため先にdb/145を適用すること。
