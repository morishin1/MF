-- db/161_enger_company_portal.sql の検証（実際の PostgreSQL で流す。test/sql/run.sh）
--
-- ■ 何を確かめるか
--   ・前提（enger.companies / enger.candidates）が無い DB では、何も作らずに止まる
--   ・2回流しても同じ（べき等）。確認 SQL（check_161）に ❌ が出ない
--   ・ブラウザ（anon / authenticated）からは読めない・書けない。service_role だけが読み書きできる
--   ・1つのメールは1人だけ。大文字・空白入りのメールは入らない
--   ・保存した人材の企業IDは、保存した利用者の企業IDと必ず一致する。停止中の利用者は保存できない
--   ・商談準備の紐づけは、企業×人材で1行だけ。状態は4つだけ
--   ・記録（events）は追記だけ。service_role でも、所有者でも、更新・削除できない
--   ・戻す SQL：有効な登録済み利用者がいると止まる。停止すれば戻せる。もう一度流せる
--
\set ON_ERROR_STOP 0
\set c161 `sed '/^begin;/d;/^commit;/d' "$SCEN_ROOT/db/161_enger_company_portal.sql"`
\set crb `sed '/^begin;/d;/^commit;/d' "$SCEN_ROOT/db/rollback_161_enger_company_portal.sql"`
\set cchk `sed 's/;\s*$//' "$SCEN_ROOT/db/check_161_enger_company_portal.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.expect_true(label text, got boolean) returns void language plpgsql as $$
begin raise notice '% : %', case when coalesce(got, false) then 'PASS' else 'FAIL' end || ' ' || label, coalesce(got::text, 'null'); end $$;
-- SQL ファイルを1つのまとまりとして流す（途中で止まったら全部なかったことになる。SQL Editor と同じ）
create or replace function pg_temp.try(label text, stmt text, expect text) returns void language plpgsql as $$
declare msg text; ok boolean := false;
begin
  begin execute stmt; ok := true; exception when others then msg := sqlerrm; end;
  if expect = 'ok' then raise notice '% : %', case when ok then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'');
  else raise notice '% : %', case when not ok and msg like '%'||expect||'%' then 'PASS' else 'FAIL' end || ' ' || label, coalesce(msg,'(no error)'); end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
end $$;

-- 1) 前提が無い DB では何も作らない
select pg_temp.try('前提が無いときは止まる', :'c161', '前提の表がありません');
select pg_temp.expect_true('前提が無いときは作らない', to_regclass('enger.dx2_company_portal_members') is null);

-- 前提（共有 Supabase にある表の最小の代用品）
create schema if not exists enger;
grant usage on schema enger to anon, authenticated, service_role;
create table if not exists enger.companies (id uuid primary key default gen_random_uuid(), name text not null, deleted_at timestamptz);
create table if not exists enger.candidates (id uuid primary key default gen_random_uuid(), candidate_no int, name text, initials text, deleted_at timestamptz);
-- Supabase の既定（新しい表に anon / authenticated / service_role の権限が付く）を再現する
alter default privileges in schema enger grant all on tables to anon, authenticated, service_role;
grant all on enger.companies, enger.candidates to anon, authenticated, service_role;

-- 2) 2回流してもエラーにならない
select pg_temp.try('161 を流せる', :'c161', 'ok');
select pg_temp.try('161 は2回流しても同じ（べき等）', :'c161', 'ok');
select pg_temp.expect('確認 SQL に ❌ が無い', (select count(*)::int from (:cchk) x where result not like '✅%'), 0);
select pg_temp.expect('確認 SQL の項目数', (select count(*)::int from (:cchk) x), 9);

-- 3) ブラウザからは読めない
select pg_temp.expect_true('anon は利用者を読めない', not has_table_privilege('anon', 'enger.dx2_company_portal_members', 'SELECT'));
select pg_temp.expect_true('authenticated は利用者を読めない', not has_table_privilege('authenticated', 'enger.dx2_company_portal_members', 'SELECT'));
select pg_temp.expect_true('authenticated は招待を読めない', not has_table_privilege('authenticated', 'enger.dx2_company_portal_invites', 'SELECT'));
select pg_temp.expect_true('authenticated は保存に書けない', not has_table_privilege('authenticated', 'enger.dx2_company_portal_saved_talents', 'INSERT'));
select pg_temp.expect_true('authenticated は紐づけを読めない', not has_table_privilege('authenticated', 'enger.dx2_company_talent_links', 'SELECT'));
select pg_temp.expect_true('anon は記録を読めない', not has_table_privilege('anon', 'enger.dx2_company_portal_events', 'SELECT'));
select pg_temp.expect_true('service_role は記録を更新できない', not has_table_privilege('service_role', 'enger.dx2_company_portal_events', 'UPDATE'));
select pg_temp.expect_true('service_role は利用者を消せない', not has_table_privilege('service_role', 'enger.dx2_company_portal_members', 'DELETE'));

-- 試験データ
insert into public.tenants (id, name) values ('4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'エイト');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@client-a.example'),
  ('aaaaaaaa-0000-4000-8000-000000000009', 'staff@eight.example');
insert into enger.companies (id, name) values
  ('cccccccc-0000-4000-8000-00000000000a', '企業A'),
  ('cccccccc-0000-4000-8000-00000000000b', '企業B');
insert into enger.candidates (id, candidate_no, name, initials) values
  ('dddddddd-0000-4000-8000-000000000001', 101, '山田 太郎', 'T.Y.'),
  ('dddddddd-0000-4000-8000-000000000002', 102, '佐藤 花子', 'H.S.');

set role service_role;
insert into enger.dx2_company_portal_members (id, tenant_id, company_id, email, display_name, role, auth_user_id, registered_at, created_by)
values ('eeeeeeee-0000-4000-8000-00000000000a', '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000a',
        'a@client-a.example', '企業Aの担当', 'admin', 'aaaaaaaa-0000-4000-8000-000000000001', now(), 'aaaaaaaa-0000-4000-8000-000000000009');
insert into enger.dx2_company_portal_members (id, tenant_id, company_id, email, display_name)
values ('eeeeeeee-0000-4000-8000-00000000000b', '4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000b',
        'b@client-b.example', '企業Bの担当');
reset role;
select pg_temp.expect('service_role は利用者を作れる', (select count(*)::int from enger.dx2_company_portal_members), 2);

-- 4) 同じメールは二重に作れない・大文字や空白は入らない
do $$ begin
  begin
    insert into enger.dx2_company_portal_members (tenant_id, company_id, email, display_name)
    values ('4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000b', 'a@client-a.example', '別企業で同じ人');
    raise notice 'FAIL 同じメールは二重に作れない : 入った';
  exception when unique_violation then raise notice 'PASS 同じメールは二重に作れない : 止まった';
  end;
  begin
    insert into enger.dx2_company_portal_members (tenant_id, company_id, email, display_name)
    values ('4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000b', 'Upper@Client-B.example', '大文字');
    raise notice 'FAIL 大文字のメールは入らない : 入った';
  exception when check_violation then raise notice 'PASS 大文字のメールは入らない : 止まった';
  end;
  begin
    insert into enger.dx2_company_portal_members (tenant_id, company_id, email, display_name, role)
    values ('4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000b', 'c@client-b.example', '権限', 'owner');
    raise notice 'FAIL 知らない権限は入らない : 入った';
  exception when check_violation then raise notice 'PASS 知らない権限は入らない : 止まった';
  end;
end $$;

-- 招待のトークンは sha256（hex 64桁）だけ
do $$ begin
  begin
    insert into enger.dx2_company_portal_invites (member_id, token_hash, expires_at)
    values ('eeeeeeee-0000-4000-8000-00000000000b', 'plain-token-should-not-be-stored', now() + interval '7 days');
    raise notice 'FAIL 平文のトークンは入らない : 入った';
  exception when check_violation then raise notice 'PASS 平文のトークンは入らない : 止まった';
  end;
end $$;
set role service_role;
insert into enger.dx2_company_portal_invites (member_id, token_hash, expires_at)
values ('eeeeeeee-0000-4000-8000-00000000000b', repeat('a', 64), now() + interval '7 days');
reset role;
select pg_temp.expect('招待（ハッシュ）は入る', (select count(*)::int from enger.dx2_company_portal_invites), 1);

-- 5) 保存の企業IDは、保存した利用者の企業IDと一致しないと入らない
set role service_role;
insert into enger.dx2_company_portal_saved_talents (company_id, member_id, candidate_id)
values ('cccccccc-0000-4000-8000-00000000000a', 'eeeeeeee-0000-4000-8000-00000000000a', 'dddddddd-0000-4000-8000-000000000001');
reset role;
select pg_temp.expect('自社の利用者は保存できる（トリガ関数の実行権限が無くても動く）', (select count(*)::int from enger.dx2_company_portal_saved_talents), 1);
do $$ begin
  begin
    insert into enger.dx2_company_portal_saved_talents (company_id, member_id, candidate_id)
    values ('cccccccc-0000-4000-8000-00000000000b', 'eeeeeeee-0000-4000-8000-00000000000a', 'dddddddd-0000-4000-8000-000000000002');
    raise notice 'FAIL 他社の企業IDでは保存できない : 入った';
  exception when check_violation then raise notice 'PASS 他社の企業IDでは保存できない : 止まった';
  end;
  begin
    insert into enger.dx2_company_portal_saved_talents (company_id, member_id, candidate_id)
    values ('cccccccc-0000-4000-8000-00000000000a', 'eeeeeeee-0000-4000-8000-00000000000a', 'dddddddd-0000-4000-8000-000000000001');
    raise notice 'FAIL 同じ人材を二重に保存できない : 入った';
  exception when unique_violation then raise notice 'PASS 同じ人材を二重に保存できない : 止まった';
  end;
end $$;
update enger.dx2_company_portal_members set disabled_at = now() where id = 'eeeeeeee-0000-4000-8000-00000000000b';
do $$ begin
  begin
    insert into enger.dx2_company_portal_saved_talents (company_id, member_id, candidate_id)
    values ('cccccccc-0000-4000-8000-00000000000b', 'eeeeeeee-0000-4000-8000-00000000000b', 'dddddddd-0000-4000-8000-000000000002');
    raise notice 'FAIL 停止中の利用者は保存できない : 入った';
  exception when check_violation then raise notice 'PASS 停止中の利用者は保存できない : 止まった';
  end;
end $$;

-- 6) 商談準備の紐づけ：企業×人材で1行・状態は4つ
set role service_role;
insert into enger.dx2_company_talent_links (tenant_id, company_id, candidate_id, status, note)
values ('4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000a', 'dddddddd-0000-4000-8000-000000000001', 'planned', '社内メモ');
reset role;
do $$ begin
  begin
    insert into enger.dx2_company_talent_links (tenant_id, company_id, candidate_id)
    values ('4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac', 'cccccccc-0000-4000-8000-00000000000a', 'dddddddd-0000-4000-8000-000000000001');
    raise notice 'FAIL 同じ企業×人材は1行 : 入った';
  exception when unique_violation then raise notice 'PASS 同じ企業×人材は1行 : 止まった';
  end;
  begin
    update enger.dx2_company_talent_links set status = 'offered';
    raise notice 'FAIL 知らない状態は入らない : 入った';
  exception when check_violation then raise notice 'PASS 知らない状態は入らない : 止まった';
  end;
end $$;

-- 7) 記録は追記だけ
set role service_role;
insert into enger.dx2_company_portal_events (company_id, member_id, actor_kind, actor_user_id, action, target_id, detail)
values ('cccccccc-0000-4000-8000-00000000000a', 'eeeeeeee-0000-4000-8000-00000000000a', 'portal', 'aaaaaaaa-0000-4000-8000-000000000001', 'talent.view', 'P-000101', '{"tab":"all"}');
reset role;
do $$ begin
  begin
    update enger.dx2_company_portal_events set action = 'talent.save';
    raise notice 'FAIL 記録は所有者でも更新できない : 更新された';
  exception when insufficient_privilege then raise notice 'PASS 記録は所有者でも更新できない : 止まった';
  end;
  begin
    delete from enger.dx2_company_portal_events;
    raise notice 'FAIL 記録は所有者でも消せない : 消えた';
  exception when insufficient_privilege then raise notice 'PASS 記録は所有者でも消せない : 止まった';
  end;
  begin
    insert into enger.dx2_company_portal_events (actor_kind, action) values ('portal', 'Talent View');
    raise notice 'FAIL 記録の種類は決まった形だけ : 入った';
  exception when check_violation then raise notice 'PASS 記録の種類は決まった形だけ : 止まった';
  end;
end $$;
select pg_temp.expect('記録は残っている', (select count(*)::int from enger.dx2_company_portal_events), 1);

-- authenticated で実際に読もうとしても読めない
set role authenticated;
do $$ begin
  begin
    perform 1 from enger.dx2_company_portal_members;
    raise notice 'FAIL authenticated で利用者を select できない : 読めた';
  exception when insufficient_privilege then raise notice 'PASS authenticated で利用者を select できない : 止まった';
  end;
end $$;
reset role;

-- 8) 戻す：有効な登録済み利用者がいると止まる
select pg_temp.try('有効な登録済みがいると、戻す SQL は止まる', :'crb', '登録済みで有効な企業ポータル利用者');
select pg_temp.expect_true('有効な登録済みがいると戻さない', to_regclass('enger.dx2_company_portal_members') is not null);
update enger.dx2_company_portal_members set disabled_at = now() where auth_user_id is not null;
select pg_temp.try('停止すれば戻す SQL が通る', :'crb', 'ok');
select pg_temp.expect_true('停止すれば戻せる（表が消える）', to_regclass('enger.dx2_company_portal_members') is null and to_regclass('enger.dx2_company_portal_events') is null);
select pg_temp.expect_true('人材・企業は消えない', (select count(*) from enger.candidates) = 2 and (select count(*) from enger.companies) = 2);
select pg_temp.try('戻したあと、もう一度流せる', :'c161', 'ok');
select pg_temp.expect('戻したあとの確認 SQL に ❌ が無い', (select count(*)::int from (:cchk) x where result not like '✅%'), 0);
