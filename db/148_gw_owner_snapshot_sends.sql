-- Metadata-only dispatch ledger. APPLY ONLY AFTER owner approval; does not activate sending.
-- No change to existing data permissions, MFA, sessions or credential storage.
begin;
create table if not exists public.gw_owner_snapshot_sends (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  dispatch_key text not null check (length(dispatch_key) <= 120),
  owner_employee_id uuid not null references public.gw_employees(id),
  schema_version text not null,
  target_date date not null,
  slot text not null check (slot in ('initial','morning','evening','manual')),
  status text not null check (status in ('sending','accepted','not_sent','unknown')),
  checked_at timestamptz not null,
  fingerprint text not null check (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  target_count integer not null check (target_count >= 0),
  obtained_count integer not null check (obtained_count >= 0 and obtained_count <= target_count),
  source_reads_complete boolean not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'sending' and finished_at is null) or (status <> 'sending' and finished_at is not null)),
  unique (tenant_id, dispatch_key)
);
-- Also supports an earlier deployed ledger: only this new table's slot allowlist changes.
alter table public.gw_owner_snapshot_sends drop constraint if exists gw_owner_snapshot_sends_slot_check;
alter table public.gw_owner_snapshot_sends add constraint gw_owner_snapshot_sends_slot_check
  check (slot in ('initial','morning','evening','manual'));
alter table public.gw_owner_snapshot_sends enable row level security;
-- Server service_role only. No client read/write policy is created, including owner clients.
revoke all on table public.gw_owner_snapshot_sends from anon, authenticated, service_role;
grant select, insert, update on table public.gw_owner_snapshot_sends to service_role;
-- Keep the original claim identity immutable. A terminal/unknown outcome is not reset for retry.
create or replace function public.gw_owner_snapshot_claim_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if TG_OP = 'DELETE' then raise exception 'snapshot dispatch claims cannot be deleted'; end if;
  if (to_jsonb(new) - 'status' - 'finished_at') is distinct from (to_jsonb(old) - 'status' - 'finished_at') then
    raise exception 'snapshot dispatch claim identity is immutable';
  end if;
  if old.status <> 'sending' and (new.status, new.finished_at) is distinct from (old.status, old.finished_at) then
    raise exception 'snapshot dispatch outcome is terminal';
  end if;
  return new;
end;
$$;
revoke all on function public.gw_owner_snapshot_claim_immutable() from public;
drop trigger if exists gw_owner_snapshot_claim_immutable on public.gw_owner_snapshot_sends;
create trigger gw_owner_snapshot_claim_immutable before update or delete on public.gw_owner_snapshot_sends
for each row execute function public.gw_owner_snapshot_claim_immutable();
comment on table public.gw_owner_snapshot_sends is
  'Owner-only GW email dispatch metadata, not email content. accepted is SMTP acceptance, not delivery. Never automatically retry sending/unknown.';
commit;
notify pgrst, 'reload schema';
