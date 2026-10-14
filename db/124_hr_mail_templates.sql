-- =============================================================================
-- 124: 採用HR：応募者へ送るメールのひな型と、送った記録
--
-- ■ 何をするか（足すだけ。既存の表は変えない）
--   1) gw_hr_mail_templates … ひな型（ひな型名・用途・件名・本文・使用／非表示・既定・版）
--        直すたびに version を1つ上げる。非表示（is_active=false）にしても消さない（過去の送信は参照したまま）
--        既定は「用途ごとに1つ」。標準のひな型は seed_key で「テナントに1回だけ」入れる（API が入れる。
--        担当者が直した・非表示にしたものは上書きしない。消す操作は無い）
--   2) gw_hr_mail_sends     … 応募者へ送ったメールの記録。実際に送った件名・本文・宛先・ひな型の ID と版を、
--        送った時点のまま持つ（あとでひな型を直しても変わらない）。結果は
--        sending（送信中）／sent（メールサービスが受け付けた）／failed（送れなかった）／unknown（結果不明）／not_sent（設定が無く送っていない）。
--        受け付け ≠ 相手への到達・開封。request_key は二重送信を防ぐ鍵（同じ鍵の2回目は送らない）
--
-- ■ 権限
--   どちらも RLS 有効・読み取りだけ・採用HRを使える人（gw_is_recruiting）。書き込みのポリシーは置かない
--   （API が採用HRの権限・テナントを確かめてから service role で書く）。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、ひな型の画面と送信だけ「SQL を流してください」と出て、ほかは止まらない。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081（gw_hr_applicants・gw_is_recruiting）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_hr_applicants') is null then
    raise exception 'gw_hr_applicants がありません。先に db/081_hr_recruiting.sql を流してください';
  end if;
  if to_regprocedure('public.gw_is_recruiting(uuid)') is null then
    raise exception 'gw_is_recruiting がありません。先に db/081_hr_recruiting.sql を流してください';
  end if;
end $$;

create table if not exists public.gw_hr_mail_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  purpose     text not null default 'other' check (purpose in ('application', 'casual', 'ceo', 'other')),
  subject     text not null check (char_length(subject) between 1 and 200 and subject !~ '[\r\n]'),
  body        text not null check (char_length(body) between 1 and 8000),
  is_active   boolean not null default true,
  is_default  boolean not null default false,
  version     integer not null default 1 check (version >= 1),
  seed_key    text,
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- 既定にできるのは使用中のひな型だけ
  constraint gw_hr_mail_templates_default_active check (not is_default or is_active)
);

-- 既定は用途ごとに1つ
create unique index if not exists uq_gw_hr_mail_templates_default
  on public.gw_hr_mail_templates(tenant_id, purpose) where is_default;
-- 標準のひな型は、テナントに1回だけ
create unique index if not exists uq_gw_hr_mail_templates_seed
  on public.gw_hr_mail_templates(tenant_id, seed_key) where seed_key is not null;
create index if not exists idx_gw_hr_mail_templates_tenant on public.gw_hr_mail_templates(tenant_id, is_active, purpose);

comment on table public.gw_hr_mail_templates is
  '採用HR：応募者へ送るメールのひな型。差し込み {{応募者名}} {{募集職種}} {{面談予約URL}} {{担当者名}} {{会社名}}。非表示にしても消さない。db/124';

create table if not exists public.gw_hr_mail_sends (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  applicant_id        uuid references public.gw_hr_applicants(id) on delete set null,
  to_email            text not null,
  to_name             text,
  from_email          text,
  reply_to            text,
  template_id         uuid references public.gw_hr_mail_templates(id) on delete set null,
  template_version    integer,
  template_name       text,
  subject             text not null,
  body                text not null,
  status              text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'unknown', 'not_sent')),
  provider            text,
  provider_message_id text,
  error               text,
  request_key         text not null check (char_length(request_key) between 8 and 80),
  sent_by             uuid references auth.users(id) on delete set null,
  sent_by_name        text,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);

-- 二重送信を防ぐ鍵（同じ画面の二度押し・通信のやり直し）
create unique index if not exists uq_gw_hr_mail_sends_request on public.gw_hr_mail_sends(tenant_id, request_key);
create index if not exists idx_gw_hr_mail_sends_applicant on public.gw_hr_mail_sends(tenant_id, applicant_id, created_at desc);

comment on table public.gw_hr_mail_sends is
  '採用HR：応募者へ送ったメール（送った時点の件名・本文・ひな型の版を固定で持つ）。sent はメールサービスが受け付けたことで、到達・開封ではない。db/124';

alter table public.gw_hr_mail_templates enable row level security;
alter table public.gw_hr_mail_sends     enable row level security;

drop policy if exists gw_hr_mail_templates_select on public.gw_hr_mail_templates;
create policy gw_hr_mail_templates_select on public.gw_hr_mail_templates
  for select using (public.gw_is_recruiting(tenant_id));
drop policy if exists gw_hr_mail_sends_select on public.gw_hr_mail_sends;
create policy gw_hr_mail_sends_select on public.gw_hr_mail_sends
  for select using (public.gw_is_recruiting(tenant_id));

notify pgrst, 'reload schema';

commit;

-- 確認1（適用後）: 2つの表のポリシーが「読み取りだけ・採用HR」か（2行・cmd は SELECT）
--
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename in ('gw_hr_mail_templates', 'gw_hr_mail_sends') order by tablename;
--
-- 確認2（適用後）: 一意の索引（3行）
--
--   select indexname from pg_indexes where schemaname = 'public'
--      and indexname in ('uq_gw_hr_mail_templates_default', 'uq_gw_hr_mail_templates_seed', 'uq_gw_hr_mail_sends_request');
--
-- 戻す（データごと消える。本番で流す前に必ず確認）:
--   drop table if exists public.gw_hr_mail_sends, public.gw_hr_mail_templates;
