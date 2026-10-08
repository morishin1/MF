-- db/128_office_excel_sync.sql（Excel 年間予定表の同期の履歴）と db/check_office_excel_sync.sql の検証。実際の PostgreSQL で流す。
--
-- ■ 何を確かめるか
--   ・125 が無いと止まる。125 の上に、2回流しても同じ（べき等）
--   ・RLS が有効でポリシーが無い：ログインした人は直接読めない・書けない（API だけが service role で扱う）
--   ・同じテナントで同期中（applying）は1件だけ。完了・失敗にして鍵を外せば、次の同期が入る。ほかのテナントは別
--   ・状態と鍵・完了日時の組み合わせの制約。期の形
--   ・確認用 SQL（db/check_office_excel_sync.sql）が、表が無くても・あってもエラーなく流れる
\set ON_ERROR_STOP 0
\set c125 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/125_office_recurring.sql"`
\set c128 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/128_office_excel_sync.sql"`
\set chk `cat "$SCEN_ROOT/db/check_office_excel_sync.sql"`

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

select pg_temp.try('X0 check SQL runs before 128 (no table)', :'chk', 'ok');
select pg_temp.try('X1 128 stops without 125', :'c128', 'db/125_office_recurring.sql');
select pg_temp.try('X2 125 applies', :'c125', 'ok');
select pg_temp.try('X3 128 applies', :'c128', 'ok');
select pg_temp.try('X4 128 applies again (idempotent)', :'c128', 'ok');
select pg_temp.expect('X5 RLS on', (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'gw_office_excel_syncs' and c.relrowsecurity), 1);
select pg_temp.expect('X6 no policies', (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'gw_office_excel_syncs'), 0);
select pg_temp.expect('X7 lock index', (select count(*)::int from pg_indexes where schemaname = 'public' and indexname = 'uq_gw_office_excel_syncs_lock'), 1);
grant all on all tables in schema public to authenticated, service_role;

insert into public.tenants(id,name) values ('12812812-0000-0000-0000-000000000001','T1'), ('12812812-0000-0000-0000-000000000002','T2');
insert into auth.users(id,email) values ('a1280001-0000-0000-0000-000000000000','fin@x');

select pg_temp.try('Y1 first sync (applying + lock)', $$insert into public.gw_office_excel_syncs(id,tenant_id,period_start,status,lock_key,total_rows,new_count)
  values ('b1280001-0000-0000-0000-000000000000','12812812-0000-0000-0000-000000000001','2026-09','applying','sync',180,180)$$, 'ok');
select pg_temp.try('Y2 second concurrent sync in same tenant is refused', $$insert into public.gw_office_excel_syncs(tenant_id,period_start,status,lock_key)
  values ('12812812-0000-0000-0000-000000000001','2026-09','applying','sync')$$, 'uq_gw_office_excel_syncs_lock');
select pg_temp.try('Y3 other tenant can sync at the same time', $$insert into public.gw_office_excel_syncs(tenant_id,period_start,status,lock_key)
  values ('12812812-0000-0000-0000-000000000002','2026-09','applying','sync')$$, 'ok');
select pg_temp.try('Y4 applying without lock is refused', $$insert into public.gw_office_excel_syncs(tenant_id,period_start,status,lock_key)
  values ('12812812-0000-0000-0000-000000000002','2026-09','applying',null)$$, 'gw_office_excel_syncs_lock');
select pg_temp.try('Y5 committed without committed_at is refused', $$update public.gw_office_excel_syncs set status='committed', lock_key=null
  where id='b1280001-0000-0000-0000-000000000000'$$, 'gw_office_excel_syncs_done');
select pg_temp.try('Y6 commit releases the lock', $$update public.gw_office_excel_syncs set status='committed', lock_key=null, committed_at=now()
  where id='b1280001-0000-0000-0000-000000000000'$$, 'ok');
select pg_temp.try('Y7 next sync in same tenant can start', $$insert into public.gw_office_excel_syncs(tenant_id,period_start,status,lock_key)
  values ('12812812-0000-0000-0000-000000000001','2027-09','applying','sync')$$, 'ok');
select pg_temp.try('Y8 bad period is refused', $$insert into public.gw_office_excel_syncs(tenant_id,period_start,status,lock_key,committed_at)
  values ('12812812-0000-0000-0000-000000000002','2026-13','committed',null,now())$$, 'check');
select pg_temp.try('Y9 bad status is refused', $$insert into public.gw_office_excel_syncs(tenant_id,period_start,status)
  values ('12812812-0000-0000-0000-000000000002','2026-09','done')$$, 'check');
select pg_temp.expect('Y10 history keeps committed rows (many nulls in lock)', (select count(*)::int from public.gw_office_excel_syncs
  where tenant_id='12812812-0000-0000-0000-000000000001'), 2);

select pg_temp.expect('Z1 logged-in user cannot read', pg_temp.count_as('a1280001-0000-0000-0000-000000000000', 'public.gw_office_excel_syncs'), 0);
select pg_temp.try('Z2 check SQL runs after 128', :'chk', 'ok');
select pg_temp.try('Z3 tenant delete cascades', $$delete from public.tenants where id='12812812-0000-0000-0000-000000000002'$$, 'ok');
select pg_temp.expect('Z4 cascade removed T2 rows', (select count(*)::int from public.gw_office_excel_syncs where tenant_id='12812812-0000-0000-0000-000000000002'), 0);
