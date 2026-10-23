-- 2026-10-23：休暇・稟議の二段階承認をDBでも守る。
--
-- 019_requests.sql の gw_requests_update は「Office管理権限ならUPDATE可能」だった。
-- これではAPIで owner を要求しても、直接Supabase RESTを呼び status='approved'
-- に変更できる。状態・承認者・承認日時の変更は /api/requests/decide
-- (server側 service_role、権限チェック・状態遷移チェック付き) のみに限定する。
--
-- 同じAPIを通る本人取下げ、Office一次承認、KEIEI最終承認、Google再同期はそのまま。
-- INSERT は本人、SELECT は本人と承認者、DELETE は従来の管理者ポリシーを保持。
--
-- 適用: Supabase SQL Editor。一度だけ（再適用も可能）。
-- 注意: db/019_requests.sql を後から再実行すると古いUPDATEポリシーに戻るため、
-- 必ずその後にこのファイルを適用する。

begin;

alter table public.gw_requests enable row level security;

drop policy if exists gw_requests_update on public.gw_requests;
create policy gw_requests_update on public.gw_requests
  for update
  using (false)
  with check (false);

commit;
