-- 【読むだけ】db/proposal_marketing.sql が入っているか・画面から書けないかを表で出す。何も変えない。
select t.name as "表",
       to_regclass('public.' || t.name) is not null as "ある",
       coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || t.name)), false) as "RLS",
       has_table_privilege('authenticated', 'public.' || t.name, 'INSERT') as "画面から追加できる（false が正）",
       has_table_privilege('authenticated', 'public.' || t.name, 'SELECT') as "画面から読める（false が正）"
from (values ('gw_marketing_reads'), ('gw_marketing_items'), ('gw_marketing_video_placements')) t(name)
where to_regclass('public.' || t.name) is not null
union all
select t.name, false, false, false, false
from (values ('gw_marketing_reads'), ('gw_marketing_items'), ('gw_marketing_video_placements')) t(name)
where to_regclass('public.' || t.name) is null;

-- 二重掲載を防ぐ索引があるか
select indexname as "索引", indexdef as "定義"
from pg_indexes
where schemaname = 'public' and indexname in ('gw_marketing_video_placements_live', 'gw_marketing_items_source');
