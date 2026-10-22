-- EIGHT秘書 Slack 窓口（db/147）の安全なロールバック（本番は明示承認後）
-- 質問・承認・送信の記録を消さない。処理待ち・承認待ち・確認待ちの行が1件でもある場合は中断する。
-- 先にアプリ側を止める（Vercel の Cron /api/cron/eight-secretary と Slack App のイベント購読を停止）。
-- Slack ID ↔ GW 社員の紐付け（gw_slack_ai_users）も消える。必要なら事前に紐付け一覧を控える（値をGitHubに貼らない）。
begin;
do $$
begin
  if to_regclass('public.gw_slack_ai_escalations') is not null
     and exists(select 1 from public.gw_slack_ai_escalations limit 1) then
    raise exception 'Slack窓口の質問・承認記録があります。記録の保全・移行なしではロールバック不可';
  end if;
  if to_regclass('public.gw_slack_ai_events') is not null
     and exists(select 1 from public.gw_slack_ai_events where state in ('queued', 'processing', 'failed')) then
    raise exception '未処理・処理中・失敗のSlackイベントがあります。確認してからロールバックしてください';
  end if;
end $$;
drop table if exists public.gw_slack_ai_escalations;
drop table if exists public.gw_slack_ai_events;
drop table if exists public.gw_slack_ai_users;
notify pgrst, 'reload schema';
commit;
