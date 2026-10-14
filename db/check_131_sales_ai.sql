-- =============================================================================
-- db/131（AI営業 MVP）の確認（読み取りだけ。何も書き換えない）
--
-- Supabase の SQL Editor に貼って Run。結果は「項目 / 状態 / 詳細」。❌ の行があれば db/131 が当たっていない。
--   ✅ … 期待どおり   ❌ … 未適用・おかしい   ℹ … 参考
-- =============================================================================
with t(name) as (values ('gw_sales_ai_settings'), ('gw_sales_ai_analyses'), ('gw_sales_ai_drafts'), ('gw_sales_ai_usage'), ('gw_sales_ai_classifications')),
pol as (
  select c.relname as tbl, p.polname, p.polcmd
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where c.relname in (select name from t)
),
fn(sig) as (values ('public.gw_sales_ai_reserve(uuid,numeric,text,text,uuid,uuid)'),
                   ('public.gw_sales_ai_settle(uuid,integer,integer,numeric,text,text,integer)')),
rows(seq, item, ok, detail) as (
  select 1, 'AI営業の表が5つある', (select count(*) = 5 from t where to_regclass('public.' || name) is not null),
         (select coalesce(string_agg(name, ', '), '') from t where to_regclass('public.' || name) is null)
  union all
  select 2, 'AI営業の表は RLS が有効',
         (select coalesce(bool_and(c.relrowsecurity), false) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname in (select name from t)), ''
  union all
  select 3, '読むだけのポリシー（SELECT）が5つ', (select count(*) = 5 from pol where polcmd = 'r'), ''
  union all
  select 4, '書き込みのポリシーが無い（書くのは API の service_role だけ）', not exists (select 1 from pol where polcmd <> 'r'),
         (select coalesce(string_agg(tbl || '.' || polname, ', '), '') from pol where polcmd <> 'r')
  union all
  select 5, '予約・確定の関数がある', (select count(*) = 2 from fn where to_regprocedure(sig) is not null), ''
  union all
  select 6, '予約・確定の関数は anon・authenticated から呼べない',
         not exists (select 1 from fn, (values ('anon'), ('authenticated')) r(role)
                      where to_regprocedure(fn.sig) is not null and exists (select 1 from pg_roles where rolname = r.role)
                        and has_function_privilege(r.role, to_regprocedure(fn.sig), 'execute')), ''
  union all
  select 7, '自己承認を止める CHECK がある',
         exists (select 1 from pg_constraint where conname = 'gw_sales_ai_drafts_no_self_approval'), ''
  union all
  select 8, '承認後の本文の書き換えを止めるトリガーがある',
         exists (select 1 from pg_trigger where tgname = 'gw_sales_ai_drafts_guard_trg' and not tgisinternal), ''
  union all
  select 9, 'gw_sales_approaches.ai_draft_id がある',
         exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'gw_sales_approaches' and column_name = 'ai_draft_id'), ''
  union all
  select 10, 'ℹ 設定（有効／停止・月の上限）', null,
         coalesce((select string_agg(x.r, ' | ') from xmltable('/table/row' passing query_to_xml(
           case when to_regclass('public.gw_sales_ai_settings') is null then 'select null::text as r where false'
                else $q$select format('enabled=%s / 停止理由=%s / 上限 %s ドル / 目標 %s ドル / 日の上限 %s ドル', enabled,
                       coalesce(paused_reason, '-'), monthly_cap_usd, monthly_target_usd, daily_cap_usd) as r
                       from public.gw_sales_ai_settings$q$ end, false, false, '') columns r text path 'r') x),
           '（まだ行が無い。最初に使うときに作られる。作られたときは止まっている）')
  union all
  select 11, 'ℹ 今月の AI 費用（確定分・日本時間の月初から）', null,
         coalesce((select string_agg(x.r, ' | ') from xmltable('/table/row' passing query_to_xml(
           case when to_regclass('public.gw_sales_ai_usage') is null then 'select null::text as r where false'
                else $q$select format('%s 回 / %s ドル', count(*), coalesce(sum(cost_usd), 0)::numeric(10,4)) as r
                       from public.gw_sales_ai_usage where status = 'committed'
                        and created_at >= (date_trunc('month', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo'$q$ end,
           false, false, '') columns r text path 'r') x), '')
  union all
  select 12, 'ℹ 商材の一次分類（分類済みの社数・PC販売・レンタルが一番合う社数）', null,
         coalesce((select string_agg(x.r, ' | ') from xmltable('/table/row' passing query_to_xml(
           case when to_regclass('public.gw_sales_ai_classifications') is null then 'select null::text as r where false'
                else $q$select format('分類済み %s 社 / 8EC・8RENT が一番 %s 社', count(*),
                       count(*) filter (where best_service = '8EC・8RENT')) as r from public.gw_sales_ai_classifications$q$ end,
           false, false, '') columns r text path 'r') x), '')
)
select item as "項目",
       case when ok is null then 'ℹ' when ok then '✅' else '❌' end as "状態",
       detail as "詳細"
  from rows order by seq;
