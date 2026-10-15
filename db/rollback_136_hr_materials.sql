-- db/136 rollback
-- 資料データ・面談との紐付けが消えるため、本番利用後は安易に実行しない。
begin;
drop table if exists public.gw_hr_interview_materials;
drop table if exists public.gw_hr_materials;
notify pgrst, 'reload schema';
commit;
