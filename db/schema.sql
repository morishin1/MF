-- =============================================================================
-- KessanPilot / Phase1 スキーマ
-- マルチテナント（テナント=会計事務所、その下に複数の顧問先「クライアント」）
-- 全テーブルに tenant_id を持ち、RLS でテナント越境を物理的に防ぐ
-- =============================================================================
-- 実行手順: Supabase SQL Editor にこのファイル全体を貼って実行
-- 前提: 認証は Supabase Auth を使う。auth.users が存在することが前提
-- =============================================================================

-- 拡張
create extension if not exists "pgcrypto";

-- =============================================================================
-- 1) テナント（会計事務所）
-- =============================================================================
create table if not exists public.tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  -- 事務所のプラン・契約情報など（将来拡張）
  created_at   timestamptz not null default now()
);

-- =============================================================================
-- 2) メンバーシップ
-- どの auth ユーザーが、どのテナントに、どのロールで所属するか
-- role: 'admin'(事務所オーナー) / 'staff'(事務所スタッフ) / 'client'(顧問先側ユーザー)
-- staff/admin はテナント内の全クライアントにアクセス
-- client は client_id が一致するクライアントのみアクセス
-- =============================================================================
create table if not exists public.memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  role        text not null check (role in ('admin','staff','client')),
  client_id   uuid,  -- role='client' のとき必須（clients.id を参照、循環FKは後で）
  created_at  timestamptz not null default now()
);

-- 一意性: (user_id, tenant_id, client_id)。client_id が NULL の行も1件に絞るため
-- coalesce で NULL をゼロUUIDに寄せた「式インデックス」で表現する。
-- （テーブル定義内の UNIQUE 制約には式を書けないため、ユニークインデックスで実現）
create unique index if not exists uq_memberships_identity
  on public.memberships (user_id, tenant_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists idx_memberships_user on public.memberships(user_id);
create index if not exists idx_memberships_tenant on public.memberships(tenant_id);

-- =============================================================================
-- 3) クライアント（顧問先企業）
-- =============================================================================
create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  industry        text,
  fiscal_month    smallint check (fiscal_month between 1 and 12),
  -- 会計ソフト連携情報（OAuthトークンは別テーブルで暗号化保管）
  accounting_software text check (accounting_software in ('mf','freee','yayoi','none')) default 'none',
  created_at      timestamptz not null default now()
);

create index if not exists idx_clients_tenant on public.clients(tenant_id);

-- memberships.client_id の FK を後付け
alter table public.memberships
  drop constraint if exists memberships_client_id_fkey;
alter table public.memberships
  add constraint memberships_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete cascade;

-- =============================================================================
-- 4) 会計ソフト OAuth トークン（テナント分離 + 列レベル暗号化想定）
-- 注: 平文では保存しない。暗号化は pgcrypto + Supabase Vault または
--     アプリ層 KMS で encrypted_token に書き込む運用にする。
-- =============================================================================
create table if not exists public.accounting_credentials (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete cascade,
  software         text not null check (software in ('mf','freee','yayoi')),
  -- 暗号化済みトークン本体（バイナリ）。decrypt はサーバ側のみ
  encrypted_token  bytea not null,
  scopes           text[] not null default '{}',
  expires_at       timestamptz,
  refresh_token_encrypted bytea,
  -- MF などの「事業者ID」相当
  external_office_id text,
  updated_at       timestamptz not null default now(),
  unique (client_id, software)
);

-- =============================================================================
-- 5) 書類（PDF等）メタデータ
-- 実体は Supabase Storage の "documents" バケット（非公開）に置く
-- storage_path 例: tenant_<uuid>/client_<uuid>/2026-04/<doc_uuid>.pdf
-- =============================================================================
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  uploaded_by   uuid references auth.users(id) on delete set null,
  filename      text not null,
  mime_type     text not null,
  size_bytes    bigint not null,
  storage_path  text not null unique,
  -- AIが認識した書類種別
  doc_type      text check (doc_type in ('invoice','receipt','bank','salary','contract','unknown')) default 'unknown',
  -- ライフサイクル
  status        text not null default 'uploaded'
                check (status in ('uploaded','recognizing','ready','asking','approved','sent','error')),
  uploaded_at   timestamptz not null default now()
);

