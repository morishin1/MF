-- db/check_onboarding_ready.sql（入社管理＋労働条件通知書の、本番 DB の前提チェック）の検証。実際の PostgreSQL で流す。
--
-- ■ 何を確かめるか
--   ・表も列も無い DB（入社の SQL を1つも流していない）でも、チェックは落ちずに「不足」を返す
--   ・最小の流し方（006 → 008 → 009 → 012 → 037 → 039 → 066 → 110）で、必須の不足が 0 になる（docs/onboarding-db-prereq.md の順）
--     ※ 土台（schema・005・007・031・033・026 の関数）は、本番では適用済みのはずのもの。ここでは、同じものを先に用意する
--   ・その8つは、どれを抜いても必須の不足が出る（＝1つも余計ではない）→ 流す順に、前提が足りないと止まることも確かめる
--   ・必須の1つずつを壊すと、その行だけが「不足」になる（列・check・一意・ポリシー・トリガ・バケット・データ）
--   ・もう一度流しても同じ（べき等）。重複データがあれば、重複の行が「不足」になる
--   ・読み取り専用（チェックを流す前後で、表の行数も定義も変わらない）
--   ・任意の欠けは、必須の判定に混ざらない。hr_flow を通さない既存の問題が、「任意（なし）」として見える
\set ON_ERROR_STOP 0
\set chk `sed 's/;[[:space:]]*$//' "$SCEN_ROOT/db/check_onboarding_ready.sql"`
\set pstub `echo "$SCEN_ROOT/test/sql/onboarding_storage_stub.sql"`
\set pbase `echo "$SCEN_ROOT/test/sql/onboarding_base.sql"`
\set p006 `echo "$SCEN_ROOT/db/006_storage_policies.sql"`
\set p008 `echo "$SCEN_ROOT/db/008_onboarding.sql"`
\set p009 `echo "$SCEN_ROOT/db/009_tasks.sql"`
\set p012 `echo "$SCEN_ROOT/db/012_hr_files.sql"`
\set p013 `echo "$SCEN_ROOT/db/013_notifications.sql"`
\set p037 `echo "$SCEN_ROOT/db/037_onboard_form.sql"`
\set p039 `echo "$SCEN_ROOT/db/039_consent_and_drive.sql"`
\set p065 `echo "$SCEN_ROOT/db/065_onboarding_one.sql"`
\set p066 `echo "$SCEN_ROOT/db/066_hr_flow.sql"`
\set p070 `echo "$SCEN_ROOT/db/070_onboarding_stage.sql"`
\set p110 `echo "$SCEN_ROOT/db/110_labor_notices.sql"`

create or replace function pg_temp.expect(label text, got int, want int) returns void language plpgsql as $$
begin raise notice '% : %', case when got = want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || got || ' / want ' || want; end $$;
create or replace function pg_temp.expect_t(label text, got text, want text) returns void language plpgsql as $$
begin raise notice '% : %', case when got is not distinct from want then 'PASS' else 'FAIL' end || ' ' || label, 'got ' || coalesce(got, '(null)') || ' / want ' || coalesce(want, '(null)'); end $$;

\i :pstub

-- チェックを、そのまま見える形にする（流すたびに、いまの DB を読み直す）
create temp view chk as :chk;
create or replace function pg_temp.v(prefix text) returns text language sql as $$
  select string_agg("判定", ',') from pg_temp.chk where "確認する対象（実体）" like prefix || '%' $$;
create or replace function pg_temp.m(prefix text) returns text language sql as $$
  select string_agg("不足の中身", ',') from pg_temp.chk where "確認する対象（実体）" like prefix || '%' $$;
create or replace function pg_temp.short() returns int language sql as $$ select count(*)::int from pg_temp.chk where "判定" = '不足' $$;
create or replace function pg_temp.short_names() returns text language sql as $$ select string_agg("確認する対象（実体）", ' | ') from pg_temp.chk where "判定" = '不足' $$;

