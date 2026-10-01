-- =============================================================================
-- 【Office Phase3 TEST】 Office 操作確認用のテストデータを作る（1人・1契約・1か月ぶん）
--
--   /office → 勤務表追加 → AI読取 → 修正 → confirmed → 請求作成待ち、を実操作するための、テスト専用データです。
--   マイグレーションではありません（db/105〜107 の番号は使いません）。削除は db/office_phase3_test_cleanup.sql。
--
-- この SQL は 3 つの部分に分かれています。上から順に Run（全部まとめて Run してもかまいません）
--   ① 作成前確認   … 読むだけ。前提・tenant・すでにテスト行が無いか・既存データの件数とハッシュ
--   ② INSERT       … 追加だけ（4 行）。1つの DO ブロックなので、途中で失敗したら何も残りません
--   ③ 作成後確認   … 読むだけ。作った 4 行・既存データが変わっていないこと（① とハッシュが同じ）
--
-- ■ 作るもの（4 行。名前は必ず【Office Phase3 TEST】を含み、id は固定＝後から正確に消せる）
--     gw_employees            要員   【Office Phase3 TEST】テスト 太郎（プロパー・在籍。メール・ログイン・入社日は無し）
--     gw_site_contracts       現場契約 客先 株式会社テスト【Office Phase3 TEST】／2026-10-01〜（終了日なし・単価なし）
--     gw_site_contract_terms  契約条件 月額・売上単価 700,000円・精算幅 140〜180時間・超過 4,000円／控除 3,500円・円未満切捨て
--     gw_billing_progress     月次進捗 2026-10（5つの印は、すべて「未」）
--   ・要員名に「テスト 太郎」を入れているのは、サンプル勤務表の氏名と照合が合うようにするためです（合わないと、氏名不一致の警告が出ます）
--   ・仕入単価（purchase_unit_price）は入れません（自社プロパーには仕入がなく、Phase 3 のどこも使いません）。必要なら契約条件の画面で入れられます
--
-- ■ 守っていること
--   ・既存の行は、変更も削除もしません（INSERT だけ）。既存の社員・企業・案件・owner のアカウント（gw_role_grants・memberships・auth.users）にも触れません
--   ・tenant は、社員名簿にちょうど1つだけあるときに、それを使います（複数あれば止まります）
--   ・メール・Slack・プッシュは送りません。請求書の送付も、支払・振込・MF への送信もありません（Phase 3 にその機能はありません）
--   ・社員行は「入社日なし・メールなし・ログインなし」、契約は「終了日なし」なので、定期処理（端末未登録の催促・入社日の切替・
--     リマインド・契約更新の45日前タスク・BP勤務表の回収）の対象になりません
--   ・gw_site_contracts.unit_price は使いません（意味が未確定のため）。金額は、契約条件（別の表）に、画面の精算表示用としてだけ入れます
--   ※ Supabase の管理画面で「Database Webhook」を別途設定している場合だけ、行の追加が外へ飛びます（リポジトリには、その設定はありません）
--
-- ■ 使い方：/office を開き、対象月を「2026年10月」に切り替える（サンプルの勤務表が10月分。契約は10/1から）。1行、出ます
-- =============================================================================


