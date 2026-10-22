-- 開発・検証用ロールバック。記録が1件でも存在したら削除しない。
begin;
do $$
begin
  if to_regclass('public.gw_hr_inbound_mail') is not null
    and exists(select 1 from public.gw_hr_inbound_mail limit 1) then
    raise exception '新着受付に登録があるためロールバックを中止しました。';
  end if;
end $$;
drop table if exists public.gw_hr_inbound_mail;
notify pgrst,'reload schema';
commit;
