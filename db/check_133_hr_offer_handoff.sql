-- =============================================================================
-- db/133（採用HR：正式契約の要否・承諾を確認して Office へ引き渡す）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は1つの表「# / 項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい
-- 1〜11 がすべて ✅、12 は件数、13 は ✅ 0件 なら OK。
--
-- db/133 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ
-- （列が無いときは件数を数えない。件数は query_to_xml で「列があるときだけ」数える）。
-- psql 専用のコマンド（\set など）は使っていない。
-- =============================================================================

with
want(column_name, data_type) as (
  values ('formal_contract_required', 'boolean'), ('handoff_at', 'timestamp with time zone'), ('handoff_by', 'uuid')
),
cols as (
  select c.column_name, c.data_type
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'gw_hr_offers'
     and c.column_name in (select column_name from want)
),
cons as (
  select c.conname, c.contype, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid and t.relname = 'gw_hr_offers'
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
),
fk as (
  -- handoff_by → auth.users（削除は restrict。引き渡しの記録を消さない）
  select c.conname, c.confdeltype
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid and t.relname = 'gw_hr_offers'
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey) and a.attname = 'handoff_by'
   where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
),
trg as (
  select t.tgname, t.tgenabled, p.proname,
         (t.tgtype & 2) <> 0 as before, (t.tgtype & 4) <> 0 as on_insert, (t.tgtype & 16) <> 0 as on_update
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid and c.relname = 'gw_hr_offers'
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and t.tgname in ('gw_hr_offers_lock_handoff', 'gw_hr_offers_formal_default', 'gw_hr_offers_lock_documents')
),
has as (
  select (select count(*) from want w join cols c using (column_name, data_type)) = 3 as all_cols,
         (select count(*) from cols) as n_cols
),
-- 件数。列が無い環境でもエラーにしないよう、列がそろっているときだけ問い合わせる（CASE の外れた側は実行されない）
cnt as (
  select
    (select count(*) from public.gw_hr_offers) as o_total,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where formal_contract_required', false, true, '')))[1]::text::bigint end as req_true,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where formal_contract_required = false', false, true, '')))[1]::text::bigint end as req_false,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where formal_contract_required is null', false, true, '')))[1]::text::bigint end as req_null,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where handoff_at is not null and formal_contract_required', false, true, '')))[1]::text::bigint end as handed_signed,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers where handoff_at is not null and formal_contract_required = false', false, true, '')))[1]::text::bigint end as handed_noformal,
    case when h.all_cols then (xpath('//n/text()', query_to_xml(
      'select count(*) as n from public.gw_hr_offers
        where (offer_type is not null and formal_contract_required is null)
           or (handoff_at is null) <> (handoff_by is null)
           or (handoff_at is not null and (accepted_at is null or declined_at is not null or revoked_at is not null))
           or (handoff_at is not null and (formal_contract_required is null or (formal_contract_required and formal_signed_at is null)))
           or (handoff_at is not null and (offer_type is null or offer_type = ''training''))',
      false, true, '')))[1]::text::bigint end as bad
  from has h
),
rows(seq, item, ok, detail) as (
  select 1, 'gw_hr_offers に 3 列がある（formal_contract_required・handoff_at・handoff_by。型も一致）',
         h.all_cols,
         case when h.all_cols then '3 / 3 列'
              else h.n_cols || ' / 3 列（足りない：' || coalesce((select string_agg(w.column_name, '・' order by w.column_name)
                     from want w where not exists (select 1 from cols c where c.column_name = w.column_name and c.data_type = w.data_type)), '') || '）' end
    from has h
  union all
  select 2, 'handoff_by は auth.users を指し、削除は restrict（引き渡しの記録を消さない）',
         exists (select 1 from fk where confdeltype = 'r'),
         coalesce((select conname || '（on delete ' || case confdeltype when 'r' then 'restrict' when 'a' then 'no action'
                     when 'n' then 'set null' when 'c' then 'cascade' else confdeltype::text end || '）' from fk limit 1), '外部キーがありません')
  union all
  select 3, '区分のあるオファーは正式契約の要否が決まっている（gw_hr_offers_formal_required_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_formal_required_chk' and contype = 'c'),
         coalesce((select def from cons where conname = 'gw_hr_offers_formal_required_chk'), '制約がありません')
  union all
  select 4, '日時と人がそろって入る（gw_hr_offers_handoff_pair_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_handoff_pair_chk' and contype = 'c'),
         coalesce((select def from cons where conname = 'gw_hr_offers_handoff_pair_chk'), '制約がありません')
  union all
  select 5, '引き渡せるのは本人が承諾した版だけ（辞退・無効化した版は不可。gw_hr_offers_handoff_accepted_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_handoff_accepted_chk' and contype = 'c'),
         coalesce((select def from cons where conname = 'gw_hr_offers_handoff_accepted_chk'), '制約がありません')
  union all
  select 6, '正式契約が必要な版は正式契約済みのあと・不要な版は承諾のまま（gw_hr_offers_handoff_formal_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_handoff_formal_chk' and contype = 'c'),
         coalesce((select def from cons where conname = 'gw_hr_offers_handoff_formal_chk'), '制約がありません')
  union all
  select 7, '育成枠・区分の無い合格通知は引き渡さない（gw_hr_offers_handoff_type_chk）',
         exists (select 1 from cons where conname = 'gw_hr_offers_handoff_type_chk' and contype = 'c'),
         coalesce((select def from cons where conname = 'gw_hr_offers_handoff_type_chk'), '制約がありません')
  union all
  select 8, '正式契約の要否の既定（BEFORE INSERT。gw_hr_offers_formal_default）',
         exists (select 1 from trg where tgname = 'gw_hr_offers_formal_default' and tgenabled = 'O' and before and on_insert
                   and proname = 'gw_hr_offers_formal_default'),
         coalesce((select '有効（' || tgname || ' → ' || proname || '）' from trg where tgname = 'gw_hr_offers_formal_default' and tgenabled = 'O'),
                  (select '無効になっています（tgenabled = ' || tgenabled::text || '）' from trg where tgname = 'gw_hr_offers_formal_default'),
                  'trigger がありません')
  union all
  select 9, '書き換え防止の関数（gw_hr_offers_lock_handoff。db/133 専用）',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                  where p.proname = 'gw_hr_offers_lock_handoff'),
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                            where p.proname = 'gw_hr_offers_lock_handoff')
              then 'あります（引き渡しの記録・送付後の正式契約の要否）' else '関数がありません' end
  union all
  select 10, '書き換え防止の trigger が有効（BEFORE UPDATE。gw_hr_offers_lock_handoff）',
         exists (select 1 from trg where tgname = 'gw_hr_offers_lock_handoff' and tgenabled = 'O' and before and on_update
                   and proname = 'gw_hr_offers_lock_handoff'),
         coalesce((select '有効（' || tgname || ' → ' || proname || '）' from trg where tgname = 'gw_hr_offers_lock_handoff' and tgenabled = 'O'),
                  (select '無効になっています（tgenabled = ' || tgenabled::text || '）' from trg where tgname = 'gw_hr_offers_lock_handoff'),
                  'trigger がありません')
  union all
  select 11, 'db/132 の書き換え防止（gw_hr_offers_lock_documents）もそのまま有効',
         exists (select 1 from trg where tgname = 'gw_hr_offers_lock_documents' and tgenabled = 'O' and proname = 'gw_hr_offers_lock_documents'),
         coalesce((select '有効（' || tgname || ' → ' || proname || '）' from trg where tgname = 'gw_hr_offers_lock_documents' and tgenabled = 'O'),
                  (select '無効になっています（tgenabled = ' || tgenabled::text || '）' from trg where tgname = 'gw_hr_offers_lock_documents'),
                  'trigger がありません（db/132 が未適用）')
  union all
  select 12, '既存データ：正式契約の要否・Office へ引き渡した版の件数',
         h.all_cols,
         case when h.all_cols
              then '正式契約 必要 ' || c.req_true || '件 / 不要 ' || c.req_false || '件 / 未設定（区分の無い合格通知）' || c.req_null
                || '件　引き渡し済み：正式契約済みのあと ' || c.handed_signed || '件・正式契約なし ' || c.handed_noformal
                || '件 / オファー全 ' || c.o_total || '件'
              else '列が無いため数えていません（オファー全 ' || c.o_total || '件）' end
    from has h, cnt c
  union all
  select 13, '正式契約の要否・引き渡しの条件に合わない行が 0件',
         h.all_cols and c.bad = 0,
         case when h.all_cols then 'おかしい行 ' || c.bad || '件' else '列が無いため数えていません' end
    from has h, cnt c
)
select seq as "#", item as 項目, case when ok then '✅' else '❌' end as 状態, detail as 詳細
  from rows
 order by seq;
