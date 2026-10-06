-- db/120_left_gate.sql を流す前の確認（読み取りだけ。何も書き換えません）
-- Supabase の SQL Editor に貼って Run。結果の3つの表を控えてください。

-- 1) 退職者として扱われる人（left、または退職日を過ぎた leaving）と、残っている権限の行
select e.display_name,
       e.status,
       e.left_on,
       coalesce((select string_agg(g.role, ',' order by g.role) from public.gw_role_grants g where g.employee_id = e.id), '') as 内部ロール,
       coalesce((select string_agg(a.app_key, ',' order by a.app_key) from public.gw_app_grants a where a.employee_id = e.id), '') as アプリ権限,
       exists (select 1 from public.memberships m where m.user_id = e.user_id and m.role in ('admin','staff')) as 会計の管理側,
       e.user_id is not null as ログインあり
  from public.gw_employees e
 where e.status = 'left'
    or (e.status = 'leaving' and e.left_on is not null and e.left_on < (now() at time zone 'Asia/Tokyo')::date)
 order by e.status, e.left_on nulls last, e.display_name;

-- 2) 退職手続き中（leaving）で、退職日がまだ来ていない／入っていない人（この人たちは 120 の後も通常どおり使える）
select e.display_name, e.status, e.left_on
  from public.gw_employees e
 where e.status = 'leaving'
   and (e.left_on is null or e.left_on >= (now() at time zone 'Asia/Tokyo')::date)
 order by e.left_on nulls last, e.display_name;

-- 3) 在籍状態ごとの人数（120 の前後で、active の人数が変わらないことを確かめる）
select status, count(*) as 人数 from public.gw_employees group by status order by status;
