-- =============================================================================
-- 106: 契約条件（単価・精算条件）— gw_site_contract_terms
--
-- ■ なぜ新しい表か（gw_site_contracts.unit_price は使わない）
--   gw_site_contracts.unit_price / settlement_condition は、いま入っている値の意味が確定していない
--   （客先への売上単価か、BP・外注への仕入単価か、混在しているか）。Phase 3 の計算では使わない。
--   その列は変更も削除も自動の移行もしない。意味を確かめたものだけ、あとで新しい列へ移す。
--
--   新しい契約条件は、この表に持つ。単価は「向き」をはっきり分ける：
--     sales_unit_price    … 客先への売上単価（こちらが請求する額の基準）
--     purchase_unit_price … BP・外注への仕入単価（こちらが支払う額の基準）
--
-- ■ 期間つき（valid_from〜valid_to）
--   月の途中で条件が変わる、契約更新で単価が変わる、を1つの契約に複数行で持つ。
--   ある月に効く行が2件以上ある場合、Office は自動で選ばず「要確認」にする（lib/office-calc.js）。
--   同じ契約で期間が重なる行は、API が登録時に断る（DB の制約にはしていない）。
--
-- ■ 精算の条件は、コードに書かず、ここから読む
--   pricing_type            monthly（月額）／ hourly（時給）／ daily（日給）
--   settlement_mode         range（精算幅あり）／ fixed（精算なし）。月額だけ必須
--   settle_min/max_minutes  精算幅の下限・上限（分。140h → 8400）
--   settle_unit_minutes     精算の単位（分）。5・10・15・30・60
--   rounding_mode / scope   単位への丸め（floor切捨て／ceil切上げ／round四捨五入 × day日ごと／month月合計）
--   over_rate_per_hour      超過単価（円／時間）。空＝未設定（要確認）、0＝超過分は精算しない
--   under_rate_per_hour     控除単価（円／時間）。同上
--   prorate                 月の一部だけ有効な条件を日割りにするか。日割り計算は Phase 3 では自動にしない
--   amount_rounding         円未満の丸め。端数が出るのに空なら、Office は金額を出さず「要確認」にする
--   仕入側（BP・外注への支払）の精算ルールは、まだ持たない（確定していない）。単価だけ持つ。
--
-- ■ RLS：読み取りだけを Office 権限（gw_is_office）に絞る
--   単価は機微情報。書き込みのポリシーは置かない（API が権限を確かめたあと、service_role で書く。
--   ブラウザから直接書き換えて、期間の重なり・入力の検査・履歴を飛ばせないようにする）。
--   gw_is_hr（人事）・会計側の管理者には読ませない。
--
-- ■ 適用の順番（重要）
--   099 → 100 → 105 → この 106 → 107 → アプリのデプロイ。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 076_site_contracts.sql、099_access_hr_office.sql（gw_is_office）
-- =============================================================================

begin;

create table if not exists public.gw_site_contract_terms (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  site_contract_id     uuid not null references public.gw_site_contracts(id) on delete cascade,

  valid_from           date not null,
  valid_to             date,
  check (valid_to is null or valid_to >= valid_from),

  pricing_type         text not null
    check (pricing_type in ('monthly', 'hourly', 'daily')),
  sales_unit_price     numeric(12, 2)
    check (sales_unit_price is null or sales_unit_price >= 0),
  purchase_unit_price  numeric(12, 2)
    check (purchase_unit_price is null or purchase_unit_price >= 0),

  settlement_mode      text
    check (settlement_mode is null or settlement_mode in ('range', 'fixed')),
  settle_min_minutes   integer
    check (settle_min_minutes is null or settle_min_minutes >= 0),
  settle_max_minutes   integer
    check (settle_max_minutes is null or settle_max_minutes >= 0),
  check (settle_min_minutes is null or settle_max_minutes is null or settle_min_minutes <= settle_max_minutes),

  settle_unit_minutes  integer
    check (settle_unit_minutes is null or settle_unit_minutes in (5, 10, 15, 30, 60)),
  rounding_mode        text
    check (rounding_mode is null or rounding_mode in ('floor', 'ceil', 'round')),
  rounding_scope       text
    check (rounding_scope is null or rounding_scope in ('day', 'month')),

  over_rate_per_hour   numeric(12, 2)
    check (over_rate_per_hour is null or over_rate_per_hour >= 0),
  under_rate_per_hour  numeric(12, 2)
    check (under_rate_per_hour is null or under_rate_per_hour >= 0),

  prorate              boolean not null default false,
  amount_rounding      text
    check (amount_rounding is null or amount_rounding in ('floor', 'ceil', 'round')),

  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.gw_site_contract_terms is
  '現場契約ごとの契約条件（期間つき）。売上単価・仕入単価・精算幅・超過／控除単価・丸め。'
  'gw_site_contracts.unit_price は意味が未確定のため使わない（db/106）';
comment on column public.gw_site_contract_terms.sales_unit_price is
  '客先への売上単価（月額なら月の単価、時給なら1時間あたり）';
comment on column public.gw_site_contract_terms.purchase_unit_price is
  'BP・外注への仕入単価（月額なら月の単価、時給なら1時間あたり）';

create index if not exists idx_gw_site_contract_terms_contract
  on public.gw_site_contract_terms(site_contract_id, valid_from desc);
create index if not exists idx_gw_site_contract_terms_tenant
  on public.gw_site_contract_terms(tenant_id);

alter table public.gw_site_contract_terms enable row level security;

drop policy if exists gw_site_contract_terms_office_select on public.gw_site_contract_terms;
create policy gw_site_contract_terms_office_select on public.gw_site_contract_terms
  for select using (public.gw_is_office(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後）: ポリシーが「読み取りだけ・Office 権限」か
--
--   select policyname, cmd, qual from pg_policies
--    where schemaname = 'public' and tablename = 'gw_site_contract_terms';
--
-- 確認2（登録後）: 契約ごとの条件（単価は Office 権限だけが見られる）
--
--   select e.display_name, c.site_company, t.valid_from, t.valid_to, t.pricing_type,
--          t.sales_unit_price, t.purchase_unit_price
--     from public.gw_site_contract_terms t
--     join public.gw_site_contracts c on c.id = t.site_contract_id
--     join public.gw_employees e on e.id = c.employee_id
--    order by e.display_name, t.valid_from;
