-- =============================================================================
-- 022_ga4.sql — Google アナリティクス（GA4）を数字の出どころに加える
--
-- 前提: db/021_web_analytics.sql が適用済みであること。
--
-- なぜ足すか
--   021 では自前の計測タグで数えていた。確実に動くが、分かるのは
--   PV・訪問者・参照元・ページまで。GA4 を入れると、同じ「1行貼る」手間で
--   デバイス・地域・滞在といったところまで見られるようになり、
--   しかも Data API は公式で安定している（Vercel の Web Analytics と違う点）。
--
--   計測タグは残す。GA4 をまだ入れていないサイトはそちらで数え続ける。
--   1つのサイトで両方が動いていても二重に足さないよう、
--   集計側で「そのサイトの主な出どころ」を1つ選んで合計する（api/analytics）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) サイトごとの GA4 の設定
--    property_id    … Data API で数字を引くときの宛先（数字の羅列）
--    measurement_id … サイトに貼るタグに書く方（G- で始まる）
--    別物なので両方持つ。管理画面ではどちらも貼り付けで入れられるようにする。
-- -----------------------------------------------------------------------------
alter table public.gw_web_projects
  add column if not exists ga4_property_id text;
alter table public.gw_web_projects
  add column if not exists ga4_measurement_id text;

create index if not exists idx_gw_web_projects_ga4
  on public.gw_web_projects(ga4_property_id) where ga4_property_id is not null;


-- -----------------------------------------------------------------------------
-- 2) 出どころに 'ga4' を足す
--    021 で置いた CHECK に無いままだと、GA4 の行を入れた時点で失敗する。
-- -----------------------------------------------------------------------------
do $$
begin
  alter table public.gw_web_daily     drop constraint if exists gw_web_daily_source_check;
  alter table public.gw_web_daily     add constraint gw_web_daily_source_check
    check (source in ('beacon','vercel','ga4'));

  alter table public.gw_web_referrers drop constraint if exists gw_web_referrers_source_check;
  alter table public.gw_web_referrers add constraint gw_web_referrers_source_check
    check (source in ('beacon','vercel','ga4'));

  alter table public.gw_web_pages     drop constraint if exists gw_web_pages_source_check;
  alter table public.gw_web_pages     add constraint gw_web_pages_source_check
    check (source in ('beacon','vercel','ga4'));
end $$;
