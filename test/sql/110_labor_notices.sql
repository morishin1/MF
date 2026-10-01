-- db/110_labor_notices.sql（労働条件通知書）の検証。実際の PostgreSQL で流す。
--
-- ■ 何を確かめるか
--   ・DB から直接読めるのは、人事として扱う人（経営者・人事・管理者）だけ。本人も、他の役割も、他社の人事も読めない
--   ・誰も（人事・経営者でも）、画面から直接は書けない（書き込みのポリシーが無い）。書くのは API の service_role だけ
--   ・版の中身（ファイルの場所・名前・ハッシュ・版番号・アップロード）は、あとから書き換えられない
--   ・公開した日時・確認した日時は、一度入ったら書き換えられない。確認は1回だけ。同じ値の再送（二重押し）は通る
--   ・公開していない版は、確認できない
--   ・同じ人・同じ版番号は、2つ作れない。版番号は1以上
--   ・アップロードした人のアカウントを消しても、版は残る（uploaded_by が null になる）
--   ・もう一度流しても同じ（べき等）。読み取り専用の前提チェック（db/check_labor_notice.sql）が、実体で判定できる
\set ON_ERROR_STOP 0
\set c110 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/110_labor_notices.sql"`
\set chk `sed 's/;[[:space:]]*$//' "$SCEN_ROOT/db/check_labor_notice.sql"`

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

-- Supabase の Storage の代用品（バケット hr は非公開）
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
insert into storage.buckets(id, name, public) values ('hr', 'hr', false) on conflict do nothing;

