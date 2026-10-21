-- =============================================================================
-- db/144（早期引き渡しと Office の契約手続きをつなぐ安全装置）の確認（読み取りだけ）
--
-- Supabase の SQL Editor にこのファイル全体を貼って Run。結果は「項目 / 状態 / 詳細」。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考（件数）
-- db/144 を流す前に実行しても、エラーにはならず ❌ が並ぶだけ（表を読む行は query_to_xml で実行時に読む）。
-- psql 専用のコマンド（\set など）は使っていない。何も書き換えない。
-- =============================================================================
with
trg(name, tbl) as (
  values ('gw_hr_office_intakes_link', 'gw_hr_office_intakes'), ('gw_hr_offers_intake_guard', 'gw_hr_offers')
),
fn(name) as (
  values ('gw_hr_office_intakes_link'), ('gw_hr_offers_intake_guard')
),
rows(seq, item, ok, detail) as (
  select 1, '前提：db/143 の表がある（gw_hr_office_intakes）',
         to_regclass('public.gw_hr_office_intakes') is not null, ''
  union all
  select 2, 'trigger（2つ）がある（引き渡しと版の結びつけ・完了・辞退・差し戻し／引き渡し済みの版を画面から書かせない）',
         (select count(*) = 2 from trg where exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                                                      where t.tgname = trg.name and c.relname = trg.tbl and not t.tgisinternal)),
         (select coalesce(string_agg(name, ', '), '') from trg where not exists (select 1 from pg_trigger t where t.tgname = trg.name and not t.tgisinternal))
  union all
  select 3, '関数（2つ）がある',
         (select count(*) = 2 from fn where exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                     where n.nspname = 'public' and p.proname = fn.name)),
         (select coalesce(string_agg(name, ', '), '') from fn where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                                                 where n.nspname = 'public' and p.proname = fn.name))
  union all
  select 4, '画面から直接かどうかを見る関数は security definer にしていない（current_user で判定するため）',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'gw_hr_offers_intake_guard' and not p.prosecdef),
         ''
  union all
  select 5, '既存の版の trigger（db/133 引き渡し・db/139 契約）が残っている（変えていない）',
         exists (select 1 from pg_trigger where tgname = 'gw_hr_offers_lock_handoff' and not tgisinternal)
         and exists (select 1 from pg_trigger where tgname = 'gw_hr_offers_lock_contract' and not tgisinternal),
         ''
  union all
  select 6, '引き渡しに結んだ版は、同じ会社・同じ応募者のもの',
         case when to_regclass('public.gw_hr_office_intakes') is null then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_hr_office_intakes i join public.gw_hr_offers o on o.id = i.offer_id
                       where o.applicant_id <> i.applicant_id or o.tenant_id <> i.tenant_id', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 7, '完了の引き渡しは、社員登録が済んでいる',
         case when to_regclass('public.gw_hr_office_intakes') is null then false
              else (xpath('/row/count/text()', query_to_xml(
                     'select count(*) from public.gw_hr_office_intakes i join public.gw_hr_applicants a on a.id = i.applicant_id
                       where i.office_status = ''completed'' and a.employee_id is null', false, true, '')))[1]::text::int = 0 end,
         ''
  union all
  select 8, 'ℹ 版と結んだ引き渡し（有効なもの）', null,
         case when to_regclass('public.gw_hr_office_intakes') is null then '表なし'
              else (xpath('/row/v/text()', query_to_xml(
                     'select (count(*) filter (where offer_id is not null))::text || '' / '' || count(*)::text as v
                        from public.gw_hr_office_intakes where returned_at is null', false, true, '')))[1]::text end
)
select seq as "#", item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
