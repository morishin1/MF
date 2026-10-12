-- =============================================================================
-- db/129（採用HR：面談合格後の採用区分 offer_type / offer_terms）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は1つの表「# / 項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい
-- 1〜6 がすべて ✅、7 は件数（既存の行は区分なし＝null のまま）、8 は ✅ 0件 なら OK。
--
-- db/129 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ
-- （列が無いときは件数を数えない。件数は query_to_xml で「列があるときだけ」数える）。
-- =============================================================================

with
cols as (
  select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'gw_hr_applicants' and column_name = 'offer_type')
       or (table_name = 'gw_hr_offers' and column_name in ('offer_type', 'offer_terms')))
),
cons as (
  select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
   where c.contype = 'c'
     and c.conname in ('gw_hr_applicants_offer_type_chk', 'gw_hr_offers_offer_type_chk', 'gw_hr_offers_offer_terms_obj_chk')
),
has as (
  select exists (select 1 from cols where table_name = 'gw_hr_applicants' and column_name = 'offer_type') as a_type,
         exists (select 1 from cols where table_name = 'gw_hr_offers'     and column_name = 'offer_type') as o_type,
         exists (select 1 from cols where table_name = 'gw_hr_offers'     and column_name = 'offer_terms') as o_terms
),
-- 件数。列が無い環境でもエラーにしないよう、列があるときだけ問い合わせる（CASE の外れた側は実行されない）
cnt as (
  select
    (select count(*) from public.gw_hr_applicants) as a_total,
    (select count(*) from public.gw_hr_offers)     as o_total,
    case when h.a_type then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_applicants where offer_type is null', false, true, '')))[1]::text::bigint end as a_null,
    case when h.o_type then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where offer_type is null', false, true, '')))[1]::text::bigint end as o_null,
    case when h.a_type then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_applicants
        where offer_type is not null
          and offer_type not in (''executive_employee'', ''training'', ''contractor'', ''part_time'', ''spot'')',
      false, true, '')))[1]::text::bigint end as a_bad,
    case when h.o_type then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers
        where offer_type is not null
          and offer_type not in (''executive_employee'', ''training'', ''contractor'', ''part_time'', ''spot'')',
      false, true, '')))[1]::text::bigint end as o_bad,
    case when h.o_terms then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where offer_terms is null or jsonb_typeof(offer_terms) <> ''object''',
      false, true, '')))[1]::text::bigint end as o_terms_bad
  from has h
),
rows(seq, item, ok, detail) as (
  select 1, 'gw_hr_applicants.offer_type がある',
         h.a_type,
         coalesce((select data_type from cols where table_name = 'gw_hr_applicants' and column_name = 'offer_type'), '列がありません')
    from has h
  union all
  select 2, 'gw_hr_offers.offer_type がある',
         h.o_type,
         coalesce((select data_type from cols where table_name = 'gw_hr_offers' and column_name = 'offer_type'), '列がありません')
    from has h
  union all
  select 3, 'gw_hr_offers.offer_terms がある（jsonb・空欄なし・既定値 {}）',
         h.o_terms and exists (select 1 from cols where table_name = 'gw_hr_offers' and column_name = 'offer_terms'
                                 and data_type = 'jsonb' and is_nullable = 'NO'),
         coalesce((select data_type || '・null ' || case is_nullable when 'NO' then '不可' else '可' end
                          || '・既定値 ' || coalesce(column_default, 'なし')
                     from cols where table_name = 'gw_hr_offers' and column_name = 'offer_terms'), '列がありません')
    from has h
  union all
  select 4, '応募者の区分の CHECK 制約（gw_hr_applicants_offer_type_chk）',
         exists (select 1 from cons where conname = 'gw_hr_applicants_offer_type_chk'),
         coalesce((select def from cons where conname = 'gw_hr_applicants_offer_type_chk'), '制約がありません')
  union all
  select 5, 'オファーの区分の CHECK 制約（gw_hr_offers_offer_type_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_offer_type_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_offer_type_chk'), '制約がありません')
  union all
  select 6, 'offer_terms が object の CHECK 制約（gw_hr_offers_offer_terms_obj_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_offer_terms_obj_chk'),
         coalesce((select def from cons where conname = 'gw_hr_offers_offer_terms_obj_chk'), '制約がありません')
  union all
  select 7, '既存データ：区分なし（offer_type が null）の件数',
         h.a_type and h.o_type,
         case when h.a_type and h.o_type
              then '応募者：区分なし ' || c.a_null || '件 / 区分あり ' || (c.a_total - c.a_null) || '件 / 全 ' || c.a_total || '件　'
                || 'オファー：区分なし ' || c.o_null || '件 / 区分あり ' || (c.o_total - c.o_null) || '件 / 全 ' || c.o_total || '件'
              else '列が無いため数えていません（応募者 全 ' || c.a_total || '件 / オファー 全 ' || c.o_total || '件）' end
    from has h, cnt c
  union all
  select 8, '不正な offer_type・object でない offer_terms が 0件',
         h.a_type and h.o_type and h.o_terms and c.a_bad = 0 and c.o_bad = 0 and c.o_terms_bad = 0,
         case when h.a_type and h.o_type and h.o_terms
              then '応募者の不正な区分 ' || c.a_bad || '件 / オファーの不正な区分 ' || c.o_bad || '件 / object でない offer_terms ' || c.o_terms_bad || '件'
              else '列が無いため数えていません' end
    from has h, cnt c
)
select seq as "#", item as 項目, case when ok then '✅' else '❌' end as 状態, detail as 詳細
  from rows
 order by seq;
