-- スポット人材テーブルの安全なロールバック（本番は明示承認後）
-- 登録済みの人材を削除しない。行が1件でもある場合は中断する。
begin;
do $$
begin
  if exists(select 1 from public.gw_hr_spot_talents limit 1) then
    raise exception 'スポット人材の記録があります。データ移行なしではロールバック不可';
  end if;
end $$;
drop table if exists public.gw_hr_spot_talents;
notify pgrst, 'reload schema';
commit;
