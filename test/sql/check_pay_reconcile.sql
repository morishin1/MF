-- db/check_pay_reconcile.sql（給与の所在と食い違いを見る、読み取りだけの確認）が、実際の PostgreSQL で動き、
-- 食い違いを正しく数えることを確かめる。
--
-- ■ 何を確かめるか
--   ・そのまま流せる。何も書き換えない（行も表も増えない）
--   ・表がまだ無いとき（契約・入社情報・給与管理）は、落ちずに「（表なし）」と言う
--   ・db/105 を流したあと、次の食い違いを、社員の氏名つきで正しく数える
--       契約に賃金があるのに給与管理に記録がない／基本給が契約と違う／通勤手当が届出と違う／未来の記録だけ
--       有効な契約が2件以上／契約の種別が取り込めない／賃金の注記に文章がある
--   ・退職者は数えない。金額は出さない
\set ON_ERROR_STOP 0
\set body `cat "$SCEN_ROOT/db/check_pay_reconcile.sql"`
\set c105 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/105_compensation.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.ok(label text, cond boolean) returns void language plpgsql as $$
begin raise notice '% : %', case when coalesce(cond, false) then 'PASS' else 'FAIL' end || ' ' || label, ''; end $$;
-- 「⚠ 2 件」「ℹ 5 件」から件数を取り出す。表が無いときは null
create or replace function pg_temp.n_of(rows_tbl text, item_prefix text) returns int language plpgsql as $$
declare s text;
begin
  execute format($f$select "状態" from %I where "項目" like %L limit 1$f$, rows_tbl, item_prefix || '%') into s;
  return nullif(regexp_replace(coalesce(s, ''), '[^0-9]', '', 'g'), '')::int;
end $$;
create or replace function pg_temp.state_of(rows_tbl text, item_prefix text) returns text language plpgsql as $$
declare s text;
begin
  execute format($f$select "状態" from %I where "項目" like %L limit 1$f$, rows_tbl, item_prefix || '%') into s;
  return s;
end $$;
create or replace function pg_temp.detail_of(rows_tbl text, item_prefix text) returns text language plpgsql as $$
declare s text;
begin
  execute format($f$select "詳細" from %I where "項目" like %L limit 1$f$, rows_tbl, item_prefix || '%') into s;
  return s;
end $$;

-- ---- 1回目: 契約・入社情報・給与管理の表が、まだ無い --------------------------------
create temp table r0 as :body;
select pg_temp.ok('P1 the script returns rows with no such tables', (select count(*) > 20 from r0));
select pg_temp.ok('P2 contracts missing → 表なし', pg_temp.state_of('r0', '契約（有効）で賃金') = '（表なし）');
select pg_temp.ok('P3 gw_compensations missing → 給与管理の表なし', pg_temp.state_of('r0', '在籍者で、契約に賃金がある') = '（給与管理の表なし）');
select pg_temp.ok('P4 hr_pay (db/100) exists and is empty', pg_temp.n_of('r0', '内定の給与専用の表') = 0);
select pg_temp.ok('P5 the ownership table (C) is always shown', (select count(*) from r0 where "区分" like 'C.%') = 8);
select pg_temp.ok('P6 unit_price is listed as out of scope', (select count(*) from r0 where "項目" like '%unit_price%' and "状態" like '対象外%') = 1);

-- ---- 準備: 契約・入社情報の表（本番にある形の代用）と、社員 ---------------------------
create table public.gw_contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  status text not null default 'draft', wage_type text, wage_amount numeric, wage_note text,
  created_at timestamptz not null default now()
);
create table public.gw_onboard_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null unique references public.gw_employees(id) on delete cascade,
  commute_cost numeric
);
insert into public.tenants(id,name) values ('66666666-6666-6666-6666-666666666666','T6');
insert into auth.users(id,email) select ('a6a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'p' || n || '@x' from generate_series(1,9) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '66666666-6666-6666-6666-666666666666', u.id, '社員' || right(split_part(u.email,'@',1), 1), u.email,
        case when u.email = 'p8@x' then 'left' else 'active' end
   from auth.users u where u.email ~ '^p[1-9]@x$';
-- 社員1: 契約に賃金があり、給与管理には記録なし
-- 社員2: 契約と一致。ただし通勤手当が本人の届出と違う
-- 社員3: 基本給が契約と違う
-- 社員4: 時給。契約と一致
-- 社員5: 契約なし。給与管理には、未来の記録だけ
-- 社員6: 有効な契約が2件
-- 社員7: 契約の種別が「その他」。賃金の注記に文章
-- 社員8: 退職者。契約に賃金があり、給与管理に記録なし（数えない）
-- 社員9: 賃金の注記に文章のみ（金額なし）
insert into public.gw_contracts(tenant_id,employee_id,status,wage_type,wage_amount,wage_note,created_at)
select '66666666-6666-6666-6666-666666666666', ('a6a0000' || n || '-0000-0000-0000-000000000000')::uuid, 'active', t, a, note, now()
  from (values (1,'月給',300000,null),(2,'月給',300000,null),(3,'月給',300000,null),(4,'時給',2000,null),
               (6,'月給',280000,null),(7,'その他',1000,'交通費は実費。皆勤手当 5000円'),(8,'月給',250000,null),(9,null,null,'家族手当あり')) v(n,t,a,note);
insert into public.gw_contracts(tenant_id,employee_id,status,wage_type,wage_amount,created_at)
values ('66666666-6666-6666-6666-666666666666','a6a00006-0000-0000-0000-000000000000','active','月給',290000, now() - interval '1 day'),
       ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','draft','月給',999999, now());
insert into public.gw_onboard_profiles(tenant_id,employee_id,commute_cost)
values ('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000',12000),
       ('66666666-6666-6666-6666-666666666666','a6a00003-0000-0000-0000-000000000000',null);

:c105
insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,commute_amount,kind,reason)
select '66666666-6666-6666-6666-666666666666', ('a6a0000' || n || '-0000-0000-0000-000000000000')::uuid, d::date, 1, t, a, c, 'initial', '検証'
  from (values (2,'2020-01-01','月給',300000,10000),(3,'2020-01-01','月給',350000,null),(4,'2020-01-01','時給',2000,null),
               (5,'2099-01-01','月給',260000,null)) v(n,d,t,a,c);

