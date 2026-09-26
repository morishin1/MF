-- =============================================================================
-- 076: SES現場契約マスター（社員/BP → 現場契約）
--
-- ■ 人員マスターとは分離しすぎない
--
--   「誰が誰か」（プロパーかBPか、どのパートナー企業か）は gw_employees /
--   gw_partner_companies（db/075）がすでに持っている。ここへ寄せるのは
--   「その人が、いまどの現場に、どんな条件で入っているか」だけ。
--   employee_id 1本で人員マスターにぶら下げる（新しい人の表は作らない）。
--
-- ■ 最小構成
--
--   画面項目を増やしすぎない、という方針のとおり、まずはこれだけ:
--     PP/BP区分・所属会社（常駐先）・上位会社・契約開始/終了・単価・
--     精算条件・契約更新状態
--
--   請求書そのもの（Board作成・送付・BP請求書受領）は、ここでは扱わない
--   （優先5・月次請求進捗で、この表の行を追って進捗を持つ）。
--
-- ■ 機微情報
--
--   単価・精算条件は、本人には見せない情報（他の社員の給与を見せないのと同じ）。
--   読み書きとも is_tenant_staff（memberships が admin/staff の人）だけに絞る。
--   本人にも社労士にも見せない。
--
--   is_tenant_staff は「管理者・人事」限定ではなく、社内スタッフ全員（admin/staff）を通す。
--   075（gw_partner_companies）の書き込み側は gw_is_hr を使っているが、
--   gw_is_hr は hr/owner の権限付与 OR is_tenant_staff の合成（041_admin_is_hr.sql）で、
--   is_tenant_staff の上位互換（緩いほう）でしかない。したがって is_tenant_staff だけに
--   絞るここでの書き方のほうが、実効的には075よりわずかに狭い。
--   「人事だけ」に本当に絞りたい場合は、いまの2関数では表現できず、
--   新しいRLS関数が要る（このマイグレーションでは作っていない）
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 075_partner_bp.sql（is_tenant_staff / gw_is_hr は既存のRLS関数を再利用）
-- =============================================================================

create table if not exists public.gw_site_contracts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,

  -- PP（自社プロパーの常駐）か BP（協力会社所属の常駐）か。
  -- employee_kind と食い違うこともあり得るので（BP企業所属でも自社案件のみのケース等）、
  -- 契約ごとに持たせる。既定は employee_kind に合わせて画面側で選ばせる
  engagement_kind text not null default 'bp'
    check (engagement_kind in ('pp', 'bp')),

  site_company    text not null,   -- 所属会社（常駐先・客先企業名）
  prime_company   text,            -- 上位会社（多次請けのときの直上の契約相手。1次請けなら空でよい）

  period_from date not null,
  period_to   date,                -- 未定なら空

  unit_price      numeric(12, 2),
  unit_price_type text not null default '月額'
    check (unit_price_type in ('月額', '時給', '日給')),
  -- 精算条件（例: "140h〜180h、超過1,500円/控除1,200円"）。まずは自由記述で十分
  settlement_condition text,

  renewal_status text not null default 'pending'
    check (renewal_status in ('pending', 'confirmed', 'ending', 'renewed')),

  note text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gw_site_contracts is
  '社員/BPの現場常駐契約。1人に複数（現場を移るたびに増える）。'
  'いま有効なものは period_to と renewal_status で判る';
comment on column public.gw_site_contracts.engagement_kind is
  'pp=自社プロパーの常駐 / bp=協力会社所属の常駐';
comment on column public.gw_site_contracts.site_company is
  '所属会社（常駐先・客先企業名）';
comment on column public.gw_site_contracts.prime_company is
  '上位会社（多次請けのときの直上の契約相手）。1次請けなら空でよい';
comment on column public.gw_site_contracts.renewal_status is
  'pending=未確認 / confirmed=更新確認済み・継続 / ending=終了予定 / renewed=更新手続き済み';

create index if not exists idx_gw_site_contracts_employee
  on public.gw_site_contracts(employee_id, period_from desc);
create index if not exists idx_gw_site_contracts_tenant
  on public.gw_site_contracts(tenant_id);
-- 契約終了が近い順に見る（優先3の45日前アラートと、優先5の月次進捗が使う）
create index if not exists idx_gw_site_contracts_period_to
  on public.gw_site_contracts(tenant_id, period_to) where period_to is not null;

-- -----------------------------------------------------------------------------
-- RLS：単価・精算条件は機微情報。社内スタッフ（admin/staff）だけ
-- -----------------------------------------------------------------------------
alter table public.gw_site_contracts enable row level security;

drop policy if exists gw_site_contracts_staff on public.gw_site_contracts;
create policy gw_site_contracts_staff on public.gw_site_contracts
  for all
  using (public.is_tenant_staff(tenant_id))
  with check (public.is_tenant_staff(tenant_id));

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, c.engagement_kind, c.site_company, c.prime_company,
--          c.period_from, c.period_to, c.unit_price, c.renewal_status
--     from public.gw_site_contracts c
--     join public.gw_employees e on e.id = c.employee_id
--    order by c.period_to nulls last;
