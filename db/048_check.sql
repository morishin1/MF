-- =============================================================================
-- 048 が入っているかを確かめて、PostgREST のキャッシュを作り直す
--
-- 「Could not find the table 'public.gw_time_entries' in the schema cache」は
-- 2つのどちらかです。
--
--   A. 表がまだ無い          … 048 が流れていない／途中で失敗した
--   B. 表はあるが、API が知らない … PostgREST が持っている表の一覧が古い
--
-- どちらかを下の 1) で見分けてから、2) を実行してください。
--
-- Supabase の SQL Editor に貼って Run するだけ（読むのと、再読み込みだけ）
-- =============================================================================

-- 1) 表があるか
select
  case when to_regclass('public.gw_time_entries') is null
       then '✗ gw_time_entries がありません → 048_timecard.sql を流してください'
       else '✓ gw_time_entries はあります' end as 打刻の表,
  case when to_regclass('public.gw_time_fixes') is null
       then '✗ gw_time_fixes がありません → 048_timecard.sql を流してください'
       else '✓ gw_time_fixes はあります' end as 修正申請の表;

-- 2) API が見ている表の一覧を作り直す。
--    表があるのにエラーが出るときは、これで直ります。
--    反映まで数秒かかることがあります
notify pgrst, 'reload schema';

-- 3) 参考：表があるなら、列がそろっているかも見ておく
select column_name as 列, data_type as 型
  from information_schema.columns
 where table_schema = 'public' and table_name = 'gw_time_entries'
 order by ordinal_position;
