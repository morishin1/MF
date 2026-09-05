-- =============================================================================
-- 027: 週次の100点評価と、月次の成長確認（AI日報評価API 要件 Phase 3・4）
--
-- ■ 日次・週次・月次の役割を分ける
--   日次 … 行動改善。良かった点・改善点・明日のポイント（点数は出さない）
--   週次 … 評価。会社評価基準10項目 × 各10点 = 100点
--   月次 … 成長確認。週次の集計と、前月との比較
--
-- ■ AIの点と、管理者の点を分けて持つ
--   AI評価を最終評価にしない。
--   ai_scores  … AIが出した点（消さない。基準を見直すときの材料になる）
--   eval_scores … 管理者が確定した点（本人に見えるのはこちら）
--   本人に見えるのは submitted_at が入ってから。
--   下書きのまま見えると「評価が下がった」と誤解される。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 週次（tc_weekly_review に足す）
--    表そのものは 8/timecard/nippo-setup.sql が作っている。
--    1人1週1件（unique(user_id, week_start)）なので、行は増やさず列を足す。
-- -----------------------------------------------------------------------------
alter table public.tc_weekly_review add column if not exists ai_scores      jsonb;
alter table public.tc_weekly_review add column if not exists ai_total       integer;
alter table public.tc_weekly_review add column if not exists ai_strengths   jsonb;   -- 強み 最大3件
alter table public.tc_weekly_review add column if not exists ai_improvements jsonb;  -- 改善項目 最大3件
alter table public.tc_weekly_review add column if not exists ai_focus       jsonb;   -- 次週の重点行動 最大2件
alter table public.tc_weekly_review add column if not exists ai_summary     text;
alter table public.tc_weekly_review add column if not exists ai_model       text;
alter table public.tc_weekly_review add column if not exists ai_prompt_version text;
alter table public.tc_weekly_review add column if not exists ai_status      text;    -- pending/processing/completed/failed
alter table public.tc_weekly_review add column if not exists ai_error       text;
alter table public.tc_weekly_review add column if not exists ai_metrics     jsonb;   -- 提出率・KGI達成率など計算値
alter table public.tc_weekly_review add column if not exists ai_generated_at timestamptz;
alter table public.tc_weekly_review add column if not exists decided_by     uuid references auth.users(id) on delete set null;

comment on column public.tc_weekly_review.ai_scores is
  'AIが出した10項目の点。管理者が直しても、これは消さない';
comment on column public.tc_weekly_review.eval_scores is
  '管理者が確定した10項目の点。本人に見えるのは submitted_at が入ってから';


-- -----------------------------------------------------------------------------
-- 2) 月次
--    週次を集計すれば数字は出るが、AIの総括と管理者コメントは残す場所が要る。
--    1人1月1件。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_monthly (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- auth.users.id（tc_nippo.user_id と同じ）
  month      date not null,                 -- その月の1日
  user_name  text,

  -- 計算で出す値。AIには「計算済み」として渡す
  metrics    jsonb,                         -- 平均点・前月比・提出率・KGI達成率・項目別平均

  ai_status      text default 'pending'
                 check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_summary     text,
  ai_strengths   jsonb,                     -- 強み TOP3
  ai_improvements jsonb,                    -- 改善 TOP3
  ai_model       text,
  ai_prompt_version text,
  ai_error       text,
  ai_generated_at timestamptz,

  manager_comment text,
  decided_by      uuid references auth.users(id) on delete set null,
  -- 本人へ出した時刻。入るまでは本人の画面に出さない
  submitted_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month)
);

create index if not exists idx_gw_nippo_monthly_user
  on public.gw_nippo_monthly(user_id, month desc);

comment on table public.gw_nippo_monthly is
  '月次の成長確認。週次の集計＋AI総括＋管理者コメント。1人1月1件';


-- -----------------------------------------------------------------------------
-- 3) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--    書き込みは service_role の API だけなので、insert/update のポリシーは置かない。
--    （gw_is_internal_staff は 026 で作っている）
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_monthly enable row level security;

drop policy if exists gw_nippo_monthly_select on public.gw_nippo_monthly;
create policy gw_nippo_monthly_select on public.gw_nippo_monthly
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select week_start, user_name, ai_total, eval_total, submitted_at
--     from public.tc_weekly_review order by week_start desc limit 20;
--   select month, user_name, ai_status, metrics->>'avgScore'
--     from public.gw_nippo_monthly order by month desc limit 20;
