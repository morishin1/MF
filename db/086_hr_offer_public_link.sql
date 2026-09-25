-- =============================================================================
-- 086: 採用HR Stage 6 — 候補者向け公開URL・送付・閲覧確認
--
-- gw_hr_offers（合格通知・版管理）はdb/081で作成済み。token_hash・expires_at・
-- revoked_at・sent_at・viewed_at・accepted_at・declined_atなど、公開URLに要る
-- 列はすべて揃っている。ここでは対応ステータス（gw_hr_applicants.status）へ
--
--   offer_sent          本人送付済み（未閲覧）
--   offer_viewed         本人が閲覧済み
--   offer_resend_pending  URL再発行ずみ・再送が必要
--
-- の3つを増やすだけ（stageは増やさない。stage=offerのまま）。
--
-- ■ 1 offer version = 1 公開token（README Stage 6 §5）
--   本人へ一度も送っていないtoken（sent_atが空）の再発行は、同じ行のtokenを
--   差し替えるだけでよい。本人へ送付済みのtokenを差し替えるときは、
--   db/081の設計どおり新しい行（version+1）を足し、古い行はrevoked_atで
--   無効化する（api/hr/offers/index.js の issueLink アクションが行う）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_status_check;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_status_check
  check (status in (
    'todo',                       -- 未対応
    'scheduling',                 -- 日程調整中
    'interview_scheduled',        -- 面談予定
    'eval_pending',                -- 評価入力待ち
    'ceo_recommend_pending',       -- 社長推薦待ち
    'ceo_interview_pending',       -- 社長面談設定待ち
    'ceo_decision_pending',        -- 社長判断待ち
    'next_scheduling_pending',     -- 次回調整待ち
    'offer_draft_pending',         -- 合格通知作成待ち
    'offer_review_pending',        -- 社内確認待ち
    'offer_send_pending',          -- 本人送付待ち
    'offer_sent',                  -- 本人送付済み（Stage 6）
    'offer_viewed',                -- 本人が閲覧済み（Stage 6）
    'offer_resend_pending',        -- URL再送待ち（Stage 6）
    'offer_response_pending',      -- 承諾待ち
    'accepted',                    -- 承諾済み
    'declined',                    -- 辞退
    'done',                        -- 完了
    'passed'                       -- 見送り
  ));

comment on column public.gw_hr_applicants.status is
  '対応ステータス（いま誰が何をすべきか）。選考ステージ（stage）とは別軸。'
  'offer_sent / offer_viewed / offer_resend_pending はStage 6（候補者向け公開URL）で追加';

notify pgrst, 'reload schema';

-- 確認:
--   select name, stage, status, decision from public.gw_hr_applicants
--   where status in ('offer_send_pending','offer_sent','offer_viewed','offer_resend_pending')
--   order by updated_at desc;
