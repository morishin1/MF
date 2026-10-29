-- PROPOSAL ONLY. proposal_marketing_pr_images.sql を取り消すときだけ、明示の承認のうえで流す。
-- 画像の記録・原本が1件でもあれば止める（消さずに運用責任者へ確認）。
-- 非公開の保存先（bucket marketing-pr-images）と、直接アクセスを止める policy はここでは消さない。
--   空であることを確かめてから、Supabase の管理画面（Storage）で bucket を消し、そのあとで
--   drop policy if exists marketing_pr_images_no_direct on storage.objects; を流す
--   （先に policy を消すと、ほかの広い policy があった場合に原本が見えてしまうため、順番を逆にしない）
begin;
do $$ begin
 if exists(select 1 from public.gw_marketing_pr_images limit 1)
 or exists(select 1 from storage.objects where bucket_id='marketing-pr-images' limit 1) then
  raise exception '画像の記録・原本が存在します。削除せず運用責任者へ確認してください';
 end if;
end $$;
drop function if exists public.gw_marketing_pr_image_finish(uuid,uuid,uuid,integer,uuid,integer,text);
drop function if exists public.gw_marketing_pr_image_reserve(uuid,uuid,uuid,integer,uuid,text,text,integer);
drop table if exists public.gw_marketing_pr_images;
commit;
