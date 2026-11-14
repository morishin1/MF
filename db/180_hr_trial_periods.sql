-- 180: HR 2週間実務トライアル。
-- 採用選考・有期雇用の契約/賃金を上書きしない独立記録。
-- 契約条件と報酬の正本は既存 HR/Office の契約書にある（このテーブルに重複保存しない）。
create table if not exists public.gw_hr_trial_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  applicant_id uuid not null references public.gw_hr_applicants(id) on delete cascade,
  start_on date not null,
  end_on date not null,
  status text not null default 'planned' check (status in ('planned','active','completed','cancelled')),
  basis text check (basis in ('employment','contractor')),
  onsite_limit_days integer not null default 3 check (onsite_limit_days between 0 and 14),
  agreement_checked_at timestamptz,
  agreement_checked_by uuid references auth.users(id) on delete set null,
  agreement_reference text check (char_length(coalesce(agreement_reference,''))<=500),
  kpi_description text not null default '' check (char_length(kpi_description)<=1000),
  week1_result text check (char_length(coalesce(week1_result,''))<=2000),
  week2_result text check (char_length(coalesce(week2_result,''))<=2000),
  review_scores jsonb not null default '{}'::jsonb,
  decision text check (decision in ('recommend','continue','close')),
  review_note text check (char_length(coalesce(review_note,''))<=2000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gw_hr_trial_exact_14_days check (end_on = start_on + 13),
  constraint gw_hr_trial_unique_start unique (tenant_id,applicant_id,start_on)
);
create index if not exists idx_gw_hr_trial_tenant_status
  on public.gw_hr_trial_periods(tenant_id,status,start_on desc);
create index if not exists idx_gw_hr_trial_applicant
  on public.gw_hr_trial_periods(applicant_id,created_at desc);

-- 同じテナントの応募者にしか紐づけられないよう DB 側でも検査。
-- 同一応募者が別テナントに存在する可能性は無い（ID一意）ため複合参照を設定。
create unique index if not exists gw_hr_applicants_id_tenant_unique
  on public.gw_hr_applicants(id,tenant_id);
alter table public.gw_hr_trial_periods
  drop constraint if exists gw_hr_trial_tenant_applicant_fk;
alter table public.gw_hr_trial_periods add constraint gw_hr_trial_tenant_applicant_fk
  foreign key (applicant_id,tenant_id)
  references public.gw_hr_applicants(id,tenant_id) on delete cascade;

alter table public.gw_hr_trial_periods enable row level security;
revoke all on public.gw_hr_trial_periods from anon,authenticated;
-- 閲覧のみクライアントRLSへ公開。書込はAPIのサーバ側権限チェック後にservice_roleで行う。
-- クライアント直書きを許すと契約確認・CEO判断をバイパスできるため、INSERT/UPDATEは付与しない。
grant select on public.gw_hr_trial_periods to authenticated;

drop policy if exists gw_hr_trial_select on public.gw_hr_trial_periods;
create policy gw_hr_trial_select on public.gw_hr_trial_periods for select to authenticated
  using (public.gw_is_recruiting(tenant_id));
-- INSERT/UPDATEのRLSポリシーは設けない。server/service_roleのみ更新する。
drop policy if exists gw_hr_trial_insert on public.gw_hr_trial_periods;
drop policy if exists gw_hr_trial_update on public.gw_hr_trial_periods;
-- DELETE は許可しない。終了・取消は status を更新して履歴を残す。
comment on table public.gw_hr_trial_periods is
  '採用候補者の任意の2週間有償実務トライアル。契約・賃金情報の正本は既存HR/Office。合否の自動確定はしない。';
