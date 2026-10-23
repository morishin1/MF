-- =============================================================================
-- db/143（採用HR → Office の早期引き渡し：社長合格の確定記録・条件ヒアリング・早期引き渡し・応募者の安全装置）の確認（読み取りだけ）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は「項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（件数）
-- db/143 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ（表を読む行は query_to_xml で実行時に読む）。
-- psql 専用のコマンド（\set など）は使っていない。何も書き換えない。
-- =============================================================================
with
tbl(name) as (
  values ('gw_hr_ceo_decisions'), ('gw_hr_hearings'), ('gw_hr_hearing_pay'), ('gw_hr_office_intakes'), ('gw_hr_office_intake_events')
),
want_con(name) as (
  values ('gw_hr_ceo_decisions_decision_chk'), ('gw_hr_ceo_decisions_note_chk'),
         ('gw_hr_hearings_offer_type_chk'), ('gw_hr_hearings_unresolved_chk'), ('gw_hr_hearings_text_chk'),
         ('gw_hr_hearings_range_chk'), ('gw_hr_hearings_exception_chk'), ('gw_hr_hearings_confirm_chk'),
         ('gw_hr_hearing_pay_amount_chk'), ('gw_hr_hearing_pay_approved_chk'),
         ('gw_hr_office_intakes_status_chk'), ('gw_hr_office_intakes_unresolved_chk'), ('gw_hr_office_intakes_exception_chk'),
         ('gw_hr_office_intakes_return_chk'), ('gw_hr_office_intakes_closed_chk'), ('gw_hr_office_intakes_received_chk'),
         ('gw_hr_office_intakes_request_chk'),
         ('gw_hr_office_intake_events_kind_chk'), ('gw_hr_office_intake_events_text_chk')
),
trg(name) as (
  values ('gw_hr_ceo_decisions_check'), ('gw_hr_ceo_decisions_guard'), ('gw_hr_hearings_guard'), ('gw_hr_hearing_pay_guard'),
         ('gw_hr_office_intakes_check'), ('gw_hr_office_intakes_lock_hearing'), ('gw_hr_office_intakes_guard'),
         ('gw_hr_office_intake_events_check'), ('gw_hr_office_intake_events_guard'), ('gw_hr_applicants_guard')
),
fn(name) as (
  values ('gw_hr_is_hire_decider'), ('gw_hr_append_only'), ('gw_hr_applicant_contract_history'), ('gw_hr_has_active_intake')
),
-- 応募者を指す外部キーは、削除で消えないよう restrict（a = no action ではなく r = restrict）
fk as (
  select r.relname::text as tbl, c.confdeltype
    from pg_constraint c join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace and n.nspname = 'public'
   where c.contype = 'f' and c.confrelid = to_regclass('public.gw_hr_applicants')
     and r.relname in (select name from tbl)
),
pol as (
  select c.relname as tbl, p.polname, p.polcmd,
         coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relname in (select name from tbl)
),
rows(seq, item, ok, detail) as (
  select 1, '5つの表がある（社長判断・ヒアリング・ヒアリングの給与・早期引き渡し・引き渡しの履歴）',
         (select count(*) = 5 from tbl where to_regclass('public.' || name) is not null),
         (select coalesce(string_agg(name, ', '), '') from tbl where to_regclass('public.' || name) is null)
  union all
  select 2, '制約（19個）がある',
         (select count(*) = 19 from want_con where exists (select 1 from pg_constraint where conname = want_con.name)),
         (select coalesce(string_agg(name, ', '), '') from want_con where not exists (select 1 from pg_constraint where conname = want_con.name))
  union all
  select 3, '有効な引き渡しは1人に1つ（差し戻していないものの部分一意索引）',
         exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_gw_hr_office_intakes_active'
                  and indexdef ilike '%returned_at IS NULL%'),
         ''
  union all
  select 4, '書き換え・削除を止める trigger（10個。応募者の安全装置を含む）がある',
         (select count(*) = 10 from trg where exists (select 1 from pg_trigger t where t.tgname = trg.name and not t.tgisinternal)),
         (select coalesce(string_agg(name, ', '), '') from trg where not exists (select 1 from pg_trigger t where t.tgname = trg.name and not t.tgisinternal))
  union all
  select 5, '関数（4つ）がある',
         (select count(*) = 4 from fn where exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                     where n.nspname = 'public' and p.proname = fn.name)),
         (select coalesce(string_agg(name, ', '), '') from fn where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                                                 where n.nspname = 'public' and p.proname = fn.name))
  union all
  select 6, '応募者を指す外部キーは削除で消えない（on delete restrict）',
         exists (select 1 from fk) and not exists (select 1 from fk where confdeltype <> 'r'),
         (select coalesce(string_agg(tbl, ', '), '') from fk where confdeltype <> 'r')
  union all
  select 7, '5つの表で RLS が有効',
         (select count(*) = 5 from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
           where c.relname in (select name from tbl) and c.relrowsecurity),
         ''
  union all
  select 8, 'ポリシーは読むだけ（書くのはサーバだけ）。採用HR・人事労務が読む（給与の表は gw_can_see_salary だけ）',
         (select count(*) = 5 from pol)
         and not exists (select 1 from pol where polcmd <> 'r')
         and not exists (select 1 from pol where tbl <> 'gw_hr_hearing_pay' and (expr not ilike '%gw_is_recruiting%' or expr not ilike '%gw_is_hr%'))
         and not exists (select 1 from pol where tbl = 'gw_hr_hearing_pay' and (expr not ilike '%gw_can_see_salary%' or expr ilike '%gw_is_recruiting%')),
         (select coalesce(string_agg(tbl || '.' || polname, ', '), '') from pol where polcmd <> 'r')
  union all
  select 9, 'ログインした人・匿名は5つの表に書けない（権限）',
         not exists (select 1 from information_schema.role_table_grants
                      where table_schema = 'public' and table_name in (select name from tbl)
                        and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
         ''
  union all
  select 10, '既存の引き渡し（db/133 の handoff_at）の CHECK・trigger が残っている（変えていない）',
         exists (select 1 from pg_trigger where tgname = 'gw_hr_offers_lock_handoff' and not tgisinternal)
         and exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_pair_chk'),
         ''
  union all
  select 11, '有効な引き渡しが2つある応募者がいない',
         case when to_regclass('public.gw_hr_office_intakes') is null then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from (select applicant_id from public.gw_hr_office_intakes where returned_at is null
                                             group by tenant_id, applicant_id having count(*) > 1) x', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 12, '引き渡しの根拠の社長判断が「合格」で、同じ応募者のもの',
         case when to_regclass('public.gw_hr_office_intakes') is null then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_hr_office_intakes i join public.gw_hr_ceo_decisions d on d.id = i.ceo_decision_id
                       where d.decision <> ''pass'' or d.applicant_id <> i.applicant_id or d.tenant_id <> i.tenant_id', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 13, '引き渡したヒアリングは固定されている（locked_at）',
         case when to_regclass('public.gw_hr_office_intakes') is null then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_hr_office_intakes i join public.gw_hr_hearings h on h.id = i.hearing_id
                       where h.locked_at is null', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 14, 'ℹ 社長判断の記録（判断ごとの件数）', null,
         case when to_regclass('public.gw_hr_ceo_decisions') is null then '表なし'
              else coalesce((xpath('/row/v/text()', query_to_xml(
                     'select string_agg(decision || '' '' || n, '' / '' order by decision) as v
                        from (select decision, count(*) n from public.gw_hr_ceo_decisions group by decision) s', false, true, '')))[1]::text, '0件') end
  union all
  select 15, 'ℹ 早期引き渡し（Office の状態ごとの件数。差し戻し済みを除く）', null,
         case when to_regclass('public.gw_hr_office_intakes') is null then '表なし'
              else coalesce((xpath('/row/v/text()', query_to_xml(
                     'select string_agg(office_status || '' '' || n, '' / '' order by office_status) as v
                        from (select office_status, count(*) n from public.gw_hr_office_intakes where returned_at is null group by office_status) s',
                     false, true, '')))[1]::text, '0件') end
  union all
  select 16, 'ℹ 条件ヒアリング（記録中／固定済み）', null,
         case when to_regclass('public.gw_hr_hearings') is null then '表なし'
              else (xpath('/row/v/text()', query_to_xml(
                     'select (count(*) filter (where locked_at is null))::text || '' / '' || (count(*) filter (where locked_at is not null))::text as v
                        from public.gw_hr_hearings', false, true, '')))[1]::text end
)
select seq as "#", item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
