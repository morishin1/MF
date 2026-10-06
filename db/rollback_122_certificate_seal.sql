-- db/122_certificate_seal.sql のやり直し。
-- certificate の印鑑の行が残っていると、check 制約を戻せないので、先に消す（または種類を other に変える）必要があります。
-- 次の1行は、certificate の印鑑を other に変えてから制約を戻します（印影は消えません。契約書に使えるようになるので、注意）。
begin;
update public.gw_seals set seal_type = 'other', is_active = false where seal_type = 'certificate';
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.gw_seals'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%seal_type%'
  loop execute format('alter table public.gw_seals drop constraint %I', c.conname); end loop;
  alter table public.gw_seals add constraint gw_seals_seal_type_check
    check (seal_type in ('representative', 'square', 'contract', 'other'));
end $$;
drop table if exists public.gw_retire_company;
notify pgrst, 'reload schema';
commit;
