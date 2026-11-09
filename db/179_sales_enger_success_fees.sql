-- ENGER 成果報酬管理。会計上の売上・請求書は作らない。
-- 1オファーの一時金は1行、継続手数料は稼働月ごとに1行。
begin;

-- 同じテナント・会社でない別法人の企業オファーを手数料に使えない。
create unique index if not exists dx2_company_portal_offers_tenant_company_id_unique
 on enger.dx2_company_portal_offers(tenant_id,company_id,id);

create table if not exists public.gw_sales_success_fees (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 company_id uuid not null,
 offer_id uuid not null,
 fee_model text not null check (fee_model in ('once','monthly')),
 fee_month date,
 fee_yen bigint not null check (fee_yen between 1 and 100000000),
 payer_name text not null check (char_length(trim(payer_name)) between 2 and 160),
 status text not null default 'draft'
   check (status in ('draft','confirmed','invoiced','paid','void')),
 agreement_reference text check (agreement_reference is null or char_length(agreement_reference) <= 500),
 confirmed_on date,
 invoice_number text check (invoice_number is null or char_length(invoice_number) between 1 and 100),
 invoiced_on date,
 paid_on date,
 note text check (note is null or char_length(note) <= 1000),
 created_by uuid references auth.users(id) on delete set null,
 updated_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint gw_sales_success_fees_offer_fk foreign key (tenant_id,company_id,offer_id)
   references enger.dx2_company_portal_offers(tenant_id,company_id,id) on delete restrict,
 constraint gw_sales_success_fees_month_check check (
   (fee_model='once' and fee_month is null) or
   (fee_model='monthly' and fee_month is not null and extract(day from fee_month)=1)
 ),
 constraint gw_sales_success_fees_confirmed_check check (
   status in ('draft','void') or (confirmed_on is not null and nullif(trim(coalesce(agreement_reference,'')),'') is not null)
 ),
 constraint gw_sales_success_fees_invoiced_check check (
   status not in ('invoiced','paid') or
   (invoiced_on is not null and nullif(trim(coalesce(invoice_number,'')),'') is not null)
 ),
 constraint gw_sales_success_fees_paid_check check (
   status <> 'paid' or paid_on is not null
 )
);
create unique index if not exists gw_sales_success_fee_once_unique
 on public.gw_sales_success_fees (tenant_id,offer_id) where fee_model='once';
create unique index if not exists gw_sales_success_fee_month_unique
 on public.gw_sales_success_fees (tenant_id,offer_id,fee_month) where fee_model='monthly';
create index if not exists gw_sales_success_fees_company_idx
 on public.gw_sales_success_fees (tenant_id,company_id,created_at desc);
create index if not exists gw_sales_success_fees_status_idx
 on public.gw_sales_success_fees (tenant_id,status,fee_month);

create table if not exists public.gw_sales_success_fee_events (
 id uuid primary key default gen_random_uuid(),
 fee_id uuid not null references public.gw_sales_success_fees(id) on delete restrict,
 tenant_id uuid not null,
 actor_id uuid references auth.users(id) on delete set null,
 from_status text,
 to_status text not null,
 fee_yen bigint not null,
 created_at timestamptz not null default now()
);
create index if not exists gw_sales_success_fee_events_fee_idx
 on public.gw_sales_success_fee_events (fee_id,created_at desc);

create or replace function public.gw_sales_success_fee_audit()
returns trigger language plpgsql as $$
begin
 if TG_OP='INSERT' or old.status is distinct from new.status then
  insert into public.gw_sales_success_fee_events (fee_id,tenant_id,actor_id,from_status,to_status,fee_yen)
  values (new.id,new.tenant_id,new.updated_by,
    case when TG_OP='INSERT' then null else old.status end,new.status,new.fee_yen);
 end if;
 return new;
end $$;

drop trigger if exists gw_sales_success_fee_audit_trigger on public.gw_sales_success_fees;
create trigger gw_sales_success_fee_audit_trigger
after insert or update of status on public.gw_sales_success_fees
for each row execute function public.gw_sales_success_fee_audit();

alter table public.gw_sales_success_fees enable row level security;
alter table public.gw_sales_success_fee_events enable row level security;
revoke all on public.gw_sales_success_fees from public,anon,authenticated;
revoke all on public.gw_sales_success_fee_events from public,anon,authenticated;
grant select,insert,update,delete on public.gw_sales_success_fees to service_role;
grant select,insert on public.gw_sales_success_fee_events to service_role;

comment on table public.gw_sales_success_fees is
 'ENGER 成果報酬の見込/契約確認/請求記録/入金記録。会計上の売上ではない。請求書は別の承認済み経理フローで発行。';

commit;
