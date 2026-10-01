-- =============================================================================
-- 100: 応募者・合格通知の給与を、専用の表へ分ける（給与分離 案A の第1段）
--
--   ■ なぜ
--     RLS は「行」を隠せても「列」は隠せない。gw_hr_applicants / gw_hr_offers に
--     給与（wage_type・wage_amount）が入っている限り、採用HRを使える人
--     （採用担当・責任者）は、ブラウザから直接 DB を叩いて給与を読める。
--     API で隠しても、DB から読めれば意味がない（api 側の保護は lib/salary.js）。
--     給与を別の表に置き、その表を「給与を見られる人」だけの RLS にする。
--
--   ■ 見られる人（gw_can_see_salary）
--     段階1: 人事・管理者・経営者（= gw_is_hr）。lib/gw.js の canSeeSalary と同じ条件
--     段階2: 経営者だけ。この関数の本体を gw_is_owner に差し替えるだけ（下の「段階2」）
--     採用担当・責任者・経理・IT・営業は、どちらの段階でも読めない
--
--   ■ 前提
--     081（gw_hr_applicants / gw_hr_offers）と、005・099（gw_is_hr / gw_is_owner）。
--     035・041・094 が本番に当たっているかには依存しない。
--
-- ■ 適用の順序（この順に。途中で止めても、動きは変わらない）
--     ① この SQL を流す。表と関数ができ、いまの給与が写される（元の列はそのまま）
--        → アプリの動きは変わらない（環境変数 HR_PAY_SPLIT が未設定のあいだは、元の列を使う）
--     ② 下の「C. 突き合わせ」で、元の列と新しい表が一致していることを確かめる
--     ③ Vercel の環境変数に HR_PAY_SPLIT=1 を入れて再デプロイ
--        → アプリが給与を新しい表から読み書きする。元の列は読まない・書かない
--     ④ 動作を確かめたら、db/101_hr_pay_clear.sql で元の列を空にする
--        → ここで初めて、採用担当・責任者が DB から給与を読めなくなる
--     ※ ③のあと④の前に元の列へ書き込みが入ると、新しい表とずれる。③と④の間は短くする
--
-- ■ 実行方法: Supabase の SQL Editor に貼って Run（べき等）
--
-- ■ A. 事前確認（読み取りだけ）
--   -- A-1. 給与が入っている行の数
--   select (select count(*) from public.gw_hr_applicants where wage_type is not null or wage_amount is not null) as applicants,
--          (select count(*) from public.gw_hr_offers      where wage_type is not null or wage_amount is not null) as offers;
--   -- A-2. gw_is_hr の定義（041 が当たっていれば管理者を含む）
--   select pg_get_functiondef('public.gw_is_hr(uuid)'::regprocedure);
--
-- ■ B. 適用後の確認（読み取りだけ）
--   select count(*) from public.gw_hr_pay;      -- A-1 の applicants + offers と同じ
--   select proname from pg_proc where proname = 'gw_can_see_salary';   -- 1行
--
-- ■ C. 突き合わせ（0行なら一致。③の前に必ず見る）
--   select 'applicant' as kind, a.id, a.wage_type, a.wage_amount, p.wage_type as pay_type, p.wage_amount as pay_amount
--     from public.gw_hr_applicants a
--     left join public.gw_hr_pay p on p.applicant_id = a.id and p.offer_id is null
--    where (a.wage_type is not null or a.wage_amount is not null)
--      and (p.id is null or a.wage_type is distinct from p.wage_type or a.wage_amount is distinct from p.wage_amount)
--   union all
--   select 'offer', o.id, o.wage_type, o.wage_amount, p.wage_type, p.wage_amount
--     from public.gw_hr_offers o
--     left join public.gw_hr_pay p on p.offer_id = o.id
--    where (o.wage_type is not null or o.wage_amount is not null)
--      and (p.id is null or o.wage_type is distinct from p.wage_type or o.wage_amount is distinct from p.wage_amount);
--
-- ■ D. 元に戻す（③の前なら、これだけ）
--   drop table if exists public.gw_hr_pay;
--   drop function if exists public.gw_can_see_salary(uuid);
--   ※ ④のあとで戻すときは、先に pay から元の列へ書き戻すこと（db/101 の冒頭に書いてある）
--
-- ■ 段階2（経営者だけ）にするとき
--   create or replace function public.gw_can_see_salary(p_tenant uuid) ... select public.gw_is_owner(p_tenant)
--   あわせて、環境変数 SALARY_OWNER_ONLY=1（アプリ側）。両方そろえること。
-- =============================================================================

begin;

-- 1) 給与を見られる人（DB側）。段階1は gw_is_hr
create or replace function public.gw_can_see_salary(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_is_hr(p_tenant)
$$;

comment on function public.gw_can_see_salary(uuid) is
  '給与を、他人の分も含めて見られる人。段階1: 人事・管理者・経営者（gw_is_hr）。'
  '段階2: 経営者だけ（gw_is_owner に差し替える）。lib/gw.js の canSeeSalary と同じ条件。';

-- 2) 応募者・合格通知の給与
--    offer_id が null の行は「応募者の現在の条件」、入っている行は「その版の合格通知の条件」。
--    合格通知は版ごとに残す（送付済みの内容を後から変えない）ので、1版につき1行。
create table if not exists public.gw_hr_pay (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  applicant_id uuid not null references public.gw_hr_applicants(id) on delete cascade,
  offer_id     uuid references public.gw_hr_offers(id) on delete cascade,
  wage_type    text,
  wage_amount  numeric(12, 2),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists uq_gw_hr_pay_applicant
  on public.gw_hr_pay(applicant_id) where offer_id is null;
create unique index if not exists uq_gw_hr_pay_offer
  on public.gw_hr_pay(offer_id) where offer_id is not null;
create index if not exists idx_gw_hr_pay_tenant
  on public.gw_hr_pay(tenant_id);

comment on table public.gw_hr_pay is
  '応募者・合格通知の給与。給与を見られる人（gw_can_see_salary）だけが読める。'
  '採用担当・責任者は読めない。書き込みは service_role の API だけ（lib/hr-pay.js）。';

alter table public.gw_hr_pay enable row level security;

-- 読み取りだけ。書き込みのポリシーは置かない（service_role の API だけが書く）
drop policy if exists gw_hr_pay_select on public.gw_hr_pay;
create policy gw_hr_pay_select on public.gw_hr_pay
  for select to authenticated
  using (public.gw_can_see_salary(tenant_id));

-- 3) いまの給与を写す（元の列は、そのまま残す。何度流しても、足りない行だけが入る）
insert into public.gw_hr_pay (tenant_id, applicant_id, offer_id, wage_type, wage_amount)
select a.tenant_id, a.id, null, a.wage_type, a.wage_amount
  from public.gw_hr_applicants a
 where (a.wage_type is not null or a.wage_amount is not null)
   and not exists (
     select 1 from public.gw_hr_pay p where p.applicant_id = a.id and p.offer_id is null
   );

insert into public.gw_hr_pay (tenant_id, applicant_id, offer_id, wage_type, wage_amount)
select o.tenant_id, o.applicant_id, o.id, o.wage_type, o.wage_amount
  from public.gw_hr_offers o
 where (o.wage_type is not null or o.wage_amount is not null)
   and not exists (
     select 1 from public.gw_hr_pay p where p.offer_id = o.id
   );

notify pgrst, 'reload schema';

commit;
