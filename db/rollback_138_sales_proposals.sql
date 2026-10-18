-- =============================================================================
-- db/138_sales_proposals.sql のやり直し（/sales 提案管理を外す）
--
-- ■ 先にやること
--   1. アプリを 138 より前の版へ戻す（/sales/proposals.html・/api/sales/proposals/* が無い版）。
--      アプリが新しいまま表を消すと、提案管理の画面が「この機能に必要なテーブルがまだ作られていません」になる
--   2. dx.enger 側の連携を止める（dx.enger の Vercel から GW_SALES_SECRET を消す）。止めないと、届いた提案が 503 not_ready になる
--      （dx.enger は 503 を控え enger.dx2_gw_sales_outbox に残して送り直すので、表を作り直せば後から入る）
--
-- ■ 消えるもの
--   提案・行動の記録・タスク・設定・連携の記録・企業の紐付け（この6つの表の中身すべて）。
--   既存の表（gw_sales_companies・gw_sales_events など）には触らない。
--   提案から企業の履歴（gw_sales_events）に写した出来事は残る（企業の連絡履歴として正しいため）。
-- =============================================================================
begin;

drop table if exists public.gw_sales_company_links;
drop table if exists public.gw_sales_proposal_sync_log;
drop table if exists public.gw_sales_proposal_settings;
drop table if exists public.gw_sales_proposal_tasks;
drop table if exists public.gw_sales_proposal_activities;
drop table if exists public.gw_sales_proposals;

drop function if exists public.gw_sales_proposal_child_guard();
drop function if exists public.gw_sales_proposals_guard();
drop function if exists public.gw_sales_proposal_visible_id(uuid);
drop function if exists public.gw_sales_proposal_visible(uuid, uuid);
drop function if exists public.gw_sales_employee_ok(uuid, uuid);
drop function if exists public.gw_sales_is_manager(uuid);

commit;

notify pgrst, 'reload schema';
