-- =============================================================================
-- db/135（応募書類にスキルシートの種類を足す）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は1つの表「# / 項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ️ … 参考（判定なし）
-- 1〜3 がすべて ✅。4 は「他の CHECK を巻き込んでいないこと」の確認用の一覧、5 は既存の書類の件数。
-- db/135 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ。
--
-- 「doc_type の CHECK」＝ gw_hr_documents の CHECK のうち、見ている列が doc_type 1つだけのもの
-- （許している値は、制約の定義にある文字列から数える。db/135 と同じ見つけ方）。
-- =============================================================================

with
col as (
  select a.attnum
    from pg_attribute a
   where a.attrelid = to_regclass('public.gw_hr_documents')
     and a.attname = 'doc_type'
     and not a.attisdropped
),
chk as (
  select con.conname,
         pg_get_constraintdef(con.oid) as def,
         coalesce(con.conkey = array[(select attnum from col)], false) as doc_type_only,
         (select coalesce(array_agg(distinct m[1]), '{}'::text[])
            from regexp_matches(pg_get_constraintdef(con.oid), '''([^'']+)''', 'g') as t(m)) as lits
    from pg_constraint con
   where con.conrelid = to_regclass('public.gw_hr_documents')
     and con.contype = 'c'
),
kind as (
  select conname, def, doc_type_only,
         (doc_type_only and lits @> array['resume','work_history','skill_sheet','other']
                        and lits <@ array['resume','work_history','skill_sheet','other']) as is4,
         (doc_type_only and lits @> array['resume','work_history','other']
                        and lits <@ array['resume','work_history','other'])               as is3
    from chk
)
select * from (
  select 1 as n, 'gw_hr_documents がある' as 項目,
         case when to_regclass('public.gw_hr_documents') is not null then '✅' else '❌' end as 状態,
         coalesce(to_regclass('public.gw_hr_documents')::text, 'なし') as 詳細
  union all
  select 2, 'doc_type の CHECK（doc_type だけを見る）が4種類（resume・work_history・skill_sheet・other）をちょうど1つ許している',
         case when (select count(*) from kind where is4) = 1 then '✅' else '❌' end,
         coalesce((select string_agg(conname || ' : ' || def, ' / ') from kind where is4), '4種類の CHECK なし（db/135 が未適用）')
  union all
  select 3, '古い3種類（resume・work_history・other だけ）の CHECK が残っていない',
         case when to_regclass('public.gw_hr_documents') is not null and (select count(*) from kind where is3) = 0 then '✅' else '❌' end,
         case when to_regclass('public.gw_hr_documents') is null then '表なし（未適用）'
              else coalesce((select string_agg(conname || ' : ' || def, ' / ') from kind where is3), '残っていない') end
  union all
  -- 4：参考。上の判定に当てはまらない CHECK（他の列・複数の列を見るもの、将来足された別の doc_type 関連）。db/135 は触らない
  select 4, '参考：db/135 が触らない CHECK（上の2・3以外）', 'ℹ️',
         coalesce((select string_agg(conname || ' : ' || def, ' / ' order by conname) from kind where not is3 and not is4), 'なし')
  union all
  -- 5：既存の書類の件数（種類ごと）。広げる前後で変わらないこと
  select 5, '書類の件数（種類ごと。広げても減らない）', 'ℹ️',
         case when to_regclass('public.gw_hr_documents') is null then '表なし（未適用）'
              else coalesce((xpath('/row/c/text()', query_to_xml(
                     'select coalesce(string_agg(doc_type || '': '' || n, '', '' order by doc_type), ''0件'') as c from (select doc_type, count(*) as n from public.gw_hr_documents group by doc_type) t',
                     false, true, '')))[1]::text, '0件') end
) r
order by n;
