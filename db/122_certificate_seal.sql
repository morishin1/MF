-- =============================================================================
-- 122_certificate_seal.sql — 証明書発行専用の印鑑（certificate）と、証明書の発行元（代表者名・会社住所）
--
-- ■ 何のためか
--   退職証明書などを、会社印を合成した PDF として発行する（api/employees/retire-cert.js）。
--   契約書用の印鑑（代表者印・角印・契約用印）とは完全に分けて、証明書用の専用の印鑑だけを使う。
--   実印・銀行印の画像は登録しない前提（登録の画面にも、そう書く）。
--
-- ■ 変えるもの
--   1) gw_seals.seal_type に 'certificate'（証明書発行用印）を足す（check 制約を作り直すだけ。既存の行は変わらない）
--   2) gw_retire_company（新しい表）… 会社ごとに1行。証明書に印字する 代表者名・会社住所。会社名は tenants.name を使う
--
-- ■ 権限・RLS
--   gw_retire_company は RLS を有効にして、読めるのは人事（gw_is_hr）だけ。書き込みのポリシーは作らない（サーバーだけが書く）
--
-- ■ 既存データへの影響
--   なし。既存の印鑑の行・契約書の押印は、このあとも同じように使える。
--   契約書を送るときに certificate の印鑑は選べない（サーバーと画面の両方で止める）。
--
-- ■ 実行方法
--   1. このファイルを Supabase の SQL Editor に貼って Run（べき等）
--   2. db/check_certificate_seal.sql を流して、合格条件を確認する（読み取りだけ）
--   やり直し: db/rollback_122_certificate_seal.sql
--
-- ■ 前提: db/091_seals.sql・db/121_retire_docs.sql が適用済み
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_seals') is null then
    raise exception 'gw_seals がありません。先に db/091_seals.sql を流してください';
  end if;
  if to_regclass('public.gw_retire_docs') is null then
    raise exception 'gw_retire_docs がありません。先に db/121_retire_docs.sql を流してください';
  end if;
end $$;

-- 1) seal_type に certificate を足す（seal_type の check 制約を、名前に関わらず探して作り直す）
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.gw_seals'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%seal_type%'
  loop
    execute format('alter table public.gw_seals drop constraint %I', c.conname);
  end loop;
  alter table public.gw_seals
    add constraint gw_seals_seal_type_check
    check (seal_type in ('representative', 'square', 'contract', 'certificate', 'other'));
end $$;

-- 2) 証明書の発行元（会社ごとに1行）
create table if not exists public.gw_retire_company (
  tenant_id      uuid primary key references public.tenants(id) on delete cascade,
  representative text,          -- 代表者名
  address        text,          -- 会社住所
  updated_by     uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now()
);

comment on table public.gw_retire_company is
  '証明書に印字する会社の情報（代表者名・会社住所）。会社名は tenants.name。db/122';

alter table public.gw_retire_company enable row level security;

drop policy if exists gw_retire_company_select on public.gw_retire_company;
create policy gw_retire_company_select on public.gw_retire_company
  for select using (public.gw_is_hr(tenant_id));

notify pgrst, 'reload schema';

commit;
