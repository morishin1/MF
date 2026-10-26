-- 148の取り消し：検証環境向け。既存の削除/スポット紐づけが1件でもあれば拒否。
begin;
do $$
begin
 if to_regclass('public.gw_hr_inbound_mail') is null then
   raise exception 'HR新着受付の台帳が見つかりません';
 end if;
 if exists(
   select 1 from public.gw_hr_inbound_mail
   where deleted_at is not null or spot_talent_id is not null
 ) then
   raise exception '削除済みまたはスポット紐づけ済みの受信記録があるため取り消せません';
 end if;
end $$;
drop function if exists public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid);
alter table public.gw_hr_inbound_mail drop constraint if exists gw_hr_inbound_mail_link_guard;
alter table public.gw_hr_inbound_mail
  add constraint gw_hr_inbound_mail_link_guard
  check ((status='linked')=(applicant_id is not null));
drop index if exists public.gw_hr_inbound_mail_spot_idx;
alter table public.gw_hr_inbound_mail
  drop column if exists spot_talent_id,
  drop column if exists deleted_at;
notify pgrst,'reload schema';
commit;
