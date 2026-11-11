-- =============================================================================
-- AI営業エージェント：本番DBの確認（読み取り専用・1回で全部）
--
-- 使い方：この全文を Supabase の SQL Editor（MF の本番プロジェクト）に貼って Run。
--         結果は section / result の一覧で出る。全部の行をコピーして渡してください。
--
-- ・SELECT だけ。データも設定も変えない（表や関数が無くてもエラーにせず「確認できません」と出す）。
-- ・結果に社員の名前が含まれるので、社外に共有しないこと。
-- ・マイグレーションが本番に入っているかは「表・列・関数があるか」からの推定（適用の履歴までは分からない）。
-- 設計書: docs/ai-sales-agent-phase0.md
-- =============================================================================
with q(ord, section, need, sql) as (values
  -- 01 基本 ------------------------------------------------------------------
  (100, '01 基本', '{}'::text[], $s$
    select format('DB=%s / PostgreSQL %s / 確認時刻 %s', current_database(), current_setting('server_version'),
                  to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI')) as r $s$),
  (110, '01 テナント数', '{tenants}', $s$ select count(*)::text || ' テナント' as r from public.tenants $s$),

  -- 02 マイグレーションの推定（表・列・関数があるか）------------------------------
  (200, '02 マイグレーション（推定）', '{}', $s$
    with m(mig, objs) as (values
      ('088 Sales',            array['gw_sales_companies','gw_sales_approaches','gw_sales_click_events','gw_sales_events','gw_sales_templates','gw_sales_campaigns']),
      ('090 商談',             array['gw_sales_meetings']),
      ('096 チャネル・非表示', array['gw_sales_companies.hidden_at','gw_sales_companies.contacts','gw_sales_approaches.failed_at','gw_sales_approaches.send_from','gw_sales_events.channel']),
      ('097 一覧の集計',       array['gw_sales_companies.last_sent_at','gw_sales_companies.click_count','gw_sales_companies.status_rank']),
      ('098 NEXT の並び',      array['gw_sales_companies.last_click_at','gw_sales_company_list']),
      ('101 件数の関数',       array['fn:gw_sales_company_facet_counts']),
      ('108 マスタ・メール',   array['gw_sales_master_options','gw_sales_companies.emails']),
      ('116 案件',             array['gw_sales_deals','gw_sales_deal_history']),
      ('119 アプリ権限',       array['gw_app_grants','fn:gw_has_app']),
      ('094 Sales のロール',   array['fn:gw_is_sales','fn:gw_has_role'])
    )
    select m.mig || ': ' || case when cardinality(miss) = 0 then 'あり' else '欠け → ' || array_to_string(miss, ', ') end as r
      from m, lateral (select array(
        select o from unnest(m.objs) o
         where case
           when o like 'fn:%' then not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                                where n.nspname = 'public' and p.proname = substr(o, 4))
           when o like '%.%' then not exists (select 1 from information_schema.columns c
                                               where c.table_schema = 'public' and c.table_name = split_part(o, '.', 1)
                                                 and c.column_name = split_part(o, '.', 2))
           else to_regclass('public.' || o) is null
         end) as miss) x
     order by m.mig $s$),

  -- 03 権限の関数（中身）-----------------------------------------------------------
  (300, '03 gw_is_sales の中身', '{}', $s$
    select coalesce(pg_get_functiondef(to_regprocedure('public.gw_is_sales(uuid)')), '（無い）') as r $s$),
  (310, '03 gw_has_app の中身', '{}', $s$
    select coalesce(pg_get_functiondef(to_regprocedure('public.gw_has_app(uuid,text)')), '（無い）') as r $s$),
  (320, '03 gw_has_role の中身', '{}', $s$
    select coalesce(pg_get_functiondef(to_regprocedure('public.gw_has_role(uuid,text)')), '（無い）') as r $s$),

  -- 04 Sales の RLS ポリシー ---------------------------------------------------------
  (400, '04 RLS ポリシー', '{}', $s$
    select tablename || ' / ' || policyname || ' / ' || cmd || ' / ' || coalesce(qual, '-') || coalesce(' / check: ' || with_check, '') as r
      from pg_policies
     where schemaname = 'public' and (tablename like 'gw\_sales\_%' or tablename = 'gw_app_grants')
     order by tablename, policyname $s$),
  (410, '04 RLS が有効な表', '{}', $s$
    select c.relname || ': ' || case when c.relrowsecurity then 'RLS 有効' else 'RLS 無効' end as r
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'gw\_sales\_%' or c.relname = 'gw_app_grants')
     order by c.relname $s$),

  -- 05 商材マスタ --------------------------------------------------------------------
  (500, '05 商材・業種マスタ', '{gw_sales_master_options}', $s$
    select kind || ' / ' || label || case when archived_at is not null then '（しまった）' else '' end as r
      from public.gw_sales_master_options order by kind, sort_order, label $s$),

  -- 06 PR0 で影響を受ける人（権限の整合）------------------------------------------------
  (600, '06 Sales アプリ権限だけ（いま DB で止まる → PR0 で使えるようになる）', '{gw_app_grants,gw_role_grants,gw_employees}', $s$
    select e.display_name || '（' || e.status || '）' as r
      from public.gw_app_grants g join public.gw_employees e on e.id = g.employee_id
     where g.app_key = 'sales'
       and not exists (select 1 from public.gw_role_grants r where r.employee_id = e.id and r.role in ('owner','manager','sales'))
     order by 1 $s$),
  (610, '06 manager/sales ロールだけ（いま API で止まる → PR0 で DB でも止まる）', '{gw_app_grants,gw_role_grants,gw_employees}', $s$
    select e.display_name || '（' || e.status || '）: ' || string_agg(r.role, ',' order by r.role) as r
      from public.gw_role_grants r join public.gw_employees e on e.id = r.employee_id
     where r.role in ('manager','sales')
       and not exists (select 1 from public.gw_role_grants o where o.employee_id = e.id and o.role = 'owner')
       and not exists (select 1 from public.gw_app_grants g where g.employee_id = e.id and g.app_key = 'sales')
     group by e.display_name, e.status order by 1 $s$),
  (620, '06 営業責任者の候補（manager ロール＋Sales アプリ権限）', '{gw_app_grants,gw_role_grants,gw_employees}', $s$
    select e.display_name || '（' || e.status || '）' as r
      from public.gw_role_grants r join public.gw_employees e on e.id = r.employee_id
     where r.role = 'manager'
       and exists (select 1 from public.gw_app_grants g where g.employee_id = e.id and g.app_key = 'sales')
     order by 1 $s$),
  (630, '06 経営者（owner）', '{gw_role_grants,gw_employees}', $s$
    select e.display_name || '（' || e.status || '）' as r
      from public.gw_role_grants r join public.gw_employees e on e.id = r.employee_id
     where r.role = 'owner' order by 1 $s$),
  (640, '06 Sales を使える人の数（PR0 の前 → 後）', '{gw_app_grants,gw_role_grants,gw_employees}', $s$
    with p as (
      select e.id,
             exists (select 1 from public.gw_role_grants r where r.employee_id = e.id and r.role in ('owner','manager','sales')) as before_db,
             exists (select 1 from public.gw_role_grants r where r.employee_id = e.id and r.role = 'owner')
               or exists (select 1 from public.gw_app_grants g where g.employee_id = e.id and g.app_key = 'sales') as after_db
        from public.gw_employees e where e.status <> 'left' and e.user_id is not null)
    select format('いま DB で通る %s 人 → PR0 のあと %s 人（増える %s・減る %s）',
                  count(*) filter (where before_db), count(*) filter (where after_db),
                  count(*) filter (where after_db and not before_db), count(*) filter (where before_db and not after_db)) as r
      from p $s$),

  -- 07 企業 --------------------------------------------------------------------------
  (700, '07 企業：ステータス別', '{gw_sales_companies}', $s$
    select coalesce(status, '-') || ': ' || count(*) as r from public.gw_sales_companies group by status order by count(*) desc $s$),
  (710, '07 企業：NG 理由別', '{gw_sales_companies}', $s$
    select coalesce(ng_reason, '（NG なし）') || ': ' || count(*) as r from public.gw_sales_companies group by ng_reason order by count(*) desc $s$),
  (720, '07 企業：商材別', '{gw_sales_companies}', $s$
    select coalesce(service, '（なし）') || ': ' || count(*) as r from public.gw_sales_companies group by service order by count(*) desc $s$),

  -- 08 AI分析の候補 --------------------------------------------------------------------
  (800, '08 AI分析の候補（概算）', '{gw_sales_companies.site_url,gw_sales_companies.ng_reason,gw_sales_companies.hidden_at,gw_sales_companies.last_sent_at}', $s$
    select format('全社 %s / サイトURLあり %s / NG %s / 非表示 %s / 成約・失注・対象外 %s / 30日以内に送信 %s / 候補 %s（サイトあり・NGなし・非表示なし・未完了・30日送信なし）',
                  count(*), count(*) filter (where site_url is not null), count(*) filter (where ng_reason is not null),
                  count(*) filter (where hidden_at is not null), count(*) filter (where status in ('won','lost','excluded')),
                  count(*) filter (where last_sent_at > now() - interval '30 days'),
                  count(*) filter (where site_url is not null and ng_reason is null and hidden_at is null
                                     and status not in ('won','lost','excluded')
                                     and (last_sent_at is null or last_sent_at <= now() - interval '30 days'))) as r
      from public.gw_sales_companies $s$),

  -- 09 PC販売・レンタルの候補（商材・キャンペーン別）-----------------------------------------
  (900, '09 PC販売・レンタルの候補（商材 / キャンペーン: 社数）', '{gw_sales_companies.hidden_at,gw_sales_campaigns}', $s$
    select coalesce(c.service, '（なし）') || ' / ' || coalesce(k.name, '（キャンペーンなし）') || ': ' || count(*) as r
      from public.gw_sales_companies c left join public.gw_sales_campaigns k on k.id = c.campaign_id
     where c.hidden_at is null and c.ng_reason is null and c.site_url is not null
       and (c.service ilike any (array['%PC%','%ＰＣ%','%8EC%','%8RENT%','%レンタル%','%パソコン%'])
            or k.name ilike any (array['%PC%','%ＰＣ%','%8EC%','%8RENT%','%レンタル%','%パソコン%']))
     group by c.service, k.name order by count(*) desc limit 30 $s$),
  (910, '09 キャンペーン（対象企業数）', '{gw_sales_campaigns}', $s$
    select k.name || case when k.archived_at is not null then '（終了）' else '' end || ': '
           || (select count(*) from public.gw_sales_companies c where c.campaign_id = k.id) as r
      from public.gw_sales_campaigns k order by k.created_at desc limit 30 $s$),

  -- 10 アタックの実績（直近90日）----------------------------------------------------------
  (1000, '10 アタック実績（直近90日・チャネル別）', '{gw_sales_approaches.failed_at}', $s$
    select channel || ': 送信 ' || count(*) filter (where sent_at is not null)
           || ' / 送れなかった ' || count(*) filter (where failed_at is not null)
           || ' / 準備だけ ' || count(*) filter (where sent_at is null and failed_at is null) as r
      from public.gw_sales_approaches where prepared_at > now() - interval '90 days'
     group by channel order by count(*) desc $s$),
  (1010, '10 営業文テンプレート', '{gw_sales_templates}', $s$
    select format('使用中 %s / しまった %s', count(*) filter (where archived_at is null), count(*) filter (where archived_at is not null)) as r
      from public.gw_sales_templates $s$)
),
chk as (
  select q.*, array(
           select n from unnest(q.need) as n
            where case
              when n like '%.%' then not exists (select 1 from information_schema.columns c
                                                  where c.table_schema = 'public' and c.table_name = split_part(n, '.', 1)
                                                    and c.column_name = split_part(n, '.', 2))
              else to_regclass('public.' || n) is null
            end) as missing
    from q
)
select chk.section,
       case when cardinality(chk.missing) > 0
            then '（確認できません。無いもの: ' || array_to_string(chk.missing, ', ') || '）'
            else coalesce(x.r, '（0件）') end as result
  from chk
  left join lateral xmltable('/table/row'
         passing query_to_xml(case when cardinality(chk.missing) = 0 then chk.sql else 'select null::text as r where false' end,
                              false, false, '')
         columns n for ordinality, r text path 'r') x on true
 order by chk.ord, x.n;
