-- 【提案・未適用】db/proposal_marketing.sql の戻し。
-- 消えるもの：既読・制作予定・動画の掲載記録（この3つの表と見張りだけ）。
-- 消えないもの：問い合わせ・応募者・自社サイトのお知らせ等の原本（ここには写していないので影響しない）。
-- 制作予定を残したいときは、流す前に CSV で控える：
--   select * from public.gw_marketing_items;  select * from public.gw_marketing_video_placements;
begin;
drop table if exists public.gw_marketing_video_placements;
drop table if exists public.gw_marketing_items;
drop table if exists public.gw_marketing_reads;
drop function if exists public.gw_marketing_video_placements_guard();
drop function if exists public.gw_marketing_items_guard();
notify pgrst, 'reload schema';
commit;
