-- db/121_retire_docs.sql のやり直し。表ごと消えます（行があれば、その行も消えます。先に控えてください）。
-- 退職書類の実体（private バケット hr の retire/ 配下）は、この SQL では消えません。
begin;
drop table if exists public.gw_retire_docs;
drop table if exists public.gw_retire_cases;
notify pgrst, 'reload schema';
commit;