-- ---- 2回目: 表がそろったあと ------------------------------------------------------------
create temp table cnt0 as select (select count(*) from public.gw_compensations) as comp, (select count(*) from public.gw_pay_audit) as aud,
  (select count(*) from public.gw_contracts) as con, (select count(*) from pg_tables where schemaname = 'public') as tbl;
create temp table r1 as :body;
select pg_temp.expect('A1 contracts (active, with wage): 社員1〜4,6(2件),7,8 = 8', pg_temp.n_of('r1', '契約（有効）で賃金'), 8);
select pg_temp.expect('A2 two or more active contracts: 社員6', pg_temp.n_of('r1', '有効な契約が2件以上'), 1);
select pg_temp.ok('A2b the name is shown', pg_temp.detail_of('r1', '有効な契約が2件以上') like '社員6%');
select pg_temp.expect('A3 unsupported wage type with amount: 社員7', pg_temp.n_of('r1', '契約の賃金の種別が'), 1);
select pg_temp.expect('A4 wage_note has text: 社員7, 社員9', pg_temp.n_of('r1', '契約の「手当・控除など」'), 2);
select pg_temp.expect('A5 declared commute: 社員2 only (null is not counted)', pg_temp.n_of('r1', '入社情報の届出'), 1);
select pg_temp.expect('A9 compensations rows', pg_temp.n_of('r1', '給与管理（gw_compensations）の行数'), 4);
select pg_temp.expect('A10 employees with a current record: 社員2,3,4 (社員5 is future)', pg_temp.n_of('r1', '給与管理に、現在の記録がある'), 3);

-- B1: 契約に賃金があるのに記録がない = 社員1, 6, 7, 9?  （9 は金額なし → 対象外）／ 社員8 は退職 → 対象外
select pg_temp.expect('B1 contract has wage but no compensation: 社員1, 6, 7', pg_temp.n_of('r1', '在籍者で、契約に賃金がある'), 3);
select pg_temp.ok('B1b names, no amounts', pg_temp.detail_of('r1', '在籍者で、契約に賃金がある') like '社員1、社員6、社員7%'
  and pg_temp.detail_of('r1', '在籍者で、契約に賃金がある') !~ '[0-9]{4}');
select pg_temp.ok('B1c the left employee (社員8) is not counted', pg_temp.detail_of('r1', '在籍者で、契約に賃金がある') not like '%社員8%');
select pg_temp.expect('B2 base differs from contract: 社員3', pg_temp.n_of('r1', '給与管理の現在の基本給が'), 1);
select pg_temp.ok('B2b name', pg_temp.detail_of('r1', '給与管理の現在の基本給が') like '社員3%');
select pg_temp.expect('B3 commute differs from declared: 社員2', pg_temp.n_of('r1', '給与管理の通勤手当が'), 1);
select pg_temp.expect('B4 future-only: 社員5', pg_temp.n_of('r1', '給与管理に、適用開始日が未来'), 1);
select pg_temp.ok('B4b name', pg_temp.detail_of('r1', '給与管理に、適用開始日が未来') like '社員5%');
select pg_temp.ok('B5 a ✅ / ⚠ mark is shown (0 is ✅)', pg_temp.state_of('r1', '給与管理の現在の基本給が') like '⚠%');

-- 何も書き換えていない
select pg_temp.ok('W1 nothing written by the script',
  (select comp = (select count(*) from public.gw_compensations) and aud = (select count(*) from public.gw_pay_audit)
      and con = (select count(*) from public.gw_contracts) and tbl = (select count(*) from pg_tables where schemaname = 'public') from cnt0));

-- 記録が揃ったら 0 件（✅）になる: 社員1に契約どおりの記録を足す
insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason)
values ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','2020-01-01',1,'月給',300000,'initial','検証');
create temp table r2 as :body;
select pg_temp.expect('B1 after adding a record for 社員1 → 2', pg_temp.n_of('r2', '在籍者で、契約に賃金がある'), 2);

-- 訂正（次の版）で契約に合わせると、食い違いが消える（最新の版で比べる）
insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason,before)
values ('66666666-6666-6666-6666-666666666666','a6a00003-0000-0000-0000-000000000000','2020-01-01',2,'月給',300000,'correction','入力ミスの訂正','{"baseAmount":350000}');
create temp table r3 as :body;
select pg_temp.expect('B2 after the correction → 0', pg_temp.n_of('r3', '給与管理の現在の基本給が'), 0);
select pg_temp.ok('B2c 0 is shown as ✅', pg_temp.state_of('r3', '給与管理の現在の基本給が') like '✅%');
