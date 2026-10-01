-- =============================================================================
-- 102: 契約（gw_contracts）の給与を、「給与を見られる人」と本人だけが読めるようにする
--
--   gw_contracts には賃金（wage_type・wage_amount・wage_note）が入っている。
--   db/029 の最初の RLS は gw_is_internal_staff（責任者を含む）で、db/035 で
--   「人事と本人」に絞られた。035 が本番に当たっているか分からなくても効くよう、
--   ここで、同じ絞り込みを（035 に依存せず）もう一度言い直す。
--   条件は gw_can_see_salary（db/100）。段階2で経営者だけにする切り替えは、
--   gw_can_see_salary の1か所を差し替えるだけで、この表にも効く。
--
-- ■ 前提: db/100（gw_can_see_salary）。gw_contracts が無い環境では、何もしない
-- ■ 効果: 責任者が、ブラウザから直接 gw_contracts の賃金を読む道を塞ぐ
--         （api/contracts などは service_role で読むので、影響しない）
-- ■ 元に戻す: create policy gw_contracts_select ... using (public.gw_is_hr(tenant_id) or employee_id = public.gw_employee_id(tenant_id));
-- ■ 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

do $$
begin
  if to_regclass('public.gw_contracts') is null then
    raise notice 'gw_contracts がまだ無いので、何もしません（db/029 を流したあとに、もう一度）';
    return;
  end if;
  if to_regprocedure('public.gw_can_see_salary(uuid)') is null then
    raise exception 'gw_can_see_salary がありません。先に db/100_hr_pay.sql を流してください';
  end if;

  drop policy if exists gw_contracts_select on public.gw_contracts;
  create policy gw_contracts_select on public.gw_contracts
    for select to authenticated
    using (
      public.gw_can_see_salary(tenant_id)
      or employee_id = public.gw_employee_id(tenant_id)
    );
end $$;

notify pgrst, 'reload schema';
