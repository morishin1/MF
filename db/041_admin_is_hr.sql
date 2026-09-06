-- =============================================================================
-- 041: 管理者を人事と同じ扱いにする
--
-- ■ なぜ
--   この会社にいるのは 管理者 と メンバー の2つだけ。
--   「人事」という3つ目の役を置いても、担当するのは結局その管理者になる。
--   それなのに、人事ロール（gw_role_grants の hr / owner）を持っていないと
--     ・メンバーのログイン情報を変えられない
--     ・利用中のシステムを切り替えられない
--     ・給与・人事書類・雇用契約が読めない
--   という状態になっていた。
--   管理者が自分に人事ロールを付けることすらできない（付け外しも人事限定）ので、
--   いちど詰まると、どこからも直せない。
--
-- ■ 何を変えるか
--   gw_is_hr() の中身だけ。
--   会計側で管理者（memberships.role が admin / staff）の人を、
--   人事ロールを持っている人と同じ扱いにする。
--
--   この関数は人事書類・給与・雇用契約・入社手続きなど多くの RLS が使っている。
--   1か所を直すと全部そろうので、ポリシーを1つずつ書き換えない。
--
-- ■ 変わらないもの
--   メンバー（memberships が client、または無い人）は今までどおり。
--   自分の行しか読めない。ここで開けているのは管理者だけ。
--
-- ■ 効かない範囲
--   API のうち service_role で動くものは、もともと RLS を通らない。
--   そちらは api/employees/*.js 側で canManageHr（管理者または人事）に
--   そろえてある。この SQL は「画面から直接読む」ぶんに効く。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

create or replace function public.gw_is_hr(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'hr')
      or public.gw_has_role(p_tenant, 'owner')
      -- 会計側の管理者。この会社は管理者とメンバーの2つしかいないので、
      -- 管理者は人事の仕事もする
      or public.is_tenant_staff(p_tenant)
$$;

comment on function public.gw_is_hr(uuid) is
  '人事として扱う人。人事ロール・経営者ロール、または会計側の管理者（admin / staff）。'
  '管理者とメンバーの2つしかいない運用なので、管理者を人事と同じ扱いにしている';


notify pgrst, 'reload schema';

-- 確認:
--   -- 自分が人事として扱われるか（ログインした状態で）
--   select public.gw_is_hr(tenant_id) as 人事扱い, display_name
--     from public.gw_employees where user_id = auth.uid();
--
--   -- 誰が管理者か
--   select u.email, m.role
--     from public.memberships m join auth.users u on u.id = m.user_id
--    where m.role in ('admin','staff');
