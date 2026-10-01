-- =============================================================================
-- 103: 業務ツール（HR・Sales・Office・経営）の権限を、DB でも、アプリと同じ並びにする
--
--   HR     … 経営者・責任者・人事・採用担当   （gw_is_recruiting に責任者を加える）
--   Sales  … 経営者・責任者・営業担当          （gw_is_sales。db/094 のまま）
--   Office … 経営者・責任者・経理              （gw_is_office を新設。表はまだ無い。判定だけ先に置く）
--   経営   … 経営者だけ                        （gw_is_owner。db/099）
--
--   lib/gw.js の RECRUIT_ROLES / SALES_ROLES / OFFICE_ROLES / KEIEI_ROLES と同じ並び
--   （test/accessparity.mjs が、この SQL と lib/gw.js が一致していることを見張る）。
--
-- ■ 順序（先にこれを満たすこと。満たしていないと、この SQL は何も変えずに止まる）
--     db/099（gw_is_owner）と db/101（応募者・合格通知の元の列の給与を空にして書けなくする）
--
--   なぜ 101 が先か:
--     責任者は、採用HRを使えるようになると、応募者・合格通知の表を（RLS で）読める。
--     元の列に給与が残っていると、ブラウザから直接 DB を叩いて、責任者が候補者の給与を読める。
--     給与は gw_hr_pay へ移してあり、そこは責任者には読めない（db/100）。
--     元の列を空にしてから、責任者を加える。
--
-- ■ 適用のタイミング
--     責任者を HR に加えるアプリ側の変更（lib/gw.js の RECRUIT_ROLES）は、すでに入っている。
--     この SQL を流すまでは、責任者は HR を開けても、DB が何も返さない（空に見える）。
--     給与は API でも外している（lib/salary.js）ので、どちらの順でも給与は漏れない。
--
-- ■ 元に戻す
--   create or replace function public.gw_is_recruiting(p_tenant uuid) ... owner / hr / recruiter だけ
--
-- ■ 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

begin;

do $$
begin
  if to_regprocedure('public.gw_is_owner(uuid)') is null then
    raise exception 'gw_is_owner がありません。先に db/099_owner_only.sql を流してください';
  end if;
  if to_regclass('public.gw_hr_pay') is null then
    raise exception 'gw_hr_pay がありません。先に db/100_hr_pay.sql を流してください';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_applicants_wage_moved')
     or not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_wage_moved') then
    raise exception '責任者を採用HRに加える前に、db/101_hr_pay_clear.sql を流してください（応募者・合格通知の元の列に給与が残っていると、責任者が DB から直接読めてしまいます）';
  end if;
end $$;

-- HR: 経営者・責任者・人事・採用担当（会計の管理者・IT・管理は含めない）
create or replace function public.gw_is_recruiting(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'manager')
      or public.gw_has_role(p_tenant, 'hr')
      or public.gw_has_role(p_tenant, 'recruiter')
$$;

comment on function public.gw_is_recruiting(uuid) is
  'HR（/hr）を使える人。社内権限の owner・manager・hr・recruiter だけ（lib/gw.js の RECRUIT_ROLES）。'
  '給与は見えない（応募者・合格通知の給与は gw_hr_pay。gw_can_see_salary だけが読める）。';

-- Office: 経営者・責任者・経理。Office の表はまだ無い（受注後の実務の画面を作るときに使う）
create or replace function public.gw_is_office(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'owner')
      or public.gw_has_role(p_tenant, 'manager')
      or public.gw_has_role(p_tenant, 'finance')
$$;

comment on function public.gw_is_office(uuid) is
  'Office を使える人。社内権限の owner・manager・finance だけ（lib/gw.js の OFFICE_ROLES）。';

notify pgrst, 'reload schema';

commit;
