-- =============================================================================
-- 【Office Phase3 TEST】 Office の操作確認用テストデータ（1件）を作る
--
--   /office → 勤務表追加 → 実 AI 読取 → 修正 → 確定 → 請求作成待ち、を実操作するための
--   「テスト専用の1人・1契約」です。マイグレーションではありません（db/105〜107 の番号は使いません）。
--
-- Supabase の SQL Editor に貼って Run。**追加だけ**です（既存の行は、更新も削除もしません）。
-- 前提：db/105・106・107 が適用済み（db/check_office_phase3.sql が ✅）
--
-- ■ 作るもの（すべて名前が【Office Phase3 TEST】で始まる。id は固定なので、後から正確に消せる）
--     社員名簿   gw_employees            1行  【Office Phase3 TEST】テスト 太郎（プロパー・在籍・メール／ログイン無し・入社日 無し）
--     現場契約   gw_site_contracts       1行  客先【Office Phase3 TEST】テスト客先（2026-04-01〜 期限なし・単価 無し）
--     契約条件   gw_site_contract_terms  1行  月額 700,000円・精算幅 140〜180時間・超過 4,000円／控除 3,500円・円未満切捨て
--                                          （この画面で試すための、架空の数字。請求書・支払には、どこにもつながりません）
--
-- ■ 既存データ・外部への影響（コードとマイグレーションを確認したうえで、これを守るように作ってあります）
--   ・既存の行は変更しません（INSERT だけ）。既存の月初4テーブルの RLS も変えません
--   ・メール・Slack・プッシュは送りません（この SQL は送信しません。アプリにも、勤務表の操作でメール・通知を送る処理はありません）
--   ・社員行は「入社日なし・メールなし・ログインなし」にしてあるので、定期処理（端末未登録の催促・入社日の切替・
--     リマインド・キャリア・BP勤務表の回収）の対象にはなりません
--   ・現場契約は「終了日なし」なので、契約更新（45日前）のタスクも作りません
--   ・単価（gw_site_contracts.unit_price）は入れません（意味が未確定のため。契約条件の表に別の列で入れます）
--   ・請求書・発注・振込・MF への送信は、Phase 3 にはありません。金額は画面の精算の表示だけです
--   ※ Supabase の管理画面で、社員名簿などに「Database Webhook」を別途設定している場合だけ、社員行の追加が外へ飛びます
--     （リポジトリには、そのような設定はありません）
--
-- ■ 使い方
--   1. この SQL を Run（すぐ下の「確認」の結果が、最後に表で出ます）
--   2. /office を開き、対象月を **2026年10月** にして（サンプルの勤務表が10月分のため）、行を探す
--   3. テストが終わったら db/office_phase3_test_cleanup.sql で、完全に消す
--
-- 二重に作りません（すでにあれば、何も作らずに止まります）。途中で失敗したら、何も残りません（1つの DO ブロック）
-- =============================================================================

do $$
declare
  v_tenant uuid := null;   -- 通常は触りません。社員名簿に会社（tenant）が2つ以上あるときだけ、ここに入れます
  v_emp    constant uuid := 'e13db73f-3d85-45ca-ac0a-7f26a5d53610';
  v_con    constant uuid := '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b';
  v_terms  constant uuid := '73c4e190-160b-4ea9-b697-f7afe7a26b45';
  v_tag    constant text := '【Office Phase3 TEST】';
  v_n      int;
