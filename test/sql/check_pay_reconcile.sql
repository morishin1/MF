-- db/check_pay_reconcile.sql（給与の所在と食い違いを見る、読み取りだけの確認。金額は出さない）と、
-- db/check_pay_reconcile_detail.sql（経営者だけが使う、金額つきの詳細）が、実際の PostgreSQL で動くことを確かめる。
--
-- ■ 何を確かめるか
--   ・そのまま流せる。何も書き換えない（行も表も増えない）
--   ・表がまだ無いとき（契約・入社情報・給与管理）は、落ちずに「（表なし）」と言う
--   ・db/105 を流したあと、社員数・参照元の有無（契約・gw_hr_pay・通勤手当の届出・給与CSVの参照元）・給与管理の未登録人数・
--     各データ間の不一致件数を、社員の氏名つきで正しく数える
--   ・対象は在籍中と退職手続き中だけ（退職者・入社準備中・BP は数えない）
--   ・通常の結果には、実際の給与金額が1つも出ない（氏名・状態・不一致の理由だけ）。金額は詳細SQLにだけ出る
--   ・名前が多いときは30人で切って「ほかN人」
\set ON_ERROR_STOP 0
\set body `cat "$SCEN_ROOT/db/check_pay_reconcile.sql"`
\set detail `cat "$SCEN_ROOT/db/check_pay_reconcile_detail.sql"`
\set c105 `sed '/^begin;/d;/^commit;/d;/^notify/d' "$SCEN_ROOT/db/105_compensation.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || coalesce(got::text, 'null') || ' / want ' || want; end $$;
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

-- ---- 1回目: 契約・入社情報・給与管理の表が、まだ無い（社員もいない）-----------------------
create temp table r0 as :body;
select pg_temp.ok('P1 the script returns rows with no such tables', (select count(*) > 20 from r0));
select pg_temp.ok('P2 contracts missing → 表なし', pg_temp.state_of('r0', '契約に給与あり') = '（表なし）');
select pg_temp.ok('P3 compensations missing → 給与管理の表なし', pg_temp.state_of('r0', '給与管理が未登録で、契約に給与がある') = '（給与管理の表なし）');
select pg_temp.ok('P4 the number of covered employees is 0, not missing', pg_temp.n_of('r0', '対象社員数') = 0);
select pg_temp.ok('P5 the ownership table (C) is always shown', (select count(*) from r0 where "区分" like 'C.%') = 8);
select pg_temp.ok('P6 unit_price is listed as out of scope', (select count(*) from r0 where "項目" like '%unit_price%' and "状態" like '対象外%') = 1);
select pg_temp.ok('P7 hr_pay (db/100) exists and is empty', pg_temp.n_of('r0', '内定の給与専用の表') = 0);
create temp table d0 as :detail;
select pg_temp.ok('P8 the detail script runs with no such tables (0 rows, no error)', (select count(*) = 0 from d0));

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
alter table public.gw_employees add column employee_kind text not null default 'proper';   -- 075（BP）
insert into public.tenants(id,name) values ('66666666-6666-6666-6666-666666666666','T6');
insert into auth.users(id,email) select ('a6a' || lpad(n::text, 5, '0') || '-0000-0000-0000-000000000000')::uuid, 'p' || n || '@x' from generate_series(1,12) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status,employee_kind)
 select u.id, '66666666-6666-6666-6666-666666666666', u.id, '社員' || substr(split_part(u.email,'@',1), 2),  u.email,
        case split_part(u.email,'@',1) when 'p8' then 'left' when 'p10' then 'invited' else 'active' end,
        case split_part(u.email,'@',1) when 'p11' then 'bp' else 'proper' end
   from auth.users u where u.email ~ '^p([1-9]|1[0-2])@x$';
-- 社員1: 契約に給与あり・給与管理は未登録・届出あり           → 候補にできる
-- 社員2: 契約と一致。ただし通勤手当が届出と違う。内定の給与は契約と同じ
-- 社員3: 基本給が契約と違う。内定の給与も契約と違う
-- 社員4: 時給。契約と一致
-- 社員5: 契約なし。給与管理には未来の記録だけ
-- 社員6: 有効な契約が2件（新しいほうを見る）。給与管理は未登録
-- 社員7: 契約の種別が「その他」。賃金の注記に文章。給与管理は未登録
-- 社員8: 退職者（数えない）
-- 社員9: 契約に金額なし・注記だけ。給与管理は未登録 → 手入力が必要
-- 社員10: 入社準備中（数えない）  社員11: BP（数えない）
-- 社員12: 契約は年俸。給与管理は月給 → 種別が違う
insert into public.gw_contracts(tenant_id,employee_id,status,wage_type,wage_amount,wage_note,created_at)
select '66666666-6666-6666-6666-666666666666', ('a6a' || lpad(n::text, 5, '0') || '-0000-0000-0000-000000000000')::uuid, 'active', t, a, note, now()
  from (values (1,'月給',300000,null),(2,'月給',300000,null),(3,'月給',300000,null),(4,'時給',2000,null),
               (6,'月給',280000,null),(7,'その他',1000,'交通費は実費。皆勤手当 5000円'),(8,'月給',250000,null),(9,null,null,'家族手当あり'),
               (10,'月給',250000,null),(12,'年俸',3600000,null)) v(n,t,a,note);
insert into public.gw_contracts(tenant_id,employee_id,status,wage_type,wage_amount,created_at)
values ('66666666-6666-6666-6666-666666666666','a6a00006-0000-0000-0000-000000000000','active','月給',290000, now() - interval '1 day'),
       ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','draft','月給',999999, now());
insert into public.gw_onboard_profiles(tenant_id,employee_id,commute_cost)
values ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000',8000),
       ('66666666-6666-6666-6666-666666666666','a6a00002-0000-0000-0000-000000000000',12000),
       ('66666666-6666-6666-6666-666666666666','a6a00003-0000-0000-0000-000000000000',null);
-- 内定の給与（gw_hr_pay）: 社員2は契約と同じ、社員3は違う
insert into public.gw_hr_applicants(id,tenant_id,name,employee_id) values
  ('b6b00002-0000-0000-0000-000000000000','66666666-6666-6666-6666-666666666666','応募2','a6a00002-0000-0000-0000-000000000000'),
  ('b6b00003-0000-0000-0000-000000000000','66666666-6666-6666-6666-666666666666','応募3','a6a00003-0000-0000-0000-000000000000');
insert into public.gw_hr_pay(tenant_id,applicant_id,wage_type,wage_amount) values
  ('66666666-6666-6666-6666-666666666666','b6b00002-0000-0000-0000-000000000000','月給',300000),
  ('66666666-6666-6666-6666-666666666666','b6b00003-0000-0000-0000-000000000000','月給',280000);

-- 給与管理の表を作る前
create temp table r1a as :body;
select pg_temp.ok('Q0 before 105: the compensation rows say 給与管理の表なし', pg_temp.state_of('r1a', '給与管理に未登録') = '（給与管理の表なし）');
select pg_temp.expect('Q1 before 105: covered employees = 9', pg_temp.n_of('r1a', '対象社員数'), 9);

:c105
insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,commute_amount,kind,reason)
select '66666666-6666-6666-6666-666666666666', ('a6a' || lpad(n::text, 5, '0') || '-0000-0000-0000-000000000000')::uuid, d::date, 1, t, a, c, 'initial', '検証'
  from (values (2,'2020-01-01','月給',300000,10000),(3,'2020-01-01','月給',350000,null),(4,'2020-01-01','時給',2000,null),
               (5,'2099-01-01','月給',260000,null),(12,'2020-01-01','月給',300000,null)) v(n,d,t,a,c);

-- ---- 2回目: 表がそろったあと ------------------------------------------------------------
create temp table cnt0 as select (select count(*) from public.gw_compensations) as comp, (select count(*) from public.gw_pay_audit) as aud,
  (select count(*) from public.gw_contracts) as con, (select count(*) from public.gw_employees) as emp,
  (select count(*) from pg_tables where schemaname = 'public') as tbl;
create temp table r1 as :body;

-- 社員数と参照元
select pg_temp.expect('A1 covered employees (active/leaving, no BP): 社員1〜7,9,12 = 9', pg_temp.n_of('r1', '対象社員数'), 9);
select pg_temp.expect('A2 invited employees are counted separately: 社員10', pg_temp.n_of('r1', '入社準備中の社員数'), 1);
select pg_temp.expect('A3 BP are counted separately: 社員11', pg_temp.n_of('r1', 'BP（外部パートナー）の人数'), 1);
select pg_temp.expect('A4 contract has wage (= CSV base reference exists): 1,2,3,4,6,7,12 = 7', pg_temp.n_of('r1', '契約に給与あり'), 7);
select pg_temp.expect('A5 contract has no wage (= CSV base is empty): 社員5, 社員9', pg_temp.n_of('r1', '契約に給与なし'), 2);
select pg_temp.ok('A5b the names are shown', pg_temp.detail_of('r1', '契約に給与なし') like '社員5、社員9%');
select pg_temp.expect('A6 hr_pay present: 社員2, 社員3', pg_temp.n_of('r1', '内定の給与あり'), 2);
select pg_temp.expect('A7 hr_pay absent: 9 - 2 = 7', pg_temp.n_of('r1', '内定の給与なし'), 7);
select pg_temp.expect('A8 declared commute (= CSV commute reference exists): 社員1, 社員2', pg_temp.n_of('r1', '通勤手当の届出あり'), 2);
select pg_temp.expect('A9 no declared commute: 9 - 2 = 7', pg_temp.n_of('r1', '通勤手当の届出なし'), 7);
select pg_temp.expect('A10 registered in pay management (current record): 社員2,3,4,12', pg_temp.n_of('r1', '給与管理に登録済み'), 4);
select pg_temp.expect('A11 not registered (no record): 社員1,6,7,9', pg_temp.n_of('r1', '給与管理に未登録'), 4);
select pg_temp.ok('A11b names', pg_temp.detail_of('r1', '給与管理に未登録') like '社員1、社員6、社員7、社員9%');
select pg_temp.expect('A12 future-only: 社員5', pg_temp.n_of('r1', '給与管理に、適用開始日が未来'), 1);

-- 不一致
select pg_temp.expect('B20 unregistered + contract has wage: 社員1, 6, 7', pg_temp.n_of('r1', '給与管理が未登録で、契約に給与がある'), 3);
select pg_temp.ok('B20b the left/invited/BP employees are not counted', pg_temp.detail_of('r1', '給与管理が未登録で、契約に給与がある') !~ '社員(8|10|11)');
select pg_temp.expect('B21 unregistered + no wage anywhere: 社員9', pg_temp.n_of('r1', '給与管理が未登録で、契約にも給与がない'), 1);
select pg_temp.expect('B22 base differs from contract: 社員3, 社員12', pg_temp.n_of('r1', '給与管理の基本給が'), 2);
select pg_temp.ok('B22b reasons are shown, not amounts', pg_temp.detail_of('r1', '給与管理の基本給が') like '%社員12（種別が違う）%'
  and pg_temp.detail_of('r1', '給与管理の基本給が') like '%社員3（金額が違う）%');
select pg_temp.expect('B23 commute differs from declared: 社員2', pg_temp.n_of('r1', '給与管理の通勤手当が'), 1);
select pg_temp.ok('B23b reason', pg_temp.detail_of('r1', '給与管理の通勤手当が') like '社員2（金額が違う）%');
select pg_temp.expect('B24 hr_pay differs from contract: 社員3', pg_temp.n_of('r1', '内定の給与が、契約'), 1);
select pg_temp.expect('B25 two or more active contracts: 社員6', pg_temp.n_of('r1', '有効な契約が2件以上'), 1);
select pg_temp.expect('B26 contract type unsupported: 社員7', pg_temp.n_of('r1', '契約の賃金の種別が'), 1);
select pg_temp.expect('B27 wage_note has text: 社員7, 社員9', pg_temp.n_of('r1', '契約の「手当・控除など」'), 2);
select pg_temp.expect('B28 CSV output vs pay management differs: 社員2 (commute), 3 (base), 12 (base)', pg_temp.n_of('r1', '給与CSVの出力値'), 3);
select pg_temp.ok('B28b what differs is shown', pg_temp.detail_of('r1', '給与CSVの出力値') like '%社員2（通勤手当が違う）%'
  and pg_temp.detail_of('r1', '給与CSVの出力値') like '%社員3（基本給が違う）%');
select pg_temp.ok('B29 a warning mark is shown for a non-zero count', pg_temp.state_of('r1', '給与管理の基本給が') like '⚠%');

-- 通常の結果に、実際の給与金額が1つも出ない
select pg_temp.ok('N1 no wage amount appears anywhere in the normal result',
  (select count(*) = 0 from r1 where ("項目" || ' ' || "状態" || ' ' || "詳細") ~ '(^|[^0-9])(300000|350000|280000|290000|260000|250000|3600000|2000|1000|12000|10000|8000|999999)([^0-9]|$)'));
select pg_temp.ok('N2 the normal result has no long digit runs at all (employee names have 1-2 digits)',
  (select count(*) = 0 from r1 where ("詳細") ~ '[0-9]{4,}'));

-- 何も書き換えていない
select pg_temp.ok('W1 nothing written by the script',
  (select comp = (select count(*) from public.gw_compensations) and aud = (select count(*) from public.gw_pay_audit)
      and con = (select count(*) from public.gw_contracts) and emp = (select count(*) from public.gw_employees)
      and tbl = (select count(*) from pg_tables where schemaname = 'public') from cnt0));

-- ---- 詳細SQL（金額つき）--------------------------------------------------------------
create temp table d1 as :detail;
select pg_temp.expect('D1 the detail lists 9 covered + 1 invited (no left, no BP) = 10', (select count(*)::int from d1), 10);
select pg_temp.ok('D2 the detail shows amounts (this is the owner-only script)',
  (select "契約の金額" = 300000 and "届出の定期代" = 12000 and "給与管理の基本給" = 300000 and "給与管理の通勤手当" = 10000 and "内定の給与の金額" = 300000
     from d1 where "氏名" = '社員2'));
select pg_temp.ok('D3 the verdicts', (select "判定" from d1 where "氏名" = '社員1') = '未登録'
  and (select "判定" from d1 where "氏名" = '社員5') = '適用前のみ'
  and (select "判定" from d1 where "氏名" = '社員3') = '基本給が契約と違う'
  and (select "判定" from d1 where "氏名" = '社員2') = '通勤手当が届出と違う'
  and (select "判定" from d1 where "氏名" = '社員4') = '一致'
  and (select "判定" from d1 where "氏名" = '社員12') = '基本給が契約と違う');
select pg_temp.ok('D4 contract count and note flag', (select "有効な契約の件数" = 2 from d1 where "氏名" = '社員6')
  and (select "契約の注記" = 'あり' from d1 where "氏名" = '社員7'));
select pg_temp.ok('D5 the newest active contract is used (社員6: 280000, not 290000)', (select "契約の金額" = 280000 from d1 where "氏名" = '社員6'));
select pg_temp.ok('D6 the detail also wrote nothing',
  (select comp = (select count(*) from public.gw_compensations) and aud = (select count(*) from public.gw_pay_audit) from cnt0));

-- 記録が揃ったら 0 件（✅）になる: 社員1に契約どおりの記録を足す
insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason)
values ('66666666-6666-6666-6666-666666666666','a6a00001-0000-0000-0000-000000000000','2020-01-01',1,'月給',300000,'initial','検証');
create temp table r2 as :body;
select pg_temp.expect('B20 after adding a record for 社員1 → 2', pg_temp.n_of('r2', '給与管理が未登録で、契約に給与がある'), 2);
select pg_temp.expect('A11 unregistered after adding → 3', pg_temp.n_of('r2', '給与管理に未登録'), 3);

-- 訂正（次の版）で契約に合わせると、食い違いが消える（最新の版で比べる）
insert into public.gw_compensations(tenant_id,employee_id,effective_from,revision,wage_type,base_amount,kind,reason,before)
values ('66666666-6666-6666-6666-666666666666','a6a00003-0000-0000-0000-000000000000','2020-01-01',2,'月給',300000,'correction','入力ミスの訂正','{"baseAmount":350000}');
create temp table r3 as :body;
select pg_temp.expect('B22 after the correction → 社員12 only', pg_temp.n_of('r3', '給与管理の基本給が'), 1);
select pg_temp.expect('B28 CSV vs pay: 社員1 (commute: registered without one, but declared), 社員2 (commute), 社員12 (base)', pg_temp.n_of('r3', '給与CSVの出力値'), 3);
select pg_temp.ok('B28c 社員3 is no longer listed (corrected)', pg_temp.detail_of('r3', '給与CSVの出力値') not like '%社員3（%'
  and pg_temp.detail_of('r3', '給与CSVの出力値') like '%社員1（通勤手当が違う）%');

-- 名前が多いとき: 30人で切って「ほかN人」
insert into auth.users(id,email) select ('a7a' || lpad(n::text, 5, '0') || '-0000-0000-0000-000000000000')::uuid, 'q' || n || '@x' from generate_series(1,35) n;
insert into public.gw_employees(id,tenant_id,user_id,display_name,email,status)
 select u.id, '66666666-6666-6666-6666-666666666666', u.id, '多数' || lpad(substr(split_part(u.email,'@',1), 2), 2, '0'), u.email, 'active' from auth.users u where u.email ~ '^q[0-9]+@x$';
create temp table r4 as :body;
select pg_temp.expect('M1 many unregistered: 3 + 35', pg_temp.n_of('r4', '給与管理に未登録'), 38);
select pg_temp.ok('M2 names are cut at 30 with a remainder', pg_temp.detail_of('r4', '給与管理に未登録') like '%…ほか8人%');

-- ---- 書き込みが構造上できない接続（begin read only）でも動く -----------------------------------
begin read only;
:body
rollback;
begin read only;
:detail
rollback;
select pg_temp.ok('RO1 both scripts ran inside read-only transactions (an error above would be counted by the runner)', true);

-- ---- db/100 の前（gw_hr_pay が無い）でも、内定の給与を「元の列」から数える -----------------------------
-- 社員2: 応募者の列に給与（契約と同じ）。社員3: 合格通知の列に給与（契約と違う）
drop table public.gw_hr_pay;
update public.gw_hr_applicants set wage_type = '月給', wage_amount = 300000 where id = 'b6b00002-0000-0000-0000-000000000000';
insert into public.gw_hr_offers(tenant_id,applicant_id,version,wage_type,wage_amount,token_hash,expires_at)
values ('66666666-6666-6666-6666-666666666666','b6b00003-0000-0000-0000-000000000000',1,'月給',270000,'h1', now() + interval '7 days'),
       ('66666666-6666-6666-6666-666666666666','b6b00003-0000-0000-0000-000000000000',2,'月給',280000,'h2', now() + interval '7 days');
create temp table r5 as :body;
select pg_temp.expect('H1 without gw_hr_pay: the 内定 rows are not 表なし; 内定あり: 社員2 (applicant column), 社員3 (offer column)', pg_temp.n_of('r5', '内定の給与あり'), 2);
select pg_temp.expect('H2 内定なし = (9 + 35 added above) - 2', pg_temp.n_of('r5', '内定の給与なし'), 42);
select pg_temp.expect('H3 the newest offer (v2) is compared with the contract: 社員3 differs', pg_temp.n_of('r5', '内定の給与が、契約'), 1);
select pg_temp.ok('H3b the name and reason, no amounts', pg_temp.detail_of('r5', '内定の給与が、契約') like '社員3（金額が違う）%');
select pg_temp.ok('H4 no amounts anywhere (also in this state)', (select count(*) = 0 from r5 where ("項目" || ' ' || "状態" || ' ' || "詳細") ~ '[0-9]{4,}'));
select pg_temp.ok('H5 the gw_hr_pay reference row says 表なし (it is not there)', pg_temp.state_of('r5', '内定の給与専用の表') = '（表なし）');
create temp table d5 as :detail;
select pg_temp.ok('H6 the detail shows the original-column amounts: 社員2 300000 (applicant), 社員3 280000 (newest offer)',
  (select "内定の給与の金額" = 300000 from d5 where "氏名" = '社員2') and (select "内定の給与の金額" = 280000 from d5 where "氏名" = '社員3'));
begin read only;
:body
rollback;
select pg_temp.ok('H7 also runs read-only without gw_hr_pay', true);
