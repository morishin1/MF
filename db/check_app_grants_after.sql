-- =============================================================================
-- 【db/119 を流した直後に流す・読み取りだけ】移行後の実効権限が、移行前と同じか
--
-- ■ 比べるもの
--   「いまの式」（内部ロールと会計の管理者から出した実効権限）と、
--   「移行後の式」（本物の gw_app_grants と内部ロールから出した実効権限）を、人ごとに比べる。
--   項目は db/check_app_grants_dryrun.sql と同じ（採用HR / Sales / 月末月初 / 人事・労務 / 経理・事務 / 経営 / 人事の管理権限 / 管理部への問い合わせ）。
--
-- ■ 合格条件
--   ① 差分が 0 行。1行でも出たら止める（権限が増える人・減る人がいる）。
--   ※ 119 のあとにメンバー一覧でアプリ利用権限を変更した人は、差分が出るのが正しい（その人は意図した変更）。
--     この確認は「119 を流した直後」に使う。
--   ② 表の行数・アプリごとの人数。③ 内部ロールに対応しない行（0 行が普通。画面で付けた分が出る）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run。個人名が出るので、人数と「差分 0 行」だけを報告する。
-- =============================================================================

-- ① 差分（0 行が合格）---------------------------------------------------------
with roles as (
  select employee_id, array_agg(role) as rs from public.gw_role_grants group by employee_id
), apps as (
  select employee_id, array_agg(app_key) as ap from public.gw_app_grants group by employee_id
), emp as (
  select e.id as employee_id, e.display_name, e.status,
         coalesce(r.rs, '{}'::text[]) as rs, coalesce(a.ap, '{}'::text[]) as ap,
         exists (select 1 from public.memberships m
                  where m.user_id = e.user_id and m.tenant_id = e.tenant_id and m.role in ('admin', 'staff')) as is_admin
    from public.gw_employees e
    left join roles r on r.employee_id = e.id
    left join apps  a on a.employee_id = e.id
), f as (
  select employee_id, display_name, status, is_admin,
         ('owner' = any(rs)) as o, ('manager' = any(rs)) as m, ('hr' = any(rs)) as h,
         ('finance' = any(rs)) as fin, ('recruiter' = any(rs)) as rec, ('sales' = any(rs)) as sal,
         ('hr' = any(ap)) as app_hr, ('sales' = any(ap)) as app_sales, ('office' = any(ap)) as app_office
    from emp
), cmp as (
  select employee_id, display_name, status,
         (o or m or h or rec)        as old_recruit,
         (o or m or sal)             as old_sell,
         (o or m or fin)             as old_monthly,
         (is_admin or o or h)        as old_office_hr,
         (is_admin or o or fin)      as old_office_finance,
         o                           as old_keiei,
         (is_admin or o or h)        as old_manage_hr,
         ((is_admin or o or h) or (o or m or fin)) as old_ai_inquiries,
         (o or app_hr)               as new_recruit,
         (o or app_sales)            as new_sell,
         ((o or is_admin or app_office) and (o or m or fin)) as new_monthly,
         (is_admin or o or (app_office and h))   as new_office_hr,
         (is_admin or o or (app_office and fin)) as new_office_finance,
         o                           as new_keiei,
         (is_admin or o or (app_office and h))   as new_manage_hr,
         ((is_admin or o or (app_office and h)) or ((o or is_admin or app_office) and (o or m or fin))) as new_ai_inquiries
    from f
)
select display_name as 名前, status as 在籍,
       case when old_recruit        <> new_recruit        then '採用HR '        else '' end
    || case when old_sell           <> new_sell           then 'Sales '         else '' end
    || case when old_monthly        <> new_monthly        then '月末月初 '      else '' end
    || case when old_office_hr      <> new_office_hr      then '人事・労務 '    else '' end
    || case when old_office_finance <> new_office_finance then '経理・事務 '    else '' end
    || case when old_keiei          <> new_keiei          then '経営 '          else '' end
    || case when old_manage_hr      <> new_manage_hr      then '人事の管理権限 ' else '' end
    || case when old_ai_inquiries   <> new_ai_inquiries   then '管理部への問い合わせ' else '' end as 変わる項目
  from cmp
 where (old_recruit, old_sell, old_monthly, old_office_hr, old_office_finance, old_keiei, old_manage_hr, old_ai_inquiries)
    is distinct from
       (new_recruit, new_sell, new_monthly, new_office_hr, new_office_finance, new_keiei, new_manage_hr, new_ai_inquiries)
 order by 1;

-- ② 表の行数・アプリごとの人数 -----------------------------------------------
select count(*)                                  as 行数,
       count(*) filter (where app_key = 'hr')     as 採用HR,
       count(*) filter (where app_key = 'sales')  as Sales,
       count(*) filter (where app_key = 'office') as Office,
       count(*) filter (where granted_by is null) as 移行で入れた行
  from public.gw_app_grants;

-- ③ 内部ロールに対応しない行（0 行が普通。画面で付けた分があれば出る）---------------
select e.display_name as 名前, g.app_key as アプリ
  from public.gw_app_grants g
  join public.gw_employees e on e.id = g.employee_id
 where not exists (
   select 1 from public.gw_role_grants r
    where r.employee_id = g.employee_id
      and ((g.app_key = 'hr'     and r.role in ('manager', 'hr', 'recruiter'))
        or (g.app_key = 'sales'  and r.role in ('manager', 'sales'))
        or (g.app_key = 'office' and r.role in ('manager', 'hr', 'finance')))
 )
 order by 1, 2;

-- ④ 表・ポリシー・関数があるか --------------------------------------------------
select (to_regclass('public.gw_app_grants') is not null)                    as 表がある,
       (to_regprocedure('public.gw_has_app(uuid, text)') is not null)       as 関数がある,
       (select count(*) from pg_policy where polrelid = 'public.gw_app_grants'::regclass) as ポリシー数_2が正;
