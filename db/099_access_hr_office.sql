-- =============================================================================
-- 099: HR・Sales・Office の利用権限をそろえる
--
-- ■ 何を変えるか
--   1) gw_is_recruiting（採用HR /hr）に manager（責任者）を加える
--        採用HR … owner（経営者）・manager（責任者）・hr（人事）・recruiter（採用担当）
--      経営者と責任者は HR・Sales・Office のすべてを使える、という運用に合わせる。
--      責任者が使えるのは採用HRの画面まで。採用判断（社長推薦の最終判断）は
--      lib/gw.js の canDecideHire のとおり、経営者・管理者だけのまま。
--
--   2) gw_is_office（月末月初業務 /office）を新設する
--        Office … owner（経営者）・manager（責任者）・finance（経理）
--      新しいロールは作らない。メンバー管理にある既存の「経理」（finance）を使う。
--      gw_role_grants.role の CHECK は、finance・manager とも db/088 で許可済みなので変えない。
--      Office の新しい表は、この関数で読み書きを絞る（表を作る 100 番台の migration 側で使う）。
--
-- ■ API と同じ条件
--   lib/gw.js の HR_ROLES / SALES_ROLES / OFFICE_ROLES（canAccessHr / canAccessSales /
--   canAccessOffice）と同じ役割の並び。/api/me の access・ヘッダーの近道・各画面の入口・
--   /api/office/* も、同じ判定を使う。test/accessparity.mjs が、この並びの一致を機械で見る。
--
-- ■ 会計側の管理者（memberships の admin / staff）・IT・管理・社労士は含めない
--   どの関数にも is_tenant_staff / gw_is_hr / 'it' / 'labor_advisor' を入れない。
--   採用HRには個人情報、Office には単価・請求額・支払などの金額情報があるため、
--   担当の権限（社内権限のチェック）を付けた人だけにする。
--
-- ■ 変えないもの
--   ・gw_is_sales（db/094 のまま。owner・manager・sales）
--   ・gw_is_hr（人事の台帳・入退社など。会計の管理者は人事の仕事を引き続きできる）
--   ・月初作業管理の既存の表（gw_site_contracts / gw_billing_progress /
--     gw_submission_links / gw_submissions）の RLS。
--     いまは is_tenant_staff、月初作業管理の API は canManageHr（管理者・人事・経営者）で、
--     範囲が完全には一致しない。どちらの向きにそろえるかは、月初作業管理を /office に
--     統合するときに決める（そのとき、単価・請求額を見られる人を Office の権限に絞る）。
--   関数の名前と引数は変えないので、既存の RLS ポリシーは作り直さなくてよい。
--
-- ■ 適用の順番（重要）
--   この SQL を先に流し、そのあとでアプリをデプロイする。
--   逆にすると、責任者がアプリでは採用HRに入れるのに、DB が 0 件を返す期間ができる。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081_hr_recruiting.sql・088_sales.sql・094_recruit_sales_roles.sql（gw_has_role・gw_is_recruiting）
-- =============================================================================

begin;

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
  '採用HR（/hr）を使える人。社内権限の owner（経営者）・manager（責任者）・hr（人事）・recruiter（採用担当）だけ。'
  '会計側の管理者・IT・管理・社労士だけでは使えない（db/094・db/099。lib/gw.js canAccessHr と同じ）';

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
  '月末月初業務（/office）を使える人。社内権限の owner（経営者）・manager（責任者）・finance（経理）だけ。'
  '会計側の管理者・人事・IT・管理・社労士だけでは使えない（db/099。lib/gw.js canAccessOffice と同じ）';

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後）: 誰が HR・Sales・Office を使える状態か（lib/gw.js と同じ条件）
--
--   select e.display_name,
--          coalesce(string_agg(g.role, ', ' order by g.role), '（なし）')      as 社内権限,
--          bool_or(g.role in ('owner', 'manager', 'hr', 'recruiter'))          as hr,
--          bool_or(g.role in ('owner', 'manager', 'sales'))                    as sales,
--          bool_or(g.role in ('owner', 'manager', 'finance'))                  as office
--     from public.gw_employees e
--     left join public.gw_role_grants g on g.employee_id = e.id
--    where e.status in ('active', 'leaving', 'invited')
--    group by e.display_name
--    order by 1;
--
-- 確認2（適用後・ログインした状態で）: 自分が Office 扱いか
--
--   select public.gw_is_office(tenant_id) as office, display_name
--     from public.gw_employees where user_id = auth.uid();