create index if not exists idx_documents_tenant_client on public.documents(tenant_id, client_id);
create index if not exists idx_documents_status on public.documents(status);

-- =============================================================================
-- 6) 仕訳ドラフト（AIが書類から作成）
-- 1ドキュメントから 0..n 件の仕訳（複合仕訳は lines に保持）
-- =============================================================================
create table if not exists public.journals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  client_id      uuid not null references public.clients(id) on delete cascade,
  document_id    uuid references public.documents(id) on delete cascade,
  -- AIによる推論
  partner_name   text,
  description    text,
  txn_date       date,
  total_amount   numeric(14,0),
  tax_category   text,                 -- 例: '課仕10%' / '対象外'
  confidence     text check (confidence in ('high','mid','low')) default 'mid',
  -- 借方/貸方の明細 [{ side, account, sub_account, amount, tax }, ...]
  lines          jsonb not null,
  ai_note        text,
  -- 状態: AIドラフト→人が承認→外部送信
  status         text not null default 'draft'
                 check (status in ('draft','approved','rejected','sent','error')),
  -- 冪等送信用（会計ソフト宛て）
  idempotency_key text,
  external_id    text,                 -- 送信先での仕訳ID
  approved_by    uuid references auth.users(id) on delete set null,
  approved_at    timestamptz,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists idx_journals_tenant_client on public.journals(tenant_id, client_id);
create index if not exists idx_journals_status on public.journals(status);
create index if not exists idx_journals_doc on public.journals(document_id);
-- 同じ idempotency_key で同じ送信先には1件のみ
create unique index if not exists uq_journals_idempotency
  on public.journals(client_id, idempotency_key) where idempotency_key is not null;

-- =============================================================================
-- 7) AIからの確認質問（書類の用途が曖昧な場合）
-- =============================================================================
create table if not exists public.ai_questions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  document_id  uuid references public.documents(id) on delete cascade,
  question     text not null,
  options      jsonb,
  answer       text,
  answered_by  uuid references auth.users(id) on delete set null,
  answered_at  timestamptz,
  status       text not null default 'open' check (status in ('open','answered','cancelled')),
  created_at   timestamptz not null default now()
);

create index if not exists idx_ai_questions_tenant on public.ai_questions(tenant_id);

-- =============================================================================
-- 8) 監査ログ（追記専用）
-- 誰が・いつ・どのテナントの何を・何のために 触ったか
-- =============================================================================
create table if not exists public.audit_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  tenant_id   uuid,
  client_id   uuid,
  actor_id    uuid,                  -- auth.users.id
  action      text not null,         -- 'document.upload' / 'journal.approve' / 'mf.send' など
  target      text,                  -- 'document:<uuid>' など
  detail      jsonb
);

create index if not exists idx_audit_tenant_ts on public.audit_log(tenant_id, ts desc);

-- =============================================================================
-- ヘルパ関数: 現在のユーザーがアクセス可能な tenant_id 集合
-- RLS から使う
-- =============================================================================
create or replace function public.user_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public
as $$
  select tenant_id from public.memberships where user_id = auth.uid();
$$;

-- 現在のユーザーが「クライアント」ロールで紐づく client_id 集合
create or replace function public.user_client_ids() returns setof uuid
language sql stable security definer set search_path = public
as $$
  select client_id
    from public.memberships
   where user_id = auth.uid() and role = 'client' and client_id is not null;
$$;

-- 現在のユーザーが特定テナントで staff/admin か
create or replace function public.is_tenant_staff(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
     where user_id = auth.uid()
       and tenant_id = p_tenant
       and role in ('admin','staff')
  );
