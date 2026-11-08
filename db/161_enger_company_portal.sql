-- =============================================================================
-- 161: 企業ポータル（ENGER business = enger.jp/business）を Sales の企業IDに紐づける
--
-- 指示書「Sales起点・ENGER連携 企業商談／企業ポータル（2026-11-06）」Phase 1。
-- 詳細は docs/sales-company-portal.md。
--
-- ■ 何を足すか（すべて新しい表。既存の表・列・RLS には一切触れない）
--
--   1. enger.dx2_company_portal_members        企業ポータルの利用者（企業ID・メール・権限・状態）
--   2. enger.dx2_company_portal_invites        招待リンク（トークンは sha256 だけを持つ）
--   3. enger.dx2_company_talent_links          Sales の商談準備：企業×人材の紐づけ（保存候補／提案予定／提案済み／見送り）
--   4. enger.dx2_company_portal_saved_talents  企業ポータルで企業が保存した人材（企業内で共有）
--   5. enger.dx2_company_portal_events         発行・停止・ログイン・閲覧・保存の記録（追記専用）
--
-- ■ 企業の正は enger.companies ただ1つ
--   企業IDは enger.companies.id（Sales の企業一覧・dx.enger と同じID）。人材は enger.candidates.id。
--   別の企業マスタ・人材マスタは作らない。会社名の文字列では紐づけない。
--
-- ■ ブラウザからは読めない（deny-by-default）
--   enger.candidates は anon キーで全列が読める既存状態（dx.enger の docs/supabase.md）なので、
--   ここで足す表は anon / authenticated から REVOKE し、RLS を有効にしてポリシーを置かない。
--   読み書きは、Sales（MF）と enger.jp（enger-lp）のサーバーが service_role で、
--   ログインと企業IDを確かめてから行う。企業IDはリクエストから受け取らず、利用者の行から決める。
--
-- ■ 削除はしない
--   利用者・招待は消さずに停止（disabled_at）・取消（revoked_at）で残す。記録（events）は追記だけ。
--
-- 実行方法: 共有 Supabase（Sales と ENGER が同じプロジェクト）の SQL Editor で Run（べき等）。
-- 確認: db/check_161_enger_company_portal.sql ／ 戻す: db/rollback_161_enger_company_portal.sql
-- 前提: enger.companies / enger.candidates / public.tenants / auth.users
-- =============================================================================

begin;

do $$
begin
  if to_regclass('enger.companies') is null
     or to_regclass('enger.candidates') is null
     or to_regclass('public.tenants') is null
     or to_regclass('auth.users') is null then
    raise exception '前提の表がありません（enger.companies / enger.candidates / public.tenants / auth.users）。Sales と ENGER が共有している Supabase で実行してください';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 企業ポータルの利用者
-- -----------------------------------------------------------------------------
create table if not exists enger.dx2_company_portal_members (
  id               uuid primary key default gen_random_uuid(),
  -- 発行した Sales のテナント（株式会社エイト）。Sales 側の見える範囲の判定に使う
  tenant_id        uuid not null references public.tenants(id) on delete restrict,
  -- 企業の正（Sales の企業一覧と同じID）。利用者がいる企業は消せない（誤って消すとログインが宙に浮く）
  company_id       uuid not null references enger.companies(id) on delete restrict,
  -- ログインID。小文字・前後空白なしで持つ（同じ人を二重に発行しない）
  email            text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and email like '%_@_%'),
  display_name     text not null check (char_length(btrim(display_name)) between 1 and 100),
  role             text not null default 'member' check (role in ('admin', 'member')),
  -- 招待を受けて登録が済むと入る（それまでは null）。Auth のアカウントが消えたら外す
  auth_user_id     uuid references auth.users(id) on delete set null,
  registered_at    timestamptz,
  last_login_at    timestamptz,
  -- 停止（退職・契約終了など）。停止中はログイン・検索・保存がすべて止まる
  disabled_at      timestamptz,
  disabled_by      uuid references auth.users(id) on delete set null,
  disabled_reason  text check (disabled_reason is null or char_length(disabled_reason) <= 300),
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 1つのメールは1つの企業・1人の利用者だけ（別企業に同じ人を二重に発行しない）
create unique index if not exists dx2_company_portal_members_email_uq
  on enger.dx2_company_portal_members (email);
create unique index if not exists dx2_company_portal_members_user_uq
  on enger.dx2_company_portal_members (auth_user_id) where auth_user_id is not null;
create index if not exists dx2_company_portal_members_company_idx
  on enger.dx2_company_portal_members (company_id, created_at desc);

comment on table enger.dx2_company_portal_members is
  '企業ポータル（enger.jp/business）の利用者。Sales の企業詳細から発行する。企業IDは enger.companies.id。'
  'サーバー（service_role）だけが読み書きする。停止は disabled_at（行は消さない）。';

-- -----------------------------------------------------------------------------
-- 2) 招待リンク（再発行のたびに新しい行。古い行は revoked_at で残す）
-- -----------------------------------------------------------------------------
create table if not exists enger.dx2_company_portal_invites (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references enger.dx2_company_portal_members(id) on delete cascade,
  -- 平文のトークンは発行のときに1度だけ画面に出す。DB には sha256（hex）だけを持つ
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (expires_at > created_at)
);
create index if not exists dx2_company_portal_invites_member_idx
  on enger.dx2_company_portal_invites (member_id, created_at desc);

comment on table enger.dx2_company_portal_invites is
  '企業ポータルの招待リンク。初回パスワードは本人が招待リンクで決める（パスワードをメール・DBに平文で置かない）。';

