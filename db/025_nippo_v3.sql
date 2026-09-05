-- =============================================================================
-- 025: 日報を6項目に作り直す（要件定義書 Phase 1）
--
-- ねらい
--   日報の目的を「記録すること」から「毎日書くうちに会社の仕事の進め方が
--   身につくこと」に変える。入力は3〜5分。
--
--   ① 今日のKGI（目標数値・実績数値・達成/未達）
--   ② 今日やったこと・成果（やったこと｜結果・成果 の行）
--   ③ 困ったこと・報告相談（問題／自分でやったこと／相談相手／次の行動）
--   ④ 今日の改善・学び（選択式＋一言）
--   ⑤ 顧客・チームのためにしたこと
--   ⑥ 明日の最優先（何を／いつまで／完了条件）
--
-- ★ 列は1つも消さない
--   tc_nippo には1年以上ぶんの日報が入っている。列を消すと過去が読めなくなる。
--   意味の同じものは使い回し、足りないものだけ足す。
--
--   ① 今日のKGI（文）        → goal_today（既存「今日の目標」）
--   ④ 改善・学びの一言       → challenge（既存「今日の挑戦・改善」）
--   ⑤ 顧客・チーム           → contribution（既存「顧客・会社への貢献」）
--   ⑥ 明日やること           → tomorrow_plan（既存）
--
--   使わなくなった列（purpose / handoff / stuck / funnel / miss_reason /
--   small_win / kpis / team_kgi など）はそのまま残す。過去の日報の表示に要る。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ① 今日のKGI の数値と結果
--    文そのものは goal_today を使う。ここは数字と達成/未達だけ
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists kgi_target  numeric;  -- 目標数値
alter table public.tc_nippo add column if not exists kgi_actual  numeric;  -- 実績数値
-- true=達成 / false=未達 / null=数値で測らない業務
alter table public.tc_nippo add column if not exists kgi_achieved boolean;

-- -----------------------------------------------------------------------------
-- ② 今日やったこと・成果
--    [{"task":"A社提案書を作成","result":"提案書を完成し送付"}, …]
--    「作業しました」で終わらせないために、result を必須にしている（画面側）
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists work_items jsonb;

-- -----------------------------------------------------------------------------
-- ③ 困ったこと・報告相談
--    [{"issue":"…","action_taken":"…","consulted":"…","next_action":"…"}, …]
--    問題だけ書いて終わらせないために、next_action を必須にしている（画面側）。
--    no_issues は「特になし」を選んだ状態。空欄と区別する
--    （書き忘れなのか、本当に無かったのかが分かるようにする）
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists issues    jsonb;
alter table public.tc_nippo add column if not exists no_issues boolean not null default false;

-- -----------------------------------------------------------------------------
-- ④ 今日の改善・学び
--    選んだ種類。["self_research","new_method","feedback","process","ai_tool","other"]
--    一言は challenge（既存）に入れる
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists improve_tags jsonb;

-- -----------------------------------------------------------------------------
-- ⑥ 明日の最優先
--    何をするかは tomorrow_plan（既存）。期限と完了条件をここに足す
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists tomorrow_deadline text;
alter table public.tc_nippo add column if not exists tomorrow_target   text;

-- -----------------------------------------------------------------------------
-- 日次の行動確認（○ / △ / ―）
--   会社評価基準10項目のうち、その日の日報から「確認できた行動」を残す。
--
--   ★ これは人事評価の点数ではない。
--     本人に毎日10項目を自己採点させると、点を取りにいく書き方になる。
--     書いた内容から機械的に拾い、行動を意識してもらうためだけに出す。
--     週次の点数はこれとは別に、管理者が付ける。
--
--   {"quantity":"o","report_consult":"d","action":"o", …}
--     o = 確認できた / d = 一部確認できた / -（または欠落）= 材料なし
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists daily_flags jsonb;

comment on column public.tc_nippo.daily_flags is
  '日報の内容から機械的に拾った「今日確認できた行動」。人事評価点ではない';

-- -----------------------------------------------------------------------------
-- 週次評価（Phase 2 の置き場所）
--   tc_weekly_review.eval_scores は既にある jsonb。
--   これまでは6項目×5点だったが、会社評価基準10項目×10点＝100点に切り替える。
--   古い6項目のデータもそのまま残るので、画面側でキーを見て出し分ける。
-- -----------------------------------------------------------------------------
alter table public.tc_weekly_review add column if not exists eval_total integer;

comment on column public.tc_weekly_review.eval_scores is
  '会社評価基準10項目 × 各0〜10点。旧データは6項目 × 5点なのでキーで判別する';

-- PostgREST のスキーマキャッシュを更新（列追加直後の保存失敗を防ぐ）
notify pgrst, 'reload schema';

-- 確認:
--   select work_date, user_name, goal_today, kgi_target, kgi_actual, kgi_achieved,
--          jsonb_array_length(coalesce(work_items,'[]'::jsonb)) as 成果件数,
--          no_issues, daily_flags
--     from public.tc_nippo
--    where work_date >= current_date - 7
--    order by work_date desc, user_name;
