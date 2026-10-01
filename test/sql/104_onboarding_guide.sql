-- db/104_onboarding_guide.sql の検証（実際の PostgreSQL で流す）。
--
-- ■ 何を確かめるか
--   ・4つの表（入社案内・発行した版・案内URL・メール履歴）は、経営者だけが読み書きできる
--   ・人事・管理者・責任者・採用担当・営業・経理・一般は、読めず、書けもしない（RLS）
--   ・1人に案内は1つ。同じ版を2回は記録できない。トークンは重複できない
--   ・もう一度流しても同じ（べき等）。既存の表を変えない
\set ON_ERROR_STOP 0
\set c104 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/104_onboarding_guide.sql"`

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

insert into public.tenants(id,name) values ('88888888-8888-8888-8888-888888888888','T8');
insert into auth.users(id,email) select ('a8a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'v' || n || '@x' from generate_series(1,9) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '88888888-8888-8888-8888-888888888888', u.id, split_part(u.email,'@',1), u.email, 'active' from auth.users u where u.email ~ '^v[1-9]@x$';
-- v1=owner v2=hr v3=manager v4=recruiter v5=（役割なし）v6=finance v7=member v8=staff(admin) v9=it
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('88888888-8888-8888-8888-888888888888','a8a00001-0000-0000-0000-000000000000','owner'),
 ('88888888-8888-8888-8888-888888888888','a8a00002-0000-0000-0000-000000000000','hr'),
 ('88888888-8888-8888-8888-888888888888','a8a00003-0000-0000-0000-000000000000','manager'),
 ('88888888-8888-8888-8888-888888888888','a8a00004-0000-0000-0000-000000000000','recruiter'),
 ('88888888-8888-8888-8888-888888888888','a8a00006-0000-0000-0000-000000000000','finance');
insert into public.memberships(tenant_id,user_id,role) values ('88888888-8888-8888-8888-888888888888','a8a00008-0000-0000-0000-000000000000','staff');

-- 適用（1回目）と、べき等（2回目）
select pg_temp.try('A1 104 applies', :'c104', 'ok');
select pg_temp.try('A2 104 applies again (idempotent)', :'c104', 'ok');

-- Supabase は、新しい表に authenticated / service_role の権限を自動で付ける（RLS は別に効く）
grant all on all tables in schema public to authenticated, service_role;

-- 行を入れる（RLS を通らない管理者として）
insert into public.gw_onboarding_guides(id,tenant_id,employee_id,location,version)
 values ('c8000000-0000-0000-0000-000000000001','88888888-8888-8888-8888-888888888888','a8a00007-0000-0000-0000-000000000000','原宿オフィス',1);
insert into public.gw_onboarding_guide_issues(tenant_id,guide_id,employee_id,version,snapshot)
 values ('88888888-8888-8888-8888-888888888888','c8000000-0000-0000-0000-000000000001','a8a00007-0000-0000-0000-000000000000',1,'{"location":"原宿オフィス"}');
insert into public.gw_onboarding_invites(tenant_id,employee_id,guide_id,token_hash,expires_at)
 values ('88888888-8888-8888-8888-888888888888','a8a00007-0000-0000-0000-000000000000','c8000000-0000-0000-0000-000000000001','h1', now() + interval '7 days');
insert into public.gw_mail_messages(tenant_id,employee_id,to_email,subject,body_text,status)
 values ('88888888-8888-8888-8888-888888888888','a8a00007-0000-0000-0000-000000000000','v7@x','件名','本文','skipped');

-- 読める人: 経営者だけ
select pg_temp.expect('R1 owner reads guides',  pg_temp.count_as('a8a00001-0000-0000-0000-000000000000','public.gw_onboarding_guides'), 1);
select pg_temp.expect('R2 owner reads issues',  pg_temp.count_as('a8a00001-0000-0000-0000-000000000000','public.gw_onboarding_guide_issues'), 1);
select pg_temp.expect('R3 owner reads invites', pg_temp.count_as('a8a00001-0000-0000-0000-000000000000','public.gw_onboarding_invites'), 1);
select pg_temp.expect('R4 owner reads mail log',pg_temp.count_as('a8a00001-0000-0000-0000-000000000000','public.gw_mail_messages'), 1);

do $$
declare u text; t text; n int; bad int := 0;
begin
  foreach u in array array['a8a00002','a8a00003','a8a00004','a8a00005','a8a00006','a8a00007','a8a00008','a8a00009'] loop
    foreach t in array array['public.gw_onboarding_guides','public.gw_onboarding_guide_issues','public.gw_onboarding_invites','public.gw_mail_messages'] loop
      n := pg_temp.count_as((u || '-0000-0000-0000-000000000000')::uuid, t);
      if n <> 0 then bad := bad + 1; raise notice 'FAIL non-owner % sees % rows in %', u, n, t; end if;
    end loop;
  end loop;
  perform pg_temp.expect('R5 hr/manager/recruiter/finance/member/admin/it/no-role read none of the 4 tables', bad, 0);
end $$;

-- 書ける人: 経営者だけ
select pg_temp.try_as('W1 owner can write a guide', 'a8a00001-0000-0000-0000-000000000000',
  $q$insert into public.gw_onboarding_guides(tenant_id,employee_id,location) values ('88888888-8888-8888-8888-888888888888','a8a00006-0000-0000-0000-000000000000','渋谷')$q$, 'ok');
select pg_temp.try_as('W2 hr cannot write a guide', 'a8a00002-0000-0000-0000-000000000000',
  $q$insert into public.gw_onboarding_guides(tenant_id,employee_id,location) values ('88888888-8888-8888-8888-888888888888','a8a00005-0000-0000-0000-000000000000','渋谷')$q$, 'row-level security');
select pg_temp.try_as('W3 manager cannot write an invite', 'a8a00003-0000-0000-0000-000000000000',
  $q$insert into public.gw_onboarding_invites(tenant_id,employee_id,token_hash,expires_at) values ('88888888-8888-8888-8888-888888888888','a8a00007-0000-0000-0000-000000000000','h2', now())$q$, 'row-level security');
select pg_temp.try_as('W4 admin (staff) cannot write mail log', 'a8a00008-0000-0000-0000-000000000000',
  $q$insert into public.gw_mail_messages(tenant_id,to_email,subject,body_text,status) values ('88888888-8888-8888-8888-888888888888','a@x','s','b','sent')$q$, 'row-level security');
select pg_temp.try_as('W5 recruiter cannot change an issued guide', 'a8a00004-0000-0000-0000-000000000000',
  $q$update public.gw_onboarding_guides set confirmed_version = 1 where id = 'c8000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.expect('W6 the update by a non-owner changed nothing',
  (select count(*)::int from public.gw_onboarding_guides where confirmed_version is not null), 0);

-- 制約
select pg_temp.try('C1 one guide per employee', $q$insert into public.gw_onboarding_guides(tenant_id,employee_id) values ('88888888-8888-8888-8888-888888888888','a8a00007-0000-0000-0000-000000000000')$q$, 'duplicate key');
select pg_temp.try('C2 the same version cannot be recorded twice', $q$insert into public.gw_onboarding_guide_issues(tenant_id,guide_id,employee_id,version,snapshot) values ('88888888-8888-8888-8888-888888888888','c8000000-0000-0000-0000-000000000001','a8a00007-0000-0000-0000-000000000000',1,'{}')$q$, 'duplicate key');
select pg_temp.try('C3 a token hash cannot repeat', $q$insert into public.gw_onboarding_invites(tenant_id,employee_id,token_hash,expires_at) values ('88888888-8888-8888-8888-888888888888','a8a00007-0000-0000-0000-000000000000','h1', now())$q$, 'duplicate key');
select pg_temp.try('C4 a mail log status must be one of sent/failed/skipped', $q$insert into public.gw_mail_messages(tenant_id,to_email,subject,body_text,status) values ('88888888-8888-8888-8888-888888888888','a@x','s','b','queued')$q$, 'check constraint');
select pg_temp.try('C5 deleting the employee removes the guide (cascade)', $q$delete from public.gw_employees where id = 'a8a00007-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('C6 ...and its issues and invites go with it', (select count(*)::int from public.gw_onboarding_guide_issues) + (select count(*)::int from public.gw_onboarding_invites), 0);
