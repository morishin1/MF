-- db/131_sales_ai.sql のやり直し（AI営業の表・関数・列を消す）。
-- ⚠ AI営業の分析・営業文・利用量の記録は消える。既存の Sales（企業・アタック・商談・案件）には触らない。
begin;

alter table public.gw_sales_approaches drop column if exists ai_draft_id;
drop function if exists public.gw_sales_ai_reserve(uuid, numeric, text, text, uuid, uuid);
drop function if exists public.gw_sales_ai_settle(uuid, int, int, numeric, text, text, int);
drop table if exists public.gw_sales_ai_usage;
drop table if exists public.gw_sales_ai_drafts;
drop function if exists public.gw_sales_ai_drafts_guard();
drop table if exists public.gw_sales_ai_analyses;
drop table if exists public.gw_sales_ai_settings;

commit;
