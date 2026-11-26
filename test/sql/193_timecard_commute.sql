-- 適用済みのテストDBで実行。社員・時刻はすべて架空。最後にロールバックする。
begin;
create function pg_temp.expect_error(command text, expected text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlerrm = expected then return; end if;
    raise;
  end;
  raise exception '期待したエラーがありません: %', expected;
end $$;
do $$
declare
  tenant uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  member uuid := gen_random_uuid(); fixed uuid := gen_random_uuid(); zero_emp uuid := gen_random_uuid();
  adviser uuid := gen_random_uuid(); other_adviser uuid := gen_random_uuid(); actor uuid := gen_random_uuid();
  mon date := '2024-12-01'; r record; ver text; rows jsonb; closed_count int;
begin
  insert into auth.users(id) values (actor);
  insert into tenants(id,name) values (tenant,'給与テスト'),(other,'別組織');
  insert into gw_employees(id,tenant_id,display_name,joined_on,status,left_on) values
    (member,tenant,'実費','2024-11-01','active',null),(fixed,tenant,'定期','2024-12-01','left','2024-12-31'),
    (zero_emp,tenant,'支給なし','2024-12-01','active',null),
    (adviser,tenant,'担当社労士','2024-11-01','active',null),
    (other_adviser,other,'別組織の社労士','2024-11-01','active',null);
  insert into gw_role_grants(tenant_id,employee_id,role) values
    (tenant,adviser,'labor_advisor'),(other,other_adviser,'labor_advisor');
  insert into gw_onboard_profiles(tenant_id,employee_id,commute_route,commute_cost) values (tenant,fixed,'A駅 → B駅',12400);
  insert into gw_time_entries(tenant_id,employee_id,work_date,status,clock_in,clock_out,breaks) values
    (tenant,member,'2024-12-02','closed','2024-12-02 09:00+09','2024-12-02 18:00+09',
     '[{"start":"2024-12-02 12:00+09","end":"2024-12-02 13:00+09"}]'),
    (tenant,member,'2024-12-03','closed','2024-12-03 22:00+09','2024-12-04 06:00+09','[]'),
    (tenant,member,'2024-12-04','absent',null,null,'[]');
  select * into strict r from gw_commute_rows(tenant,mon,member);
  assert r.amount is null and not r.reviewed and cardinality(r.work_dates)=2 and r.work_minutes=960;
  assert jsonb_array_length(gw_commute_overview(tenant,mon,null)->'rows')=3;
  assert jsonb_array_length(gw_commute_overview(tenant,mon,null)->'advisors')=1;
  assert not (gw_commute_overview(tenant,mon,member)->'rows'->0 ? 'advisor_id');
  assert gw_commute_export(tenant,mon,adviser) is null;
  ver := r.version;
  perform pg_temp.expect_error(format('select gw_commute_save(%L,%L,%L,%L,false,''actual'',''区間'',600,array[%L::date],null,%L)',
    tenant,mon,member,actor,'2024-12-04',ver),'commute_dates');
  perform gw_commute_save(tenant,mon,member,actor,false,'actual','区間',600,array['2024-12-02'::date],null,ver);
  perform pg_temp.expect_error(format('select gw_commute_save(%L,%L,%L,%L,true,''none'','''',0,''{}'',null,%L)',
    tenant,mon,member,actor,ver),'commute_stale');
  select * into strict r from gw_commute_rows(tenant,mon,member);
  assert not r.reviewed and r.applied and r.amount=600;
  perform pg_temp.expect_error(format('select gw_commute_save(%L,%L,%L,%L,true,''actual'',''区間'',600,%L,%L,%L)',
    tenant,mon,member,actor,r.dates,other_adviser,r.version),'commute_advisor');
  perform gw_commute_save(tenant,mon,member,actor,true,'actual','区間',600,r.dates,adviser,r.version);
  -- 確認後に勤怠が変わると再確認。実費対象日は社員が選んだまま。
  update gw_time_entries set clock_out = clock_out + interval '15 minutes' where employee_id=member and work_date='2024-12-03';
  select * into strict r from gw_commute_rows(tenant,mon,member);
  assert not r.reviewed and r.work_minutes=975;
  perform gw_commute_save(tenant,mon,member,actor,true,'actual','区間',600,r.dates,adviser,r.version);
  select * into strict r from gw_commute_rows(tenant,mon,fixed);
  assert r.method='pass' and r.rate=12400 and not r.reviewed;
  perform gw_commute_save(tenant,mon,fixed,actor,true,r.method,r.route,r.rate::int,r.dates,null,r.version);
  perform pg_temp.expect_error(format('select gw_commute_close(%L,%L,null,%L,true)',tenant,mon,actor),'commute_unreviewed');
  assert not exists(select from gw_commute_claims where tenant_id=tenant and payroll is not null);
  select * into strict r from gw_commute_rows(tenant,mon,zero_emp);
  perform gw_commute_save(tenant,mon,zero_emp,actor,true,'none','',0,'{}',null,r.version);
  insert into gw_time_fixes(tenant_id,employee_id,work_date,reason) values (tenant,member,'2024-12-03','修正');
  perform pg_temp.expect_error(format('select gw_commute_close(%L,%L,null,%L,true)',tenant,mon,actor),'commute_attendance');
  update gw_time_fixes set status='rejected' where tenant_id=tenant;
  closed_count := gw_commute_close(tenant,mon,null,actor,true);
  assert closed_count=3;
  assert gw_commute_close(tenant,mon,null,actor,true)=0;
  rows := gw_commute_export(tenant,mon,adviser);
  assert jsonb_array_length(rows)=1 and rows->0->>'name'='実費' and rows->0->>'amount'='600';
  assert rows->0->>'workMinutes'='975' and rows->0->>'commuteDays'='1' and not (rows->0 ? 'route');
  assert jsonb_array_length(gw_commute_export(tenant,mon,null))=3;
  assert jsonb_array_length(gw_commute_export(tenant,mon,other_adviser))=0;
  select value into rows from jsonb_array_elements(gw_commute_export(tenant,mon,null)) where value->>'name'='支給なし';
  assert rows->>'amount'='0';
  perform pg_temp.expect_error(format('insert into gw_time_entries(tenant_id,employee_id,work_date) values (%L,%L,%L)',
    tenant,member,'2024-12-05'),'commute_locked');
  perform pg_temp.expect_error(format('insert into gw_time_fixes(tenant_id,employee_id,work_date,reason) values (%L,%L,%L,%L)',
    tenant,zero_emp,'2024-12-05','修正'),'commute_locked');
  select * into strict r from gw_commute_rows(tenant,'2025-01-01',member);
  assert r.rate=600 and r.advisor_id=adviser and cardinality(r.dates)=0 and r.amount is null and not r.reviewed;
  assert not exists(select from gw_commute_rows(tenant,'2025-01-01',fixed));
  update gw_onboard_profiles set commute_cost=20000 where tenant_id=tenant;
  select value into rows from jsonb_array_elements(gw_commute_export(tenant,mon,null)) where value->>'name'='定期';
  assert rows->>'amount'='12400';
  perform gw_commute_close(tenant,mon,member,actor,false);
  assert gw_commute_export(tenant,mon,null) is null;
  assert (select locked from gw_commute_rows(tenant,mon,fixed));
  assert not (select locked from gw_commute_rows(tenant,mon,member));
  assert not has_function_privilege('authenticated','gw_commute_export(uuid,date,uuid)','execute');
  assert not has_table_privilege('anon','gw_commute_claims','select');
end $$;
rollback;