-- ================= A. 入社の表が1つも無い DB（土台だけ）=================
select pg_temp.expect('A1 no onboarding tables: the check still runs and reports many 不足', (pg_temp.short() > 5)::int, 1);
select pg_temp.expect_t('A2 gw_procedures table is 不足', pg_temp.v('gw_procedures（表）の基本'), '不足');
select pg_temp.expect_t('A3 gw_procedures missing says the table is missing', pg_temp.m('gw_procedures（表）の基本'), '表が無い（gw_procedures）');
select pg_temp.expect_t('A4 gw_labor_notices is 不足 (110 not applied)', pg_temp.v('gw_labor_notices（表）'), '不足');
select pg_temp.expect_t('A5 gw_employees base columns exist (005)', pg_temp.v('gw_employees（表）の基本'), '必須で存在');
select pg_temp.expect_t('A6 gw_employees.manager_id etc. are 不足 until 033', pg_temp.v('gw_employees.manager_id'), '不足');
select pg_temp.expect_t('A7 gw_employees.autonomy_level is 不足 until 031', pg_temp.v('gw_employees.autonomy_level'), '不足');
select pg_temp.expect_t('A8 duplicate-procedures row is 不足 when there is no table (not an error)', pg_temp.v('同じ人・同じ種別の入社手続き'), '不足');
select pg_temp.expect_t('A9 safe_uuid is not there yet (apply 006 first)', pg_temp.v('関数 safe_uuid'), '任意（なし）');
select pg_temp.expect_t('A10 gw_is_owner exists (db/099 is part of the base)', pg_temp.v('関数 gw_is_owner'), '任意（あり）');
select pg_temp.expect_t('A11 the summary row is first', (select "判定" from pg_temp.chk limit 1), '集計');

-- ================= B. 土台（本番では適用済みのはず）を用意する =================
-- 007（本人が自分の社員名簿の行を読めるポリシー）・031/033（gw_employees の列）・026 の関数（039 の前提）。test/sql/onboarding_base.sql
\i :pbase
select pg_temp.expect_t('B1 after the base: gw_employees.manager_id etc. exist', pg_temp.v('gw_employees.manager_id'), '必須で存在');
select pg_temp.expect_t('B2 after the base: gw_employees.autonomy_level exists', pg_temp.v('gw_employees.autonomy_level'), '必須で存在');
select pg_temp.expect_t('B3 the self-read policy (007) exists', pg_temp.v('gw_employees を、本人が'), '必須で存在');
select pg_temp.expect_t('B4 gw_is_internal_staff exists (what 039 needs)', pg_temp.v('関数 gw_is_internal_staff'), '任意（あり）');

