-- db/120_left_gate.sql を流した後の確認（読み取りだけ。何も書き換えません）
-- Supabase の SQL Editor に貼って Run。
--
-- ログイン中の人を、auth.uid() を差し替えて再現します（set_config は、この実行の中だけ有効）。
-- 退職者として扱う人ごとに、権限関数が false / null を返すことを確かめます。
--
-- 【合格条件】
--   結果の表（A）…「退職者」の行は すべて 判定が NG ではない（列「結果」がすべて OK）
--   結果の表（B）…「在籍」の行は、権限関数が 120 の前と変わらない（owner は true のまま）
--   結果の表（C）…active の人数が、check_left_gate_before.sql の 3) と同じ

drop table if exists _lg;
create temp table _lg (区分 text, 氏名 text, 状態 text, 退職日 date, owner boolean, hr boolean, hr_app boolean,
                       名簿の自分の行 boolean, 内部管理側 boolean, 会計管理側 boolean, 退職者判定 boolean, 結果 text);

do $$
declare
  r record;
  v_owner boolean; v_hr boolean; v_app boolean; v_emp boolean; v_int boolean; v_staff boolean; v_left boolean;
begin
  for r in
    select e.id, e.tenant_id, e.user_id, e.display_name, e.status, e.left_on,
           public.gw_employee_is_left(e.status, e.left_on) as is_left
      from public.gw_employees e
     where e.user_id is not null
  loop
    perform set_config('request.jwt.claim.sub', r.user_id::text, true);
    v_owner := public.gw_has_role(r.tenant_id, 'owner');
    v_hr    := public.gw_is_hr(r.tenant_id);
    v_app   := public.gw_has_app(r.tenant_id, 'hr');
    v_emp   := public.gw_employee_id(r.tenant_id) is not null;
    v_int   := public.gw_is_internal_staff();
    v_staff := public.is_tenant_staff(r.tenant_id);
    v_left  := public.gw_me_is_left();
    insert into _lg values (
      case when r.is_left then '退職者' else '在籍' end,
      r.display_name, r.status, r.left_on, v_owner, v_hr, v_app, v_emp, v_int, v_staff, v_left,
      case
        when r.is_left and (v_owner or v_hr or v_app or v_emp or v_int or v_staff or not v_left) then 'NG'
        when not r.is_left and v_left then 'NG'
        else 'OK'
      end);
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- A) 退職者として扱う人：すべて false になり、結果が OK
select * from _lg where 区分 = '退職者' order by 氏名;

-- B) 在籍の人：権限は変わらない（owner の人は owner = true のまま）
select * from _lg where 区分 = '在籍' order by owner desc, 氏名;

-- C) NG の件数（0 なら合格）と、在籍状態ごとの人数
select count(*) filter (where 結果 = 'NG') as ng件数 from _lg;
select status, count(*) as 人数 from public.gw_employees group by status order by status;