$$;

-- =============================================================================
-- RLS: 全テーブル有効化
-- =============================================================================
alter table public.tenants                enable row level security;
alter table public.memberships            enable row level security;
alter table public.clients                enable row level security;
alter table public.accounting_credentials enable row level security;
alter table public.documents              enable row level security;
alter table public.journals               enable row level security;
alter table public.ai_questions           enable row level security;
alter table public.audit_log              enable row level security;

-- tenants: 自分が所属しているテナントだけ見える
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select using (id in (select public.user_tenant_ids()));

-- memberships: 自分のメンバーシップだけ見える
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select using (user_id = auth.uid());

-- 「テナント内クライアントへのアクセス」共通条件:
--   - staff/admin: そのテナントに staff/admin として所属
--   - client    : memberships に該当 client_id があるユーザー
-- これを以下 clients / documents / journals / ai_questions に適用
drop policy if exists clients_rw on public.clients;
create policy clients_rw on public.clients
  for all
  using (
    public.is_tenant_staff(tenant_id)
    or id in (select public.user_client_ids())
  )
  with check (
    public.is_tenant_staff(tenant_id)
    or id in (select public.user_client_ids())
  );

drop policy if exists documents_rw on public.documents;
create policy documents_rw on public.documents
  for all
  using (
    public.is_tenant_staff(tenant_id)
    or client_id in (select public.user_client_ids())
  )
  with check (
    public.is_tenant_staff(tenant_id)
    or client_id in (select public.user_client_ids())
  );

drop policy if exists journals_rw on public.journals;
create policy journals_rw on public.journals
  for all
  using (
    public.is_tenant_staff(tenant_id)
    or client_id in (select public.user_client_ids())
  )
  with check (
    public.is_tenant_staff(tenant_id)
    or client_id in (select public.user_client_ids())
  );

drop policy if exists ai_questions_rw on public.ai_questions;
create policy ai_questions_rw on public.ai_questions
  for all
  using (
    public.is_tenant_staff(tenant_id)
    or client_id in (select public.user_client_ids())
  )
  with check (
    public.is_tenant_staff(tenant_id)
    or client_id in (select public.user_client_ids())
  );

-- accounting_credentials: staff/admin だけ閲覧（顧問先には見せない）
drop policy if exists credentials_staff_only on public.accounting_credentials;
create policy credentials_staff_only on public.accounting_credentials
  for all
  using (public.is_tenant_staff(tenant_id))
  with check (public.is_tenant_staff(tenant_id));

-- audit_log: テナント所属者は read のみ。書き込みはサーバ（service role）からのみ
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log
  for select using (tenant_id in (select public.user_tenant_ids()));
-- INSERT/UPDATE/DELETE はポリシー無し → service role 以外は不可

-- =============================================================================
-- ストレージ（参考）
-- documents バケットを「非公開」で作成し、以下 RLS を適用する想定：
-- (1) バケット作成（Supabase ダッシュボードか以下のSQL）:
--   insert into storage.buckets (id, name, public) values ('documents','documents', false)
--     on conflict (id) do nothing;
-- (2) パス規約: <tenant_id>/<client_id>/...
--     その先頭2セグメントから tenant_id / client_id を判定して RLS を書く。
--   create policy "documents_owner_rw" on storage.objects
--     for all
--     using (
--       bucket_id = 'documents'
--       and (
--         public.is_tenant_staff((split_part(name,'/',1))::uuid)
--         or (split_part(name,'/',2))::uuid in (select public.user_client_ids())
--       )
--     )
--     with check (
--       bucket_id = 'documents'
--       and (
--         public.is_tenant_staff((split_part(name,'/',1))::uuid)
--         or (split_part(name,'/',2))::uuid in (select public.user_client_ids())
--       )
--     );
-- =============================================================================
