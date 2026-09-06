-- =============================================================================
-- いまどこまで適用されているかを見る
--
-- Supabase の SQL Editor に貼って Run するだけ。何も書き換えない（読むだけ）。
-- 「未適用」と出た番号の SQL を、上から順に流してください。
--
-- 判定のしかた
--   各マイグレーションが必ず作るもの（表・列・関数・バケット）が1つあるかを見る。
--   途中でエラーになって半分だけ流れた場合は、目印より前の部分は入っているのに
--   「適用済み」と出ることがある。そのときは、その番号をもう一度流せばよい
--   （どのファイルも if not exists で書いてあるので、2回流しても壊れない）。
-- =============================================================================

with checks(seq, mig, title, kind, obj, col) as (values
  -- 会計（KessanPilot）
  ( 1, 'schema', '会計の土台（tenants / clients / documents / journals）', 'table',    'documents',              null),
  ( 2, '002',    '書類の種別判定',                                      'column',   'documents',              'is_accounting'),
  ( 3, '003',    'マネーフォワード OAuth',                              'table',    'accounting_credentials', null),
  ( 4, '004',    'Google Drive 同期',                                   'column',   'documents',              'drive_file_id'),

  -- グループウェアの土台
  ( 5, '005',    'グループウェアの土台（社員名簿・社内権限）',           'table',    'gw_employees',           null),
  ( 6, '006',    'Storage のポリシー',                                  'function', 'safe_uuid',              null),
  ( 7, '007',    '社内お知らせ',                                        'table',    'gw_notices',             null),
  ( 8, '008',    '入社・退職手続き',                                    'table',    'gw_procedures',          null),
  ( 9, '009',    'やること（タスク）',                                  'table',    'gw_tasks',               null),
  (10, '010',    '社内メッセージ',                                      'table',    'gw_messages',            null),
  (11, '011',    '貸与品・書類の雛形',                                  'table',    'gw_assets',              null),
  (12, '012',    '手続きの提出ファイル',                                'table',    'gw_procedure_files',     null),
  (13, '013',    '社内通知',                                            'table',    'gw_notifications',       null),
  (14, '014',    'メッセージの添付',                                    'table',    'gw_message_files',       null),
  (15, '015',    'スペース予約',                                        'table',    'gw_bookings',            null),
  (16, '016',    '経費精算',                                            'table',    'gw_expense_reports',     null),
  (17, '017',    '自分だけのカレンダー',                                'table',    'gw_calendar_events',     null),
  (18, '018',    'Googleカレンダー連携（読み取り）',                     'table',    'gw_google_links',        null),
  (19, '019',    '有給・稟議',                                          'table',    'gw_requests',            null),
  (20, '020',    '社内文書（マニュアル・規定・様式）',                  'table',    'gw_library',             null),
  (21, '021',    '自社Webサイトのアクセス統合',                         'table',    'gw_web_projects',        null),
  (22, '022',    'GA4 を数字の出どころに加える',                        'column',   'gw_web_projects',        'ga4_property_id'),

  -- ここから下が、今回追加したぶん
  (23, '023',    '口コミブロック台帳のRLS',                             'function', 'gw_can_manage_blocks',   null),
  (24, '024',    '予定を Googleカレンダーへ書き出す',                    'column',   'gw_calendar_events',     'gcal_event_id'),
  (25, '025',    '日報を6項目に',                                       'column',   'tc_nippo',               'work_items'),
  (26, '026',    '日報のAI評価',                                        'table',    'gw_nippo_ai_evals',      null),
  (27, '027',    '週次100点・月次',                                     'table',    'gw_nippo_monthly',       null),
  (28, '028',    '試用期間の判定',                                      'table',    'gw_probation_reviews',   null),
  (29, '029',    '雇用契約・面談',                                      'table',    'gw_contracts',           null),
  (30, '030',    'ダッシュボード連動（KPI・次にやること・点数の内訳）',  'table',    'gw_action_items',        null),
  (31, '031',    '止まっていること・自走レベル・デキル履歴',            'table',    'gw_blockers',            null),
  (32, '032',    '3か月育成計画・月間KGI/KPI',                        'table',    'gw_growth_plans',        null),
  (33, '033',    '1ファイル登録（雇用・育成マスターの取り込み）',        'table',    'gw_import_batches',      null),
  (34, '034',    '日報を朝と夜に分ける（先に描いてから動く）',          'column',   'tc_nippo',               'success_image'),
  (35, '035',    '勤務・育成区分／給与を読める人を絞る',                'column',   'gw_employees',           'work_mode'),
  (36, '036',    '日報を朝4つ・夜5つに／みんなの日報',                  'table',    'gw_nippo_shares',        null),
  (37, '037',    '入社フォーム（本人の情報・同意）',                    'table',    'gw_onboard_profiles',    null),
  (38, '038',    '社員名簿に備考',                                      'column',   'gw_employees',           'note'),
  (39, '039',    '電子同意（版付き）／提出書類の Drive 自動整理',        'table',    'gw_consent_docs',        null)
),

-- ファイルの適用状況
migrations as (
  select
    seq, mig, title,
    case kind
      when 'table'  then to_regclass('public.' || obj) is not null
      when 'column' then exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = obj and column_name = col)
      when 'function' then exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = obj)
    end as ok,
    case when col is null then obj else obj || '.' || col end as marker
  from checks
),

-- 日報の土台。これは 8grp-site の 8/timecard/ が作っている（このリポジトリではない）
foundation(seq, mig, title, ok, marker) as (
  select 101, '前提', '日報の土台（8grp-site の 8/timecard/nippo-setup.sql）',
         to_regclass('public.tc_nippo') is not null, 'tc_nippo'
  union all
  select 102, '前提', '週次レビューの土台（同上）',
         to_regclass('public.tc_weekly_review') is not null, 'tc_weekly_review'
  union all
  select 103, '前提', 'タイムカードの名簿（同上）',
         to_regclass('public.tc_profiles') is not null, 'tc_profiles'
  union all
  select 104, '前提', '無限道場の名簿（LMS。同じ auth.users を使う）',
         to_regclass('public.profiles') is not null, 'profiles'
),

-- ファイルの保存先
buckets(seq, mig, title, ok, marker) as (
  select 201, 'bucket', '会計書類',           exists(select 1 from storage.buckets where id = 'documents'), 'documents'
  union all
  select 202, 'bucket', '人事書類・雇用契約書', exists(select 1 from storage.buckets where id = 'hr'),        'hr'
  union all
  select 203, 'bucket', 'メッセージの添付',     exists(select 1 from storage.buckets where id = 'messages'),  'messages'
  union all
  select 204, 'bucket', '経費の領収書',         exists(select 1 from storage.buckets where id = 'expenses'),  'expenses'
  union all
  select 205, 'bucket', '社内文書',             exists(select 1 from storage.buckets where id = 'library'),   'library'
)

select
  case
    when seq < 100 then lpad(seq::text, 2, '0') || '. ' || mig
    when seq < 200 then '前提'
    else '保存先'
  end                                        as "区分",
  title                                      as "内容",
  case when ok then '✅ 適用済み' else '❌ 未適用' end as "状態",
  marker                                     as "目印",
  case
    when ok then ''
    when seq < 100 then 'db/' || mig || '_*.sql を流す'
    when seq < 200 then '8grp-site 側の SQL を先に流す'
    else '該当のマイグレーションを流すと作られる'
  end                                        as "やること"
from (
  select seq, mig, title, ok, marker from migrations
  union all select seq, mig, title, ok, marker from foundation
  union all select seq, mig, title, ok, marker from buckets
) all_checks
order by seq;
