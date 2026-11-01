-- 157: Office 備品・契約の更新月管理（既存 gw_assets を拡張）
-- 適用: Supabase SQL Editor で本ファイルを実行後、アプリをデプロイ。
-- 注意: 実際の電話番号・請求情報は公開リポジトリに保存しない。画面から非公開で取り込む。
alter table public.gw_assets
  add column if not exists vendor text,
  add column if not exists monthly_fee_ex_tax numeric(12,2),
  add column if not exists renewal_month date,
  add column if not exists renewal_confidence text not null default 'unconfirmed',
  add column if not exists contract_note text;

-- renewals are stored as the first calendar day of the relevant month; not an automatic charge/expiration date.
alter table public.gw_assets
  drop constraint if exists gw_assets_renewal_confidence_check;
alter table public.gw_assets
  add constraint gw_assets_renewal_confidence_check
  check (renewal_confidence in ('unconfirmed','estimated','confirmed'));
alter table public.gw_assets
  drop constraint if exists gw_assets_monthly_fee_check;
alter table public.gw_assets
  add constraint gw_assets_monthly_fee_check
  check (monthly_fee_ex_tax is null or monthly_fee_ex_tax >= 0);
alter table public.gw_assets
  drop constraint if exists gw_assets_renewal_first_of_month;
alter table public.gw_assets
  add constraint gw_assets_renewal_first_of_month
  check (renewal_month is null or extract(day from renewal_month) = 1);

create index if not exists idx_gw_assets_renewal
  on public.gw_assets (tenant_id, renewal_month)
  where renewal_month is not null;

comment on column public.gw_assets.renewal_month is
  '更新対象月の1日。契約書未確認の推定月も格納可。renewal_confidence と合わせて表示し、解約申出期限とは混同しない。';
comment on column public.gw_assets.renewal_confidence is
  'unconfirmed=未確認、estimated=請求書等からの目安、confirmed=契約書/キャリア確認済み。';
comment on column public.gw_assets.monthly_fee_ex_tax is
  '該当品目の月額税抜目安。請求書総額と一致するとは限らない。';
