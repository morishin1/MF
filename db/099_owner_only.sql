-- =============================================================================
-- 099: 経営者（owner）専用の権限
--
--   経営（/keiei）に入れるのは owner だけ。その owner を、管理者・人事が
--   自分に付けたり、外したり、乗っ取ったりできないようにする。
--   （アプリ側の入口は api/employees/*.js と lib/owner-guard.js。
--    ここは、ブラウザから直接 DB を叩かれても破れないようにする最後の砦）
--
--   1) gw_is_owner(tenant)         … owner だけを表す関数（is_tenant_staff・人事を含めない）
--   2) gw_role_grants の RLS       … owner の行の付与・剥奪は owner だけ
--   3) 最後の owner の保護トリガ    … 在籍中の owner を0人にする削除・変更を止める
--   4) owner 変更履歴のトリガ       … gw_activity_log に owner.granted / owner.revoked を残す
--   5) gw_employees の保護トリガ    … owner の社員行（user_id・状態・メール）を owner 以外が変えられない
--
-- ■ 前提（この SQL が依存するもの）
--   005_groupware_core.sql だけ（gw_role_grants / gw_employees / gw_activity_log /
--   gw_has_role / gw_is_hr）。035・041・094 が本番に当たっているかどうかには依存しない。
--   gw_is_hr は再定義しない（041 の定義がそのまま効く）。
--
-- ■ 実行方法
--   Supabase の SQL Editor に貼って Run（べき等。何度流しても同じ）。
--   流す前に、下の「A. 事前確認」を実行して、結果を確かめること。
--
-- ■ A. 事前確認（読み取りだけ。先に流して結果を見る）
--
--   -- A-1. owner が何人いて、在籍中か（0人なら、このあと誰も owner を付けられなくなる）
--   select e.display_name, e.email, e.status
--     from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
--    where g.role = 'owner' order by e.display_name;
--
--   -- A-2. いまの gw_is_hr の定義（041 が当たっていれば is_tenant_staff を含む）
--   select pg_get_functiondef('public.gw_is_hr(uuid)'::regprocedure);
--
--   -- A-3. gw_role_grants の現在のポリシー
--   select polname, pg_get_expr(polqual, polrelid) as using_expr,
--          pg_get_expr(polwithcheck, polrelid) as check_expr
--     from pg_policy where polrelid = 'public.gw_role_grants'::regclass;
--
-- ■ B. 適用後の確認（読み取りだけ）
--
--   select proname from pg_proc
--    where proname in ('gw_is_owner','gw_role_grants_guard','gw_role_grants_owner_audit','gw_employees_owner_guard');
--   -- → 4行
--   select tgname from pg_trigger
--    where tgname in ('gw_role_grants_guard_trg','gw_role_grants_owner_audit_trg','gw_employees_owner_guard_trg');
--   -- → 3行
--   select polname, pg_get_expr(polqual, polrelid) from pg_policy
--    where polrelid = 'public.gw_role_grants'::regclass and polname = 'gw_role_grants_hr_write';
--   -- → using に gw_is_owner が入っている
--
-- ■ C. 元に戻す（必要なときだけ）
--
--   drop trigger if exists gw_role_grants_guard_trg on public.gw_role_grants;
--   drop trigger if exists gw_role_grants_owner_audit_trg on public.gw_role_grants;
--   drop trigger if exists gw_employees_owner_guard_trg on public.gw_employees;
--   drop policy if exists gw_role_grants_hr_write on public.gw_role_grants;
--   create policy gw_role_grants_hr_write on public.gw_role_grants
--     for all using (public.gw_is_hr(tenant_id)) with check (public.gw_is_hr(tenant_id));
--
-- ■ D. owner が誰もいなくなったとき（復旧）
--   このトリガは「消す・変える」だけを止める。付けるのは止めない。
--   SQL Editor（RLS を通らない）から、在籍中の人に付け直せる。
--
--   insert into public.gw_role_grants (tenant_id, employee_id, role)
--   select e.tenant_id, e.id, 'owner'
--     from public.gw_employees e where e.email = 'ここに経営者のメール'
--   on conflict (employee_id, role) do nothing;
-- =============================================================================

begin;

-- 1) owner だけ。管理者（is_tenant_staff）・人事は含めない
create or replace function public.gw_is_owner(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
$$;

comment on function public.gw_is_owner(uuid) is
  '経営者（owner）だけ。経営（/keiei）と、owner の付与・剥奪の判定。'
  '会計の管理者・人事・責任者・採用担当・経理は含めない（lib/gw.js の canKeiei と同じ条件）。';

-- 2) gw_role_grants: owner の行を付け外しできるのは owner だけ。
--    ほかのロールは、これまでどおり人事権限（gw_is_hr）で付け外しできる。
--    読み取りは別ポリシー（gw_role_grants_select）のまま
drop policy if exists gw_role_grants_hr_write on public.gw_role_grants;
create policy gw_role_grants_hr_write on public.gw_role_grants
  for all
  using (
    public.gw_is_hr(tenant_id)
    and (role <> 'owner' or public.gw_is_owner(tenant_id))
  )
  with check (
    public.gw_is_hr(tenant_id)
    and (role <> 'owner' or public.gw_is_owner(tenant_id))
  );

-- 3) 最後の（在籍中の）owner を0人にさせない。
--    RLS を通らない経路（SQL Editor・service_role）でも止まる。
--    社員の削除による cascade で owner の行が消えるときも、ここで止まる。
--    テナントごと消えるとき（cascade）は止めない。
create or replace function public.gw_role_grants_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed   boolean;
  v_active    boolean;
  v_remaining int;
begin
  if old.role <> 'owner' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- owner の行が「なくなる」変更か（削除・別ロールへの変更・別の人への付け替え）
  if tg_op = 'DELETE' then
    v_removed := true;
  else
    v_removed := (new.role <> 'owner') or (new.employee_id <> old.employee_id) or (new.tenant_id <> old.tenant_id);
  end if;
  if not v_removed then
    return new;
  end if;

  -- テナントごと消えている最中は止めない
  if not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- 外れる人が在籍中か。名簿の行が既に無い（社員削除の cascade）ときは在籍中とみなす
  select (e.status not in ('leaving', 'left')) into v_active
    from public.gw_employees e where e.id = old.employee_id;
  if v_active is false then
    -- もともと在籍していない人を外しても、在籍中の人数は減らない
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select count(*) into v_remaining
    from public.gw_role_grants g
    join public.gw_employees e on e.id = g.employee_id
   where g.tenant_id = old.tenant_id
     and g.role = 'owner'
     and g.id <> old.id
     and e.status not in ('leaving', 'left');

  if v_remaining = 0 then
    raise exception 'last_owner: 在籍中の経営者（owner）を0人にはできません。先に、ほかの人に owner を付けてください'
      using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$$;

drop trigger if exists gw_role_grants_guard_trg on public.gw_role_grants;
create trigger gw_role_grants_guard_trg
  before delete or update on public.gw_role_grants
  for each row execute function public.gw_role_grants_guard();

-- 4) owner の付与・剥奪の履歴。API を通らない変更（SQL Editor・ブラウザからの直接）も残る。
--    アプリ側の記録（owner.grant / owner.revoke）は「誰が何をしようとしたか」、
--    こちら（owner.granted / owner.revoked）は「実際に DB で何が変わったか」。
create or replace function public.gw_role_grants_owner_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      insert into public.gw_activity_log (tenant_id, actor_id, action, target, detail)
      values (new.tenant_id, auth.uid(), 'owner.granted', 'employee:' || new.employee_id,
              jsonb_build_object('via', 'db', 'granted_by', new.granted_by));
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.role = 'owner' then
      insert into public.gw_activity_log (tenant_id, actor_id, action, target, detail)
      values (old.tenant_id, auth.uid(), 'owner.revoked', 'employee:' || old.employee_id,
              jsonb_build_object('via', 'db'));
    end if;
    return old;
  else
    if (old.role = 'owner') is distinct from (new.role = 'owner') then
      insert into public.gw_activity_log (tenant_id, actor_id, action, target, detail)
      values (new.tenant_id, auth.uid(),
              case when new.role = 'owner' then 'owner.granted' else 'owner.revoked' end,
              'employee:' || new.employee_id,
              jsonb_build_object('via', 'db', 'from', old.role, 'to', new.role));
    end if;
    return new;
  end if;
end
$$;

drop trigger if exists gw_role_grants_owner_audit_trg on public.gw_role_grants;
create trigger gw_role_grants_owner_audit_trg
  after insert or update or delete on public.gw_role_grants
  for each row execute function public.gw_role_grants_owner_audit();

-- 5) owner の社員行を、owner 以外が変えられないようにする。
--    gw_employees_hr_write は人事が他人の行を全部書けるので、そのままだと
--    owner の user_id を自分のものに書き換えて、owner になりすませてしまう。
--    サービス（API・SQL Editor）は auth.uid() が null なので、ここでは止めない
--    （API 側は lib/owner-guard.js が同じ内容を守る）。
create or replace function public.gw_employees_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_is_owner  boolean;
  v_remaining int;
begin
  if v_uid is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select exists (
    select 1 from public.gw_role_grants g
     where g.employee_id = old.id and g.role = 'owner'
  ) into v_is_owner;
  if not v_is_owner then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    if not public.gw_is_owner(old.tenant_id) then
      raise exception 'owner_only: 経営者の名簿の削除は、経営者だけができます' using errcode = '42501';
    end if;
    return old;   -- 最後の owner かどうかは gw_role_grants_guard（cascade）が見る
  end if;

  -- UPDATE: ログインの紐づけ・在籍状態・メール・所属テナントは、owner だけが変えられる
  if new.user_id is distinct from old.user_id
     or new.status is distinct from old.status
     or new.email is distinct from old.email
     or new.tenant_id is distinct from old.tenant_id then
    if not public.gw_is_owner(old.tenant_id) then
      raise exception 'owner_only: 経営者の名簿（ログイン・在籍状態・メール）の変更は、経営者だけができます'
        using errcode = '42501';
    end if;
  end if;

  -- 最後の（在籍中の）owner を、退職にして締め出さない
  if new.status in ('leaving', 'left') and old.status not in ('leaving', 'left') then
    select count(*) into v_remaining
      from public.gw_role_grants g
      join public.gw_employees e on e.id = g.employee_id
     where g.tenant_id = old.tenant_id
       and g.role = 'owner'
       and g.employee_id <> old.id
       and e.status not in ('leaving', 'left');
    if v_remaining = 0 then
      raise exception 'last_owner: 在籍中の経営者（owner）を0人にはできません。先に、ほかの人に owner を付けてください'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists gw_employees_owner_guard_trg on public.gw_employees;
create trigger gw_employees_owner_guard_trg
  before update or delete on public.gw_employees
  for each row execute function public.gw_employees_owner_guard();

notify pgrst, 'reload schema';

commit;
