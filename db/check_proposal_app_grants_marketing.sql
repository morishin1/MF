-- 読むだけ：db/proposal_app_grants_marketing.sql の状態を確かめる（何も書き換えない）
--   ① app_key の制約（流す前は hr/sales/office、流したあとは marketing を含む）
--   ② marketing を付けた人数（流した直後は 0。自動では付けない）
--   ③ アプリごとの人数（流す前後で hr/sales/office は変わらない）
select '① app_key の制約' as "確認", con.conname as "名前", pg_get_constraintdef(con.oid) as "中身"
  from pg_constraint con
 where con.conrelid = 'public.gw_app_grants'::regclass and con.contype = 'c';

select '② marketing を付けた人数（直後は 0）' as "確認", count(*) as "件数"
  from public.gw_app_grants where app_key = 'marketing';

select '③ アプリごとの人数' as "確認", app_key, count(*) as "件数"
  from public.gw_app_grants group by app_key order by app_key;
