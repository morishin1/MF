-- db/136 rollback
-- 面談との紐付けと資料マスタを削除する。PDF実体（storage bucket hr / <tenant>/materials/...）は
-- DB rollback では自動削除しないため、必要なら対象パスを確認してStorage側で別途削除する。
begin;
drop table if exists public.gw_hr_interview_materials;
drop table if exists public.gw_hr_materials;
notify pgrst, 'reload schema';
commit;
