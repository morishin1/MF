-- AI営業エージェント Phase 0 / 本番確認（読み取り専用）
-- Supabase SQL Editorで実行し、結果をClaudeへ共有してください。
-- 参照: docs/ai-sales-agent-phase0.md §11

-- 1) Sales の表と列（096/097/098/101/108/116 が入っているか）
select table_name, count(*) as columns
  from information_schema.columns
 where table_schema = 'public' and table_name like 'gw_sales_%'
 group by table_name order by table_name;

select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'gw_sales_companies'
   and column_name in ('hidden_at','contacts','last_sent_at','click_count','status_rank','last_click_at','emails');

-- 2) 権限の部品があるか（db/119・120）と、いまの gw_is_sales の中身
select to_regclass('public.gw_app_grants') as app_grants_table,
       to_regprocedure('public.gw_has_app(uuid,text)') as gw_has_app,
       to_regprocedure('public.gw_has_role(uuid,text)') as gw_has_role;
select pg_get_functiondef('public.gw_is_sales(uuid)'::regprocedure);

-- 3) 提案サービス（商材）のマスタ
select kind, label, archived_at is not null as archived
  from public.gw_sales_master_options order by kind, sort_order, label;

-- 4) PR0 で影響を受ける人
-- 4-a) アプリ権限 sales はあるが、owner/manager/sales のロールが無い人（いま API は通るが DB で止まる → 直る）
select e.display_name, e.status
  from public.gw_app_grants g
  join public.gw_employees e on e.id = g.employee_id
 where g.app_key = 'sales'
   and not exists (select 1 from public.gw_role_grants r
                    where r.employee_id = e.id and r.role in ('owner','manager','sales'));
-- 4-b) manager / sales のロールはあるが、アプリ権限 sales が無い人（経営者を除く。いま API で止まっている → DB でも止まる）
select e.display_name, e.status, array_agg(r.role order by r.role) as roles
  from public.gw_role_grants r
  join public.gw_employees e on e.id = r.employee_id
 where r.role in ('manager','sales')
   and not exists (select 1 from public.gw_role_grants o where o.employee_id = e.id and o.role = 'owner')
   and not exists (select 1 from public.gw_app_grants g where g.employee_id = e.id and g.app_key = 'sales')
 group by e.display_name, e.status;
-- 4-c) 営業責任者の候補（manager ロール＋Sales のアプリ権限）
select e.display_name, e.status
  from public.gw_role_grants r
  join public.gw_employees e on e.id = r.employee_id
 where r.role = 'manager'
   and exists (select 1 from public.gw_app_grants g where g.employee_id = e.id and g.app_key = 'sales');

-- 5) 企業の数と内訳
select status, count(*) from public.gw_sales_companies group by status order by 2 desc;
select coalesce(ng_reason,'(なし)') as ng, count(*) from public.gw_sales_companies group by 1 order by 2 desc;
select coalesce(service,'(なし)') as service, count(*) from public.gw_sales_companies group by 1 order by 2 desc;

-- 6) AI分析の対象になりうる企業（サイトURLあり・NGでない・非表示でない・未成約）
select count(*) filter (where site_url is not null) as with_site,
       count(*) filter (where form_url is not null) as with_form,
       count(*) as total
  from public.gw_sales_companies
 where hidden_at is null and ng_reason is null and status not in ('won','lost','excluded');

-- 7) 検証用（PC販売・レンタル）の候補：商材・キャンペーンごとの数
select coalesce(c.service,'(なし)') as service, coalesce(k.name,'(なし)') as campaign, count(*)
  from public.gw_sales_companies c
  left join public.gw_sales_campaigns k on k.id = c.campaign_id
 where c.hidden_at is null and c.ng_reason is null and c.site_url is not null
 group by 1, 2 order by 3 desc limit 30;
