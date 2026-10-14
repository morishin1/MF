-- db/124_hr_mail_templates.sql（採用HR：応募者へ送るメールのひな型・送った記録）の検証。実際の PostgreSQL で流す。
--
-- ■ 何を確かめるか
--   ・前提（081 採用HR）の上に、2回流しても同じ（べき等）
--   ・2つの表は、採用HRを使える人（gw_is_recruiting）だけが読める。一般メンバー・他社の人事は読めない。誰も直接は書けない
--   ・既定は用途ごとに1つ・非表示は既定にできない・標準のひな型はテナントに1回だけ
--   ・件名の改行・用途の値・長さの制約
--   ・送信の鍵（request_key）はテナントの中で一意（二重送信を防ぐ）。結果の値の制約
--   ・ひな型・応募者を消しても、送った記録は残る（参照だけ外れる）
\set ON_ERROR_STOP 0
\set c124 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/124_hr_mail_templates.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;
create or replace function pg_temp.count_as(uid uuid, tbl text) returns int language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  execute format('select count(*) from %s', tbl) into n;
  execute 'reset role';
  return n;
end $$;
create or replace function pg_temp.try_as(label text, uid uuid, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  perform set_config('request.jwt.claim.sub', uid::text, false);
  execute 'set local role authenticated';
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  execute 'reset role';
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;

select pg_temp.try('A1 124 applies', :'c124', 'ok');
select pg_temp.try('A2 124 applies again (idempotent)', :'c124', 'ok');
select pg_temp.expect('A3 two select-only policies', (select count(*)::int from pg_policies where schemaname='public'
  and tablename in ('gw_hr_mail_templates','gw_hr_mail_sends') and cmd='SELECT'), 2);
select pg_temp.expect('A4 no write policies', (select count(*)::int from pg_policies where schemaname='public'
  and tablename in ('gw_hr_mail_templates','gw_hr_mail_sends') and cmd<>'SELECT'), 0);
select pg_temp.expect('A5 three unique indexes', (select count(*)::int from pg_indexes where schemaname='public'
  and indexname in ('uq_gw_hr_mail_templates_default','uq_gw_hr_mail_templates_seed','uq_gw_hr_mail_sends_request')), 3);
grant all on all tables in schema public to authenticated, service_role;

insert into public.tenants(id,name) values ('12412412-0000-0000-0000-000000000001','T1'), ('12412412-0000-0000-0000-000000000002','T2');
insert into auth.users(id,email) values
 ('a1240001-0000-0000-0000-000000000000','hr@x'), ('a1240002-0000-0000-0000-000000000000','rec@x'),
 ('a1240003-0000-0000-0000-000000000000','member@x'), ('b1240001-0000-0000-0000-000000000000','other-hr@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status) values
 ('a1240001-0000-0000-0000-000000000000','12412412-0000-0000-0000-000000000001','a1240001-0000-0000-0000-000000000000','人事','hr@x','active'),
 ('a1240002-0000-0000-0000-000000000000','12412412-0000-0000-0000-000000000001','a1240002-0000-0000-0000-000000000000','採用','rec@x','active'),
 ('a1240003-0000-0000-0000-000000000000','12412412-0000-0000-0000-000000000001','a1240003-0000-0000-0000-000000000000','一般','member@x','active'),
 ('b1240001-0000-0000-0000-000000000000','12412412-0000-0000-0000-000000000002','b1240001-0000-0000-0000-000000000000','他社人事','other-hr@x','active');
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('12412412-0000-0000-0000-000000000001','a1240001-0000-0000-0000-000000000000','hr'),
 ('12412412-0000-0000-0000-000000000001','a1240002-0000-0000-0000-000000000000','recruiter'),
 ('12412412-0000-0000-0000-000000000002','b1240001-0000-0000-0000-000000000000','hr');
insert into public.gw_hr_applicants(id,tenant_id,name,email,job_title) values
 ('a124aaaa-0000-0000-0000-000000000001','12412412-0000-0000-0000-000000000001','応募 太郎','taro@example.jp','エンジニア');

-- ひな型（service role 相当：postgres で書く）
insert into public.gw_hr_mail_templates(id,tenant_id,name,purpose,subject,body,is_default,seed_key) values
 ('a124bbbb-0000-0000-0000-000000000001','12412412-0000-0000-0000-000000000001','標準','application','件名','{{応募者名}} 様',true,'standard_application_v1'),
 ('a124bbbb-0000-0000-0000-000000000002','12412412-0000-0000-0000-000000000001','複製','application','件名','本文',false,null),
 ('a124bbbb-0000-0000-0000-000000000003','12412412-0000-0000-0000-000000000001','社長面談','ceo','件名','本文',true,null);

select pg_temp.try('B1 second default for the same purpose is refused',
  $q$update public.gw_hr_mail_templates set is_default=true where id='a124bbbb-0000-0000-0000-000000000002'$q$, 'uq_gw_hr_mail_templates_default');
select pg_temp.try('B2 a default must be active',
  $q$update public.gw_hr_mail_templates set is_active=false where id='a124bbbb-0000-0000-0000-000000000001'$q$, 'gw_hr_mail_templates_default_active');
select pg_temp.try('B3 hide clears default (as the API does)',
  $q$update public.gw_hr_mail_templates set is_active=false, is_default=false where id='a124bbbb-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.try('B4 another template can then become default',
  $q$update public.gw_hr_mail_templates set is_default=true where id='a124bbbb-0000-0000-0000-000000000002'$q$, 'ok');
select pg_temp.try('B5 standard template only once per tenant',
  $q$insert into public.gw_hr_mail_templates(tenant_id,name,purpose,subject,body,seed_key) values ('12412412-0000-0000-0000-000000000001','標準2','application','s','b','standard_application_v1')$q$, 'uq_gw_hr_mail_templates_seed');
select pg_temp.try('B6 the same standard template in another tenant is fine',
  $q$insert into public.gw_hr_mail_templates(tenant_id,name,purpose,subject,body,seed_key) values ('12412412-0000-0000-0000-000000000002','標準','application','s','b','standard_application_v1')$q$, 'ok');
select pg_temp.try('B7 newline in the subject is refused',
  $q$insert into public.gw_hr_mail_templates(tenant_id,name,purpose,subject,body) values ('12412412-0000-0000-0000-000000000001','x','other',E'件名\nBcc: x@example.jp','b')$q$, 'gw_hr_mail_templates_subject_check');
select pg_temp.try('B8 unknown purpose is refused',
  $q$insert into public.gw_hr_mail_templates(tenant_id,name,purpose,subject,body) values ('12412412-0000-0000-0000-000000000001','x','spam','s','b')$q$, 'gw_hr_mail_templates_purpose_check');
select pg_temp.try('B9 empty body is refused',
  $q$insert into public.gw_hr_mail_templates(tenant_id,name,purpose,subject,body) values ('12412412-0000-0000-0000-000000000001','x','other','s','')$q$, 'gw_hr_mail_templates_body_check');
select pg_temp.try('B10 version must be at least 1',
  $q$update public.gw_hr_mail_templates set version=0 where id='a124bbbb-0000-0000-0000-000000000002'$q$, 'gw_hr_mail_templates_version_check');

-- 送った記録
insert into public.gw_hr_mail_sends(id,tenant_id,applicant_id,to_email,to_name,template_id,template_version,template_name,subject,body,status,request_key,sent_by) values
 ('a124cccc-0000-0000-0000-000000000001','12412412-0000-0000-0000-000000000001','a124aaaa-0000-0000-0000-000000000001','taro@example.jp','応募 太郎',
  'a124bbbb-0000-0000-0000-000000000002',1,'複製','件名','本文','sent','key-0000-0001','a1240001-0000-0000-0000-000000000000');
select pg_temp.try('C1 the same request key twice is refused (no double send)',
  $q$insert into public.gw_hr_mail_sends(tenant_id,to_email,subject,body,request_key) values ('12412412-0000-0000-0000-000000000001','taro@example.jp','s','b','key-0000-0001')$q$, 'uq_gw_hr_mail_sends_request');
select pg_temp.try('C2 the same key in another tenant is fine',
  $q$insert into public.gw_hr_mail_sends(tenant_id,to_email,subject,body,request_key) values ('12412412-0000-0000-0000-000000000002','b@example.jp','s','b','key-0000-0001')$q$, 'ok');
select pg_temp.try('C3 unknown status is refused',
  $q$insert into public.gw_hr_mail_sends(tenant_id,to_email,subject,body,request_key,status) values ('12412412-0000-0000-0000-000000000001','t@example.jp','s','b','key-0000-0002','delivered')$q$, 'gw_hr_mail_sends_status_check');
select pg_temp.try('C4 too short request key is refused',
  $q$insert into public.gw_hr_mail_sends(tenant_id,to_email,subject,body,request_key) values ('12412412-0000-0000-0000-000000000001','t@example.jp','s','b','short')$q$, 'gw_hr_mail_sends_request_key_check');

-- 読み取り（RLS）
select pg_temp.expect('D1 hr reads templates of own tenant', pg_temp.count_as('a1240001-0000-0000-0000-000000000000','public.gw_hr_mail_templates'), 3);
select pg_temp.expect('D2 recruiter reads templates', pg_temp.count_as('a1240002-0000-0000-0000-000000000000','public.gw_hr_mail_templates'), 3);
select pg_temp.expect('D3 member reads no templates', pg_temp.count_as('a1240003-0000-0000-0000-000000000000','public.gw_hr_mail_templates'), 0);
select pg_temp.expect('D4 other tenant hr reads only own', pg_temp.count_as('b1240001-0000-0000-0000-000000000000','public.gw_hr_mail_templates'), 1);
select pg_temp.expect('D5 hr reads sends of own tenant', pg_temp.count_as('a1240001-0000-0000-0000-000000000000','public.gw_hr_mail_sends'), 1);
select pg_temp.expect('D6 member reads no sends', pg_temp.count_as('a1240003-0000-0000-0000-000000000000','public.gw_hr_mail_sends'), 0);
select pg_temp.expect('D7 other tenant hr reads only own sends', pg_temp.count_as('b1240001-0000-0000-0000-000000000000','public.gw_hr_mail_sends'), 1);

-- 書き込み（RLS：誰も直接は書けない）
select pg_temp.try_as('E1 hr cannot insert a template directly', 'a1240001-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_mail_templates(tenant_id,name,purpose,subject,body) values ('12412412-0000-0000-0000-000000000001','x','other','s','b')$q$, 'row-level security');
select pg_temp.try_as('E2 hr cannot insert a send record directly', 'a1240001-0000-0000-0000-000000000000',
  $q$insert into public.gw_hr_mail_sends(tenant_id,to_email,subject,body,request_key) values ('12412412-0000-0000-0000-000000000001','t@example.jp','s','b','key-0000-0009')$q$, 'row-level security');
select pg_temp.try_as('E3b hr update of a send changes no rows', 'a1240001-0000-0000-0000-000000000000',
  $q$do $d$ declare n int; begin update public.gw_hr_mail_sends set body='改ざん'; get diagnostics n = row_count; if n > 0 then raise exception 'updated %', n; end if; end $d$$q$, 'ok');
select pg_temp.expect('E4 send body unchanged', (select count(*)::int from public.gw_hr_mail_sends where body='改ざん'), 0);

-- 消しても記録は残る
delete from public.gw_hr_mail_templates where id='a124bbbb-0000-0000-0000-000000000002';
delete from public.gw_hr_applicants where id='a124aaaa-0000-0000-0000-000000000001';
select pg_temp.expect('F1 send record kept after template and applicant are deleted',
  (select count(*)::int from public.gw_hr_mail_sends where id='a124cccc-0000-0000-0000-000000000001' and template_id is null and applicant_id is null
     and template_version=1 and template_name='複製' and subject='件名'), 1);
