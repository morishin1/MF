-- =============================================================================
-- 入社管理（admin-hr.html）と、労働条件通知書の一連の動きに、本番 DB が足りているかの確認。読み取り専用。
--
-- ■ 使い方
--   Supabase の SQL Editor に貼って Run。select だけで、何も変えない（表も列も、行も作らない）。
--   いちばん上の「集計」の行と、「判定」が「不足」の行を見る。
--
-- ■ 何を基準にしているか
--   いまの main のコードが、実際に読み書きする表・列・制約・関数・ポリシーを、1つずつ確かめる。
--     api/hr/index.js              … 入社管理の一覧・詳細・登録・チェック・日付変更（admin-hr.html）
--     api/onboarding/notice.js     … 労働条件通知書（管理側）。アップロード・プレビュー・公開
--     api/onboarding/start.js      … 本人の入社準備（/onboarding/）。通知書を見る・確認しました
--     api/onboarding/status.js     … 入社手続きの進み具合（本人・管理者・社労士が同じものを見る）
--     と、それらが読み込む lib/（gw.js・onboard-advance.js・hr-run.js・labor-notice-db.js ほか）
--
-- ■ 番号では判断しない
--   db/ の番号は、系統（main・PR #39）で重なっている（099・100・105 が両方にある）。
--   「066 を流したか」ではなく、「その SQL が作るはずの表・列・関数・制約が、いま実際にあるか」で見る。
--   「出どころ」のファイル名は、足りなかったときに「どのファイルが作るものか」の参考。
--
-- ■ 判定の読み方
--   必須で存在 … 必須のものが、ある
--   不足       … 必須のものが、無い。入社管理か、通知書の一連の動きが止まる。「無いと起きること」を見る
--   任意（あり） … 任意のものが、ある
--   任意（なし） … 任意のものが、無い。無くても入社管理と通知書は動く（その分の機能・精度だけ落ちる）
--   「不足の中身」には、無い表・列・値を出す（表ごと無いときは「表が無い」）。
--
-- ■ 「必須」の意味
--   次の2つが動くのに要るもの。
--     ① 入社管理の画面が開き、入社予定者を登録し、一覧・詳細を見て、チェック・日付を変えられる
--     ② 通知書のアップロード → プレビュー → 本人に公開 → 本人が「確認しました」→ 管理側に確認日時
--   「任意」は、それが無くても上の2つは動くもの。ただし、何が止まるかは「無いと起きること」に書いてある。
-- =============================================================================

