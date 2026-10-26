-- 148: HR採用メールの一括レビュー・削除（復元可）・スポット人材連携
-- 147適用済み環境に追加。個人情報を上書き・物理削除しない。
begin;
do $$
begin
 if to_regclass('public.gw_hr_inbound_mail') is null
   or to_regclass('public.gw_hr_spot_talents') is null then
  raise exception 'HR受信台帳147とスポット台帳145を先に適用してください';
 end if;
end $$;
alter table public.gw_hr_inbound_mail
  add column if not exists deleted_at timestamptz,
  add column if not exists spot_talent_id uuid references public.gw_hr_spot_talents(id) on delete restrict;
alter table public.gw_hr_inbound_mail drop constraint if exists gw_hr_inbound_mail_link_guard;
alter table public.gw_hr_inbound_mail
  add constraint gw_hr_inbound_mail_link_guard
  check ((status='linked')=(num_nonnulls(applicant_id,spot_talent_id)=1));
create index if not exists gw_hr_inbound_mail_spot_idx on public.gw_hr_inbound_mail(tenant_id,spot_talent_id);

-- API側で認証・採用権限を確認し、service_roleからだけ呼ぶ。
-- ひとつでも古い行・対象外の状態・重複IDがあれば一括全体を巻き戻す。
create or replace function public.gw_hr_inbox_bulk_apply(
 p_tenant uuid,p_items jsonb,p_action text,p_reason text,p_actor uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare
 item jsonb;
 row_data public.gw_hr_inbound_mail;
 affected integer:=0;
 total integer;
 note_text text:=left(btrim(coalesce(p_reason,'')),1000);
begin
 if auth.role() is distinct from 'service_role' then
   raise exception 'forbidden' using errcode='42501';
 end if;
 if p_tenant is null or p_actor is null or
    jsonb_typeof(p_items) is distinct from 'array'
    or p_action not in ('review','ignored','new','archive','restore') then
   raise exception 'invalid_bulk_request';
 end if;
 total:=jsonb_array_length(p_items);
 if total<1 or total>50 then raise exception 'invalid_bulk_count'; end if;
 if total<>(select count(distinct e->>'id') from jsonb_array_elements(p_items) e)
   or exists(select 1 from jsonb_array_elements(p_items) e
       where nullif(e->>'id','') is null or nullif(e->>'updatedAt','') is null) then
   raise exception 'invalid_bulk_items';
 end if;
 if p_action in ('ignored','archive') and note_text='' then
   raise exception 'reason_required';
 end if;
 -- 行を確定的な順番で取得して並行担当者の競合・デッドロックを防止
 for item in select value from jsonb_array_elements(p_items)
             order by value->>'id' loop
   select * into row_data from public.gw_hr_inbound_mail
    where id=(item->>'id')::uuid and tenant_id=p_tenant for update;
   if not found then raise exception 'stale_record'; end if;
   if row_data.updated_at is distinct from (item->>'updatedAt')::timestamptz then
     raise exception 'stale_record';
   end if;
   if row_data.status='linked' then raise exception 'linked_record_protected'; end if;
   if p_action='restore' then
     if row_data.deleted_at is null then raise exception 'not_archived'; end if;
     update public.gw_hr_inbound_mail set deleted_at=null,status='ignored',
       review_note=coalesce(nullif(note_text,''),review_note),
       reviewed_by=p_actor,reviewed_at=now(),updated_at=now()
       where id=row_data.id;
   elsif p_action='archive' then
     if row_data.deleted_at is not null then raise exception 'already_archived'; end if;
     update public.gw_hr_inbound_mail set deleted_at=now(),status='ignored',
       review_note=note_text,reviewed_by=p_actor,reviewed_at=now(),updated_at=now()
       where id=row_data.id;
   else
     if row_data.deleted_at is not null then raise exception 'archived_record'; end if;
     update public.gw_hr_inbound_mail set
       status=p_action,
       review_note=case when p_action='ignored' then note_text
         when note_text<>'' then note_text else review_note end,
       reviewed_by=p_actor,reviewed_at=now(),updated_at=now()
       where id=row_data.id;
   end if;
   affected:=affected+1;
 end loop;
 return affected;
end $$;
revoke all on function public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.gw_hr_inbox_bulk_apply(uuid,jsonb,text,text,uuid)
 to service_role;
notify pgrst,'reload schema';
commit;