-- =============================================================================
-- ① 作成前確認（読むだけ）
--    判定が ❌ の行があれば、②に進まないでください（②も、同じ条件で止まります）
-- =============================================================================
select 順, 項目, 値, 判定
  from (values
    (1,  'Phase 3 の表（105〜107）がある',
         'gw_site_contract_terms / gw_timesheets / gw_office_events',
         case when to_regclass('public.gw_site_contract_terms') is not null and to_regclass('public.gw_timesheets') is not null
                   and to_regclass('public.gw_office_events') is not null then '✅' else '❌ 先に 105〜107 を適用' end),
    (2,  '本番の会社（tenant）の数（社員名簿）',
         (select count(distinct tenant_id)::text from public.gw_employees),
         case when (select count(distinct tenant_id) from public.gw_employees) = 1 then '✅ 1つだけ' else '❌ 1つでないと自動では決めません' end),
    (3,  'このSQLが使う tenant',
         coalesce((select tenant_id::text from public.gw_employees group by tenant_id limit 1), '（無し）'), 'ℹ'),
    (4,  'すでにあるテスト行（社員・契約・条件・進捗）',
         ((select count(*) from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or strpos(display_name, '【Office Phase3 TEST】') > 0)
        + (select count(*) from public.gw_site_contracts where id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b' or strpos(site_company, '【Office Phase3 TEST】') > 0)
        + (select count(*) from public.gw_site_contract_terms where id = '73c4e190-160b-4ea9-b697-f7afe7a26b45')
        + (select count(*) from public.gw_billing_progress where id = 'd309c095-8c2a-4a21-b713-ba43acd61698'))::text || ' 件',
         case when ((select count(*) from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610' or strpos(display_name, '【Office Phase3 TEST】') > 0)
                  + (select count(*) from public.gw_site_contracts where id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b' or strpos(site_company, '【Office Phase3 TEST】') > 0)
                  + (select count(*) from public.gw_site_contract_terms where id = '73c4e190-160b-4ea9-b697-f7afe7a26b45')
                  + (select count(*) from public.gw_billing_progress where id = 'd309c095-8c2a-4a21-b713-ba43acd61698')) = 0
              then '✅ 0件（まだ作っていない）' else '❌ すでにあります。作り直すなら、先に cleanup で消す' end),
    (5,  '既存 gw_employees（社員）の件数',        (select count(*)::text from public.gw_employees), 'ℹ'),
    (6,  '既存 gw_site_contracts（現場契約）の件数', (select count(*)::text from public.gw_site_contracts),
         case when (select count(*) from public.gw_site_contracts) = 0 then '✅ 0件（想定どおり）' else 'ℹ 0件のはずでした。確認してください' end),
    (7,  '既存 gw_billing_progress（月次進捗）の件数', (select count(*)::text from public.gw_billing_progress),
         case when (select count(*) from public.gw_billing_progress) = 0 then '✅ 0件（想定どおり）' else 'ℹ 0件のはずでした。確認してください' end),
    (8,  '既存 owner の権限（gw_role_grants, role=owner）の件数', (select count(*)::text from public.gw_role_grants where role = 'owner'), 'ℹ'),
    (9,  'ハッシュ gw_employees（既存）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_employees t where t.id <> 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'), 'ℹ ③と同じであること'),
    (10, 'ハッシュ gw_site_contracts（既存）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_site_contracts t where t.id <> '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'), 'ℹ ③と同じであること'),
    (11, 'ハッシュ gw_billing_progress（既存）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_billing_progress t where t.id <> 'd309c095-8c2a-4a21-b713-ba43acd61698'), 'ℹ ③と同じであること'),
    (12, 'ハッシュ gw_role_grants（owner などの権限）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_role_grants t), 'ℹ ③と同じであること'),
    (13, 'ハッシュ memberships（ログインの所属）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.memberships t), 'ℹ ③と同じであること')
  ) as v(順, 項目, 値, 判定)
 order by 順;


-- =============================================================================
-- ② INSERT（追加だけ。4 行。1つの DO ブロック＝途中で失敗したら、何も残りません）
-- =============================================================================
do $$
declare
  v_tenant uuid;
  v_n      int;
  v_tag    constant text := '【Office Phase3 TEST】';
  v_emp    constant uuid := 'e13db73f-3d85-45ca-ac0a-7f26a5d53610';
  v_con    constant uuid := '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b';
  v_terms  constant uuid := '73c4e190-160b-4ea9-b697-f7afe7a26b45';
  v_prog   constant uuid := 'd309c095-8c2a-4a21-b713-ba43acd61698';
begin
  -- 止まる条件（①の判定が ❌ のとき）
  if to_regclass('public.gw_site_contract_terms') is null or to_regclass('public.gw_timesheets') is null
     or to_regclass('public.gw_office_events') is null then
    raise exception '先に db/105・106・107 を適用してください（db/check_office_phase3.sql が ✅ になってから）';
  end if;
  select count(distinct tenant_id) into v_n from public.gw_employees;
  if v_n <> 1 then
    raise exception '社員名簿に会社（tenant）が % 個あります。ちょうど1つのときしか、自動では決めません', v_n;
  end if;
  select tenant_id into v_tenant from public.gw_employees group by tenant_id limit 1;
  if exists (select 1 from public.gw_employees where id = v_emp or strpos(display_name, v_tag) > 0)
     or exists (select 1 from public.gw_site_contracts where id = v_con or strpos(site_company, v_tag) > 0)
     or exists (select 1 from public.gw_site_contract_terms where id = v_terms)
     or exists (select 1 from public.gw_billing_progress where id = v_prog) then
    raise exception 'テストデータは、すでに入っています。作り直すなら、先に db/office_phase3_test_cleanup.sql で消してください';
  end if;

  -- 1) 要員（社員名簿）：メール・ログイン・入社日は入れない
  insert into public.gw_employees (id, tenant_id, display_name, department, status, employee_kind)
  values (v_emp, v_tenant, v_tag || 'テスト 太郎', 'Office Phase3 TEST', 'active', 'proper');

  -- 2) 現場契約：終了日なし・単価（unit_price）なし
  insert into public.gw_site_contracts
    (id, tenant_id, employee_id, engagement_kind, site_company, prime_company, period_from, period_to,
     unit_price, renewal_status, note)
  values
    (v_con, v_tenant, v_emp, 'pp', '株式会社テスト' || v_tag, null, date '2026-10-01', null,
     null, 'confirmed',
     v_tag || 'Office の操作確認用。実請求・実支払には使わない。テスト後に db/office_phase3_test_cleanup.sql で削除する');

  -- 3) 契約条件：月額 700,000円・精算幅 140〜180時間（8400〜10800分）・超過 4,000円/h・控除 3,500円/h・円未満切捨て
  --    purchase_unit_price（仕入単価）は入れない
  insert into public.gw_site_contract_terms
    (id, tenant_id, site_contract_id, valid_from, valid_to, pricing_type, sales_unit_price, purchase_unit_price,
     settlement_mode, settle_min_minutes, settle_max_minutes, settle_unit_minutes, rounding_mode, rounding_scope,
     over_rate_per_hour, under_rate_per_hour, prorate, amount_rounding)
  values
    (v_terms, v_tenant, v_con, date '2026-10-01', null, 'monthly', 700000, null,
     'range', 8400, 10800, null, null, null,
     4000, 3500, false, 'floor');

  -- 4) 月次進捗（2026-10）：5つの印（勤務表受領・稼働確認・Board作成・送付・BP請求書受領）は、すべて既定の「未」
  insert into public.gw_billing_progress (id, tenant_id, employee_id, site_contract_id, billing_month, note)
  values (v_prog, v_tenant, v_emp, v_con, '2026-10', v_tag || 'Office の操作確認用');
end $$;


-- =============================================================================
-- ③ 作成後確認（読むだけ）
--    ・作った 4 行が、想定どおりであること
--    ・ハッシュが ① と同じであること（＝既存の社員・契約・進捗・owner の権限・ログインの所属が、1文字も変わっていない）
-- =============================================================================
select 順, 項目, 値, 判定
  from (values
    (1,  '作成 社員 gw_employees',
         coalesce((select display_name || ' ／ ' || status || ' ／ ' || employee_kind || ' ／ email=' || coalesce(email, 'なし') || ' ／ user_id=' || coalesce(user_id::text, 'なし') || ' ／ 入社日=' || coalesce(joined_on::text, 'なし')
                     from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'), '（無い）'),
         case when exists (select 1 from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610') then '✅' else '❌' end),
    (2,  '作成 現場契約 gw_site_contracts',
         coalesce((select site_company || ' ／ ' || period_from || '〜' || coalesce(period_to::text, '期限なし') || ' ／ unit_price=' || coalesce(unit_price::text, 'なし') || ' ／ ' || engagement_kind
                     from public.gw_site_contracts where id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'), '（無い）'),
         case when exists (select 1 from public.gw_site_contracts where id = '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b') then '✅' else '❌' end),
    (3,  '作成 契約条件 gw_site_contract_terms',
         coalesce((select pricing_type || ' ／ 売上単価 ' || sales_unit_price::bigint || '円 ／ 仕入単価 ' || coalesce(purchase_unit_price::text, 'なし') || ' ／ 精算幅 ' || (settle_min_minutes / 60) || '〜' || (settle_max_minutes / 60) || 'h ／ 超過 ' || over_rate_per_hour::bigint || '円 ／ 控除 ' || under_rate_per_hour::bigint || '円'
                     from public.gw_site_contract_terms where id = '73c4e190-160b-4ea9-b697-f7afe7a26b45'), '（無い）'),
         case when exists (select 1 from public.gw_site_contract_terms where id = '73c4e190-160b-4ea9-b697-f7afe7a26b45') then '✅' else '❌' end),
    (4,  '作成 月次進捗 gw_billing_progress',
         coalesce((select billing_month || ' ／ 受領=' || timesheet_received || ' 稼働確認=' || work_confirmed || ' Board作成=' || board_created || ' 送付=' || sent || ' BP請求書=' || bp_invoice_received
                     from public.gw_billing_progress where id = 'd309c095-8c2a-4a21-b713-ba43acd61698'), '（無い）'),
         case when exists (select 1 from public.gw_billing_progress where id = 'd309c095-8c2a-4a21-b713-ba43acd61698'
                              and not (timesheet_received or work_confirmed or board_created or sent or bp_invoice_received)) then '✅ 5つとも「未」' else '❌' end),
    (5,  '名前に【Office Phase3 TEST】を含む行（社員・契約）',
         (select count(*) from public.gw_employees where strpos(display_name, '【Office Phase3 TEST】') > 0)::text || ' ／ '
           || (select count(*) from public.gw_site_contracts where strpos(site_company, '【Office Phase3 TEST】') > 0)::text,
         case when (select count(*) from public.gw_employees where strpos(display_name, '【Office Phase3 TEST】') > 0) = 1
               and (select count(*) from public.gw_site_contracts where strpos(site_company, '【Office Phase3 TEST】') > 0) = 1
              then '✅ 各1件だけ' else '❌' end),
    (6,  '既存 gw_employees（テスト以外）の件数',        (select count(*)::text from public.gw_employees where id <> 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'), 'ℹ ① の(5)と同じ'),
    (7,  '既存 gw_site_contracts（テスト以外）の件数',   (select count(*)::text from public.gw_site_contracts where id <> '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'), 'ℹ ① の(6)と同じ'),
    (8,  '既存 gw_billing_progress（テスト以外）の件数', (select count(*)::text from public.gw_billing_progress where id <> 'd309c095-8c2a-4a21-b713-ba43acd61698'), 'ℹ ① の(7)と同じ'),
    (9,  'ハッシュ gw_employees（既存）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_employees t where t.id <> 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'), 'ℹ ① の(9)と同じであること'),
    (10, 'ハッシュ gw_site_contracts（既存）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_site_contracts t where t.id <> '3688ccc1-bf24-4fcd-81fa-50e4a2086c7b'), 'ℹ ① の(10)と同じであること'),
    (11, 'ハッシュ gw_billing_progress（既存）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_billing_progress t where t.id <> 'd309c095-8c2a-4a21-b713-ba43acd61698'), 'ℹ ① の(11)と同じであること'),
    (12, 'ハッシュ gw_role_grants（owner などの権限）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.gw_role_grants t), 'ℹ ① の(12)と同じであること'),
    (13, 'ハッシュ memberships（ログインの所属）',
         (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.memberships t), 'ℹ ① の(13)と同じであること'),
    (14, '後片付けの目印（Storage）',
         coalesce((select 'billing-submissions / ' || tenant_id::text || '/' || id::text || '/  （勤務表を追加すると、実ファイルがここに入る。消すときは、先にここを空にする）'
                     from public.gw_employees where id = 'e13db73f-3d85-45ca-ac0a-7f26a5d53610'), '（無い）'), 'ℹ'),
    (15, '/office での見え方', '対象月を 2026年10月 にすると、1行（勤務表待ち）が出る。9月には出ない', 'ℹ')
  ) as v(順, 項目, 値, 判定)
 order by 順;