-- 試験用のデータ（1社・owner 1人・入社予定の本人 1人）
insert into public.tenants(id, name) values ('88888888-8888-8888-8888-888888888888', 'T8');
insert into auth.users(id, email) values ('a8a00001-0000-0000-0000-000000000000', 'owner8@x'), ('a8a00002-0000-0000-0000-000000000000', 'new8@x');
insert into public.gw_employees(id, tenant_id, user_id, display_name, email, status) values
  ('a8a00001-0000-0000-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'a8a00001-0000-0000-0000-000000000000', 'owner8', 'owner8@x', 'active'),
  ('a8a00002-0000-0000-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'new8', 'new8@x', 'active');

-- ================= C. 最小の流し方（docs/onboarding-db-prereq.md の順）=================
\i :p006
\i :p008
\i :p009
\i :p012
\i :p037
\i :p039
\i :p066
\i :p110
grant all on all tables in schema public to authenticated, service_role;

select pg_temp.expect('C1 owner/hr data is the only 不足 left (no role is granted yet)', pg_temp.short(), 1);
select pg_temp.expect_t('C2 ...and it is the owner/hr row', pg_temp.short_names(), 'owner または hr ロールの人が、1人以上いる');
insert into public.gw_role_grants(tenant_id, employee_id, role) values ('88888888-8888-8888-8888-888888888888', 'a8a00001-0000-0000-0000-000000000000', 'owner');
select pg_temp.expect('C3 after the 8 files + an owner: no 必須 is missing', pg_temp.short(), 0);
select pg_temp.expect_t('C4 the summary says so', (select "不足の中身" from pg_temp.chk where "判定" = '集計'), '必須は全部そろっています');
select pg_temp.expect_t('C5 the summary row is "必須は全部そろっています"', (select "確認する対象（実体）" from pg_temp.chk where "判定" = '集計'), '必須の不足 0 件 ／ 任意の欠け ' || (select count(*) from pg_temp.chk where "判定" = '任意（なし）') || ' 件');

-- 任意のもの（流していない）は「任意（なし）」。必須には数えない
select pg_temp.expect_t('C6 gw_procedures.stage (070) is optional and absent', pg_temp.v('gw_procedures.stage'), '任意（なし）');
select pg_temp.expect_t('C7 mynumber columns (070) are optional and absent', pg_temp.v('gw_procedures.mynumber_status'), '任意（なし）');
select pg_temp.expect_t('C8 gw_notifications (013) is optional and absent', pg_temp.v('gw_notifications（表）'), '任意（なし）');
select pg_temp.expect_t('C9 gw_sign_requests (046) is optional and absent', pg_temp.v('gw_sign_requests（表）'), '任意（なし）');
select pg_temp.expect_t('C10 gw_onboarding_guides (104) is optional and absent', pg_temp.v('gw_onboarding_guides'), '任意（なし）');
select pg_temp.expect_t('C11 the chain itself gave the consent/profile tables (037, 039)', pg_temp.v('gw_onboard_consents') || ',' || pg_temp.v('gw_consent_docs'), '任意（あり）,任意（あり）');
select pg_temp.expect_t('C12 gw_role_grants.role allows it/manager/finance (066)', pg_temp.v('gw_role_grants.role'), '任意（あり）');

-- 070 を足すと、stage・マイナンバーの行が「あり」になる。013 を足すと通知の行が「あり」になる（hr_flow は、どの SQL も許していないので、まだ「なし」）
\i :p070
\i :p013
select pg_temp.expect_t('C13 070 → stage and mynumber columns are there', pg_temp.v('gw_procedures.stage') || ',' || pg_temp.v('gw_procedures.mynumber_status'), '任意（あり）,任意（あり）');
select pg_temp.expect_t('C14 013 → gw_notifications and general are there', pg_temp.v('gw_notifications（表）') || ',' || pg_temp.v('gw_notifications.kind の check が general'), '任意（あり）,任意（あり）');
select pg_temp.expect_t('C15 013 → but hr_flow is still not allowed (existing gap: no migration allows it)', pg_temp.v('gw_notifications.kind の check が hr_flow'), '任意（なし）');
select pg_temp.expect('C16 optional gaps never count as 不足', pg_temp.short(), 0);
select pg_temp.expect_t('C17 the notice policy row is owner/hr only', pg_temp.v('gw_labor_notices の読み取りポリシー（'), '必須で存在');

-- ================= D. 抜くと不足が出る =================
-- 8つのファイルを1つずつ本当に抜いた DB での確認は、test/sql/run.sh の最後（onboarding の最小の流し方）でやる。
-- ここでは、そのファイルが作るものを1つ壊して、チェックが「不足」と言い、ほかを巻き込まないことを確かめる
begin;
  drop policy gw_employees_self_select on public.gw_employees;   -- 007 を抜いたのと同じ
  select pg_temp.expect_t('D1 without 007 (self-read policy) → that row is 不足', pg_temp.v('gw_employees を、本人が'), '不足');
  select pg_temp.expect('D1b ...and only that one', pg_temp.short(), 1);
rollback;
begin;
  alter table public.gw_procedures drop column drive_folders;      -- 039 を抜いたのと同じ（3列のうち1つ）
  select pg_temp.expect_t('D2 without 039 → drive_folders row is 不足', pg_temp.v('gw_procedures.drive_folders'), '不足');
  select pg_temp.expect_t('D2b ...and the missing column is named', pg_temp.m('gw_procedures.drive_folders'), 'drive_folders');
  select pg_temp.expect('D2c ...and only that one', pg_temp.short(), 1);
rollback;
begin;
  alter table public.gw_procedures drop column phase;               -- 066 を抜いたのと同じ
  select pg_temp.expect_t('D3 without 066 → phase row is 不足', pg_temp.v('gw_procedures.phase'), '不足');
  select pg_temp.expect('D3b ...and only that one', pg_temp.short(), 1);
rollback;
begin;
  alter table public.gw_procedure_items drop column item_key;       -- 037 を抜いたのと同じ
  select pg_temp.expect_t('D4 without 037 → item_key row is 不足', pg_temp.v('gw_procedure_items.item_key'), '不足');
  select pg_temp.expect('D4b ...and only that one', pg_temp.short(), 1);
rollback;
begin;
  alter table public.gw_procedure_items drop column assignee_id;    -- 066 を抜いたのと同じ（担当者）
  select pg_temp.expect_t('D5 without 066 → assignee_id row is 不足', pg_temp.v('gw_procedure_items.phase'), '不足');
rollback;
begin;
  delete from storage.buckets where id = 'hr';                      -- 012 を抜いたのと同じ
  select pg_temp.expect_t('D6 without 012 → bucket hr row is 不足', pg_temp.v('Storage バケット hr が、非公開で存在'), '不足');
  select pg_temp.expect_t('D6b ...and the bucket settings row is 不足 too', pg_temp.v('Storage バケット hr の設定'), '不足');
rollback;
begin;
  drop table public.gw_labor_notices;                               -- 110 を抜いたのと同じ
  select pg_temp.expect_t('D7 without 110 → the notice table row is 不足', pg_temp.v('gw_labor_notices（表）'), '不足');
  select pg_temp.expect_t('D7b ...and the policy row is 不足', pg_temp.v('gw_labor_notices の読み取りポリシー（'), '不足');
  select pg_temp.expect_t('D7c ...and the trigger row is 不足', pg_temp.v('gw_labor_notices の更新ガード'), '不足');
rollback;

-- ================= E. 1つずつ壊す =================
-- E1 check 制約（担当 6 種のうち 3 つしか通さない＝066 の前の 008 のまま）
begin;
  alter table public.gw_procedure_items drop constraint gw_procedure_items_owner_check;
  alter table public.gw_procedure_items add constraint gw_procedure_items_owner_check check (owner in ('employee', 'hr', 'labor_advisor'));
  select pg_temp.expect_t('E1 owner check with only 3 values → 不足', pg_temp.v('gw_procedure_items.owner'), '不足');
  select pg_temp.expect_t('E1b ...and it names the missing values', pg_temp.m('gw_procedure_items.owner'), 'it・manager・finance');
  select pg_temp.expect('E1c ...and only that one', pg_temp.short(), 1);
rollback;
-- E2 check 制約を外す（制約が無ければ、どんな値も通る → 不足にしない）
begin;
  alter table public.gw_procedure_items drop constraint gw_procedure_items_owner_check;
  select pg_temp.expect_t('E2 no owner check at all → nothing to refuse, stays OK', pg_temp.v('gw_procedure_items.owner'), '必須で存在');
rollback;
-- E3 状態の check（done を通さない）
begin;
  alter table public.gw_procedures drop constraint gw_procedures_status_check;
  alter table public.gw_procedures add constraint gw_procedures_status_check check (status in ('not_started', 'in_progress'));
  select pg_temp.expect_t('E3 procedures.status check without done/cancelled → 不足', pg_temp.v('gw_procedures・gw_procedure_items の check'), '不足');
  select pg_temp.expect_t('E3b ...and it names the values', pg_temp.m('gw_procedures・gw_procedure_items の check'), 'gw_procedures.status：done・cancelled');
rollback;
-- E4 一意（同じ人・同じ種別）。無ければ不足。重複があれば、重複の行も不足
begin;
  alter table public.gw_procedures drop constraint gw_procedures_employee_id_kind_key;
  select pg_temp.expect_t('E4 no unique (employee_id, kind) → 不足', pg_temp.v('gw_procedures の (employee_id, kind) が一意'), '不足');
  select pg_temp.expect_t('E4b ...no duplicates yet, so the duplicate row is fine', pg_temp.v('同じ人・同じ種別の入社手続き'), '必須で存在');
  insert into public.gw_procedures(id, tenant_id, employee_id, kind, status) values
    ('c8000000-0000-0000-0000-000000000001', '88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'onboarding', 'in_progress'),
    ('c8000000-0000-0000-0000-000000000002', '88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'onboarding', 'in_progress');
  select pg_temp.expect_t('E4c two onboarding procedures for one person → the duplicate row is 不足', pg_temp.v('同じ人・同じ種別の入社手続き'), '不足');
rollback;
-- E5 通知書の読み取りポリシーが古い（gw_is_hr＝管理者も読める）
begin;
  drop policy gw_labor_notices_read on public.gw_labor_notices;
  create policy gw_labor_notices_read on public.gw_labor_notices for select to authenticated using (public.gw_is_hr(tenant_id));
  select pg_temp.expect_t('E5 old policy: the owner/hr-only row is 不足', pg_temp.v('gw_labor_notices の読み取りポリシー（'), '不足');
  select pg_temp.expect_t('E5b ...and the not-the-old-definition row is 不足', pg_temp.v('gw_labor_notices の読み取りポリシーが、管理者'), '不足');
rollback;
-- E6 RLS が無効
begin;
  alter table public.gw_labor_notices disable row level security;
  select pg_temp.expect_t('E6 RLS off → 不足', pg_temp.v('gw_labor_notices の RLS が有効'), '不足');
rollback;
-- E7 更新ガード（トリガ）が無い
begin;
  drop trigger gw_labor_notices_guard_trg on public.gw_labor_notices;
  select pg_temp.expect_t('E7 trigger missing → 不足', pg_temp.v('gw_labor_notices の更新ガード'), '不足');
rollback;
-- E8 バケットが公開
begin;
  update storage.buckets set public = true where id = 'hr';
  select pg_temp.expect_t('E8 public bucket → 不足', pg_temp.v('Storage バケット hr が、非公開で存在'), '不足');
  select pg_temp.expect_t('E8b ...and it says to make it private', pg_temp.m('Storage バケット hr が、非公開で存在'), '公開になっています。非公開に直してください');
rollback;
-- E9 バケットの制限（10MB・画像だけ）→ PDF 15MB を妨げる。PDF を許せば OK
begin;
  update storage.buckets set file_size_limit = 10 * 1024 * 1024 where id = 'hr';
  select pg_temp.expect_t('E9 10MB limit → 不足', pg_temp.v('Storage バケット hr の設定'), '不足');
  update storage.buckets set file_size_limit = 15 * 1024 * 1024, allowed_mime_types = array['image/png', 'image/jpeg'] where id = 'hr';
  select pg_temp.expect_t('E9b images only → 不足', pg_temp.v('Storage バケット hr の設定'), '不足');
  update storage.buckets set allowed_mime_types = array['image/png', 'application/pdf'] where id = 'hr';
  select pg_temp.expect_t('E9c 15MB + pdf allowed → OK', pg_temp.v('Storage バケット hr の設定'), '必須で存在');
  update storage.buckets set allowed_mime_types = array['image/*', 'application/*'] where id = 'hr';
  select pg_temp.expect_t('E9d application/* allowed → OK', pg_temp.v('Storage バケット hr の設定'), '必須で存在');
  update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'hr';
  select pg_temp.expect_t('E9e no limits → OK', pg_temp.v('Storage バケット hr の設定'), '必須で存在');
rollback;
-- E10 owner・hr がいない
begin;
  -- 最後の owner は外せない（db/099 の安全装置）。ここでは、その装置をこのトランザクションの中だけ止めて、「owner・hr がいない」状態を作る
  set local session_replication_role = replica;
  delete from public.gw_role_grants;
  select pg_temp.expect_t('E10 no owner/hr → 不足', pg_temp.v('owner または hr ロールの人が'), '不足');
  insert into public.gw_role_grants(tenant_id, employee_id, role) values ('88888888-8888-8888-8888-888888888888', 'a8a00002-0000-0000-0000-000000000000', 'hr');
  select pg_temp.expect_t('E10b an hr alone is enough', pg_temp.v('owner または hr ロールの人が'), '必須で存在');
rollback;
-- E11 本人の読み取りポリシー（手続き）
begin;
  drop policy gw_procedures_select on public.gw_procedures;
  select pg_temp.expect_t('E11 procedures self-read policy missing → 不足', pg_temp.v('gw_procedures・gw_procedure_items を、本人が'), '不足');
  select pg_temp.expect_t('E11b ...and it names which', pg_temp.m('gw_procedures・gw_procedure_items を、本人が'), 'gw_procedures の本人の読み取り');
rollback;
-- E12 関数
begin;
  drop function public.gw_procedure_is_mine(uuid) cascade;
  select pg_temp.expect_t('E12 RLS function missing → 不足', pg_temp.v('RLS の関数'), '不足');
  select pg_temp.expect_t('E12b ...and it names the function', pg_temp.m('RLS の関数'), 'gw_procedure_is_mine');
rollback;
-- E13 一意（通知書の版）
begin;
  alter table public.gw_labor_notices drop constraint gw_labor_notices_employee_id_version_key;
  select pg_temp.expect_t('E13 no unique (employee_id, version) → 不足', pg_temp.v('gw_labor_notices の (employee_id, version) が一意'), '不足');
rollback;
-- E14 列の不足は、列名で出る
begin;
  alter table public.gw_labor_notices drop column confirmed_by;
  select pg_temp.expect_t('E14 notice column missing → names the column', pg_temp.m('gw_labor_notices（表）'), 'confirmed_by');
rollback;

-- ================= F. もう一度流しても同じ（べき等）／ 065 を足しても同じ =================
\i :p006
\i :p008
\i :p009
\i :p012
\i :p037
\i :p039
\i :p066
\i :p110
\i :p065
select pg_temp.expect('F1 re-running the 8 files (+ 065) changes nothing: still no 必須 missing', pg_temp.short(), 0);

-- ================= G. 読み取り専用 =================
-- チェックを流す前後で、表の行数も、定義（表・関数・ポリシー・制約）の数も変わらない
create temp table snap1 as
  select (select count(*) from pg_class where relnamespace = 'public'::regnamespace) as rels,
         (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) as procs,
         (select count(*) from pg_policies where schemaname = 'public') as pols,
         (select count(*) from pg_constraint where connamespace = 'public'::regnamespace) as cons,
         (select count(*) from public.gw_procedures) as procedures_rows,
         (select count(*) from public.gw_role_grants) as grants_rows,
         (select count(*) from public.gw_activity_log) as log_rows;
select count(*) from pg_temp.chk;
create temp table snap2 as
  select (select count(*) from pg_class where relnamespace = 'public'::regnamespace) as rels,
         (select count(*) from pg_proc where pronamespace = 'public'::regnamespace) as procs,
         (select count(*) from pg_policies where schemaname = 'public') as pols,
         (select count(*) from pg_constraint where connamespace = 'public'::regnamespace) as cons,
         (select count(*) from public.gw_procedures) as procedures_rows,
         (select count(*) from public.gw_role_grants) as grants_rows,
         (select count(*) from public.gw_activity_log) as log_rows;
select pg_temp.expect('G1 running the check changes no definitions and no rows', (select (s1 = s2)::int from (select row(snap1.*) as s1 from snap1) a, (select row(snap2.*) as s2 from snap2) b), 1);
