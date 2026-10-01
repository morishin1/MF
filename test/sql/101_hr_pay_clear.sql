-- db/101_hr_pay_clear.sql の検証（実際の PostgreSQL で流す）。
--
-- ■ 何を確かめるか
--   ・元の列にだけ給与が残っている行があるとき、何も変えずに止まる（安全装置）
--   ・gw_hr_pay に行があれば、元の列が空になる。値が違っても（分離のあとに直していても）止まらない
--   ・以後、元の列には給与を書けない（設定を誤っても、元の列に給与が戻らない）
--   ・元の列を空にしたあと、採用担当は、応募者の表を読めても、どこにも給与が見えない
--   ・もう一度流しても同じ（べき等）
--
-- ■ このシナリオは db/100 まで流した DB の上で、db/101 をこの中で流す（run.sh が SCEN_ROOT を渡す）
\set ON_ERROR_STOP 0
-- 101 の本体（begin / commit は、関数の中では実行できないので外す）
\set c `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/101_hr_pay_clear.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;

insert into public.tenants(id,name) values ('55555555-5555-5555-5555-555555555555','T5');
insert into auth.users(id,email) values ('a5a00000-0000-0000-0000-000000000004','recruiter5@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 values ('a5a00000-0000-0000-0000-000000000004','55555555-5555-5555-5555-555555555555','a5a00000-0000-0000-0000-000000000004','recruiter5','recruiter5@x','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values ('55555555-5555-5555-5555-555555555555','a5a00000-0000-0000-0000-000000000004','recruiter');

insert into public.gw_hr_applicants(id,tenant_id,name,source,wage_type,wage_amount) values
 ('e5000000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','移行済み','リファラル','月給',400000),
 ('e5000000-0000-0000-0000-000000000002','55555555-5555-5555-5555-555555555555','移行漏れ','リファラル','月給',300000);
insert into public.gw_hr_offers(id,tenant_id,applicant_id,version,wage_type,wage_amount,token_hash,expires_at)
 values ('f5000000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','e5000000-0000-0000-0000-000000000001',1,'月給',400000,'h5',now()+interval '1 day');
-- 分離のあとに給与を直した（元の列 400000 ≠ gw_hr_pay 410000）。2人目と合格通知は gw_hr_pay に行が無い
insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount)
 values ('55555555-5555-5555-5555-555555555555','e5000000-0000-0000-0000-000000000001','月給',410000);

-- 安全装置: gw_hr_pay に行が無い給与が残っているので、止まる。何も変わらない
select pg_temp.try('G1 stops when a wage exists only in the old column', :'c', '元の列にだけ給与が残っている');
select pg_temp.expect('G1 nothing changed (applicant)', (select count(*)::int from public.gw_hr_applicants where wage_amount is not null), 2);
select pg_temp.expect('G1 nothing changed (offer)', (select count(*)::int from public.gw_hr_offers where wage_amount is not null), 1);

-- 漏れていた行を gw_hr_pay に足す（db/100 を流し直すのと同じ）
insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount)
 values ('55555555-5555-5555-5555-555555555555','e5000000-0000-0000-0000-000000000002','月給',300000);
insert into public.gw_hr_pay(tenant_id,applicant_id,offer_id,wage_type,wage_amount)
 values ('55555555-5555-5555-5555-555555555555','e5000000-0000-0000-0000-000000000001','f5000000-0000-0000-0000-000000000001','月給',400000);

select pg_temp.try('G2 clears when every wage has a pay row (values may differ)', :'c', 'ok');
select pg_temp.expect('G2 old applicant columns are empty', (select count(*)::int from public.gw_hr_applicants where wage_type is not null or wage_amount is not null), 0);
select pg_temp.expect('G2 old offer columns are empty', (select count(*)::int from public.gw_hr_offers where wage_type is not null or wage_amount is not null), 0);
select pg_temp.expect('G2 pay is untouched (3 rows, newest value kept)',
  (select count(*)::int from public.gw_hr_pay where tenant_id = '55555555-5555-5555-5555-555555555555'), 3);
select pg_temp.expect('G2 the corrected wage is kept in pay',
  (select wage_amount::int from public.gw_hr_pay where applicant_id = 'e5000000-0000-0000-0000-000000000001' and offer_id is null), 410000);

-- 以後、元の列には給与を書けない（設定を誤っても、元の列に給与が戻らない）
select pg_temp.try('C1 cannot write a wage into the old applicant column', $$update public.gw_hr_applicants set wage_amount = 1$$, 'gw_hr_applicants_wage_moved');
select pg_temp.try('C2 cannot insert a wage into the old applicant column', $$insert into public.gw_hr_applicants(tenant_id,name,source,wage_amount) values ('55555555-5555-5555-5555-555555555555','x','y',1)$$, 'gw_hr_applicants_wage_moved');
select pg_temp.try('C3 cannot write a wage into the old offer column', $$update public.gw_hr_offers set wage_type = 'x'$$, 'gw_hr_offers_wage_moved');
select pg_temp.try('C4 non-wage edits still work', $$update public.gw_hr_applicants set job_title = 'エンジニア'$$, 'ok');

-- 採用担当は、応募者の表そのものは読める。給与は、どこにも見えない
set role authenticated;
select set_config('request.jwt.claim.sub','a5a00000-0000-0000-0000-000000000004', false);
select pg_temp.expect('R1 recruiter reads applicants', (select count(*)::int from public.gw_hr_applicants where tenant_id = '55555555-5555-5555-5555-555555555555'), 2);
select pg_temp.expect('R2 recruiter sees no wage in applicants', (select count(*)::int from public.gw_hr_applicants where wage_amount is not null or wage_type is not null), 0);
select pg_temp.expect('R3 recruiter sees no wage in offers', (select count(*)::int from public.gw_hr_offers where wage_amount is not null or wage_type is not null), 0);
select pg_temp.expect('R4 recruiter cannot read pay', (select count(*)::int from public.gw_hr_pay), 0);
reset role;

-- もう一度流しても同じ（べき等）
select pg_temp.try('I1 rerun is a no-op', :'c', 'ok');
select pg_temp.expect('I1 still empty', (select count(*)::int from public.gw_hr_applicants where wage_amount is not null), 0);