begin
  -- ① 前提：105〜107 が入っているか（入っていなければ、契約条件・勤務表の表が無い）
  if to_regclass('public.gw_site_contract_terms') is null or to_regclass('public.gw_timesheets') is null
     or to_regclass('public.gw_office_events') is null then
    raise exception '先に db/105・106・107 を適用してください（db/check_office_phase3.sql が ✅ になってから）';
  end if;

  -- ② どの会社（tenant）に作るか：社員名簿の tenant がちょうど1つのときだけ、自動で決める
  if v_tenant is null then
    select count(distinct tenant_id) into v_n from public.gw_employees;
    if v_n <> 1 then
      raise exception '社員名簿に会社（tenant）が % 個あります。1つだけのときしか自動では決めません。上の v_tenant に、作りたい tenant の id を入れてください', v_n;
    end if;
    select distinct tenant_id into v_tenant from public.gw_employees;
  elsif not exists (select 1 from public.gw_employees where tenant_id = v_tenant) then
    raise exception 'v_tenant（%）の社員が名簿にありません。tenant の id を確認してください', v_tenant;
  end if;

  -- ③ 二重に作らない
  if exists (select 1 from public.gw_employees where id = v_emp or starts_with(display_name, v_tag))
     or exists (select 1 from public.gw_site_contracts where id = v_con or starts_with(site_company, v_tag))
     or exists (select 1 from public.gw_site_contract_terms where id = v_terms) then
    raise exception 'テストデータは、すでに入っています。作り直すなら、先に db/office_phase3_test_cleanup.sql で消してください';
  end if;

  -- ④ 作る（追加だけ）
  insert into public.gw_employees (id, tenant_id, display_name, department, status, employee_kind)
  values (v_emp, v_tenant, v_tag || 'テスト 太郎', 'Office Phase3 TEST', 'active', 'proper');

  insert into public.gw_site_contracts
    (id, tenant_id, employee_id, engagement_kind, site_company, prime_company, period_from, period_to,
     unit_price, renewal_status, note)
  values
    (v_con, v_tenant, v_emp, 'pp', v_tag || 'テスト客先', null, date '2026-04-01', null,
     null, 'confirmed',
     v_tag || 'Office の操作確認用。実請求・実支払には使わない。テスト後に db/office_phase3_test_cleanup.sql で削除する');

  insert into public.gw_site_contract_terms
    (id, tenant_id, site_contract_id, valid_from, valid_to, pricing_type, sales_unit_price, purchase_unit_price,
     settlement_mode, settle_min_minutes, settle_max_minutes, settle_unit_minutes, rounding_mode, rounding_scope,
     over_rate_per_hour, under_rate_per_hour, prorate, amount_rounding)
  values
    (v_terms, v_tenant, v_con, date '2026-04-01', null, 'monthly', 700000, null,
     'range', 8400, 10800, null, null, null,
     4000, 3500, false, 'floor');
end $$;

-- ⑤ 確認：作ったもの（3行）と、既存データの件数（テスト以外。db/check_office_phase3.sql の D と見比べる）
select '作ったもの' as 区分, 'gw_employees' as 表, id::text as id, display_name as 内容, created_at
  from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'
union all
select '作ったもの', 'gw_site_contracts', id::text, site_company || '（' || period_from || '〜 期限なし）', created_at
  from public.gw_site_contracts where id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'
union all
select '作ったもの', 'gw_site_contract_terms', id::text,
       '月額 ' || sales_unit_price::bigint || '円／精算幅 ' || (settle_min_minutes / 60) || '〜' || (settle_max_minutes / 60) || '時間', created_at
  from public.gw_site_contract_terms where id = '73c4e190-160b-4ea9-b697-f7afe7a26b45'
union all
select '後片付けの目印', 'Storage', null,
       'billing-submissions / ' || tenant_id::text || '/' || id::text || '/  （テストで勤務表を追加すると、実ファイルがここに入る。消すときは、先にここを空にする）', null
  from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'
union all
select '既存（テスト以外）', 'gw_employees', null, count(*)::text || ' 件', null
  from public.gw_employees where id <> 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'
union all
select '既存（テスト以外）', 'gw_site_contracts', null, count(*)::text || ' 件', null
  from public.gw_site_contracts where id <> '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'
union all
select '既存（テスト以外）', 'gw_billing_progress', null, count(*)::text || ' 件', null
  from public.gw_billing_progress where site_contract_id <> '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'
union all
select '既存（テスト以外）', 'gw_submissions', null, count(*)::text || ' 件', null
  from public.gw_submissions where employee_id <> 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'
order by 1, 2;
