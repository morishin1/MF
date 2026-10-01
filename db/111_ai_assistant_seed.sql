-- =============================================================================
-- 111: 社内AI（db/110）の初期ナレッジ
--
-- ■ 何のためか
--   ナレッジが0件のままでは、社内AIを開いても何も答えられない。
--   運用しながら各社の実情に合わせて書き換えてもらう前提の、
--   たたき台（messages.html のよくある質問と対応する内容）を入れておく。
--   内容は一般的な案内文なので、管理画面（admin-ai.html）で自由に編集・無効化してよい。
--
-- ■ べき等性
--   同じ tenant_id・title の行が無いときだけ入れる（二重に流しても増えない）。
--   既存テナントにだけ入る。この SQL を実行したあとに作られたテナントには入らない
--   （そのテナント用に別途入れるか、管理画面から登録する）。
--
-- ■ 既存データへの影響
--   gw_ai_knowledge への行追加のみ。他の表・既存行には触れない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 110_ai_assistant.sql
-- =============================================================================

insert into public.gw_ai_knowledge
  (tenant_id, title, category, content, source_type, access_scope, link_url, link_label, is_active)
select t.id, v.title, v.category, v.content, 'manual', v.access_scope, v.link_url, v.link_label, true
  from public.tenants t
  cross join (values
    ('有給休暇の申請方法', 'hr',
     '有給休暇は「勤怠・申請」の休暇申請から申請してください。原則として事前申請です。承認後に反映されます。',
     'all', 'requests.html', '休暇・申請を開く'),

    ('経費精算の締切', 'accounting',
     '経費精算は「勤怠・申請」の経費精算から提出してください。締切や支払日は会社ごとに決めているため、詳しくは管理部にご確認ください。',
     'all', 'expenses.html', '経費精算を開く'),

    ('請求書の提出先', 'accounting',
     '受け取った請求書は、管理部へ共有してください。提出方法（アップロード先など）は社内文書もあわせてご確認ください。',
     'all', 'library.html', '社内文書を見る'),

    ('PCを紛失した場合', 'it',
     '会社PCを紛失・盗難にあった場合は、まず管理部へ連絡してください。緊急時は社内AIを待たず直接問い合わせても構いません。',
     'all', null, null),

    ('入社書類について', 'hr',
     '入社手続きに必要な書類は「入社手続き」から確認・提出できます。提出済みの書類も同じ画面で確認できます。',
     'all', 'onboarding.html', '入社手続きを開く'),

    ('グループウェアの使い方', 'general_affairs',
     'タスク・日報・勤怠・社内文書など、日々の業務はこのグループウェアからまとめて行えます。迷ったときは、まず社内AIに聞いてください。',
     'all', 'home.html', 'ホームを開く'),

    ('振込手数料の扱い', 'accounting',
     '振込手数料は支払手数料として処理します。実際の処理方法は税理士・経理担当にご確認ください。',
     'finance', null, null),

    ('来客対応', 'general_affairs',
     '来客の予定がある場合は、事前に総務へ共有してください。会議室の予約は社内文書の案内を参照してください。',
     'all', 'library.html', '社内文書を見る')
  ) as v(title, category, content, access_scope, link_url, link_label)
 where not exists (
   select 1 from public.gw_ai_knowledge k
    where k.tenant_id = t.id and k.title = v.title
 );

notify pgrst, 'reload schema';

-- 確認:
--   select tenant_id, title, category, access_scope, is_active
--     from public.gw_ai_knowledge
--    order by tenant_id, category, title;
