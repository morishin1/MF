-- Physical copies of lending books. An ISBN identifies an edition and may be shared by several copies.
create table if not exists public.gw_lending_books (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  copy_no bigint generated always as identity,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  isbn text check (isbn ~ '^97[89][0-9]{10}$'),
  confirmed boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  unique (tenant_id, id),
  unique (copy_no),
  check (not confirmed or isbn is not null)
);

create table if not exists public.gw_book_loans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  book_id uuid not null,
  borrower_name text not null check (char_length(btrim(borrower_name)) between 1 and 100),
  loaned_on date not null,
  returned_on date check (returned_on >= loaned_on),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, book_id) references public.gw_lending_books(tenant_id, id)
);

create unique index if not exists gw_book_loans_one_open
  on public.gw_book_loans (book_id) where returned_on is null;
create index if not exists gw_book_loans_history
  on public.gw_book_loans (tenant_id, book_id, loaned_on desc);
create index if not exists gw_lending_books_list
  on public.gw_lending_books (tenant_id, copy_no);

-- The authenticated GW endpoint checks Office access and returns a separate, borrower-free member catalogue.
alter table public.gw_lending_books enable row level security;
alter table public.gw_book_loans enable row level security;
revoke all on public.gw_lending_books, public.gw_book_loans from public, anon, authenticated;
revoke all on sequence public.gw_lending_books_copy_no_seq from public, anon, authenticated;
grant select, insert, update on public.gw_lending_books, public.gw_book_loans to service_role;
grant usage on sequence public.gw_lending_books_copy_no_seq to service_role;

create or replace function public.gw_check_book_checkout()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.gw_lending_books
    where id = new.book_id and tenant_id = new.tenant_id and confirmed for update;
  if not found then
    raise exception 'book_not_available' using errcode = '23503';
  end if;
  if exists (select 1 from public.gw_book_loans where book_id = new.book_id and returned_on > new.loaned_on) then
    raise exception 'loan_before_return' using errcode = '23P01';
  end if;
  return new;
end;
$$;
revoke all on function public.gw_check_book_checkout() from public, anon, authenticated;
drop trigger if exists gw_check_book_checkout on public.gw_book_loans;
create trigger gw_check_book_checkout before insert on public.gw_book_loans
  for each row execute function public.gw_check_book_checkout();
