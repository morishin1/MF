-- 【提案・未適用】採用メール新着受付の「人ごとの既読」。番号は適用を決めたときに振る。
--
-- ■ 何のためか
--   「未読」（その人がまだ本文を開いていない）と「未対応」（登録・対応終了がまだ）を分ける。
--   開いただけで対応済みにはしない。既読は人ごとに独立（Aさんが開いても、Bさんには未読のまま）。
--
-- ■ 前提
--   db/147_hr_inbound_mail.sql（gw_hr_inbound_mail）と db/081（gw_is_recruiting）が適用済み。
--
-- ■ 書き込み
--   API（api/hr/inbox.js、service_role）だけ。本文を表示できたあとに1行足す（同じ人・同じメールは1行だけ）。
--   画面（authenticated）からの直接の書き込みはさせない。読むのは「自分の行」だけ。
--
-- ■ 未適用のあいだ
--   API は未読数を null（「確認できない」）で返し、画面は「未読は確認できません」と出す。0件にはしない。
--
-- ■ 戻し方
--   db/proposal_rollback_hr_inbox_reads.sql（表を消すだけ。受信メールそのもの・対応状態には触れない）
begin;
do $$
begin
  if to_regclass('public.gw_hr_inbound_mail') is null then
    raise exception '先に db/147_hr_inbound_mail.sql を適用してください';
  end if;
end $$;

create table if not exists public.gw_hr_inbound_mail_reads (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  mail_id   uuid not null references public.gw_hr_inbound_mail(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (mail_id, user_id)
);
create index if not exists gw_hr_inbound_mail_reads_user
  on public.gw_hr_inbound_mail_reads (tenant_id, user_id);

-- 既読の行のテナントは、メールのテナントと必ず同じにする（別テナントのメールIDで行を作らせない）
create or replace function public.gw_hr_inbound_mail_reads_tenant_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.gw_hr_inbound_mail m where m.id = new.mail_id and m.tenant_id = new.tenant_id) then
    raise exception 'tenant mismatch' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists gw_hr_inbound_mail_reads_tenant_guard on public.gw_hr_inbound_mail_reads;
create trigger gw_hr_inbound_mail_reads_tenant_guard
  before insert or update on public.gw_hr_inbound_mail_reads
  for each row execute function public.gw_hr_inbound_mail_reads_tenant_guard();

alter table public.gw_hr_inbound_mail_reads enable row level security;
drop policy if exists gw_hr_inbound_mail_reads_own on public.gw_hr_inbound_mail_reads;
create policy gw_hr_inbound_mail_reads_own on public.gw_hr_inbound_mail_reads
  for select to authenticated
  using (user_id = auth.uid() and public.gw_is_recruiting(tenant_id));
revoke all on public.gw_hr_inbound_mail_reads from anon, authenticated;
grant select on public.gw_hr_inbound_mail_reads to authenticated;
grant all on public.gw_hr_inbound_mail_reads to service_role;
comment on table public.gw_hr_inbound_mail_reads is
  '採用メール新着受付の人ごとの既読。未対応（状態）とは別。書き込みはAPI（service_role）のみ。';
notify pgrst, 'reload schema';
commit;
