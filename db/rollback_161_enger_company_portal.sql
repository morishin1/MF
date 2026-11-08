-- db/161_enger_company_portal.sql を戻す。
--
-- ■ 先にアプリを戻す
--   1. MF（Sales）と enger-lp（enger.jp/business）の該当 PR を戻してから流す。
--      アプリが残ったまま表を消すと、企業詳細の「企業ポータル」「商談準備」タブと
--      企業ポータルの「保存」が「db/161 の実行を依頼してください」になる（壊れはしない）。
--
-- ■ 消えるもの
--   企業ポータルの利用者・招待・保存・商談準備の紐づけ・記録。
--   Auth のアカウント（auth.users）は消えない。enger.companies / enger.candidates も変わらない。
--   有効な登録済みの利用者がいるときは止まる（残す判断を先にする）。
--   それでも戻すときは、下の do ブロックを消してから流す（データが消える）。
--
-- 実行方法: 共有 Supabase の SQL Editor で Run。

begin;

do $$
begin
  if to_regclass('enger.dx2_company_portal_members') is not null
     and exists (select 1 from enger.dx2_company_portal_members where auth_user_id is not null and disabled_at is null) then
    raise exception '登録済みで有効な企業ポータル利用者がいます。先に停止するか、残す判断をしてください（この SQL は何も変えていません）';
  end if;
end $$;

drop table if exists enger.dx2_company_portal_saved_talents;
drop table if exists enger.dx2_company_portal_invites;
drop table if exists enger.dx2_company_talent_links;
drop table if exists enger.dx2_company_portal_events;
drop table if exists enger.dx2_company_portal_members;
drop function if exists enger.dx2_company_portal_saved_guard();
drop function if exists enger.dx2_company_portal_events_append_only();

commit;
