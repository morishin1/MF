-- =============================================================================
-- 【Office Phase3 TEST】 のテストデータを、完全に消す（db/office_phase3_test_seed.sql で作ったもの）
--
-- Supabase の SQL Editor に貼って Run。消すのは、**固定の id で指定した、テスト用の行だけ**です。
-- 既存のデータ（本物の社員・契約・勤務表・月次進捗）には、触りません。
--
-- ■ 先に、Storage のファイルを消してください（SQL からは消せません）
--   テストで勤務表を追加すると、Storage の billing-submissions に、実ファイルが入ります。
--   Supabase の Storage → billing-submissions → 「<tenant の id>/e13db73f-3d85-45ca-ac0a-7f26a5d53610」のフォルダ
--   （seed の確認表の「後片付けの目印」に、そのままの場所が出ています）を開き、中のファイルを削除してください。
--   ファイルが残っていると、この SQL は何も消さずに止まります（残骸を作らないため）。
--
-- ■ 消すもの（この順）
--   1. 操作ログ（gw_activity_log）のうち、テストの契約・提出ファイル・社員を指すもの
--   2. Office の操作履歴（gw_office_events）のうち、テストの社員・契約のもの
--   3. 社員名簿の1行（gw_employees）… これで、次が連鎖して消えます（外部キーの on delete cascade）
--        現場契約 → 契約条件・月次進捗（5つの印）・提出ファイルの記録・勤務表 → 日別データ
--
-- ■ 止まる条件（何も消さずに、理由を出して止まります）
--   ・名前が【Office Phase3 TEST】で始まらない（別の行を指している）
--   ・社員行にログイン（user_id）が紐づいている（テスト用ではなくなっている）
--   ・Storage にテストのファイルが残っている
--
-- 何度 Run しても安全です（すでに無ければ、何もせず、最後の確認表が 0 で出ます）。途中で失敗したら、何も消えません
-- =============================================================================

do $$
declare
  v_emp   constant uuid := 'e13db73f-3d85-45ca-ac0a-7f26a5d53610';
  v_con   constant uuid := '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b';
  v_tag   constant text := '【Office Phase3 TEST】';
  v_tenant uuid;
  v_name   text;
  v_user   uuid;
  v_n      int;
begin
  select tenant_id, display_name, user_id into v_tenant, v_name, v_user from public.gw_employees where id = v_emp;

  if v_tenant is not null then
    -- ① 想定どおりのテスト行か
    if not starts_with(v_name, v_tag) then
      raise exception '社員行の名前が「%」で始まっていません（%）。別の行を指している可能性があるので、何も消しません', v_tag, v_name;
    end if;
    if v_user is not null then
      raise exception 'この社員行にログイン（user_id）が紐づいています。テスト用ではなくなっているので、何も消しません';
    end if;
    if exists (select 1 from public.gw_site_contracts where id = v_con and not starts_with(site_company, v_tag)) then
      raise exception '現場契約の客先名が「%」で始まっていません。何も消しません', v_tag;
    end if;
    if exists (select 1 from public.gw_site_contracts where employee_id = v_emp and id <> v_con) then
      raise exception 'このテスト社員に、テスト用以外の現場契約が紐づいています。何も消しません（確認してください）';
    end if;

    -- ② Storage にファイルが残っていないか
    if to_regclass('storage.objects') is not null then
      execute 'select count(*) from storage.objects where bucket_id = $1 and starts_with(name, $2)'
        into v_n using 'billing-submissions', v_tenant::text || '/' || v_emp::text || '/';
      if v_n > 0 then
        raise exception 'Storage（billing-submissions）に、テストのファイルが % 件残っています。Storage → billing-submissions → %/% を開いて削除してから、もう一度 Run してください',
          v_n, v_tenant, v_emp;
      end if;
    end if;
  end if;

  -- ③ 消す（社員行が無くても、履歴・ログの取りこぼしは消す）
  delete from public.gw_activity_log
   where target = 'site_contract:' || v_con::text
      or target = 'employee:' || v_emp::text
      or target in (select 'submission:' || s.id::text from public.gw_submissions s where s.employee_id = v_emp)
      or detail ->> 'employeeId' = v_emp::text;

  delete from public.gw_office_events where employee_id = v_emp or site_contract_id = v_con;

  delete from public.gw_employees where id = v_emp and starts_with(display_name, v_tag);
end $$;

-- ④ 確認：すべて 0 であること（残っていれば、その行が残骸です）
select 表, 残り
  from (
    values
      (1, 'gw_employees（テスト社員）',        (select count(*) from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or starts_with(display_name, '【Office Phase3 TEST】'))),
      (2, 'gw_site_contracts（テスト契約）',    (select count(*) from public.gw_site_contracts where id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b' or starts_with(site_company, '【Office Phase3 TEST】'))),
      (3, 'gw_site_contract_terms（契約条件）', (select count(*) from public.gw_site_contract_terms where site_contract_id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b' or id = '73c4e190-160b-4ea9-b697-f7afe7a26b45')),
      (4, 'gw_billing_progress（月次進捗）',    (select count(*) from public.gw_billing_progress where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or site_contract_id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b')),
      (5, 'gw_submissions（提出ファイルの記録）', (select count(*) from public.gw_submissions where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or site_contract_id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b')),
      (6, 'gw_timesheets（勤務表）',            (select count(*) from public.gw_timesheets where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or site_contract_id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b')),
      (7, 'gw_timesheet_days（日別）',          (select count(*) from public.gw_timesheet_days d where d.timesheet_id in (select id from public.gw_timesheets where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'))),
      (8, 'gw_office_events（操作履歴）',       (select count(*) from public.gw_office_events where employee_id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or site_contract_id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b')),
      (9, 'gw_activity_log（操作ログ）',        (select count(*) from public.gw_activity_log where target = 'site_contract:3688ccc1-bf24-4fcd-81fa-50e4a2086c7b' or target = 'employee:e13db73f-3d85-45ca-ac0a-7f26a5d53610' or detail ->> 'employeeId' = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'))
  ) as t(n, 表, 残り)
 order by n;