with
col(tbl, c) as (
  select table_name::text, column_name::text from information_schema.columns where table_schema = 'public'
),
-- 制約（check・unique）の定義。pg_get_constraintdef は、値の並びを 'a'::text のまま返す
con as (
  select (select relname from pg_class where oid = k.conrelid)::text as tbl, k.conname::text as name, k.contype,
         pg_get_constraintdef(k.oid) as def
    from pg_constraint k where k.connamespace = 'public'::regnamespace
),
-- 一意なインデックス（unique 制約も、これに入る）。条件付き・式のものは数えない
uniq as (
  select t.relname::text as tbl, array_agg(a.attname::text order by a.attname::text) as cols
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any(i.indkey)
   where i.indisunique and i.indpred is null and i.indexprs is null
   group by i.indexrelid, t.relname
),
-- check 制約に、この値が通る（列ごとに、その制約があるときだけ見る。制約が無ければ、どんな値も通る）
conval(tbl, colname, lits) as (values
  ('gw_procedures',      'kind',     array['onboarding', 'offboarding']),
  ('gw_procedures',      'status',   array['in_progress', 'done', 'cancelled']),
  ('gw_procedure_items', 'status',   array['todo', 'submitted', 'done', 'na']),
  ('gw_procedure_items', 'category', array['task', 'document']),
  ('gw_procedure_items', 'owner',    array['employee', 'hr', 'labor_advisor', 'it', 'manager', 'finance']),
  ('gw_notifications',   'kind',     array['general']),
  ('gw_role_grants',     'role',     array['owner', 'hr', 'it', 'manager', 'finance'])
),
conval_bad as (
  select * from (
  select cv.tbl, cv.colname,
         array_to_string(array(
           select l from unnest(cv.lits) as x(l)
            where not exists (select 1 from con where con.tbl = cv.tbl and con.contype = 'c'
                                and con.def ~ ('[( ]' || cv.colname || ' = ANY') and con.def like '%''' || x.l || '''%')
         ), '・') as lacking
    from conval cv
   where exists (select 1 from con where con.tbl = cv.tbl and con.contype = 'c' and con.def ~ ('[( ]' || cv.colname || ' = ANY'))
  ) b where b.lacking <> ''
),

-- ---- 表と列 --------------------------------------------------------------------
-- 並び: 番号, 区分, 確認する対象, 使うところ, 無いと起きること, 出どころ（参考）, 表, 列
spec(ord, kind, target, used_by, effect, file_hint, tbl, cols) as (
  values
  -- ======== 1 土台（どの画面・APIも通る）========
  (110, '必須', 'tenants（表）', '全 API（会社の特定）',
     '会社を特定できず、どの API も動かない', 'db/schema.sql',
     'tenants', array['id', 'name']),
  (111, '必須', 'memberships（表）と id・tenant_id・role・client_id・user_id', 'lib/auth.js getMemberships（全 API）',
     '管理者（admin / staff）かどうかを引けず、どの API も動かない', 'db/schema.sql',
     'memberships', array['id', 'tenant_id', 'role', 'client_id', 'user_id']),
  (112, '必須', 'gw_employees（表）の基本の列', 'lib/gw.js gwContext（全 API）',
     '社員名簿の行を引けず、全員が「社員名簿にあなたの行がありません」（403）になる', 'db/005_groupware_core.sql',
     'gw_employees', array['id', 'tenant_id', 'user_id', 'display_name', 'email', 'department', 'position', 'employment_type', 'joined_on', 'status']),
  (113, '必須', 'gw_employees.manager_id・initial_role・work_style・job_family_code（列）', 'lib/gw.js gwContext（全 API）',
     'gwContext の問い合わせが失敗し、全員が社員名簿に居ない扱い（403）になる', 'db/033_intake.sql',
     'gw_employees', array['manager_id', 'initial_role', 'work_style', 'job_family_code']),
  (114, '必須', 'gw_employees.autonomy_level（列）', 'lib/gw.js gwContext（全 API）',
     'gwContext の問い合わせが失敗し、全員が社員名簿に居ない扱い（403）になる', 'db/031_autonomy_blockers.sql',
     'gw_employees', array['autonomy_level']),
  (115, '必須', 'gw_role_grants（表）と id・tenant_id・employee_id・role。社内ロール（owner・hr）', 'lib/gw.js gwContext、通知書・入社管理の権限判定',
     '誰も owner・hr として扱われず、入社管理も通知書も 403', 'db/005_groupware_core.sql',
     'gw_role_grants', array['id', 'tenant_id', 'employee_id', 'role']),
  (116, '必須', 'gw_activity_log（表）と tenant_id・actor_id・action・target・detail。操作の記録', 'lib/gw-audit.js（通知書の登録・公開・確認の記録）',
     '操作の記録が残らない（操作そのものは通る）', 'db/005_groupware_core.sql',
     'gw_activity_log', array['tenant_id', 'actor_id', 'action', 'target', 'detail']),

  -- ======== 2 入社手続き（api/hr/index.js）========
  (210, '必須', 'gw_procedures（表）の基本の列。入社・退社の手続き本体', 'api/hr/index.js（一覧・詳細・登録・変更）、status.js、start.js',
     'GET /api/hr が 503（not_ready）。入社管理の画面が開かない。本人の入社準備も手続きを引けない', 'db/008_onboarding.sql',
     'gw_procedures', array['id', 'tenant_id', 'employee_id', 'kind', 'status', 'target_on', 'note', 'drive_link', 'created_by', 'created_at', 'updated_at']),
  (211, '必須', 'gw_procedures.phase・notified_at・notified_for（列）', 'api/hr/index.js（一覧の取得 P_FIELDS）',
     'GET /api/hr が 503（列が無い）。入社管理の画面が開かない', 'db/066_hr_flow.sql',
     'gw_procedures', array['phase', 'notified_at', 'notified_for']),
  (212, '必須', 'gw_procedures.drive_folders・advisor_shared_to・advisor_shared_at（列）', 'api/hr/index.js（一覧の取得 P_FIELDS）',
     'GET /api/hr が 503（列が無い）。入社管理の画面が開かない', 'db/039_consent_and_drive.sql',
     'gw_procedures', array['drive_folders', 'advisor_shared_to', 'advisor_shared_at']),
  (220, '必須', 'gw_procedure_items（表）の基本の列。チェックリスト', 'api/hr/index.js（詳細・チェック・登録）、status.js',
     'チェックリストが空に見える。チェックを付けられない。本人の入社準備が進み具合を数えられない', 'db/008_onboarding.sql',
     'gw_procedure_items', array['id', 'tenant_id', 'procedure_id', 'title', 'category', 'owner', 'required', 'share_with_advisor', 'status', 'due_on', 'note', 'sort_order', 'completed_at', 'completed_by', 'created_at', 'updated_at']),
  (221, '必須', 'gw_procedure_items.item_key（列）', 'api/hr/index.js（I_FIELDS）、lib/hr-run.js（足りない項目の判定）、status.js',
     'チェックリストが空に見える。登録のとき項目を作れない', 'db/037_onboard_form.sql',
     'gw_procedure_items', array['item_key']),
  (222, '必須', 'gw_procedure_items.phase・assignee_id（列）', 'api/hr/index.js（I_FIELDS）、lib/hr-run.js（担当者を決める）',
     'チェックリストが空に見える。登録のとき担当者を入れられない', 'db/066_hr_flow.sql',
     'gw_procedure_items', array['phase', 'assignee_id']),
  -- ======== 3 通知書（db/110）と保管先 ========
  (310, '必須', 'gw_labor_notices（表）と、API が読み書きする全ての列', 'api/onboarding/notice.js・start.js・status.js・lib/labor-notice-db.js',
     '通知書のアップロード・公開・確認が動かない（503）', 'db/110_labor_notices.sql',
     'gw_labor_notices', array['id', 'tenant_id', 'employee_id', 'version', 'storage_path', 'filename', 'size_bytes', 'sha256', 'uploaded_by', 'uploaded_at', 'published_by', 'published_at', 'confirmed_by', 'confirmed_at']),

  -- ======== 4 段階の判定に使う事実の表（無くても止まらない。あるぶんだけ、段階が正しくなる）========
  (410, '任意', 'gw_sign_requests（表）と、電子署名の依頼の列', 'lib/labor-notice-db.js esignState、lib/onboard-advance.js、status.js',
     '電子署名の依頼があるかを見られない。電子署名を使っていない会社は、通知書の確認だけで進むので、困らない', 'db/046_esign.sql',
     'gw_sign_requests', array['id', 'tenant_id', 'employee_id', 'title', 'doc_kind', 'status', 'due_on', 'signed_at', 'sent_at']),
  (411, '任意', 'gw_doc_orders（表）と、社労士への作成依頼の列', 'lib/labor-notice-db.js esignState、lib/onboard-advance.js',
     '社労士への作成依頼の有無を見られない（管理側の注意書きと、段階の「作成依頼」の判定が出ない）', 'db/056_doc_orders.sql',
     'gw_doc_orders', array['id', 'tenant_id', 'employee_id', 'doc_kind', 'status', 'updated_at']),
  (412, '任意', 'gw_onboard_profiles（表）と、本人の入社情報の列', 'lib/onboard-advance.js、status.js',
     '入社情報の提出を事実として読めず、通知書の確認のあとの「入社情報の入力」が済んだことにならない', 'db/037_onboard_form.sql',
     'gw_onboard_profiles', array['employee_id', 'status', 'submitted_at']),
  (413, '任意', 'gw_onboard_consents（表）と、誓約書などの同意の列', 'lib/onboard-advance.js、status.js',
     '同意を事実として読めず、「誓約書などの同意」が済まない扱いになる（通知書の確認の記録そのものは残る）', 'db/037_onboard_form.sql',
     'gw_onboard_consents', array['employee_id', 'kind', 'version', 'agreed_at']),
  (414, '任意', 'gw_consent_docs（表）と、同意する文書の列', 'lib/onboard-advance.js、status.js',
     '同意する文書を読めない。表が空のときはコードの版で判定するので、表だけが無いと「同意が必要な文書」は出ない', 'db/039_consent_and_drive.sql',
     'gw_consent_docs', array['tenant_id', 'status', 'doc_key']),
  (415, '任意', 'gw_orientation_items（表）と、オリエンテーションの教材の列', 'lib/onboard-advance.js、status.js',
     'オリエンテーションの確認が数えられない（「必要書類提出」の判定から、このぶんが外れる）', 'db/071_onboarding_stage2.sql',
     'gw_orientation_items', array['id', 'tenant_id', 'title', 'kind', 'required', 'sort_order', 'active']),
  (416, '任意', 'gw_orientation_checks（表）と、確認の列', 'lib/onboard-advance.js、status.js',
     'オリエンテーションの確認が数えられない', 'db/071_onboarding_stage2.sql',
     'gw_orientation_checks', array['employee_id', 'item_id', 'confirmed_at']),
  (417, '任意', 'gw_contracts（表）。雇用契約', 'api/onboarding/status.js（契約の期間・試用期間の表示）',
     '契約の期間・試用期間が「本人の既知の情報」に出ない（表示だけ）', 'db/029_contracts.sql',
     'gw_contracts', array['employee_id', 'status', 'created_at']),
  (418, '任意', 'gw_procedure_files（表）。本人が出した書類のファイル', '新規メンバー登録の入社キット（lib/onboard-kit.js）、書類の提出',
     '本人が書類をアップロードできない。入社管理の登録（/api/hr）と通知書は、この表が無くても動く', 'db/012_hr_files.sql',
     'gw_procedure_files', array['id', 'tenant_id', 'procedure_id', 'item_id']),
  (419, '任意', 'gw_employee_careers（表）。キャリア', 'api/onboarding/start.js（STEP の「次の一手」）',
     '入社準備が終わったあとの「キャリアプランを確認する」が出ない', 'db/092_career.sql',
     'gw_employee_careers', array['tenant_id', 'employee_id', 'is_active']),

  -- ======== 5 通知・やること・記録（無くても、手続きは止まらない）========
  (510, '任意', 'gw_notifications（表）と、通知の列', 'lib/notify.js（本人への通知書の公開通知、入退社の担当者への知らせ）',
     'ベルの通知が出ない。手続きそのものは止まらない', 'db/013_notifications.sql',
     'gw_notifications', array['tenant_id', 'employee_id', 'kind', 'title', 'body', 'link', 'dedupe_key', 'read_at', 'created_at']),
  (511, '任意', 'gw_tasks（表）と、やることの列（link を含む）', 'lib/hr-run.js tell（担当者の「やること」に入れる）',
     '担当者の「やること」に入らない（お知らせは届く。手続きは止まらない）', 'db/009_tasks.sql・db/066_hr_flow.sql',
     'gw_tasks', array['tenant_id', 'title', 'body', 'assignee_id', 'due_on', 'priority', 'status', 'category', 'link']),
  (512, '任意', 'gw_sensitive_access_log（表）と、機密の閲覧記録の列', 'lib/sensitive-log.js（管理側で通知書を開いた記録）',
     '他人の通知書を開いた記録（閲覧ログ）が残らない。プレビュー自体は動く', 'db/070_onboarding_stage.sql',
     'gw_sensitive_access_log', array['tenant_id', 'actor_id', 'actor_name', 'subject_id', 'kind', 'action', 'target', 'detail', 'ip', 'user_agent']),

  -- ======== 6 段階の写し・マイナンバー（無くても、画面は動く）========
  (610, '任意', 'gw_procedures.stage・stage_at（列）', 'lib/onboard-advance.js advance（段階の写しを書く）、status.js、start.js',
     '段階が進んだときに、次の担当者へ知らせられない（advance が何もせず戻る）。画面の段階は、事実から計算するので正しく出る', 'db/070_onboarding_stage.sql',
     'gw_procedures', array['stage', 'stage_at']),
  (611, '任意', 'gw_procedures.mynumber_status・mynumber_status_at・mynumber_status_by（列）', 'api/hr/index.js（マイナンバーの進み具合）、status.js',
     'マイナンバーの進み具合が「未提出」のまま。変えようとすると 503（一覧と他の操作は動く）', 'db/070_onboarding_stage.sql',
     'gw_procedures', array['mynumber_status', 'mynumber_status_at', 'mynumber_status_by']),

  -- ======== 7 入社案内（/onboarding/ の STEP1）========
  (710, '任意', 'gw_onboarding_guides（表）と、案内の列', 'api/onboarding/start.js（STEP1 の入社案内）',
     'STEP1 が「データ未連携」になる。STEP2 以降（通知書の確認）は止めない', 'db/104_onboarding_guide.sql',
     'gw_onboarding_guides', array['id', 'tenant_id', 'employee_id', 'version', 'confirmed_version', 'confirmed_at']),
  (711, '任意', 'gw_onboarding_guide_issues（表）と、発行した案内の列', 'api/onboarding/start.js',
     '発行済みの入社案内の中身を読めない', 'db/104_onboarding_guide.sql',
     'gw_onboarding_guide_issues', array['guide_id', 'version', 'snapshot']),
  (712, '任意', 'gw_onboarding_invites（表）と、案内URLの列', 'api/onboarding/start.js（案内URL ?t= が本人のものかの確認）',
     '案内URLから来た人が、別の人のURLかを確かめられない', 'db/104_onboarding_guide.sql',
     'gw_onboarding_invites', array['employee_id', 'tenant_id', 'token_hash'])
),
spec_chk as (
  select s.ord, s.kind, s.target, s.used_by, s.effect, s.file_hint,
         (to_regclass('public.' || s.tbl) is not null
           and not exists (select 1 from unnest(s.cols) as x(name)
                            where not exists (select 1 from col where col.tbl = s.tbl and col.c = x.name))) as ok,
         case when to_regclass('public.' || s.tbl) is null then '表が無い（' || s.tbl || '）'
              else (select string_agg(x.name, '・' order by x.name) from unnest(s.cols) as x(name)
                     where not exists (select 1 from col where col.tbl = s.tbl and col.c = x.name)) end as missing
    from spec s
),

-- ---- 表と列のほか（関数・制約・ポリシー・インデックス・バケット・データ）--------------
other(ord, kind, target, used_by, effect, file_hint, ok, missing) as (
  values
  -- 関数（RLS のポリシーが呼ぶ。status.js は、ログインした本人の権限そのままで読む）
  (120, '必須', 'RLS の関数 gw_has_role・gw_is_hr・gw_employee_id・gw_is_advisor・gw_procedure_is_mine・is_tenant_staff', 'RLS のポリシー（status.js は userClient で読む）。通知書の RLS（gw_has_role）',
     'ポリシーが呼べず、本人・管理者の読み取りが失敗する。通知書の RLS が効かない', 'db/005_groupware_core.sql・db/008_onboarding.sql・db/schema.sql',
     to_regprocedure('public.gw_has_role(uuid, text)') is not null and to_regprocedure('public.gw_is_hr(uuid)') is not null
       and to_regprocedure('public.gw_employee_id(uuid)') is not null and to_regprocedure('public.gw_is_advisor(uuid)') is not null
       and to_regprocedure('public.gw_procedure_is_mine(uuid)') is not null and to_regprocedure('public.is_tenant_staff(uuid)') is not null,
     concat_ws('・',
       case when to_regprocedure('public.gw_has_role(uuid, text)') is null then 'gw_has_role' end,
       case when to_regprocedure('public.gw_is_hr(uuid)') is null then 'gw_is_hr' end,
       case when to_regprocedure('public.gw_employee_id(uuid)') is null then 'gw_employee_id' end,
       case when to_regprocedure('public.gw_is_advisor(uuid)') is null then 'gw_is_advisor' end,
       case when to_regprocedure('public.gw_procedure_is_mine(uuid)') is null then 'gw_procedure_is_mine' end,
       case when to_regprocedure('public.is_tenant_staff(uuid)') is null then 'is_tenant_staff' end)),
  -- 本人が、自分の社員名簿の行を読める（status.js は、本人のトークンで読む）
  (121, '必須', 'gw_employees を、本人が自分の行だけ読めるポリシー（user_id = auth.uid()）', 'api/onboarding/status.js（本人のトークンで名簿を読む）',
     '本人が自分の氏名を引けず、入社手続きの進み具合（status）が 404 になる', 'db/007_notices.sql（gw_employees_self_select）',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_employees' and cmd in ('SELECT', 'ALL')
               and qual ~ 'user_id' and qual ~ 'auth\.uid'), null),
  -- 本人が、自分の手続き・チェックリストを読める
  (122, '必須', 'gw_procedures・gw_procedure_items を、本人が自分の分だけ読めるポリシー', 'api/onboarding/status.js（本人のトークンで読む）',
     '本人の入社手続き・チェックリストが空に見える（status）', 'db/008_onboarding.sql（gw_procedures_select・gw_procedure_items_select）',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_procedures' and cmd in ('SELECT', 'ALL') and qual ~ 'gw_employee_id')
       and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_procedure_items' and cmd in ('SELECT', 'ALL') and qual ~ 'gw_procedure_is_mine'),
     concat_ws('・',
       case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_procedures' and cmd in ('SELECT', 'ALL') and qual ~ 'gw_employee_id') then 'gw_procedures の本人の読み取り' end,
       case when not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_procedure_items' and cmd in ('SELECT', 'ALL') and qual ~ 'gw_procedure_is_mine') then 'gw_procedure_items の本人の読み取り' end)),

  -- 制約: 値が通る（無いと、登録・チェックのときに check 違反で落ちる）
  (223, '必須', 'gw_procedure_items.owner の check が、担当 6 種（本人・人事・社労士・IT・上長・経理）を通す', 'lib/hr-run.js seed（POST /api/hr の項目の作成）、lib/hr-flow.js',
     '入社の登録（POST /api/hr）が seed_failed（500）で止まる。it・manager・finance の項目を入れられない', 'db/066_hr_flow.sql',
     to_regclass('public.gw_procedure_items') is not null
       and not exists (select 1 from conval_bad where tbl = 'gw_procedure_items' and colname = 'owner'),
     case when to_regclass('public.gw_procedure_items') is null then '表が無い'
          else (select lacking from conval_bad where tbl = 'gw_procedure_items' and colname = 'owner') end),
  (224, '必須', 'gw_procedures・gw_procedure_items の check が、使う値（種別・状態・分類）を通す', 'api/hr/index.js（kind・status）、lib/hr-run.js（category・status）',
     '登録・チェックのとき check 違反（500）で落ちる', 'db/008_onboarding.sql',
     to_regclass('public.gw_procedures') is not null and to_regclass('public.gw_procedure_items') is not null
       and not exists (select 1 from conval_bad where tbl in ('gw_procedures', 'gw_procedure_items') and colname <> 'owner'),
     (select string_agg(tbl || '.' || colname || '：' || lacking, ' / ') from conval_bad
       where tbl in ('gw_procedures', 'gw_procedure_items') and colname <> 'owner')),
  -- 一意: 同じ人・同じ種別の手続きは1つ（2つあると、本人の画面から書類を出す口が消える。db/065 の冒頭）
  (225, '必須', 'gw_procedures の (employee_id, kind) が一意', 'api/hr/index.js create（同じ人・同じ種別は1つ）、lib/onboard-kit.js findProcedure',
     '同じ人に入社手続きが2つできうる。2つになると、maybeSingle がエラーになり、画面が壊れる', 'db/008_onboarding.sql（unique）または db/065_onboarding_one.sql',
     exists (select 1 from uniq where tbl = 'gw_procedures' and cols = array['employee_id', 'kind']), null),
  (226, '必須', 'gw_labor_notices の (employee_id, version) が一意', 'api/onboarding/notice.js attach（版が重なったら数え直す）',
     '同時に2人が登録したとき、同じ版番号が2つできうる', 'db/110_labor_notices.sql',
     exists (select 1 from uniq where tbl = 'gw_labor_notices' and cols = array['employee_id', 'version']), null),
  (513, '任意', 'gw_notifications の (employee_id, dedupe_key) が一意', 'lib/notify.js（upsert の onConflict）',
     '通知が入らない（upsert が失敗する）。手続きは止まらない', 'db/013_notifications.sql',
     exists (select 1 from uniq where tbl = 'gw_notifications' and cols = array['dedupe_key', 'employee_id']), null),
  (514, '任意', 'gw_notifications.kind の check が general（本人への通知書の公開通知）を通す', 'api/onboarding/notice.js publish（本人への通知）',
     '本人に「通知書を確認してください」の通知が届かない（公開自体は通る）', 'db/013_notifications.sql・db/040_reminders.sql ほか',
     to_regclass('public.gw_notifications') is not null and not exists (select 1 from conval_bad where tbl = 'gw_notifications' and lacking like '%general%'),
     case when to_regclass('public.gw_notifications') is null then '表が無い'
          else (select lacking from conval_bad where tbl = 'gw_notifications') end),
  -- hr_flow: lib/hr-run.js は kind = 'hr_flow' で通知を作る。どの migration も、この値を check に入れていない
  (515, '任意', 'gw_notifications.kind の check が hr_flow（入退社の担当者への知らせ）を通す', 'lib/hr-run.js tell（入退社の登録・日付変更・もう一度知らせる）',
     '担当者へのベルの通知が入らない（check 違反は notify が握りつぶす）。「やること」と Slack は動く。手続きは止まらない。'
       || ' ※ main のどの SQL も hr_flow を許していない（既存の問題）', 'どの migration にも無い（lib/hr-run.js のコード側の値）',
     to_regclass('public.gw_notifications') is not null
       and not exists (select 1 from con where tbl = 'gw_notifications' and contype = 'c' and def ~ 'kind = ANY')
       or exists (select 1 from con where tbl = 'gw_notifications' and contype = 'c' and def ~ 'kind = ANY' and def like '%''hr_flow''%'),
     case when to_regclass('public.gw_notifications') is null then '表が無い' else 'hr_flow' end),
  (516, '任意', 'gw_role_grants.role の check が it・manager・finance を通す', 'lib/hr-run.js assigneesFor（IT・上長・経理の担当者を決める）',
     'IT・上長・経理のロールを付けられない。担当者は、人事・経営者に寄る（入社管理は動く）', 'db/066_hr_flow.sql',
     to_regclass('public.gw_role_grants') is not null
       and not exists (select 1 from conval_bad where tbl = 'gw_role_grants' and colname = 'role'),
     case when to_regclass('public.gw_role_grants') is null then '表が無い'
          else (select lacking from conval_bad where tbl = 'gw_role_grants' and colname = 'role') end),

  -- 通知書（db/110）の権限と守り
  (311, '必須', 'gw_labor_notices の RLS が有効', '通知書の読み取り（給与・個人情報を含む）',
     '誰でも直接読めてしまう', 'db/110_labor_notices.sql',
     coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.gw_labor_notices')), false), null),
  (312, '必須', 'gw_labor_notices の読み取りポリシー（gw_labor_notices_read）が、owner・hr ロールだけ', '通知書の読み取り',
     '通知書を読める人が、owner・hr より多い（または、誰も読めない）', 'db/110_labor_notices.sql',
     exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_labor_notices' and policyname = 'gw_labor_notices_read'
               and qual ~ 'gw_has_role' and qual ~ 'owner' and qual ~ 'hr'
               and qual !~ 'gw_is_hr' and qual !~ 'is_tenant_staff'), null),
  (313, '必須', 'gw_labor_notices の読み取りポリシーが、管理者（admin / staff）も読める古い定義ではない', '通知書の読み取り',
     '管理者（admin / staff）にも通知書が読めてしまう（古い定義）。db/110 をもう一度流すと、owner・hr だけに置き換わる（べき等）', 'db/110_labor_notices.sql',
     to_regclass('public.gw_labor_notices') is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'gw_labor_notices' and policyname = 'gw_labor_notices_read'
                         and (qual ~ 'gw_is_hr' or qual ~ 'is_tenant_staff')), null),
  (314, '必須', 'gw_labor_notices の更新ガード（トリガ）', '確認は1回だけ・版の中身は書き換え不可',
     '確認日時・公開日時・ファイル情報が、あとから書き換えられる', 'db/110_labor_notices.sql',
     exists (select 1 from pg_trigger where tgrelid = to_regclass('public.gw_labor_notices') and tgname = 'gw_labor_notices_guard_trg' and not tgisinternal), null),
  (315, '必須', 'Storage バケット hr が、非公開で存在する', 'api/onboarding/notice.js・start.js（通知書の PDF の置き場所・署名付きURL）',
     'PDF を置けない・開けない（バケットが無い）。公開のままだと、URL を知る誰でも開ける', 'db/012_hr_files.sql',
     exists (select 1 from storage.buckets where id = 'hr' and public = false),
     (select case when public then '公開になっています。非公開に直してください' end from storage.buckets where id = 'hr')),
  (316, '必須', 'Storage バケット hr の設定（file_size_limit・allowed_mime_types）が、PDF（15MB まで）を妨げない', 'api/onboarding/notice.js（PDF の置き場所へのアップロード）',
     '通知書の PDF をアップロードできない（サイズ・種類の制限で断られる）', 'Supabase の Storage 設定（バケット hr）',
     exists (select 1 from storage.buckets b where b.id = 'hr'
               and coalesce((to_jsonb(b) ->> 'file_size_limit')::bigint, 9223372036854775807) >= 15 * 1024 * 1024
               and case when jsonb_typeof(to_jsonb(b) -> 'allowed_mime_types') = 'array'
                        then exists (select 1 from jsonb_array_elements_text(to_jsonb(b) -> 'allowed_mime_types') as m(x)
                                      where m.x in ('application/pdf', 'application/*', '*/*'))
                        else true end),
     case when exists (select 1 from storage.buckets where id = 'hr')
          then 'file_size_limit が 15MB 未満か、allowed_mime_types に PDF が入っていません' else 'バケット hr が無い' end),

  -- ---- データ（読むだけ）----
  (910, '必須', 'owner または hr ロールの人が、1人以上いる', '通知書・入社管理の操作（owner・hr だけ）',
     '通知書を操作できる人がいない（403）', '（データ。db/005 の初期投入）',
     case when to_regclass('public.gw_role_grants') is null then false
          else coalesce((xpath('/row/n/text()', query_to_xml(
                 'select count(*) as n from public.gw_role_grants where role in (''owner'', ''hr'')', false, true, '')))[1]::text::int, 0) > 0 end,
     case when to_regclass('public.gw_role_grants') is null then '表が無い' else 'owner・hr のロールを持つ人が 0 人' end),
  (911, '必須', '同じ人・同じ種別の入社手続きが、重複していない', 'lib/onboard-kit.js findProcedure、api/hr/index.js create',
     '重複があると、本人の画面から書類を出す口が消え、管理側の操作のたびに増える。db/065 で、いちばん古いものにまとめる', 'db/065_onboarding_one.sql（まとめる）',
     case when to_regclass('public.gw_procedures') is null
               or exists (select 1 from unnest(array['employee_id', 'kind']) as x(name)
                           where not exists (select 1 from col where col.tbl = 'gw_procedures' and col.c = x.name)) then false
          else coalesce((xpath('/row/n/text()', query_to_xml(
                 'select count(*) as n from (select 1 from public.gw_procedures group by employee_id, kind having count(*) > 1) d', false, true, '')))[1]::text::int, 0) = 0 end,
     case when to_regclass('public.gw_procedures') is null then '表が無い' end),

  -- ---- 不足の SQL を流すときの前提（いまの動きには関係しない。流す前に、これが無いと、そのファイルが途中で止まる）----
  (810, '任意', '関数 safe_uuid(text)', '（流すとき）db/012_hr_files.sql が、Storage のポリシーで呼ぶ',
     '無いと、db/012 が途中で止まる（バケット hr と、書類の表が作られない）。先に db/006 が要る', 'db/006_storage_policies.sql',
     to_regprocedure('public.safe_uuid(text)') is not null, null),
  (811, '任意', '関数 gw_is_internal_staff()', '（流すとき）db/039_consent_and_drive.sql が、同意文書のポリシーで呼ぶ',
     '無いと、db/039 が途中で止まる（gw_procedures の drive_folders・advisor_shared_* 列が足されない）。この関数は db/026_nippo_ai_eval.sql が作る', 'db/026_nippo_ai_eval.sql',
     to_regprocedure('public.gw_is_internal_staff()') is not null, null),
  (812, '任意', '関数 gw_is_owner(uuid)', '（流すとき）db/104_onboarding_guide.sql（入社案内）が呼ぶ',
     '無いと、db/104 が途中で止まる。この関数は db/099_owner_only.sql（PR #39 の系統）が作る。今回は流さない方針なので、入社案内（STEP1）は「データ未連携」のまま', 'db/099_owner_only.sql',
     to_regprocedure('public.gw_is_owner(uuid)') is not null, null)
),

checks as (
  select * from spec_chk
  union all
  select * from other
)
select
  case when ord = 0 then '集計'
       when ok and kind = '必須' then '必須で存在'
       when not ok and kind = '必須' then '不足'
       when ok then '任意（あり）'
       else '任意（なし）' end                                    as "判定",
  target                                                         as "確認する対象（実体）",
  case when ord = 0 then missing
       when ok then null
       else coalesce(missing, '（定義が足りません。「確認する対象」を見てください）') end as "不足の中身",
  effect                                                         as "無いと起きること",
  used_by                                                        as "使うところ",
  file_hint                                                      as "出どころ（参考。番号でなく実体で見る）"
from (
  select 0 as ord, '必須' as kind,
         '必須の不足 ' || count(*) filter (where kind = '必須' and not ok) || ' 件 ／ 任意の欠け ' || count(*) filter (where kind = '任意' and not ok) || ' 件'
           as target,
         case when count(*) filter (where kind = '必須' and not ok) = 0 then '必須は全部そろっています' else '「不足」の行を先に直す' end as missing,
         '必須の不足が 0 件なら、入社管理（admin-hr.html）と通知書の一連の動きの前提は、DB 側はそろっています' as effect,
         'いまの main の api/hr・api/onboarding/{notice,start,status}.js と、その lib/' as used_by,
         '読み取り専用（何も変えません）' as file_hint,
         true as ok
    from checks
  union all
  select ord, kind, target, missing, effect, used_by, file_hint, ok from checks
) r
order by ord;