-- -----------------------------------------------------------------------------
-- 3) Sales の商談準備：企業×人材の紐づけ（社内向け。企業には見せない）
-- -----------------------------------------------------------------------------
create table if not exists enger.dx2_company_talent_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  company_id    uuid not null references enger.companies(id) on delete cascade,
  candidate_id  uuid not null references enger.candidates(id) on delete cascade,
  -- saved=保存候補 / planned=提案予定 / proposed=提案済み / declined=見送り
  status        text not null default 'saved' check (status in ('saved', 'planned', 'proposed', 'declined')),
  -- 社内メモ。企業ポータルには出さない
  note          text not null default '' check (char_length(note) <= 1000),
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, company_id, candidate_id)
);
create index if not exists dx2_company_talent_links_company_idx
  on enger.dx2_company_talent_links (tenant_id, company_id, updated_at desc);

comment on table enger.dx2_company_talent_links is
  'Sales の商談準備で、企業IDに人材を紐づけた記録（保存候補／提案予定／提案済み／見送り）。社内向け。企業ポータルには出さない。';

-- -----------------------------------------------------------------------------
-- 4) 企業ポータルで保存した人材（企業内で共有する）
-- -----------------------------------------------------------------------------
create table if not exists enger.dx2_company_portal_saved_talents (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references enger.companies(id) on delete cascade,
  member_id     uuid not null references enger.dx2_company_portal_members(id) on delete cascade,
  candidate_id  uuid not null references enger.candidates(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (member_id, candidate_id)
);
create index if not exists dx2_company_portal_saved_company_idx
  on enger.dx2_company_portal_saved_talents (company_id, created_at desc);

comment on table enger.dx2_company_portal_saved_talents is
  '企業ポータルで保存した人材。同じ企業の利用者全員に共有される（保存した人も表示する）。';

-- 保存の企業IDは、保存した利用者の企業IDと必ず一致させる（API の取り違えを DB でも止める）
create or replace function enger.dx2_company_portal_saved_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from enger.dx2_company_portal_members m
     where m.id = new.member_id and m.company_id = new.company_id and m.disabled_at is null
  ) then
    raise exception 'saved talent company does not match an active portal member' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists dx2_company_portal_saved_guard on enger.dx2_company_portal_saved_talents;
create trigger dx2_company_portal_saved_guard
  before insert or update on enger.dx2_company_portal_saved_talents
  for each row execute function enger.dx2_company_portal_saved_guard();

-- -----------------------------------------------------------------------------
-- 5) 記録（追記専用）。外部キーは置かない（元の行が消えても記録は残す）
-- -----------------------------------------------------------------------------
create table if not exists enger.dx2_company_portal_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid,
  member_id      uuid,
  -- staff = Sales の社員 / portal = 企業ポータルの利用者 / system
  actor_kind     text not null check (actor_kind in ('staff', 'portal', 'system')),
  actor_user_id  uuid,
  -- 例: member.invite / member.disable / portal.login / talent.search / talent.view / talent.save
  action         text not null check (char_length(action) <= 60 and action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_id      text check (target_id is null or char_length(target_id) <= 100),
  -- 連絡先・パスワード・トークンは入れない（API 側で項目を決めて入れる）
  detail         jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4000),
  created_at     timestamptz not null default clock_timestamp()
);
create index if not exists dx2_company_portal_events_company_idx
  on enger.dx2_company_portal_events (company_id, created_at desc);
create index if not exists dx2_company_portal_events_member_idx
  on enger.dx2_company_portal_events (member_id, created_at desc);

comment on table enger.dx2_company_portal_events is
  '企業ポータルの発行・停止・ログイン・検索・閲覧・保存の記録。追記専用（更新・削除はトリガで拒否）。';

create or replace function enger.dx2_company_portal_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'enger.dx2_company_portal_events is append-only' using errcode = '42501';
end $$;

drop trigger if exists dx2_company_portal_events_append_only on enger.dx2_company_portal_events;
create trigger dx2_company_portal_events_append_only
  before update or delete on enger.dx2_company_portal_events
  for each row execute function enger.dx2_company_portal_events_append_only();

-- -----------------------------------------------------------------------------
-- 6) 権限：ブラウザ（anon / authenticated）からは一切触れない。サーバー（service_role）だけ
-- -----------------------------------------------------------------------------
alter table enger.dx2_company_portal_members        enable row level security;
alter table enger.dx2_company_portal_invites        enable row level security;
alter table enger.dx2_company_talent_links          enable row level security;
alter table enger.dx2_company_portal_saved_talents  enable row level security;
alter table enger.dx2_company_portal_events         enable row level security;

-- Supabase は新しい表に anon / authenticated / service_role の全権限を自動で付ける。
-- いったん全部外してから、service_role に要るものだけを付け直す
-- （service_role にも UPDATE / DELETE を残すと、記録の「追記だけ」・利用者の「消さない」が権限で守れない）
revoke all on enger.dx2_company_portal_members        from public, anon, authenticated, service_role;
revoke all on enger.dx2_company_portal_invites        from public, anon, authenticated, service_role;
revoke all on enger.dx2_company_talent_links          from public, anon, authenticated, service_role;
revoke all on enger.dx2_company_portal_saved_talents  from public, anon, authenticated, service_role;
revoke all on enger.dx2_company_portal_events         from public, anon, authenticated, service_role;

grant select, insert, update on enger.dx2_company_portal_members       to service_role;
grant select, insert, update on enger.dx2_company_portal_invites       to service_role;
grant select, insert, update on enger.dx2_company_talent_links         to service_role;
grant select, insert, delete on enger.dx2_company_portal_saved_talents to service_role;
grant select, insert         on enger.dx2_company_portal_events        to service_role;

revoke all on function enger.dx2_company_portal_saved_guard()          from public, anon, authenticated;
revoke all on function enger.dx2_company_portal_events_append_only()   from public, anon, authenticated;

commit;
