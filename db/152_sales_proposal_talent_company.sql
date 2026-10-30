-- 本人実行用。htglvascsuqkixpmclwr / public schema（MF Sales）。
-- nullable列追加のみ。既存データ・RLS・権限・既存列の型/コメントは変更しない。
-- 順序: このSQL → check_152 → MF受信/表示コード → ENGER送信コード。
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table public.gw_sales_proposals in access exclusive mode;
do $$
declare
  col record;
  existing record;
begin
  -- 変更前に両列を検証。一方でも不適合なら全体を停止する。
  for col in select * from (values
    ('talent_company_name', 'text'),
    ('talent_company_observed_at', 'timestamp with time zone')
  ) as wanted(name, type_name)
  loop
    select data_type, is_nullable, is_generated, column_default into existing
      from information_schema.columns
      where table_schema='public' and table_name='gw_sales_proposals' and column_name=col.name;
    if found and (existing.data_type <> col.type_name or existing.is_nullable <> 'YES'
        or existing.is_generated <> 'NEVER' or existing.column_default is not null) then
      raise exception 'Existing public.gw_sales_proposals.% has incompatible type/nullability/default/generated definition; no change made', col.name;
    end if;
  end loop;

  if not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='gw_sales_proposals' and column_name='talent_company_name') then
    alter table public.gw_sales_proposals add column talent_company_name text;
    comment on column public.gw_sales_proposals.talent_company_name is
      'ENGER candidate_idで特定したcandidates.companyの写し。未連携はNULL。提案先会社・source_company・実名を代用しない。';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='gw_sales_proposals' and column_name='talent_company_observed_at') then
    alter table public.gw_sales_proposals add column talent_company_observed_at timestamptz;
    comment on column public.gw_sales_proposals.talent_company_observed_at is
      'ENGERで人材所属会社を読み始めた観測時刻。古いsnapshotの逆順適用防止。更新時刻ではない。';
  end if;
end $$;
commit;