insert into public.tenants(id,name) values ('77777777-7777-7777-7777-777777777777','T7'), ('66666666-6666-6666-6666-666666666666','T6');
insert into auth.users(id,email) select ('a7a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'v' || n || '@x' from generate_series(1,8) n;
insert into auth.users(id,email) values ('a7a000f0-0000-0000-0000-000000000000', 'uploader@x'), ('b7a00001-0000-0000-0000-000000000000', 'other-hr@x');
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '77777777-7777-7777-7777-777777777777', u.id, split_part(u.email,'@',1), u.email, 'active' from auth.users u where u.email ~ '^v[1-8]@x$';
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 values ('b7a00001-0000-0000-0000-000000000000','66666666-6666-6666-6666-666666666666','b7a00001-0000-0000-0000-000000000000','other-hr','other-hr@x','active');
-- v1=owner v2=hr v3=manager v4=recruiter v5=（役割なし）v6=finance v7=member（通知書の本人）v8=staff(admin)
insert into public.gw_role_grants(tenant_id,employee_id,role) values
 ('77777777-7777-7777-7777-777777777777','a7a00001-0000-0000-0000-000000000000','owner'),
 ('77777777-7777-7777-7777-777777777777','a7a00002-0000-0000-0000-000000000000','hr'),
 ('77777777-7777-7777-7777-777777777777','a7a00003-0000-0000-0000-000000000000','manager'),
 ('77777777-7777-7777-7777-777777777777','a7a00004-0000-0000-0000-000000000000','recruiter'),
 ('77777777-7777-7777-7777-777777777777','a7a00006-0000-0000-0000-000000000000','finance'),
 ('66666666-6666-6666-6666-666666666666','b7a00001-0000-0000-0000-000000000000','hr');
insert into public.memberships(tenant_id,user_id,role) values ('77777777-7777-7777-7777-777777777777','a7a00008-0000-0000-0000-000000000000','staff');

-- 前提チェック（読み取り専用）。適用前: 必須の NG は 0、この SQL の分は「未適用」4 件
select pg_temp.expect('K1 check sql: no NG before applying 110', (select count(*)::int from (:chk) t where "結果" = 'NG'), 0);
select pg_temp.expect('K2 check sql: 110 objects are reported as not applied yet (4 rows)', (select count(*)::int from (:chk) t where "結果" = '未適用'), 4);

-- 適用（1回目）と、べき等（2回目）
select pg_temp.try('A1 110 applies', :'c110', 'ok');
select pg_temp.try('A2 110 applies again (idempotent)', :'c110', 'ok');
grant all on all tables in schema public to authenticated, service_role;
select pg_temp.expect('K3 check sql: after applying, nothing is reported as not applied', (select count(*)::int from (:chk) t where "結果" = '未適用'), 0);
select pg_temp.expect('K4 check sql: still no NG', (select count(*)::int from (:chk) t where "結果" = 'NG'), 0);

-- 行を入れる（RLS を通らない管理者として）。v7 の v1（公開済み）・v2（下書き）
insert into public.gw_labor_notices(id,tenant_id,employee_id,version,storage_path,filename,size_bytes,sha256,uploaded_by,published_by,published_at)
 values ('d7000000-0000-0000-0000-000000000001','77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',1,
         '77777777-7777-7777-7777-777777777777/labor-notice/a7a00007-0000-0000-0000-000000000000/f1.pdf','通知書_v1.pdf',1000,'aa','a7a00002-0000-0000-0000-000000000000','a7a00002-0000-0000-0000-000000000000', now());
insert into public.gw_labor_notices(id,tenant_id,employee_id,version,storage_path,filename,size_bytes,sha256,uploaded_by)
 values ('d7000000-0000-0000-0000-000000000002','77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',2,
         '77777777-7777-7777-7777-777777777777/labor-notice/a7a00007-0000-0000-0000-000000000000/f2.pdf','通知書_v2.pdf',2000,'bb','a7a000f0-0000-0000-0000-000000000000');

-- 読める人: 人事として扱う人（経営者・人事・管理者）だけ
select pg_temp.expect('R1 owner reads', pg_temp.count_as('a7a00001-0000-0000-0000-000000000000','public.gw_labor_notices'), 2);
select pg_temp.expect('R2 hr reads', pg_temp.count_as('a7a00002-0000-0000-0000-000000000000','public.gw_labor_notices'), 2);
select pg_temp.expect('R3 admin (staff) reads', pg_temp.count_as('a7a00008-0000-0000-0000-000000000000','public.gw_labor_notices'), 2);
do $$
declare u text; n int; bad int := 0;
begin
  -- manager / recruiter / 役割なし / finance / 通知書の本人（v7）
  foreach u in array array['a7a00003','a7a00004','a7a00005','a7a00006','a7a00007'] loop
    n := pg_temp.count_as((u || '-0000-0000-0000-000000000000')::uuid, 'public.gw_labor_notices');
    if n <> 0 then bad := bad + 1; raise notice 'FAIL % sees % rows', u, n; end if;
  end loop;
  perform pg_temp.expect('R4 manager/recruiter/no-role/finance and the employee himself read nothing directly (the API serves him)', bad, 0);
end $$;
select pg_temp.expect('R5 another company''s hr reads nothing', pg_temp.count_as('b7a00001-0000-0000-0000-000000000000','public.gw_labor_notices'), 0);

-- 書ける人: 誰もいない（API の service_role だけ）
select pg_temp.try_as('W1 owner cannot insert directly', 'a7a00001-0000-0000-0000-000000000000',
  $q$insert into public.gw_labor_notices(tenant_id,employee_id,version,storage_path,filename) values ('77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',9,'p','f')$q$, 'row-level security');
select pg_temp.try_as('W2 hr cannot insert directly', 'a7a00002-0000-0000-0000-000000000000',
  $q$insert into public.gw_labor_notices(tenant_id,employee_id,version,storage_path,filename) values ('77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',9,'p','f')$q$, 'row-level security');
select pg_temp.try_as('W3 the employee cannot confirm directly', 'a7a00007-0000-0000-0000-000000000000',
  $q$update public.gw_labor_notices set confirmed_at = now() where id = 'd7000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.expect('W4 ...and it changed nothing', (select count(*)::int from public.gw_labor_notices where confirmed_at is not null), 0);
select pg_temp.try_as('W5 hr cannot publish directly', 'a7a00002-0000-0000-0000-000000000000',
  $q$update public.gw_labor_notices set published_at = now() where id = 'd7000000-0000-0000-0000-000000000002'$q$, 'ok');
select pg_temp.expect('W6 ...and it changed nothing', (select count(*)::int from public.gw_labor_notices where published_at is null), 1);

-- 版の中身は書き換えられない（service_role / 管理者でも）
select pg_temp.try('T1 storage_path is immutable', $q$update public.gw_labor_notices set storage_path = 'x' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '版の中身は変えられません');
select pg_temp.try('T2 filename is immutable', $q$update public.gw_labor_notices set filename = 'x.pdf' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '版の中身は変えられません');
select pg_temp.try('T3 version is immutable', $q$update public.gw_labor_notices set version = 5 where id = 'd7000000-0000-0000-0000-000000000001'$q$, '版の中身は変えられません');
select pg_temp.try('T4 sha256 is immutable', $q$update public.gw_labor_notices set sha256 = 'zz' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '版の中身は変えられません');
select pg_temp.try('T5 uploaded_at is immutable', $q$update public.gw_labor_notices set uploaded_at = now() + interval '1 day' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '版の中身は変えられません');
select pg_temp.try('T6 employee_id is immutable (a version cannot be moved to another person)', $q$update public.gw_labor_notices set employee_id = 'a7a00006-0000-0000-0000-000000000000' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '版の中身は変えられません');

-- 公開・確認
select pg_temp.try('P1 a draft cannot be confirmed', $q$update public.gw_labor_notices set confirmed_at = now() where id = 'd7000000-0000-0000-0000-000000000002'$q$, 'confirm_needs_publish');
select pg_temp.try('P2 a published version can be confirmed (once)', $q$update public.gw_labor_notices set confirmed_at = '2026-10-02 10:00+09', confirmed_by = 'a7a00007-0000-0000-0000-000000000000' where id = 'd7000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.try('P3 the same confirmation can be sent again (double click is idempotent)', $q$update public.gw_labor_notices set confirmed_at = '2026-10-02 10:00+09', confirmed_by = 'a7a00007-0000-0000-0000-000000000000' where id = 'd7000000-0000-0000-0000-000000000001'$q$, 'ok');
select pg_temp.try('P4 the confirmed time cannot be changed', $q$update public.gw_labor_notices set confirmed_at = '2026-10-09 10:00+09' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '確認した日時は変えられません');
select pg_temp.try('P5 the confirmation cannot be erased', $q$update public.gw_labor_notices set confirmed_at = null where id = 'd7000000-0000-0000-0000-000000000001'$q$, '確認した日時は変えられません');
select pg_temp.try('P6 the published time cannot be changed', $q$update public.gw_labor_notices set published_at = now() + interval '1 day' where id = 'd7000000-0000-0000-0000-000000000001'$q$, '公開した日時は変えられません');
select pg_temp.try('P7 the published time cannot be erased', $q$update public.gw_labor_notices set published_at = null where id = 'd7000000-0000-0000-0000-000000000001'$q$, '公開した日時は変えられません');
select pg_temp.try('P8 a draft can be published', $q$update public.gw_labor_notices set published_at = now(), published_by = 'a7a00002-0000-0000-0000-000000000000' where id = 'd7000000-0000-0000-0000-000000000002'$q$, 'ok');
select pg_temp.expect('P9 the new version starts unconfirmed; the old version keeps its confirmation',
  (select count(*)::int from public.gw_labor_notices where version = 2 and confirmed_at is null) * 10
  + (select count(*)::int from public.gw_labor_notices where version = 1 and confirmed_at is not null), 11);

-- 制約
select pg_temp.try('C1 the same version cannot exist twice for a person', $q$insert into public.gw_labor_notices(tenant_id,employee_id,version,storage_path,filename) values ('77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',2,'p','f')$q$, 'duplicate key');
select pg_temp.try('C2 version must be 1 or more', $q$insert into public.gw_labor_notices(tenant_id,employee_id,version,storage_path,filename) values ('77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',0,'p','f')$q$, 'check constraint');
select pg_temp.try('C3 a new version is just added (history is kept)', $q$insert into public.gw_labor_notices(tenant_id,employee_id,version,storage_path,filename) values ('77777777-7777-7777-7777-777777777777','a7a00007-0000-0000-0000-000000000000',3,'p3','f3.pdf')$q$, 'ok');
select pg_temp.expect('C4 all three versions are kept', (select count(*)::int from public.gw_labor_notices where employee_id = 'a7a00007-0000-0000-0000-000000000000'), 3);

-- アップロードした人のアカウントを消しても、版は残る
select pg_temp.try('F1 deleting the uploader account succeeds', $q$delete from auth.users where id = 'a7a000f0-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('F2 ...the version stays, uploaded_by becomes null', (select count(*)::int from public.gw_labor_notices where id = 'd7000000-0000-0000-0000-000000000002' and uploaded_by is null), 1);

-- 本人（社員）の行を消すと、通知書も一緒に消える（個人情報の削除）。ここ以外に、削除の経路は無い
select pg_temp.try('D1 deleting the employee removes the versions (cascade)', $q$delete from public.gw_employees where id = 'a7a00007-0000-0000-0000-000000000000'$q$, 'ok');
select pg_temp.expect('D2 ...and nothing is left', (select count(*)::int from public.gw_labor_notices), 0);
