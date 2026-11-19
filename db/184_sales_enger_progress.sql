begin;

alter table public.gw_sales_deals
  add column if not exists next_action text check (char_length(next_action) <= 240),
  add column if not exists next_due_on date,
  add column if not exists meeting_held_on date,
  add column if not exists joined_on date;

create or replace function public.gw_sales_deal_clear_joined()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.stage <> 'won' then
    new.joined_on := null;
  end if;
  return new;
end;
$$;
drop trigger if exists gw_sales_deal_clear_joined on public.gw_sales_deals;
create trigger gw_sales_deal_clear_joined
  before update of stage on public.gw_sales_deals
  for each row execute function public.gw_sales_deal_clear_joined();

create table if not exists public.gw_sales_enger_deal_links (
  tenant_id uuid not null references public.tenants(id),
  source_kind text not null check (source_kind in ('proposal', 'offer')),
  source_id uuid not null,
  deal_id uuid not null references public.gw_sales_deals(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, source_kind, source_id)
);
create index if not exists idx_gw_sales_enger_deal_links_deal
  on public.gw_sales_enger_deal_links (tenant_id, deal_id, source_kind);
alter table public.gw_sales_enger_deal_links enable row level security;
revoke all on public.gw_sales_enger_deal_links from public, anon, authenticated;
grant select on public.gw_sales_enger_deal_links to service_role;

-- The API authorizes the source and resolves its Sales company before calling this function.
-- Take the lock before creating a deal so concurrent retries cannot leave duplicates.
create or replace function public.gw_link_enger_deal(
  p_tenant uuid, p_kind text, p_source uuid, p_company uuid,
  p_deal uuid, p_title text, p_owner uuid, p_actor uuid
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  linked uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_tenant::text || ':' || p_kind || ':' || p_source::text, 0));
  select deal_id into linked from public.gw_sales_enger_deal_links
    where tenant_id = p_tenant and source_kind = p_kind and source_id = p_source;
  if linked is not null then
    if p_deal is not null and linked <> p_deal then
      raise exception 'Source already linked' using errcode = '23505';
    end if;
    return linked;
  end if;
  if p_deal is null then
    insert into public.gw_sales_deals (tenant_id, company_id, title, service, stage, owner_id, created_by, updated_by)
    values (p_tenant, p_company, p_title, 'ENGER',
      case when p_kind = 'offer' then 'negotiation' else 'proposal' end, p_owner, p_actor, p_actor)
    returning id into linked;
  else
    select id into linked from public.gw_sales_deals
      where id = p_deal and tenant_id = p_tenant and company_id = p_company;
    if linked is null then
      raise exception 'Deal does not belong to the source company' using errcode = '23503';
    end if;
  end if;
  insert into public.gw_sales_enger_deal_links (tenant_id, source_kind, source_id, deal_id, created_by)
    values (p_tenant, p_kind, p_source, linked, p_actor);
  return linked;
end;
$$;
revoke all on function public.gw_link_enger_deal(uuid,text,uuid,uuid,uuid,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.gw_link_enger_deal(uuid,text,uuid,uuid,uuid,text,uuid,uuid) to service_role;

commit;
notify pgrst, 'reload schema';
