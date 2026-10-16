-- db/137 採用HR 完成仕上げ 確認（読み取りのみ）
select * from (
  select 1 n, 'オファー通知PDFの3列がある' 項目,
    case when (select count(*) from information_schema.columns
      where table_schema='public' and table_name='gw_hr_offers'
        and column_name in ('offer_title','offer_pdf_path','offer_pdf_sha256')) = 3 then '✅' else '❌' end 状態,
    (select count(*)::text || ' / 3 列' from information_schema.columns
      where table_schema='public' and table_name='gw_hr_offers'
        and column_name in ('offer_title','offer_pdf_path','offer_pdf_sha256')) 詳細
  union all
  select 2, 'オファー通知PDFのSHA制約',
    case when exists(select 1 from pg_constraint where conname='gw_hr_offers_offer_pdf_sha_chk') then '✅' else '❌' end,
    coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname='gw_hr_offers_offer_pdf_sha_chk'),'なし')
  union all
  select 3, '応募者statusに position_closed（募集終了）がある',
    case when exists (
      select 1 from pg_constraint c
      where c.conrelid='public.gw_hr_applicants'::regclass
        and c.conname='gw_hr_applicants_status_check'
        and pg_get_constraintdef(c.oid) like '%position_closed%'
    ) then '✅' else '❌' end,
    coalesce((select pg_get_constraintdef(oid) from pg_constraint
      where conname='gw_hr_applicants_status_check' and conrelid='public.gw_hr_applicants'::regclass),'なし')
  union all
  select 4, '参考：スキルシート（db/135）が使える',
    case when exists (
      select 1 from pg_constraint c
      where c.conrelid='public.gw_hr_documents'::regclass
        and c.contype='c' and pg_get_constraintdef(c.oid) like '%skill_sheet%'
    ) then '✅' else '❌' end,
    case when to_regclass('public.gw_hr_documents') is null then 'gw_hr_documents なし'
      else 'db/135_hr_document_skill_sheet.sql の適用状態を確認' end
  union all
  select 5, '参考：募集終了の人数', 'ℹ️',
    case when to_regclass('public.gw_hr_applicants') is null then '表なし'
      else (select count(*)::text || ' 人' from public.gw_hr_applicants where status='position_closed') end
) x order by n;
