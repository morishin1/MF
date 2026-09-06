-- =============================================================================
-- 000_install_fresh.sql — 新規Supabaseプロジェクト用の一括インストール
--
-- 既存の6ファイルを「正しい実行順」でそのまま連結したもの。
--   schema.sql → 002 → 003 → 004 → 005 → 006
-- 内容は各ファイルと完全に同一。順序間違いを防ぐためだけの存在。
--
-- 使い方: Supabase の SQL Editor にこのファイルの全文を貼って1回実行する。
-- 途中でエラーが出た場合は、そこで停止する。エラー文を確認して対処すること。
-- 既存環境（すでに schema.sql を流してあるプロジェクト）では使わない。
--   そちらは個別ファイルを順に適用する運用のまま。
--
-- 全ファイルが冪等（if not exists / drop policy if exists / create or replace）
-- なので、途中で止まっても直してから再実行できる。
-- =============================================================================


-- ############################################################################
-- ## schema.sql
-- ############################################################################

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

-- ############################################################################
-- ## 002_document_classification.sql
-- ############################################################################

-- 002_document_classification.sql
-- 書類の「種別判定＋月次管理」対応。
-- 既存データを壊さない“追加”マイグレーション（本番Supabaseでそのまま実行可）。

-- 1) doc_type の種別を拡張（会計証憑＋非会計書類も受け入れる）
alter table public.documents drop constraint if exists documents_doc_type_check;
alter table public.documents
  add constraint documents_doc_type_check
  check (doc_type in (
    'invoice',     -- 請求書
    'receipt',     -- 領収書・レシート
    'bank',        -- 通帳・銀行明細
    'card',        -- クレジットカード明細
    'salary',      -- 給与明細
    'contract',    -- 契約書
    'quote',       -- 見積書・発注書
    'tax',         -- 納付書・税金関係
    'certificate', -- 証明書類（登記簿・各種証明）
    'namecard',    -- 名刺
    'other',       -- その他
    'unknown'      -- 未判定
  ));

-- 2) 月次管理・要約用カラムを追加
alter table public.documents add column if not exists doc_date      date;    -- 書類に記載の日付（AI抽出）
alter table public.documents add column if not exists period        text;    -- 管理上の対象月 'YYYY-MM'
alter table public.documents add column if not exists ai_summary    text;    -- AIの一言要約
alter table public.documents add column if not exists is_accounting boolean default false; -- 仕訳対象の会計証憑か

-- 3) status に 'classified'（分類済み）/ 'filed'（非会計・整理完了）を追加
alter table public.documents drop constraint if exists documents_status_check;
alter table public.documents
  add constraint documents_status_check
  check (status in (
    'uploaded',    -- アップロード直後
    'recognizing', -- AI処理中
    'classified',  -- 分類のみ完了
    'ready',       -- 会計証憑＝仕訳ドラフト生成済み（承認待ち）
    'asking',      -- 追加確認中
    'filed',       -- 非会計＝月次整理完了
    'approved',    -- 承認済み
    'sent',        -- MF登録済み
    'error'        -- エラー
  ));

-- 4) 月次×種別で素早く引くためのインデックス
create index if not exists idx_documents_period on public.documents(tenant_id, client_id, period);
create index if not exists idx_documents_type   on public.documents(tenant_id, client_id, doc_type);

-- ############################################################################
-- ## 003_mf_oauth.sql
-- ############################################################################

-- 003_mf_oauth.sql
-- MF OAuth トークン保管を扱いやすくする。
-- 暗号化済みトークン（AES-256-GCM）を base64 文字列で保存するため bytea → text へ変更。
-- accounting_credentials は現状データ無しのため型変更は安全。

alter table public.accounting_credentials
  alter column encrypted_token type text using encode(encrypted_token, 'base64');

alter table public.accounting_credentials
  alter column refresh_token_encrypted type text using
    (case when refresh_token_encrypted is null then null else encode(refresh_token_encrypted, 'base64') end);

-- ############################################################################
-- ## 004_drive_sync.sql
-- ############################################################################

-- 004_drive_sync.sql
-- Google Drive 保存の記録用カラムを documents に追加。
-- 追加のみ・既存データは変更しないため、そのまま実行可。

alter table public.documents add column if not exists drive_file_id   text;
alter table public.documents add column if not exists drive_link      text;
alter table public.documents add column if not exists drive_synced_at timestamptz;

-- 未同期の抽出を速くする（Driveへの遡り同期で使用）
create index if not exists idx_documents_drive_pending
  on public.documents(tenant_id, client_id)
  where drive_file_id is null;

-- ############################################################################
-- ## 005_groupware_core.sql
-- ############################################################################

-- 005_groupware_core.sql
-- 社内グループウェア 第1段: 社員名簿・社内ロール・操作ログの土台
--
-- ▼ 設計方針（着手前調査の決定事項に基づく）
--
--  1. 既存8テーブル（tenants / memberships / clients / accounting_credentials /
--     documents / journals / ai_questions / audit_log）は一切変更しない。追加のみ。
--
--  2. memberships.role の CHECK 制約は広げない。
--     'hr' や 'manager' を足すと is_tenant_staff()（schema.sql:211-220）、
--     lib/auth.js の canAccessClient()、api/me.js の isAdmin、
--     api/journals/approve.js の承認判定が、その新ロールを「権限なし」と解釈する。
--     エラーではなく静かに403になるため、会計機能が気づかれずに壊れる。
--     → 社内ロールは gw_role_grants に「別軸」で持つ。
--
--  3. 社内テーブルの基礎条件は user_tenant_ids() ではなく is_tenant_staff() を使う。
--     user_tenant_ids()（schema.sql:195-199）はロールを絞らないため、
--     role='client' の顧問先ユーザーにも自テナントとして見えてしまう。
--
--  4. 操作ログは既存 audit_log に相乗りさせない。
--     audit_select（schema.sql:304-306）が tenant_id in (user_tenant_ids()) のみで、
--     顧問先ユーザーからテナント全体のログが読める状態にあるため、
--     社内の機微な detail を同じ経路に乗せない。gw_activity_log に分離する。
--
--  5. 既存ポリシーは全て PERMISSIVE / TO PUBLIC。追加は必ず「可視範囲を広げる」方向に
--     しか働かないため、既存業務テーブルには一切ポリシーを足さない（新テーブルで受ける）。
--     唯一の例外は memberships への SELECT 追加で、これは意図的な加算的拡張。
--
-- 実行方法: Supabase の SQL Editor に全文を貼って実行（db/ は配信対象外）。
-- 再実行しても安全（if not exists / drop policy if exists で冪等）。


-- =============================================================================
-- 1) 社員名簿
--    グループウェア全機能の共通前提。メンション・担当者選択・既読者表示・
--    入社手続きの対象者、すべてがこのテーブルを参照する。
-- =============================================================================
create table if not exists public.gw_employees (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  -- 招待前の内定者も先に登録できるよう nullable。
  -- memberships.user_id は not null なので、内定者を memberships で先行作成はできない。
  -- 招待してアカウントが出来た時点で、ここに auth.users の id を書き込んで紐づける。
  user_id         uuid references auth.users(id) on delete set null,

  display_name    text not null,
  email           text,
  department      text,
  position        text,
  employment_type text check (employment_type in
                    ('正社員','契約社員','パート','アルバイト','業務委託','役員','その他')),
  joined_on       date,
  left_on         date,
  work_location   text,

  -- invited: 招待済みでまだログインしていない / active: 在籍
  -- leaving: 退職手続き中 / left: 退職済み（行は残す。過去の投稿の表示名に必要なため）
  status          text not null default 'active'
                    check (status in ('invited','active','leaving','left')),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 1ユーザーが同一テナントで二重に社員登録されないようにする。
-- user_id が null（内定者）の行は複数あってよいので部分インデックスにする。
create unique index if not exists uq_gw_employees_user
  on public.gw_employees(tenant_id, user_id) where user_id is not null;

create index if not exists idx_gw_employees_tenant
  on public.gw_employees(tenant_id, status);


-- =============================================================================
-- 2) 社内ロール
--    memberships.role（admin/staff/client）とは別軸。会計側の権限判定には影響しない。
--      owner         … 経営者。管理者と同じ画面を見る
--      hr            … 人事。社員名簿の編集・入社手続きを行う
--      manager       … 責任者。タスクのエスカレーション先
--      labor_advisor … 社労士。許可された入社手続き書類のみ
-- =============================================================================
create table if not exists public.gw_role_grants (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  role        text not null check (role in ('owner','hr','manager','labor_advisor')),
  granted_by  uuid references auth.users(id) on delete set null,
  granted_at  timestamptz not null default now(),
  unique (employee_id, role)
);

create index if not exists idx_gw_role_grants_tenant
  on public.gw_role_grants(tenant_id, role);


-- =============================================================================
-- 3) 社内の操作ログ（audit_log とは別。顧問先から読めない）
-- =============================================================================
create table if not exists public.gw_activity_log (
  id        bigserial primary key,
  ts        timestamptz not null default now(),
  tenant_id uuid,
  actor_id  uuid,          -- auth.users.id。参照先が消えてもログは残すので FK は張らない
  action    text not null,  -- 'employee.create' / 'role.grant' など
  target    text,           -- 'employee:<uuid>' 形式
  detail    jsonb
);

create index if not exists idx_gw_activity_tenant_ts
  on public.gw_activity_log(tenant_id, ts desc);


-- =============================================================================
-- 4) ヘルパ関数
--    既存の user_tenant_ids / user_client_ids / is_tenant_staff と同じ流儀で、
--    SECURITY DEFINER にして RLS の無限再帰を避ける。
-- =============================================================================

-- 自分の社員ID（このテナントで社員登録されていなければ null）
create or replace function public.gw_employee_id(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
    from public.gw_employees
   where tenant_id = p_tenant
     and user_id = auth.uid()
   limit 1
$$;

-- 指定した社内ロールを持っているか
create or replace function public.gw_has_role(p_tenant uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_role_grants g
      join public.gw_employees e on e.id = g.employee_id
     where g.tenant_id = p_tenant
       and g.role = p_role
       and e.user_id = auth.uid()
  )
$$;

-- 人事権限（hr または owner）。人事情報の編集はここで判定する
create or replace function public.gw_is_hr(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'hr')
      or public.gw_has_role(p_tenant, 'owner')
$$;


-- =============================================================================
-- 5) RLS
-- =============================================================================
alter table public.gw_employees     enable row level security;
alter table public.gw_role_grants   enable row level security;
alter table public.gw_activity_log  enable row level security;

-- 社員名簿: 社内の人（admin/staff）は全員読める。
-- メンションや担当者選択に必要なので、閲覧は社内で共有する。
-- 顧問先ユーザー（role='client'）は is_tenant_staff が false なので読めない。
drop policy if exists gw_employees_select on public.gw_employees;
create policy gw_employees_select on public.gw_employees
  for select using (public.is_tenant_staff(tenant_id));

-- 本人は自分の行だけ更新できる（プロフィール編集）
drop policy if exists gw_employees_self_update on public.gw_employees;
create policy gw_employees_self_update on public.gw_employees
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 追加・削除・他人の編集は人事のみ
drop policy if exists gw_employees_hr_write on public.gw_employees;
create policy gw_employees_hr_write on public.gw_employees
  for all
  using (public.gw_is_hr(tenant_id))
  with check (public.gw_is_hr(tenant_id));

-- 社内ロール: 誰が何の権限かは社内で共有。付け外しは人事のみ
drop policy if exists gw_role_grants_select on public.gw_role_grants;
create policy gw_role_grants_select on public.gw_role_grants
  for select using (public.is_tenant_staff(tenant_id));

drop policy if exists gw_role_grants_hr_write on public.gw_role_grants;
create policy gw_role_grants_hr_write on public.gw_role_grants
  for all
  using (public.gw_is_hr(tenant_id))
  with check (public.gw_is_hr(tenant_id));

-- 操作ログ: 社内の人だけ読める。書き込みポリシーは意図的に定義しない
-- （サーバ側の service_role からのみ書く。audit_log と同じ扱い）
drop policy if exists gw_activity_select on public.gw_activity_log;
create policy gw_activity_select on public.gw_activity_log
  for select using (public.is_tenant_staff(tenant_id));


-- =============================================================================
-- 6) memberships への加算的な SELECT ポリシー
--    既存の memberships_select（user_id = auth.uid()＝自分の行のみ）は変更しない。
--    PERMISSIVE ポリシーは OR で合成されるため、これは可視範囲を広げるだけで
--    既存の挙動を壊さない。社員名簿と会計側の権限を突き合わせるために必要。
-- =============================================================================
drop policy if exists memberships_select_staff on public.memberships;
create policy memberships_select_staff on public.memberships
  for select using (public.is_tenant_staff(tenant_id));


-- =============================================================================
-- 7) 初期投入について
--    gw_employees への最初の1行は、まだ誰も hr ロールを持っていないため
--    RLS 経由では入れられない。サーバ側（service_role を使う API）から投入するか、
--    この SQL Editor で直接 insert する。
--    以下は雛形（実行するなら値を埋めてコメントを外す）。
--
--    with t as (select id from public.tenants limit 1),
--         u as (select id from auth.users where email = 'ここに管理者のメール' limit 1)
--    insert into public.gw_employees (tenant_id, user_id, display_name, email, status)
--    select t.id, u.id, 'ここに氏名', 'ここに管理者のメール', 'active' from t, u
--    on conflict do nothing;
--
--    -- 続けて、その社員に owner と hr を付与する
--    insert into public.gw_role_grants (tenant_id, employee_id, role)
--    select e.tenant_id, e.id, r.role
--      from public.gw_employees e
--      cross join (values ('owner'),('hr')) as r(role)
--     where e.email = 'ここに管理者のメール'
--    on conflict do nothing;
-- =============================================================================

-- ############################################################################
-- ## 006_storage_policies.sql
-- ############################################################################

-- 006_storage_policies.sql
-- Storage バケット documents のアクセス制御。
--
-- ▼ なぜ必要か
-- schema.sql:308-333 のStorageポリシーは「参考」として丸ごとSQLコメントになっており、
-- schema.sql を実行しても storage.objects にポリシーは作られない。
-- 未適用の場合、storage.objects はポリシー不在＝全拒否となり、書類へのアクセスは
-- サーバ側 service_role が発行する短期署名URLだけに依存している状態になる。
-- （現状の app.html / admin.html は署名URL経由なので動くが、多層防御になっていない）
--
-- ▼ 元のコメント版からの修正点
-- 元案は split_part(name,'/',1)::uuid を無条件にキャストしていた。
-- この形だと、UUID以外のプレフィックス（例: 'groupware/...'）のオブジェクトが
-- 1つでも入った時点で invalid input syntax エラーになり、
-- 既存の書類一覧・署名URL発行まで巻き添えで落ちる。
-- PostgreSQL は AND の評価順を保証しないため、正規表現でガードするだけでは不十分。
-- そこで、失敗時に null を返す safe_uuid() を通してからキャストする。
--
-- 実行方法: Supabase の SQL Editor に全文を貼って実行。再実行しても安全。


-- =============================================================================
-- 1) バケット（非公開）
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;


-- =============================================================================
-- 2) 文字列を安全に uuid へ変換する（失敗したら null）
--    RLS の中で ::uuid を直接使うと、想定外のパスでクエリ全体が落ちるため。
-- =============================================================================
create or replace function public.safe_uuid(p text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p::uuid;
exception
  when others then
    return null;
end;
$$;


-- =============================================================================
-- 3) documents バケットのポリシー
--    パス規約: <tenant_id>/<client_id>/<YYYY-MM>/<doc_id>.<ext>
--      - 事務所スタッフ（admin/staff）… 自テナント配下すべて
--      - 顧問先ユーザー（client）      … 自分のクライアント配下のみ
--    safe_uuid が null を返した場合、is_tenant_staff(null) は false、
--    null in (...) は真にならないため、いずれも「拒否」に倒れる。
-- =============================================================================
drop policy if exists documents_owner_rw on storage.objects;
drop policy if exists documents_tenant_rw on storage.objects;

create policy documents_tenant_rw on storage.objects
  for all
  using (
    bucket_id = 'documents'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2)) in (select public.user_client_ids())
    )
  )
  with check (
    bucket_id = 'documents'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2)) in (select public.user_client_ids())
    )
  );


-- =============================================================================
-- 4) 確認用
--    実行後、以下で1行返ることを確認する。
--
--    select policyname, cmd
--      from pg_policies
--     where schemaname = 'storage' and tablename = 'objects';
-- =============================================================================


-- #############################################################################
-- ## 007_notices.sql
-- #############################################################################

-- =============================================================================
-- 007_notices.sql — 社内お知らせ
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針（005 のヘッダに書いた原則をそのまま踏襲する）
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 基礎条件に user_tenant_ids() は使わない。
--      顧問先ロールのユーザーもテナントIDを持つため、社内情報が漏れる。
--      「そのテナントの社員名簿に載っていること」= gw_employee_id() で判定する。
--   3. 部署宛てのお知らせは API ではなく RLS で絞る。
--      anon key と JWT はブラウザにあるので、API 層の if は境界にならない。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) お知らせ本体
-- -----------------------------------------------------------------------------
create table if not exists public.gw_notices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  title       text not null,
  body        text not null,

  -- 表示上の色分けに使う。運用しながら増やす想定
  category    text not null default 'general'
              check (category in ('general','important','system','event')),

  -- 宛先。'all' = 全社 / 'department' = departments に挙げた部署のみ
  audience    text not null default 'all'
              check (audience in ('all','department')),
  departments text[] not null default '{}',

  pinned      boolean not null default false,

  -- 'draft' は本人と管理者にしか見えない。'published' で配信開始
  status      text not null default 'published'
              check (status in ('draft','published','archived')),

  publish_at  timestamptz not null default now(),
  expires_at  timestamptz,

  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_notices_tenant
  on public.gw_notices(tenant_id, status, publish_at desc);


-- -----------------------------------------------------------------------------
-- 2) 既読
--    誰が読んだかを管理者が確認できるようにする（要件: 既読状況）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_notice_reads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  notice_id   uuid not null references public.gw_notices(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  read_at     timestamptz not null default now(),
  unique (notice_id, employee_id)
);

create index if not exists idx_gw_notice_reads_notice
  on public.gw_notice_reads(notice_id);


-- -----------------------------------------------------------------------------
-- 3) ヘルパ: 自分の部署名
--    RLS の中から呼ぶので SECURITY DEFINER。未登録なら null。
-- -----------------------------------------------------------------------------
create or replace function public.gw_my_department(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select department
    from public.gw_employees
   where tenant_id = p_tenant
     and user_id = auth.uid()
   limit 1
$$;

-- 自分にそのお知らせが配信されているか
create or replace function public.gw_notice_targets_me(
  p_tenant uuid, p_audience text, p_departments text[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
           when p_audience = 'all' then true
           else coalesce(public.gw_my_department(p_tenant), '') = any(coalesce(p_departments, '{}'))
         end
$$;


-- -----------------------------------------------------------------------------
-- 4) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_notices      enable row level security;
alter table public.gw_notice_reads enable row level security;

-- 参照: 管理者はすべて。社員は「自分宛て・公開中・期限内」のみ
drop policy if exists gw_notices_select on public.gw_notices;
create policy gw_notices_select on public.gw_notices
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or (
      public.gw_employee_id(tenant_id) is not null
      and status = 'published'
      and publish_at <= now()
      and (expires_at is null or expires_at > now())
      and public.gw_notice_targets_me(tenant_id, audience, departments)
    )
  );

-- 作成・編集・削除: 管理者(staff/admin) または 人事権限(hr/owner)
drop policy if exists gw_notices_write on public.gw_notices;
create policy gw_notices_write on public.gw_notices
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 既読の参照: 管理者は全員分（既読状況の集計）、社員は自分の分だけ
drop policy if exists gw_notice_reads_select on public.gw_notice_reads;
create policy gw_notice_reads_select on public.gw_notice_reads
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 社員名簿に自分の行を読む権限を足す（追加のみ。既存ポリシーは変更しない）。
-- 005 の gw_employees_select は is_tenant_staff 限定なので、メンバー（顧問先ロール）は
-- 自分の氏名すら引けない。お知らせの既読を自分で付けるために必要になる。
drop policy if exists gw_employees_self_select on public.gw_employees;
create policy gw_employees_self_select on public.gw_employees
  for select using (user_id = auth.uid());

-- 既読を付けられるのは自分の分だけ。他人の既読は作れない
drop policy if exists gw_notice_reads_insert on public.gw_notice_reads;
create policy gw_notice_reads_insert on public.gw_notice_reads
  for insert
  with check (employee_id = public.gw_employee_id(tenant_id));


-- #############################################################################
-- ## 008_onboarding.sql
-- #############################################################################

-- =============================================================================
-- 008_onboarding.sql — 入社・退職手続き
--
-- 前提: db/005_groupware_core.sql と db/007_notices.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 手続きの中身は人事情報そのものなので、既定は「人事と管理者だけ」。
--      本人は自分の手続きだけ、社労士は共有マークの付いた項目だけ見える。
--   3. 本人による「提出しました」の更新は RLS では許可しない。
--      列単位の制限が RLS では書けないため、直接 UPDATE を全面的に塞ぎ、
--      サーバ側の API（api/onboarding/submit.js）だけを唯一の書き込み口にする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 手続き本体
-- -----------------------------------------------------------------------------
create table if not exists public.gw_procedures (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,

  kind         text not null default 'onboarding'
               check (kind in ('onboarding','offboarding')),
  status       text not null default 'in_progress'
               check (status in ('not_started','in_progress','done','cancelled')),

  -- 入社日／退職日。期限の色分けに使う
  target_on    date,
  note         text,

  -- 個人フォルダ（Google Drive）。未設定の環境では null のまま
  drive_folder_id text,
  drive_link      text,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 同じ人に同じ種別の手続きを二重に作らない
  unique (employee_id, kind)
);

create index if not exists idx_gw_procedures_tenant
  on public.gw_procedures(tenant_id, status, target_on);


-- -----------------------------------------------------------------------------
-- 2) 手続きの項目（提出書類・作業）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_procedure_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  procedure_id  uuid not null references public.gw_procedures(id) on delete cascade,

  title         text not null,
  category      text not null default 'document'
                check (category in ('document','task','account','equipment')),

  -- 誰の担当か。本人が出すものだけをメンバー画面に出す
  owner         text not null default 'employee'
                check (owner in ('employee','hr','labor_advisor')),

  required      boolean not null default true,

  -- 社労士に開示してよい項目か。既定は開示しない
  share_with_advisor boolean not null default false,

  status        text not null default 'todo'
                check (status in ('todo','submitted','done','na')),

  due_on        date,
  note          text,
  sort_order    integer not null default 0,

  -- 本人がアップロードした書類と紐づける（documents は会計側と共用）
  document_id   uuid references public.documents(id) on delete set null,

  completed_at  timestamptz,
  completed_by  uuid references auth.users(id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_gw_procedure_items_proc
  on public.gw_procedure_items(procedure_id, sort_order);


-- -----------------------------------------------------------------------------
-- 3) ヘルパ: 社労士かどうか
-- -----------------------------------------------------------------------------
create or replace function public.gw_is_advisor(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_has_role(p_tenant, 'labor_advisor')
$$;

-- 指定した手続きが自分のものか（項目のポリシーから呼ぶ）
create or replace function public.gw_procedure_is_mine(p_procedure uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_procedures p
      join public.gw_employees e on e.id = p.employee_id
     where p.id = p_procedure
       and e.user_id = auth.uid()
  )
$$;


-- -----------------------------------------------------------------------------
-- 4) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_procedures      enable row level security;
alter table public.gw_procedure_items enable row level security;

-- 手続きの参照: 管理者・人事は全件、本人は自分の分、社労士は一覧のみ
drop policy if exists gw_procedures_select on public.gw_procedures;
create policy gw_procedures_select on public.gw_procedures
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_is_advisor(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 手続きの作成・編集・削除: 管理者と人事のみ
drop policy if exists gw_procedures_write on public.gw_procedures;
create policy gw_procedures_write on public.gw_procedures
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 項目の参照:
--   管理者・人事 … 全件
--   本人         … 自分の手続きの項目
--   社労士       … share_with_advisor が立っている項目だけ
drop policy if exists gw_procedure_items_select on public.gw_procedure_items;
create policy gw_procedure_items_select on public.gw_procedure_items
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_procedure_is_mine(procedure_id)
    or (public.gw_is_advisor(tenant_id) and share_with_advisor)
  );

-- 社労士が「誰の手続きか」を見られるようにする（追加のみ）。
-- 手続きが1件も無い社員は対象外なので、名簿全体が見えるわけではない。
drop policy if exists gw_employees_advisor_select on public.gw_employees;
create policy gw_employees_advisor_select on public.gw_employees
  for select
  using (
    public.gw_is_advisor(tenant_id)
    and exists (
      select 1 from public.gw_procedures p where p.employee_id = gw_employees.id
    )
  );

-- 項目の作成・編集・削除: 管理者と人事のみ。
-- 本人の「提出しました」も含めてここでは許可しない（列単位の制限が書けないため）。
-- 本人の更新は api/onboarding/submit.js（service_role）を唯一の口にする。
drop policy if exists gw_procedure_items_write on public.gw_procedure_items;
create policy gw_procedure_items_write on public.gw_procedure_items
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- #############################################################################
-- ## 009_tasks.sql
-- #############################################################################

-- =============================================================================
-- 009_tasks.sql — やること（タスク・予定）
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 見えてよいのは「社内の人」だけ。顧問先ロールのユーザーに漏れないよう、
--      基礎条件に user_tenant_ids() は使わず gw_employee_id() を使う。
--   3. 担当者が自分のタスクの状態を変えるのは RLS では許可しない。
--      列単位の制限が書けないため、担当者に UPDATE を許すと担当者や期限まで
--      書き換えられる。サーバ側（api/tasks/index.js の PATCH）を唯一の口にする。
-- =============================================================================

create table if not exists public.gw_tasks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,

  title        text not null,
  body         text,

  -- 担当者。未割り当て（部署のタスクなど）もありうるので null 可
  assignee_id  uuid references public.gw_employees(id) on delete set null,

  -- 期限を過ぎたときに気づいてほしい人（責任者）
  escalate_to  uuid references public.gw_employees(id) on delete set null,
  escalated_at timestamptz,

  due_on       date,
  priority     text not null default 'normal'
               check (priority in ('low','normal','high')),
  status       text not null default 'todo'
               check (status in ('todo','doing','done','cancelled')),

  -- 「入社手続き」「月次経理」など。自由入力の分類
  category     text,

  completed_at timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gw_tasks_tenant
  on public.gw_tasks(tenant_id, status, due_on);
create index if not exists idx_gw_tasks_assignee
  on public.gw_tasks(assignee_id, status);


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.gw_tasks enable row level security;

-- 参照: 管理者・人事は全件。それ以外の社員は自分が関係するものだけ
--       （担当・エスカレーション先・自分が作ったもの）
drop policy if exists gw_tasks_select on public.gw_tasks;
create policy gw_tasks_select on public.gw_tasks
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or assignee_id  = public.gw_employee_id(tenant_id)
    or escalate_to  = public.gw_employee_id(tenant_id)
    or created_by   = auth.uid()
  );

-- 作成・編集・削除: 管理者と人事のみ。
-- 担当者による状態変更は api/tasks/index.js（service_role）で扱う。
drop policy if exists gw_tasks_write on public.gw_tasks;
create policy gw_tasks_write on public.gw_tasks
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 担当者選択のために、社員名簿を社内の人に見せる
--   005 の gw_employees_select は is_tenant_staff 限定で、007 で本人の行だけ
--   追加した。タスクの担当者名を出すには、社員同士が名前を引ける必要がある。
--   公開するのは名簿に載っている人だけ（＝顧問先ロールのユーザーには見えない）。
-- -----------------------------------------------------------------------------
drop policy if exists gw_employees_peer_select on public.gw_employees;
create policy gw_employees_peer_select on public.gw_employees
  for select
  using (public.gw_employee_id(tenant_id) is not null);


-- #############################################################################
-- ## 010_messages.sql
-- #############################################################################

-- =============================================================================
-- 010_messages.sql — 社内メッセージ（1対1・グループ）
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 見えるのは「そのスレッドに参加している人」だけ。
--      管理者や経営者であっても、参加していないスレッドは読めない。
--      個人のやりとりなので、役職で覗けるようにはしない。
--   3. スレッドの作成と参加者の追加、既読の更新は RLS では許可しない。
--      自分の参加行を書き換えて別のスレッドに入り込めてしまうため、
--      サーバ側（api/messages/*）を唯一の書き込み口にする。
--      本文の投稿だけは安全に書けるので RLS で直接許可する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) スレッド
-- -----------------------------------------------------------------------------
create table if not exists public.gw_threads (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  kind            text not null default 'dm' check (kind in ('dm','group')),
  -- グループのときの名前。1対1では相手の名前を画面側で出すので null
  title           text,

  created_by      uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists idx_gw_threads_tenant
  on public.gw_threads(tenant_id, last_message_at desc);


-- -----------------------------------------------------------------------------
-- 2) 参加者
-- -----------------------------------------------------------------------------
create table if not exists public.gw_thread_members (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  thread_id    uuid not null references public.gw_threads(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,

  -- ここまで読んだ、の目印。未読件数はこれと突き合わせて数える
  last_read_at timestamptz not null default 'epoch',
  joined_at    timestamptz not null default now(),

  unique (thread_id, employee_id)
);

create index if not exists idx_gw_thread_members_employee
  on public.gw_thread_members(employee_id);


-- -----------------------------------------------------------------------------
-- 3) 本文
-- -----------------------------------------------------------------------------
create table if not exists public.gw_messages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  thread_id  uuid not null references public.gw_threads(id) on delete cascade,
  sender_id  uuid not null references public.gw_employees(id) on delete cascade,

  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_messages_thread
  on public.gw_messages(thread_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 4) ヘルパ: 自分がそのスレッドに参加しているか
--    RLS の中から呼ぶので SECURITY DEFINER（無限再帰を避ける）
-- -----------------------------------------------------------------------------
create or replace function public.gw_in_thread(p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_thread_members tm
      join public.gw_employees e on e.id = tm.employee_id
     where tm.thread_id = p_thread
       and e.user_id = auth.uid()
  )
$$;


-- -----------------------------------------------------------------------------
-- 5) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_threads        enable row level security;
alter table public.gw_thread_members enable row level security;
alter table public.gw_messages       enable row level security;

-- スレッド: 参加者だけが見える。作成・変更のポリシーは意図的に置かない
drop policy if exists gw_threads_select on public.gw_threads;
create policy gw_threads_select on public.gw_threads
  for select using (public.gw_in_thread(id));

-- 参加者一覧: 同じスレッドの参加者だけが見える。書き込みポリシーは置かない
drop policy if exists gw_thread_members_select on public.gw_thread_members;
create policy gw_thread_members_select on public.gw_thread_members
  for select using (public.gw_in_thread(thread_id));

-- 本文の参照: 参加者だけ
drop policy if exists gw_messages_select on public.gw_messages;
create policy gw_messages_select on public.gw_messages
  for select using (public.gw_in_thread(thread_id));

-- 本文の投稿: 参加しているスレッドに、自分名義でのみ書ける。
-- 他人になりすませないよう sender_id を自分の社員IDに固定する。
drop policy if exists gw_messages_insert on public.gw_messages;
create policy gw_messages_insert on public.gw_messages
  for insert
  with check (
    public.gw_in_thread(thread_id)
    and sender_id = public.gw_employee_id(tenant_id)
  );

-- 投稿の取り消しは自分の分だけ（編集はできない。履歴を濁らせないため）
drop policy if exists gw_messages_delete on public.gw_messages;
create policy gw_messages_delete on public.gw_messages
  for delete
  using (sender_id = public.gw_employee_id(tenant_id));


-- #############################################################################
-- ## 011_assets_templates.sql
-- #############################################################################

-- =============================================================================
-- 011_assets_templates.sql — 貸与品・アカウント台帳と、書類の雛形
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 台帳は人事情報に近いので、既定は「管理者・人事」だけ。
--      ただし自分に貸与されているものは本人にも見せる（返却漏れを防ぐため）。
--   3. 雛形は社内文書なので、管理者・人事のみ。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 貸与品・アカウント
-- -----------------------------------------------------------------------------
create table if not exists public.gw_assets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  kind        text not null default 'other'
              check (kind in ('pc','phone','account','key','other')),
  -- 「MacBook Air M2」「Slack」「オフィス鍵」など
  name        text not null,
  -- 製造番号・アカウント名など、個体を特定するもの
  identifier  text,

  assigned_to uuid references public.gw_employees(id) on delete set null,
  assigned_on date,
  returned_on date,

  status      text not null default 'in_stock'
              check (status in ('in_stock','assigned','returned','disposed')),

  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_assets_tenant
  on public.gw_assets(tenant_id, status);
create index if not exists idx_gw_assets_assignee
  on public.gw_assets(assigned_to);


-- -----------------------------------------------------------------------------
-- 2) 書類の雛形
--    body の中の {{氏名}} などを、対象者の情報で差し込んで使う。
--    差し込みは画面側で行う（DBには雛形そのものだけを持つ）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_doc_templates (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,

  name             text not null,
  kind             text not null default 'general'
                   check (kind in ('onboarding','offboarding','general')),
  -- 対象の雇用区分。空配列なら全区分が対象
  employment_types text[] not null default '{}',

  body             text not null,
  note             text,

  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_gw_doc_templates_tenant
  on public.gw_doc_templates(tenant_id, kind);


-- -----------------------------------------------------------------------------
-- 3) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_assets        enable row level security;
alter table public.gw_doc_templates enable row level security;

-- 台帳の参照: 管理者・人事は全件。本人は自分に貸与されているものだけ
drop policy if exists gw_assets_select on public.gw_assets;
create policy gw_assets_select on public.gw_assets
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or assigned_to = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_assets_write on public.gw_assets;
create policy gw_assets_write on public.gw_assets
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 雛形: 管理者・人事のみ
drop policy if exists gw_doc_templates_select on public.gw_doc_templates;
create policy gw_doc_templates_select on public.gw_doc_templates
  for select
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

drop policy if exists gw_doc_templates_write on public.gw_doc_templates;
create policy gw_doc_templates_write on public.gw_doc_templates
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- #############################################################################
-- ## 012_hr_files.sql
-- #############################################################################

-- =============================================================================
-- 012_hr_files.sql — 入社・退職手続きの提出ファイル
--
-- 前提: 006_storage_policies.sql（safe_uuid）と 008_onboarding.sql が適用済み。
--
-- なぜ documents テーブルを使わないか
--   documents は会計の証憑用で、同じ取引先のメンバーなら誰でも読める。
--   マイナンバー確認書類や年金手帳の控えを同じ場所に置くと、社員同士で
--   見えてしまう。保存先のバケットごと分けて、本人と人事だけに絞る。
--
-- 社労士は「共有マークの付いた項目」に紐づくファイルだけ見える。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) バケット（非公開・証憑とは別）
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('hr', 'hr', false)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- 2) 提出ファイルの台帳
-- -----------------------------------------------------------------------------
create table if not exists public.gw_procedure_files (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  procedure_id  uuid not null references public.gw_procedures(id) on delete cascade,
  -- どのチェック項目に対する提出か。項目が消えてもファイルは残す
  item_id       uuid references public.gw_procedure_items(id) on delete set null,

  filename      text not null,
  mime_type     text not null,
  size_bytes    integer,
  storage_path  text not null,

  -- 人事フォルダ（GDRIVE_HR_FOLDER_ID の下）へのコピー
  drive_file_id text,
  drive_link    text,

  uploaded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_gw_procedure_files_proc
  on public.gw_procedure_files(procedure_id);


-- -----------------------------------------------------------------------------
-- 3) RLS
--    書き込みポリシーは意図的に置かない。
--    保存先パスと item_id の整合をサーバ側で組み立てる必要があるため、
--    api/onboarding/upload.js（service_role）を唯一の書き込み口にする。
-- -----------------------------------------------------------------------------
alter table public.gw_procedure_files enable row level security;

drop policy if exists gw_procedure_files_select on public.gw_procedure_files;
create policy gw_procedure_files_select on public.gw_procedure_files
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_procedure_is_mine(procedure_id)
    or (
      public.gw_is_advisor(tenant_id)
      and exists (
        select 1 from public.gw_procedure_items i
         where i.id = gw_procedure_files.item_id
           and i.share_with_advisor
      )
    )
  );


-- -----------------------------------------------------------------------------
-- 4) Storage のポリシー
--    パス規約: <tenant_id>/<procedure_id>/<file_id>.<ext>
--    safe_uuid を通すのは、UUID でないパスが1つでもあると
--    キャスト失敗でクエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
drop policy if exists hr_files_rw on storage.objects;
create policy hr_files_rw on storage.objects
  for all
  using (
    bucket_id = 'hr'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_procedure_is_mine(public.safe_uuid(split_part(name, '/', 2)))
    )
  )
  with check (
    bucket_id = 'hr'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_procedure_is_mine(public.safe_uuid(split_part(name, '/', 2)))
    )
  );


-- #############################################################################
-- ## 013_notifications.sql
-- #############################################################################

-- =============================================================================
-- 013_notifications.sql — 社内通知
--
-- 前提: 005_groupware_core.sql と 009_tasks.sql が適用済み。
--
-- 用途
--   いまは「タスクの期限超過」だけだが、あとから新着メッセージや
--   提出物の督促にも使えるよう、汎用の1テーブルにしている。
--
-- 方針
--   自分あての通知しか見えない。管理者や経営者でも他人の通知は読めない。
--   （誰に何が届いたかは、その人の仕事の中身そのものなので広げない）
--   書き込みポリシーは置かない。サーバ側（cron / API）からのみ作る。
-- =============================================================================

create table if not exists public.gw_notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  -- 宛先。社員名簿の行に紐づける
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  kind        text not null default 'general'
              check (kind in ('general','task_overdue','task_assigned','notice','message')),

  title       text not null,
  body        text,
  -- 押したときの遷移先（同一サイト内の相対パス）
  link        text,

  -- 同じ用件で何度も通知しないための鍵。例: 'task_overdue:<task_id>'
  dedupe_key  text,

  read_at     timestamptz,
  created_at  timestamptz not null default now(),

  unique (employee_id, dedupe_key)
);

create index if not exists idx_gw_notifications_inbox
  on public.gw_notifications(employee_id, read_at, created_at desc);


-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.gw_notifications enable row level security;

-- 参照: 自分あてのものだけ
drop policy if exists gw_notifications_select on public.gw_notifications;
create policy gw_notifications_select on public.gw_notifications
  for select
  using (employee_id = public.gw_employee_id(tenant_id));

-- 既読を付けるのは自分の分だけ。作成・削除のポリシーは置かない
drop policy if exists gw_notifications_update on public.gw_notifications;
create policy gw_notifications_update on public.gw_notifications
  for update
  using (employee_id = public.gw_employee_id(tenant_id))
  with check (employee_id = public.gw_employee_id(tenant_id));


-- #############################################################################
-- ## 014_message_files.sql
-- #############################################################################

-- =============================================================================
-- 014_message_files.sql — メッセージの添付ファイル
--
-- 前提: 006_storage_policies.sql（safe_uuid）と 010_messages.sql が適用済み。
--
-- 方針
--   バケットは会計の証憑（documents）とも人事書類（hr）とも分ける。
--   やりとりの添付は「そのスレッドの参加者だけ」が見られればよく、
--   他の2つとは見せる相手がまったく違うため。
--
--   書き込みポリシーは置かない。保存先パスとスレッドの対応をサーバ側で
--   組み立てる必要があるので、api/messages/upload.js を唯一の口にする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) バケット（非公開）
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('messages', 'messages', false)
on conflict (id) do nothing;


-- -----------------------------------------------------------------------------
-- 2) 添付の台帳
--    先にファイルを預けてから本文を送るので、message_id は後から入る。
--    送信されずに残った行は message_id が null のままになる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_message_files (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  thread_id    uuid not null references public.gw_threads(id) on delete cascade,
  message_id   uuid references public.gw_messages(id) on delete cascade,

  filename     text not null,
  mime_type    text not null,
  size_bytes   integer,
  storage_path text not null,

  uploaded_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_gw_message_files_thread
  on public.gw_message_files(thread_id, created_at);
create index if not exists idx_gw_message_files_message
  on public.gw_message_files(message_id);


-- -----------------------------------------------------------------------------
-- 3) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_message_files enable row level security;

-- 参照: そのスレッドの参加者だけ。管理者でも参加していなければ見えない
drop policy if exists gw_message_files_select on public.gw_message_files;
create policy gw_message_files_select on public.gw_message_files
  for select
  using (public.gw_in_thread(thread_id));


-- -----------------------------------------------------------------------------
-- 4) Storage のポリシー
--    パス規約: <tenant_id>/<thread_id>/<file_id>.<ext>
--    safe_uuid を通すのは、UUID でないパスが1つでもあるとキャスト失敗で
--    クエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
drop policy if exists message_files_rw on storage.objects;
create policy message_files_rw on storage.objects
  for all
  using (
    bucket_id = 'messages'
    and public.gw_in_thread(public.safe_uuid(split_part(name, '/', 2)))
  )
  with check (
    bucket_id = 'messages'
    and public.gw_in_thread(public.safe_uuid(split_part(name, '/', 2)))
  );


-- =============================================================================
-- 015_spaces_bookings.sql — スペース（設備）と、その予約申請
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--   2. 空き状況は社員全員が見えないと予約の意味が無いので、
--      予約の参照は「同じ会社の社員なら誰でも」にする。
--   3. 承認・却下は管理者と人事だけ。申請者自身の取り消しは API 側で行う。
--      （RLS は列単位の制限が書けないため、本人に UPDATE を許すと
--        自分の申請を approved に書き換えられてしまう）
--   4. 同じスペースの時間の重なりは、アプリではなく DB の制約で止める。
--      同時申請の競合はアプリ側のチェックでは防ぎきれないため。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) スペースのマスタ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_spaces (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- 「NO.01」のような掲示用の番号。並び順と表示に使う
  code          text not null,
  name          text not null,
  capacity      int,
  note          text,

  -- 予約先の Google カレンダー。空なら GCAL_CALENDAR_ID を使う。
  -- スペースごとにカレンダーを分けたい場合だけ入れる。
  calendar_id   text,

  -- false にすると新規申請を受け付けない（一覧には残る）
  active        boolean not null default true,
  -- true なら承認待ちを挟む。false なら申請と同時に確定
  needs_approval boolean not null default true,

  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (tenant_id, code)
);

create index if not exists idx_gw_spaces_tenant
  on public.gw_spaces(tenant_id, active, sort_order);


-- -----------------------------------------------------------------------------
-- 2) 予約申請
-- -----------------------------------------------------------------------------
create table if not exists public.gw_bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  space_id       uuid not null references public.gw_spaces(id) on delete cascade,
  employee_id    uuid not null references public.gw_employees(id) on delete cascade,

  title          text not null,
  note           text,
  headcount      int,

  starts_at      timestamptz not null,
  ends_at        timestamptz not null,

  status         text not null default 'pending'
                 check (status in ('pending','approved','rejected','cancelled')),

  decided_by     uuid references public.gw_employees(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,

  -- Google カレンダー側の控え。連携に失敗しても予約自体は成立させ、
  -- 何が起きたかを gcal_error に残して管理画面で気づけるようにする
  gcal_calendar_id text,
  gcal_event_id    text,
  gcal_link        text,
  gcal_error       text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint gw_bookings_time_order check (ends_at > starts_at)
);

create index if not exists idx_gw_bookings_tenant_time
  on public.gw_bookings(tenant_id, starts_at desc);
create index if not exists idx_gw_bookings_space_time
  on public.gw_bookings(space_id, starts_at);
create index if not exists idx_gw_bookings_employee
  on public.gw_bookings(employee_id, starts_at desc);
create index if not exists idx_gw_bookings_status
  on public.gw_bookings(tenant_id, status);


-- -----------------------------------------------------------------------------
-- 3) 二重予約の防止
--    申請中・承認済みの間で、同じスペースの時間が重なる行を作れなくする。
--    btree_gist が使えない環境ではスキップし、アプリ側のチェックだけで動かす。
-- -----------------------------------------------------------------------------
do $$
begin
  create extension if not exists btree_gist;

  if not exists (
    select 1 from pg_constraint where conname = 'gw_bookings_no_overlap'
  ) then
    alter table public.gw_bookings
      add constraint gw_bookings_no_overlap
      exclude using gist (
        space_id with =,
        tstzrange(starts_at, ends_at) with &&
      ) where (status in ('pending','approved'));
  end if;
exception when others then
  raise notice 'gw_bookings_no_overlap を作成できませんでした: %', sqlerrm;
end $$;


-- -----------------------------------------------------------------------------
-- 4) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_spaces   enable row level security;
alter table public.gw_bookings enable row level security;

-- スペース一覧: 同じ会社の社員なら誰でも読める
drop policy if exists gw_spaces_select on public.gw_spaces;
create policy gw_spaces_select on public.gw_spaces
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_employee_id(tenant_id) is not null
  );

-- マスタの編集は管理者・人事だけ
drop policy if exists gw_spaces_write on public.gw_spaces;
create policy gw_spaces_write on public.gw_spaces
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 予約の参照: 空き状況が分からないと予約できないので、社員全員に見せる
drop policy if exists gw_bookings_select on public.gw_bookings;
create policy gw_bookings_select on public.gw_bookings
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_employee_id(tenant_id) is not null
  );

-- 申請は本人名義でのみ作れる。誰かの名前で勝手に押さえられないようにする
drop policy if exists gw_bookings_insert on public.gw_bookings;
create policy gw_bookings_insert on public.gw_bookings
  for insert
  with check (
    employee_id = public.gw_employee_id(tenant_id)
    and status = 'pending'
  );

-- 承認・却下・変更は管理者と人事だけ。
-- 申請者自身の取り消しは /api/bookings/cancel（service_role）が行う
drop policy if exists gw_bookings_update on public.gw_bookings;
create policy gw_bookings_update on public.gw_bookings
  for update
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

drop policy if exists gw_bookings_delete on public.gw_bookings;
create policy gw_bookings_delete on public.gw_bookings
  for delete
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 5) 通知の種別に 'booking' を足す
--    013 の CHECK に無いままだと、予約の通知を入れた時点で失敗する。
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message','booking'));
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 6) スペースの初期データ
--    8sp.co.jp の掲示に合わせた並び。NO.04 は掲示に無いため入れていない。
--    増減は管理画面（スケジュール・設備予約）から行う。
--    既にグループウェアを使っている会社（社員名簿に行がある）にだけ入れる。
-- -----------------------------------------------------------------------------
insert into public.gw_spaces (tenant_id, code, name, sort_order)
select t.id, v.code, v.name, v.sort
from public.tenants t
cross join (values
  ('NO.01', 'カフェスペース',   1),
  ('NO.02', 'スタジオスペース', 2),
  ('NO.03', 'ワークスペース',   3),
  ('NO.05', 'BOXスペース',      5),
  ('NO.06', '個室スペース',     6),
  ('NO.07', '会議スペース',     7)
) as v(code, name, sort)
where exists (select 1 from public.gw_employees e where e.tenant_id = t.id)
on conflict (tenant_id, code) do nothing;


-- =============================================================================
-- 016_expenses.sql — 経費精算（申請・承認・支払）
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 方針
--   1. 会計側のテーブル・ポリシーには一切触らない。追加のみ。
--      承認された経費は CSV で書き出して会計に取り込む。自動で仕訳は作らない。
--   2. 申請は「1件のヘッダ＋複数の明細」。月まとめでも1件ずつでも出せる。
--   3. 承認経路は金額で決める。しきい値未満は管理部の1段、
--      それ以上は管理部→代表の2段。しきい値は画面から変えられる。
--   4. 他人の経費は見えない。管理部・経営者だけが全件を見る。
--      金額と使途は、人事情報と同じくらい他人に見せたくない情報として扱う。
--   5. 提出後の明細は本人でも書き換えられない。直したいときは取り消して出し直す。
--      承認の途中で金額が変わると、何を承認したのかが分からなくなるため。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) ワークフローの設定（会社ごとに1行）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_workflow_settings (
  tenant_id                uuid primary key references public.tenants(id) on delete cascade,

  -- この金額（円）以上は代表（owner）の承認も必要。0 なら常に1段だけ
  expense_owner_threshold  int not null default 100000,

  -- 申請画面に出す勘定科目の選択肢
  expense_categories       text[] not null default array[
    '旅費交通費','会議費','交際費','消耗品費','新聞図書費',
    '通信費','研修費','支払手数料','荷造運賃','雑費'
  ],

  updated_at               timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 2) 精算申請（ヘッダ）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_expense_reports (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  employee_id    uuid not null references public.gw_employees(id) on delete cascade,

  title          text not null,
  -- 対象月 'YYYY-MM'。会計に渡すときの区分に使う
  period         text,
  -- 立替払い か 法人カード か。法人カードは支払処理が要らない
  payment_method text not null default 'personal'
                 check (payment_method in ('personal','corporate_card')),

  -- 明細の合計。API が明細から計算して入れる（画面での集計とズレないように）
  total_amount   int not null default 0,

  status         text not null default 'pending'
                 check (status in ('pending','pending_owner','approved','paid','rejected','cancelled')),

  -- 1段目（管理部）と2段目（代表）を分けて残す。誰がどこまで見たかを追えるように
  approved_by       uuid references public.gw_employees(id) on delete set null,
  approved_at       timestamptz,
  owner_approved_by uuid references public.gw_employees(id) on delete set null,
  owner_approved_at timestamptz,

  paid_on        date,
  paid_by        uuid references public.gw_employees(id) on delete set null,

  decision_note  text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_gw_expense_reports_tenant
  on public.gw_expense_reports(tenant_id, status, created_at desc);
create index if not exists idx_gw_expense_reports_employee
  on public.gw_expense_reports(employee_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 3) 明細
-- -----------------------------------------------------------------------------
create table if not exists public.gw_expense_lines (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  report_id     uuid not null references public.gw_expense_reports(id) on delete cascade,

  spent_on      date not null,
  category      text not null,
  payee         text,
  description   text,
  amount        int not null check (amount > 0),

  tax_rate      int not null default 10 check (tax_rate in (0, 8, 10)),
  -- インボイス登録事業者の領収書か。仕入税額控除の可否に関わるので申請時に取る
  invoice_registered boolean not null default true,

  -- 領収書。バケット 'expenses' の中のパス
  receipt_path  text,
  receipt_name  text,

  created_at    timestamptz not null default now()
);

create index if not exists idx_gw_expense_lines_report
  on public.gw_expense_lines(report_id, spent_on);


-- -----------------------------------------------------------------------------
-- 4) 判定用のヘルパ
--    RLS のポリシーから呼ぶので SECURITY DEFINER。
--    search_path を固定しないと、同名の関数を作られて乗っ取られる余地が残る。
-- -----------------------------------------------------------------------------

-- その申請が自分のものか
create or replace function public.gw_expense_is_mine(p_report uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_expense_reports r
     where r.id = p_report
       and r.employee_id = public.gw_employee_id(r.tenant_id)
  );
$$;

-- 自分の申請で、まだ1段目の承認が付いていないか（明細を入れてよい状態か）
create or replace function public.gw_expense_editable(p_report uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.gw_expense_reports r
     where r.id = p_report
       and r.employee_id = public.gw_employee_id(r.tenant_id)
       and r.status = 'pending'
  );
$$;

-- 経費を承認・閲覧できる立場か（管理部＝管理者/人事、または経営者）
create or replace function public.gw_expense_can_review(p_tenant uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant)
      or public.gw_is_hr(p_tenant)
      or public.gw_has_role(p_tenant, 'owner');
$$;


-- -----------------------------------------------------------------------------
-- 5) RLS
-- -----------------------------------------------------------------------------
alter table public.gw_workflow_settings enable row level security;
alter table public.gw_expense_reports   enable row level security;
alter table public.gw_expense_lines     enable row level security;

-- 設定: 社員は読める（しきい値と科目一覧が申請画面に要る）。書き換えは管理部だけ
drop policy if exists gw_workflow_settings_select on public.gw_workflow_settings;
create policy gw_workflow_settings_select on public.gw_workflow_settings
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_employee_id(tenant_id) is not null
  );

drop policy if exists gw_workflow_settings_write on public.gw_workflow_settings;
create policy gw_workflow_settings_write on public.gw_workflow_settings
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));

-- 申請の参照: 本人と、承認できる立場の人だけ。同僚には見せない
drop policy if exists gw_expense_reports_select on public.gw_expense_reports;
create policy gw_expense_reports_select on public.gw_expense_reports
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 申請の作成: 本人名義で、承認待ちの状態でのみ
drop policy if exists gw_expense_reports_insert on public.gw_expense_reports;
create policy gw_expense_reports_insert on public.gw_expense_reports
  for insert
  with check (
    employee_id = public.gw_employee_id(tenant_id)
    and status = 'pending'
  );

-- 承認・却下・支払記録は承認できる立場の人だけ。
-- 本人の取り下げは /api/expenses/decide（service_role）が行う。
-- RLS は列を絞れないので、本人に UPDATE を許すと自分で approved にできてしまう
drop policy if exists gw_expense_reports_update on public.gw_expense_reports;
create policy gw_expense_reports_update on public.gw_expense_reports
  for update
  using (public.gw_expense_can_review(tenant_id))
  with check (public.gw_expense_can_review(tenant_id));

drop policy if exists gw_expense_reports_delete on public.gw_expense_reports;
create policy gw_expense_reports_delete on public.gw_expense_reports
  for delete
  using (public.gw_expense_can_review(tenant_id));

-- 明細の参照: ヘッダと同じ範囲
drop policy if exists gw_expense_lines_select on public.gw_expense_lines;
create policy gw_expense_lines_select on public.gw_expense_lines
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or public.gw_expense_is_mine(report_id)
  );

-- 明細の作成: 自分の、まだ承認されていない申請にだけ足せる
drop policy if exists gw_expense_lines_insert on public.gw_expense_lines;
create policy gw_expense_lines_insert on public.gw_expense_lines
  for insert
  with check (public.gw_expense_editable(report_id) or public.gw_expense_can_review(tenant_id));

drop policy if exists gw_expense_lines_delete on public.gw_expense_lines;
create policy gw_expense_lines_delete on public.gw_expense_lines
  for delete
  using (public.gw_expense_editable(report_id) or public.gw_expense_can_review(tenant_id));

-- 明細の更新は誰にも許さない。金額を後から動かせないようにするため、
-- 直すときは取り消して出し直す（更新ポリシーを置かない ＝ 全員拒否）


-- -----------------------------------------------------------------------------
-- 6) 領収書の置き場
--    パス規約: <tenant_id>/<employee_id>/<uuid>.<ext>
--    申請を作る前にアップロードするので、申請IDではなく社員IDで区切る。
--    safe_uuid を通すのは、UUID でないパスが混じるとキャストで
--    クエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('expenses', 'expenses', false)
on conflict (id) do nothing;

drop policy if exists expense_files_rw on storage.objects;
create policy expense_files_rw on storage.objects
  for all
  using (
    bucket_id = 'expenses'
    and (
      public.gw_expense_can_review(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2))
         = public.gw_employee_id(public.safe_uuid(split_part(name, '/', 1)))
    )
  )
  with check (
    bucket_id = 'expenses'
    and (
      public.gw_expense_can_review(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2))
         = public.gw_employee_id(public.safe_uuid(split_part(name, '/', 1)))
    )
  );


-- -----------------------------------------------------------------------------
-- 7) 通知の種別に 'expense' を足す
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message','booking','expense'));
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 8) 設定の初期行
--    社員名簿に行がある会社（グループウェアを使っている会社）にだけ入れる。
-- -----------------------------------------------------------------------------
insert into public.gw_workflow_settings (tenant_id)
select t.id from public.tenants t
where exists (select 1 from public.gw_employees e where e.tenant_id = t.id)
on conflict (tenant_id) do nothing;


-- =============================================================================
-- 017_schedule.sql — 自分だけの社内カレンダー
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 位置づけ
--   Google カレンダーは「設備・スペースの予約」という会社の共有カレンダーとして
--   すでに使っている（015）。こちらは個人の予定で、性格がまったく違う。
--
--   個人の予定は本人以外に見せない。管理者にも経営者にも見せない。
--   スケジュールの中身は「誰といつ会っているか」が分かってしまうもので、
--   社内の連絡や手続きより機微が高い。見える必要のある人がいないなら、
--   最初から誰にも見えないようにしておく。
--
--   これは意図的な判断であって、あとから「部署内で共有」を足すときは
--   visibility の列を増やしてポリシーを広げる。逆（狭める）は既に見られた
--   あとでは取り返しがつかないので、狭いほうから始める。
-- =============================================================================

create table if not exists public.gw_calendar_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  -- 予定の持ち主。この人以外は読めない
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,

  title        text not null,
  body         text,
  location     text,

  category     text not null default 'work'
               check (category in ('work','meeting','visit','private','other')),

  -- 終日の予定。時刻を見せずに1日の帯として出す
  all_day      boolean not null default false,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 終日は開始＝終了になりうるので > ではなく >=
  constraint gw_calendar_events_time_order check (ends_at >= starts_at)
);

create index if not exists idx_gw_calendar_events_owner
  on public.gw_calendar_events(employee_id, starts_at);


-- -----------------------------------------------------------------------------
-- RLS: 本人だけ。is_tenant_staff も gw_is_hr も、あえて入れない
-- -----------------------------------------------------------------------------
alter table public.gw_calendar_events enable row level security;

drop policy if exists gw_calendar_events_own on public.gw_calendar_events;
create policy gw_calendar_events_own on public.gw_calendar_events
  for all
  using (employee_id = public.gw_employee_id(tenant_id))
  with check (employee_id = public.gw_employee_id(tenant_id));


-- =============================================================================
-- 018_google_calendar_link.sql — 各自の Google カレンダー連携
--
-- 前提: db/017_schedule.sql が適用済みであること。
--
-- 何を保存するか
--   本人が同意して発行された refresh token を1人1行で持つ。
--   これは「その人のカレンダーを読み続けられる鍵」なので、
--   ・列の中身は暗号化して入れる（api/google/* が AES-256-GCM で出し入れする）
--   ・RLS のポリシーを1つも置かない ＝ anon / authenticated からは読めない
--   の二重で守る。service_role（サーバ側の API）だけが触れる。
--
--   連携しているかどうか、どのアドレスか、は画面に出す必要があるので、
--   API が必要な列だけを選んで返す。トークンそのものは返さない。
--
-- スペース予約（015）が使っているサービスアカウントとは別の仕組み。
-- あちらは「会社の共有カレンダーに書く」、こちらは「各自のカレンダーを読む」。
-- サービスアカウントで個人のカレンダーを読むにはドメイン全体の委任が必要で、
-- それは全社員のカレンダーを本人の同意なく読める強すぎる権限になるため使わない。
-- =============================================================================

create table if not exists public.gw_google_links (
  employee_id    uuid primary key references public.gw_employees(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  -- どの Google アカウントとつないだか。本人が確認するために出す
  google_email   text,

  -- AES-256-GCM で暗号化した refresh token（平文では入れない）
  refresh_token  text not null,
  scope          text,

  connected_at   timestamptz not null default now(),
  last_synced_at timestamptz,
  -- 直近の取得で失敗した理由。連携が切れたことに気づけるようにする
  sync_error     text
);

create index if not exists idx_gw_google_links_tenant
  on public.gw_google_links(tenant_id);


-- -----------------------------------------------------------------------------
-- RLS: ポリシーを置かない ＝ 誰も直接は読めない。
--      有効化だけして、service_role からのアクセスに限る。
-- -----------------------------------------------------------------------------
alter table public.gw_google_links enable row level security;

-- 念のため、以前の版で作ったポリシーが残っていたら消す
drop policy if exists gw_google_links_own on public.gw_google_links;


-- =============================================================================
-- 019_requests.sql — 有給休暇と稟議の申請・承認
--
-- 前提: db/016_expenses.sql（gw_workflow_settings）が適用済みであること。
--
-- 経費精算と分けた理由
--   経費は「明細が複数あって合計が意味を持つ」形、こちらは「1件で完結する」形。
--   同じ表に入れると、使わない列だらけになって何が必須なのか分からなくなる。
--
-- 種別をまとめて1表にした理由
--   有給と稟議は入力する項目が違うが、申請→承認→通知の骨格は同じ。
--   あとで慶弔休暇や出張申請を足すとき、kind を増やすだけで済むようにした。
--   種別ごとに使う列が違うのは承知のうえで、JSONB にはしていない
--   （日付や金額で絞り込む場面が必ず来るので、列のままのほうが扱いやすい）。
--
-- 承認の道すじ（設定で変えない。迷いどころを作らないため）
--   有給 … 管理部（管理者・人事）の1段。承認されると共有カレンダーに入る
--   稟議 … 管理部 → 代表（経営者権限）の2段。金額に関わらず必ず2段
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 申請
-- -----------------------------------------------------------------------------
create table if not exists public.gw_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,

  kind          text not null check (kind in ('leave','ringi')),
  title         text not null,
  body          text,

  -- 有給用。時間単位の取得は扱わない（半日までにする）
  leave_type    text check (leave_type in ('paid','am','pm','special','absence')),
  starts_on     date,
  ends_on       date,
  -- 消化日数。半休は 0.5。土日を除いた日数を画面が計算し、申請者が直せる
  days          numeric(4,1),

  -- 稟議用。金額の無い稟議（方針の決裁など）もあるので必須にしない
  amount        int,

  status        text not null default 'pending'
                check (status in ('pending','pending_owner','approved','rejected','cancelled')),

  approved_by       uuid references public.gw_employees(id) on delete set null,
  approved_at       timestamptz,
  owner_approved_by uuid references public.gw_employees(id) on delete set null,
  owner_approved_at timestamptz,
  decision_note     text,

  -- 承認された有給を共有カレンダーへ入れた控え。
  -- 反映に失敗しても申請は成立させ、理由を残して管理画面で気づけるようにする
  gcal_calendar_id text,
  gcal_event_id    text,
  gcal_link        text,
  gcal_error       text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- 種別ごとに、無いと意味を成さない項目を必須にする
  constraint gw_requests_leave_shape check (
    kind <> 'leave' or (leave_type is not null and starts_on is not null and ends_on is not null and days is not null)
  ),
  constraint gw_requests_leave_order check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint gw_requests_days_range check (days is null or (days > 0 and days <= 365))
);

create index if not exists idx_gw_requests_tenant
  on public.gw_requests(tenant_id, kind, status, created_at desc);
create index if not exists idx_gw_requests_employee
  on public.gw_requests(employee_id, created_at desc);
create index if not exists idx_gw_requests_leave_period
  on public.gw_requests(employee_id, starts_on)
  where kind = 'leave';


-- -----------------------------------------------------------------------------
-- 2) 有給の付与日数
--    残日数を出すのに要る。付与のルール（勤続年数に応じた日数、繰越の上限）は
--    労務側の判断なので、計算はせず、管理部が入れた数をそのまま使う。
--    年度は会計期間に合わせて4月始まり。fiscal_year は開始年（2026-04〜2027-03 なら 2026）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_leave_grants (
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  fiscal_year  int not null,

  granted_days numeric(4,1) not null default 0,   -- その年度に付与した日数
  carried_days numeric(4,1) not null default 0,   -- 前年度からの繰越
  note         text,
  updated_at   timestamptz not null default now(),

  primary key (employee_id, fiscal_year)
);

create index if not exists idx_gw_leave_grants_tenant
  on public.gw_leave_grants(tenant_id, fiscal_year);


-- -----------------------------------------------------------------------------
-- 3) RLS
--    申請の中身（休む理由、稟議の内容）は本人と承認者だけ。同僚には見せない。
--    「誰が休むか」は承認後に共有カレンダーへ出るので、そちらで分かる。
-- -----------------------------------------------------------------------------
alter table public.gw_requests     enable row level security;
alter table public.gw_leave_grants enable row level security;

drop policy if exists gw_requests_select on public.gw_requests;
create policy gw_requests_select on public.gw_requests
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_requests_insert on public.gw_requests;
create policy gw_requests_insert on public.gw_requests
  for insert
  with check (
    employee_id = public.gw_employee_id(tenant_id)
    and status = 'pending'
  );

-- 承認・却下は承認できる立場の人だけ。
-- 本人の取り下げは /api/requests/decide（service_role）が行う。
-- RLS は列を絞れないので、本人に UPDATE を許すと自分で approved にできてしまう
drop policy if exists gw_requests_update on public.gw_requests;
create policy gw_requests_update on public.gw_requests
  for update
  using (public.gw_expense_can_review(tenant_id))
  with check (public.gw_expense_can_review(tenant_id));

drop policy if exists gw_requests_delete on public.gw_requests;
create policy gw_requests_delete on public.gw_requests
  for delete
  using (public.gw_expense_can_review(tenant_id));

-- 付与日数: 本人は自分の分を読める（残日数の表示に要る）。書き換えは管理部だけ
drop policy if exists gw_leave_grants_select on public.gw_leave_grants;
create policy gw_leave_grants_select on public.gw_leave_grants
  for select
  using (
    public.gw_expense_can_review(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_leave_grants_write on public.gw_leave_grants;
create policy gw_leave_grants_write on public.gw_leave_grants
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 4) 通知の種別に 'request' を足す
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_notifications') is not null then
    alter table public.gw_notifications
      drop constraint if exists gw_notifications_kind_check;
    alter table public.gw_notifications
      add constraint gw_notifications_kind_check
      check (kind in ('general','task_overdue','task_assigned','notice','message','booking','expense','request'));
  end if;
end $$;


-- =============================================================================
-- 020_library.sql — 社内文書（マニュアル・社内規定・様式）
--
-- 前提: db/006_storage_policies.sql（safe_uuid）と db/005_groupware_core.sql。
--
-- gw_doc_templates（011）との違い
--   あちらは「管理部が差し込んで書き出す雛形」で、管理部しか見ない。
--   こちらは「社員が読むための文書」。就業規則、経費のルール、申請様式など。
--   読む人が違うので、同じ表には入れない。
--
-- 置き方は2通りを許す
--   ・ファイルを上げる（バケット library）
--   ・外部のリンクを登録する（Google ドライブやスプレッドシートをそのまま使う場合）
--   すでに Google 側で運用している文書を無理に移させないため。
-- =============================================================================

create table if not exists public.gw_library (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  title       text not null,
  category    text not null default 'other'
              check (category in ('rule','manual','form','other')),
  description text,

  -- バケット library の中のパス。外部リンクだけの登録なら空
  file_path   text,
  file_name   text,
  mime_type   text,
  size_bytes  integer,

  -- Google ドライブなど、外に置いてある文書へのリンク
  link_url    text,

  -- false にすると社員には出ない（作りかけを隠す用）
  published   boolean not null default true,
  sort_order  int not null default 0,

  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- ファイルもリンクも無い行は、開くものが無くて意味を成さない
  constraint gw_library_has_target check (file_path is not null or link_url is not null)
);

create index if not exists idx_gw_library_tenant
  on public.gw_library(tenant_id, category, sort_order);


-- -----------------------------------------------------------------------------
-- RLS: 社員は公開されているものを読める。登録・編集は管理部だけ
-- -----------------------------------------------------------------------------
alter table public.gw_library enable row level security;

drop policy if exists gw_library_select on public.gw_library;
create policy gw_library_select on public.gw_library
  for select
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or (published and public.gw_employee_id(tenant_id) is not null)
  );

drop policy if exists gw_library_write on public.gw_library;
create policy gw_library_write on public.gw_library
  for all
  using (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id))
  with check (public.is_tenant_staff(tenant_id) or public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- ファイルの置き場
--   パス規約: <tenant_id>/<uuid>.<ext>
--   社員なら誰でも読める。書き込みは管理部だけ。
--   safe_uuid を通すのは、UUID でないパスが混じるとキャストで
--   クエリ全体が落ちるため（006 と同じ理由）。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('library', 'library', false)
on conflict (id) do nothing;

drop policy if exists library_read on storage.objects;
create policy library_read on storage.objects
  for select
  using (
    bucket_id = 'library'
    and public.gw_employee_id(public.safe_uuid(split_part(name, '/', 1))) is not null
  );

drop policy if exists library_write on storage.objects;
create policy library_write on storage.objects
  for all
  using (
    bucket_id = 'library'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
    )
  )
  with check (
    bucket_id = 'library'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.gw_is_hr(public.safe_uuid(split_part(name, '/', 1)))
    )
  );


-- =============================================================================
-- 021_web_analytics.sql — 自社Webサイトのアクセス統合
--
-- 前提: db/005_groupware_core.sql が適用済みであること。
--
-- 表の名前について
--   仕様書では vercel_projects / analytics_daily という名前だったが、
--   この Supabase は LMS・事務ポータル・ENGER と共用している。
--   analytics_daily のような一般的な名前は将来ぶつかる可能性が高いので、
--   このリポジトリの決まりどおり gw_ を付けた（CLAUDE.md）。
--
-- 誰が見られるか
--   数字は経営情報なので、管理者と経営者だけ。人事権限では見せない。
--
-- データの出どころ
--   1) 自前の計測タグ（js/beacon.js → /api/collect）… 必ず取れる
--   2) 外部の集計（Vercel など）… 取れるサイトだけ
--   どちらで入れた行かを source 列に残し、混ざっても後から切り分けられるようにする。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 対象サイト
-- -----------------------------------------------------------------------------
create table if not exists public.gw_web_projects (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  -- Vercel のプロジェクトID。手で足したサイトでは空
  provider_id   text,
  provider      text not null default 'vercel' check (provider in ('vercel','manual')),

  -- 一覧に出す名前（"ENGER" など）。Vercel のプロジェクト名とは分けて持つ
  name          text not null,
  project_name  text,
  domain        text,

  -- 計測タグを貼るときの合鍵。/api/collect はこの値で受け口を判別する
  beacon_key    text unique,

  enabled       boolean not null default true,
  sort_order    int not null default 0,

  -- 直近の取り込み結果。取れていないサイトを画面で見分けるために残す
  last_synced_at timestamptz,
  sync_source    text,
  sync_error     text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (tenant_id, provider, provider_id)
);

create index if not exists idx_gw_web_projects_tenant
  on public.gw_web_projects(tenant_id, enabled, sort_order);
create index if not exists idx_gw_web_projects_beacon
  on public.gw_web_projects(beacon_key) where beacon_key is not null;


-- -----------------------------------------------------------------------------
-- 2) 日別の数字
--    同じ日を何度取り込んでも増えないよう、(project, date, source) で一意にして
--    上書きする。時間ごとに回すので、追記だと1日で24倍になる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_web_daily (
  project_id uuid not null references public.gw_web_projects(id) on delete cascade,
  date       date not null,
  source     text not null default 'beacon' check (source in ('beacon','vercel')),

  pageviews  int not null default 0,
  visitors   int not null default 0,

  updated_at timestamptz not null default now(),
  primary key (project_id, date, source)
);

create index if not exists idx_gw_web_daily_date
  on public.gw_web_daily(date desc);


-- -----------------------------------------------------------------------------
-- 3) 流入元と人気ページ
--    上位だけ持てば足りるので、取り込み側で件数を絞ってから入れる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_web_referrers (
  project_id uuid not null references public.gw_web_projects(id) on delete cascade,
  date       date not null,
  source     text not null default 'beacon' check (source in ('beacon','vercel')),
  -- "google" "direct" "x.com" など。ホスト名まで
  referrer   text not null,
  pageviews  int not null default 0,
  primary key (project_id, date, source, referrer)
);

create table if not exists public.gw_web_pages (
  project_id uuid not null references public.gw_web_projects(id) on delete cascade,
  date       date not null,
  source     text not null default 'beacon' check (source in ('beacon','vercel')),
  path       text not null,
  pageviews  int not null default 0,
  primary key (project_id, date, source, path)
);

create index if not exists idx_gw_web_referrers_date on public.gw_web_referrers(date desc);
create index if not exists idx_gw_web_pages_date on public.gw_web_pages(date desc);


-- -----------------------------------------------------------------------------
-- 4) RLS
--    アクセス数は経営情報。管理者と経営者だけに見せる。
--    書き込みは取り込み処理（service_role）だけなので、書き込みポリシーは置かない。
-- -----------------------------------------------------------------------------
alter table public.gw_web_projects  enable row level security;
alter table public.gw_web_daily     enable row level security;
alter table public.gw_web_referrers enable row level security;
alter table public.gw_web_pages     enable row level security;

create or replace function public.gw_can_see_analytics(p_tenant uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_tenant_staff(p_tenant) or public.gw_has_role(p_tenant, 'owner');
$$;

drop policy if exists gw_web_projects_select on public.gw_web_projects;
create policy gw_web_projects_select on public.gw_web_projects
  for select using (public.gw_can_see_analytics(tenant_id));

-- 明細3表は project_id 経由で判定する。テナント列を持たせると
-- 取り込みのたびに整合を気にすることになるため、親を1回引くほうを選んだ
drop policy if exists gw_web_daily_select on public.gw_web_daily;
create policy gw_web_daily_select on public.gw_web_daily
  for select using (exists (
    select 1 from public.gw_web_projects p
     where p.id = gw_web_daily.project_id
       and public.gw_can_see_analytics(p.tenant_id)));

drop policy if exists gw_web_referrers_select on public.gw_web_referrers;
create policy gw_web_referrers_select on public.gw_web_referrers
  for select using (exists (
    select 1 from public.gw_web_projects p
     where p.id = gw_web_referrers.project_id
       and public.gw_can_see_analytics(p.tenant_id)));

drop policy if exists gw_web_pages_select on public.gw_web_pages;
create policy gw_web_pages_select on public.gw_web_pages
  for select using (exists (
    select 1 from public.gw_web_projects p
     where p.id = gw_web_pages.project_id
       and public.gw_can_see_analytics(p.tenant_id)));


-- -----------------------------------------------------------------------------
-- 5) 口コミサイトのブロック（8grp.co.jp 用）
--    判定と記録は 8grp-site 側（Apache と PHP）が行う。この Supabase には
--    台帳と記録だけが入る。ここでは、その2表がまだ無ければ作っておく
--    （8grp-site の scripts/referrer-block/schema.sql と同じ内容）。
--    こちらの管理画面からも件数を見られるようにするため。
-- -----------------------------------------------------------------------------
create table if not exists public.blocked_referrers (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null unique,
  service_name text not null,
  enabled      boolean not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

create table if not exists public.blocked_access_logs (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  referer    text,
  domain     text,
  path       text,
  user_agent text
);

create index if not exists idx_blocked_access_logs_time
  on public.blocked_access_logs(created_at desc);
create index if not exists idx_blocked_access_logs_domain
  on public.blocked_access_logs(domain, created_at desc);

alter table public.blocked_referrers   enable row level security;
alter table public.blocked_access_logs enable row level security;

drop policy if exists blocked_referrers_rw on public.blocked_referrers;
create policy blocked_referrers_rw on public.blocked_referrers
  for all to authenticated using (true) with check (true);

drop policy if exists blocked_access_logs_select on public.blocked_access_logs;
create policy blocked_access_logs_select on public.blocked_access_logs
  for select to authenticated using (true);

insert into public.blocked_referrers (domain, service_name) values
  ('openwork.jp',    'OpenWork'),
  ('jobtalk.jp',     '転職会議'),
  ('en-hyouban.com', 'エンゲージ 会社の評判')
on conflict (domain) do nothing;


-- =============================================================================
-- 022_ga4.sql — Google アナリティクス（GA4）を数字の出どころに加える
--
-- 前提: db/021_web_analytics.sql が適用済みであること。
--
-- なぜ足すか
--   021 では自前の計測タグで数えていた。確実に動くが、分かるのは
--   PV・訪問者・参照元・ページまで。GA4 を入れると、同じ「1行貼る」手間で
--   デバイス・地域・滞在といったところまで見られるようになり、
--   しかも Data API は公式で安定している（Vercel の Web Analytics と違う点）。
--
--   計測タグは残す。GA4 をまだ入れていないサイトはそちらで数え続ける。
--   1つのサイトで両方が動いていても二重に足さないよう、
--   集計側で「そのサイトの主な出どころ」を1つ選んで合計する（api/analytics）。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) サイトごとの GA4 の設定
--    property_id    … Data API で数字を引くときの宛先（数字の羅列）
--    measurement_id … サイトに貼るタグに書く方（G- で始まる）
--    別物なので両方持つ。管理画面ではどちらも貼り付けで入れられるようにする。
-- -----------------------------------------------------------------------------
alter table public.gw_web_projects
  add column if not exists ga4_property_id text;
alter table public.gw_web_projects
  add column if not exists ga4_measurement_id text;

create index if not exists idx_gw_web_projects_ga4
  on public.gw_web_projects(ga4_property_id) where ga4_property_id is not null;


-- -----------------------------------------------------------------------------
-- 2) 出どころに 'ga4' を足す
--    021 で置いた CHECK に無いままだと、GA4 の行を入れた時点で失敗する。
-- -----------------------------------------------------------------------------
do $$
begin
  alter table public.gw_web_daily     drop constraint if exists gw_web_daily_source_check;
  alter table public.gw_web_daily     add constraint gw_web_daily_source_check
    check (source in ('beacon','vercel','ga4'));

  alter table public.gw_web_referrers drop constraint if exists gw_web_referrers_source_check;
  alter table public.gw_web_referrers add constraint gw_web_referrers_source_check
    check (source in ('beacon','vercel','ga4'));

  alter table public.gw_web_pages     drop constraint if exists gw_web_pages_source_check;
  alter table public.gw_web_pages     add constraint gw_web_pages_source_check
    check (source in ('beacon','vercel','ga4'));
end $$;


-- =============================================================================
-- 023_blocked_referrers_scope.sql — 口コミサイトブロックの台帳を社内側に寄せる
--
-- 前提: db/021_web_analytics.sql が適用済みであること（無くても表は作られる）。
-- =============================================================================
-- =============================================================================
-- 023: 口コミサイトブロックの台帳を、社内グループウェア側に寄せる
--
-- 何を変えるか
--   これまで台帳（blocked_referrers）と記録（blocked_access_logs）は
--   「ログインしていれば誰でも読み書きできる」設定だった。
--   この Supabase は LMS・タイムカード・事務ポータルと共有しているので、
--   その「誰でも」には日報を書きに来ただけの人も含まれる。
--
--   管理画面を mf.8grp.co.jp（このグループウェア）へ移すのに合わせて、
--   読めるのを「管理者・経営者」だけに絞る。
--   書き込みは API（service_role）だけが行うので、ポリシーは select しか置かない。
--
-- 何を変えないか
--   ・判定そのものは今までどおり 8grp.co.jp 側の Apache（.htaccess）が行う
--   ・記録の書き込みは blocked.php が service_role で行う（RLS を通らない）
--   ・表の形は 021 のまま。列は足さない
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- 021 を流していない環境でも動くように、表が無ければ作る
create table if not exists public.blocked_referrers (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null unique,
  service_name text not null,
  enabled      boolean not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

create table if not exists public.blocked_access_logs (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  referer    text,
  domain     text,
  path       text,
  user_agent text
);


-- -----------------------------------------------------------------------------
-- 1) 誰が見てよいか
--    この Supabase には社内の別システムのアカウントも同居しているため、
--    「authenticated かどうか」では絞りきれない。
--    どこかのテナントで管理者・担当者、または経営者である人だけに限る。
--    （アクセス分析と同じ範囲。台帳は経営情報の一部という扱い）
-- -----------------------------------------------------------------------------
create or replace function public.gw_can_manage_blocks()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
     where m.user_id = auth.uid()
       and m.role in ('admin', 'staff')
  ) or exists (
    select 1
      from public.gw_role_grants g
      join public.gw_employees  e on e.id = g.employee_id
     where e.user_id = auth.uid()
       and g.role = 'owner'
  );
$$;

revoke all on function public.gw_can_manage_blocks() from public;
grant execute on function public.gw_can_manage_blocks() to authenticated;


-- -----------------------------------------------------------------------------
-- 2) ポリシーの張り替え
--    追加・ON/OFF・削除は /api/blocks が service_role で行う。
--    ブラウザから直接書ける口を残すと、台帳を壊された時に誰がやったか追えない。
-- -----------------------------------------------------------------------------
alter table public.blocked_referrers   enable row level security;
alter table public.blocked_access_logs enable row level security;

drop policy if exists blocked_referrers_rw     on public.blocked_referrers;
drop policy if exists blocked_referrers_select on public.blocked_referrers;
create policy blocked_referrers_select on public.blocked_referrers
  for select to authenticated
  using (public.gw_can_manage_blocks());

drop policy if exists blocked_access_logs_select on public.blocked_access_logs;
create policy blocked_access_logs_select on public.blocked_access_logs
  for select to authenticated
  using (public.gw_can_manage_blocks());


-- -----------------------------------------------------------------------------
-- 3) 記録が無限に積み上がらないようにする
--    ブロックの記録は「どこから何件来たか」が分かればよく、
--    半年前の1件を読み返すことはない。90日で捨てる。
-- -----------------------------------------------------------------------------
create or replace function public.blocked_access_logs_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.blocked_access_logs
   where created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- pg_cron が入っている環境でだけ毎日回す。無くてもエラーにしない
do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.unschedule('blocked_access_logs_prune')
      where exists (select 1 from cron.job where jobname = 'blocked_access_logs_prune');
    perform cron.schedule(
      'blocked_access_logs_prune', '20 18 * * *',   -- 毎日 03:20 JST
      $cron$select public.blocked_access_logs_prune();$cron$
    );
  end if;
exception when others then
  raise notice '古い記録の自動削除は設定できませんでした: %', sqlerrm;
end $$;


-- 確認:
--   select public.gw_can_manage_blocks();
--   select domain, service_name, enabled from public.blocked_referrers order by domain;
--   select count(*) from public.blocked_access_logs;


-- =============================================================================
-- 024_schedule_gcal.sql — 社内の予定を本人の Google カレンダーへ書き出す
--
-- 前提: db/017_schedule.sql / db/018_google_calendar_link.sql が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 024: 社内の予定を、本人の Google カレンダーへ書き出せるようにする
--
-- これまで（018）は「読むだけ」だった。本人の Google カレンダーを読んで
-- 社内の予定と並べて表示するところまで。
-- ここから先は逆向きに、社内で入れた予定を本人の Google カレンダーへ入れる。
--
-- 何を持つか
--   書き出した予定の Google 側の id を控える。これが無いと、
--   同じ予定を2回押したときに向こうに2件できる。id があれば2回目は上書きになる。
--
-- ★ 併せて必要な作業（SQLだけでは足りない）
--   OAuth の権限（スコープ）に「予定の書き込み」を足したので、
--   既に連携している人は一度つなぎ直す必要がある。
--   古い権限のままだと書き込みが 403 で断られる。
--   画面には「つなぎ直してください」と出るようにしてある。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- Google 側の予定 id。null なら「まだ書き出していない」
alter table public.gw_calendar_events
  add column if not exists gcal_event_id text;

-- 最後に書き出した時刻。社内で直したあと書き出し直したかを見分ける
alter table public.gw_calendar_events
  add column if not exists gcal_synced_at timestamptz;

comment on column public.gw_calendar_events.gcal_event_id is
  '本人の Google カレンダーに書き出したときの向こうの予定id。2回押しても増やさないために持つ';

-- 書き出し済みの予定だけを引くことがあるので索引を1つ。
-- 部分索引にしているのは、大半が null（書き出していない）になるため
create index if not exists idx_gw_calendar_events_gcal
  on public.gw_calendar_events(employee_id)
  where gcal_event_id is not null;

-- PostgREST のスキーマキャッシュを更新（列追加直後の保存失敗を防ぐ）
notify pgrst, 'reload schema';

-- 確認:
--   select id, title, gcal_event_id, gcal_synced_at
--     from public.gw_calendar_events order by starts_at desc limit 20;


-- =============================================================================
-- 025_nippo_v3.sql — 日報を6項目に作り直す（要件定義書 Phase 1）
--
-- 前提: 8/timecard/nippo-setup.sql（tc_nippo / tc_weekly_review）が適用済みであること。
--       この表は 8grp-site 側のリポジトリが作っている。
-- =============================================================================
-- =============================================================================
-- 025: 日報を6項目に作り直す（要件定義書 Phase 1）
--
-- ねらい
--   日報の目的を「記録すること」から「毎日書くうちに会社の仕事の進め方が
--   身につくこと」に変える。入力は3〜5分。
--
--   ① 今日のKGI（目標数値・実績数値・達成/未達）
--   ② 今日やったこと・成果（やったこと｜結果・成果 の行）
--   ③ 困ったこと・報告相談（問題／自分でやったこと／相談相手／次の行動）
--   ④ 今日の改善・学び（選択式＋一言）
--   ⑤ 顧客・チームのためにしたこと
--   ⑥ 明日の最優先（何を／いつまで／完了条件）
--
-- ★ 列は1つも消さない
--   tc_nippo には1年以上ぶんの日報が入っている。列を消すと過去が読めなくなる。
--   意味の同じものは使い回し、足りないものだけ足す。
--
--   ① 今日のKGI（文）        → goal_today（既存「今日の目標」）
--   ④ 改善・学びの一言       → challenge（既存「今日の挑戦・改善」）
--   ⑤ 顧客・チーム           → contribution（既存「顧客・会社への貢献」）
--   ⑥ 明日やること           → tomorrow_plan（既存）
--
--   使わなくなった列（purpose / handoff / stuck / funnel / miss_reason /
--   small_win / kpis / team_kgi など）はそのまま残す。過去の日報の表示に要る。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ① 今日のKGI の数値と結果
--    文そのものは goal_today を使う。ここは数字と達成/未達だけ
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists kgi_target  numeric;  -- 目標数値
alter table public.tc_nippo add column if not exists kgi_actual  numeric;  -- 実績数値
-- true=達成 / false=未達 / null=数値で測らない業務
alter table public.tc_nippo add column if not exists kgi_achieved boolean;

-- -----------------------------------------------------------------------------
-- ② 今日やったこと・成果
--    [{"task":"A社提案書を作成","result":"提案書を完成し送付"}, …]
--    「作業しました」で終わらせないために、result を必須にしている（画面側）
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists work_items jsonb;

-- -----------------------------------------------------------------------------
-- ③ 困ったこと・報告相談
--    [{"issue":"…","action_taken":"…","consulted":"…","next_action":"…"}, …]
--    問題だけ書いて終わらせないために、next_action を必須にしている（画面側）。
--    no_issues は「特になし」を選んだ状態。空欄と区別する
--    （書き忘れなのか、本当に無かったのかが分かるようにする）
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists issues    jsonb;
alter table public.tc_nippo add column if not exists no_issues boolean not null default false;

-- -----------------------------------------------------------------------------
-- ④ 今日の改善・学び
--    選んだ種類。["self_research","new_method","feedback","process","ai_tool","other"]
--    一言は challenge（既存）に入れる
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists improve_tags jsonb;

-- -----------------------------------------------------------------------------
-- ⑥ 明日の最優先
--    何をするかは tomorrow_plan（既存）。期限と完了条件をここに足す
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists tomorrow_deadline text;
alter table public.tc_nippo add column if not exists tomorrow_target   text;

-- -----------------------------------------------------------------------------
-- 日次の行動確認（○ / △ / ―）
--   会社評価基準10項目のうち、その日の日報から「確認できた行動」を残す。
--
--   ★ これは人事評価の点数ではない。
--     本人に毎日10項目を自己採点させると、点を取りにいく書き方になる。
--     書いた内容から機械的に拾い、行動を意識してもらうためだけに出す。
--     週次の点数はこれとは別に、管理者が付ける。
--
--   {"quantity":"o","report_consult":"d","action":"o", …}
--     o = 確認できた / d = 一部確認できた / -（または欠落）= 材料なし
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists daily_flags jsonb;

comment on column public.tc_nippo.daily_flags is
  '日報の内容から機械的に拾った「今日確認できた行動」。人事評価点ではない';

-- -----------------------------------------------------------------------------
-- 週次評価（Phase 2 の置き場所）
--   tc_weekly_review.eval_scores は既にある jsonb。
--   これまでは6項目×5点だったが、会社評価基準10項目×10点＝100点に切り替える。
--   古い6項目のデータもそのまま残るので、画面側でキーを見て出し分ける。
-- -----------------------------------------------------------------------------
alter table public.tc_weekly_review add column if not exists eval_total integer;

comment on column public.tc_weekly_review.eval_scores is
  '会社評価基準10項目 × 各0〜10点。旧データは6項目 × 5点なのでキーで判別する';

-- PostgREST のスキーマキャッシュを更新（列追加直後の保存失敗を防ぐ）
notify pgrst, 'reload schema';

-- 確認:
--   select work_date, user_name, goal_today, kgi_target, kgi_actual, kgi_achieved,
--          jsonb_array_length(coalesce(work_items,'[]'::jsonb)) as 成果件数,
--          no_issues, daily_flags
--     from public.tc_nippo
--    where work_date >= current_date - 7
--    order by work_date desc, user_name;


-- =============================================================================
-- 026_nippo_ai_eval.sql — 日報のAI評価
--
-- 前提: db/025_nippo_v3.sql と 8/timecard/nippo-setup.sql（tc_nippo）が適用済み。
-- =============================================================================
-- =============================================================================
-- 026: 日報のAI評価（AI日報評価API 実装要件 Phase 1・2）
--
-- 日報を出したあと、AIが内容を読んで
--   ・良かったところ
--   ・改善すると良いところ
--   ・明日のポイント
--   ・会社評価基準10項目の参考点（各0〜10点）と、その理由
-- を返す。結果はここに構造化して残す。
--
-- ■ 分けて持つ理由
--   日報本体（tc_nippo）に評価列を足さない。
--   ・AIが落ちても日報の保存は成功させたい（別の行なら独立して失敗できる）
--   ・評価をやり直したとき、前の評価も履歴として残したい
--   ・評価基準を変えたら prompt_version で世代を見分けたい
--
-- ■ 上書きしない
--   再評価すると新しい行が増える。最新は created_at の新しいものを見る。
--   点数が変わった経緯が消えると、あとから「なぜこの評価だったか」を
--   説明できなくなる。
--
-- ■ 評価材料不足を0点にしない
--   scores の各項目は {score, status, reason}。書いていないことは
--   status='not_enough_data' として score を null にする。
--   0点にすると「書けば点が増える」になり、日報が長くなるだけになる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

create table if not exists public.gw_nippo_ai_evals (
  id          uuid primary key default gen_random_uuid(),
  nippo_id    uuid not null references public.tc_nippo(id) on delete cascade,
  -- tc_nippo.user_id と同じ（auth.users.id）。RLS の判定に使うので写しを持つ
  user_id     uuid not null,
  work_date   date not null,

  -- pending → processing → completed / failed
  status      text not null default 'pending'
              check (status in ('pending', 'processing', 'completed', 'failed')),

  -- どのモデル・どの評価基準で出したか。基準を変えたときに世代が分かる
  model          text,
  prompt_version text,

  -- 10項目 × 各0〜10点の合計。材料不足の項目は分母から外して按分する
  total_score integer,

  -- {"quantity":{"score":8,"status":"evaluated","reason":"…"}, …}
  scores             jsonb,
  good_points        jsonb,   -- 最大3件
  improvement_points jsonb,   -- 最大3件
  ai_comment         text,
  tomorrow_advice    text,

  -- 数字で出せるものはAIに渡さず、こちらで計算した値を残す
  -- （KGI達成率・成果件数・相談件数・提出時刻など）
  system_metrics jsonb,

  -- AIの生の応答。あとから「なぜこの点になったか」を追えるように残す
  raw_response jsonb,

  error_detail text,
  attempts     integer not null default 0,

  -- 管理者による修正。AI評価を最終評価にしない
  manager_scores  jsonb,     -- {"quantity":9, …} 直した項目だけ
  manager_comment text,
  manager_total   integer,
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_nippo_ai_evals_nippo
  on public.gw_nippo_ai_evals(nippo_id, created_at desc);
create index if not exists idx_gw_nippo_ai_evals_user
  on public.gw_nippo_ai_evals(user_id, work_date desc);

comment on table public.gw_nippo_ai_evals is
  '日報のAI評価。再評価すると行が増える（上書きしない）。最新は created_at の新しいもの';
comment on column public.gw_nippo_ai_evals.total_score is
  '参考点。人事評価の確定値ではない。管理者が manager_scores で直せる';


-- -----------------------------------------------------------------------------
-- 誰が読めるか
--   本人と、社内の管理者・担当者・経営者だけ。
--   書き込みは service_role の API だけが行うので、insert/update のポリシーは置かない。
--   ブラウザから直接書ける口を残すと、自分の点数を書き換えられる。
-- -----------------------------------------------------------------------------
create or replace function public.gw_is_internal_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
     where m.user_id = auth.uid()
       and m.role in ('admin', 'staff')
  ) or exists (
    select 1
      from public.gw_role_grants g
      join public.gw_employees  e on e.id = g.employee_id
     where e.user_id = auth.uid()
       and g.role in ('owner', 'hr', 'manager')
  );
$$;

revoke all on function public.gw_is_internal_staff() from public;
grant execute on function public.gw_is_internal_staff() to authenticated;

alter table public.gw_nippo_ai_evals enable row level security;

drop policy if exists gw_nippo_ai_evals_select on public.gw_nippo_ai_evals;
create policy gw_nippo_ai_evals_select on public.gw_nippo_ai_evals
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());


-- -----------------------------------------------------------------------------
-- 生の応答は重い。90日で捨てる（点数と理由は残す）
-- -----------------------------------------------------------------------------
create or replace function public.gw_nippo_ai_evals_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.gw_nippo_ai_evals
     set raw_response = null
   where raw_response is not null
     and created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.unschedule('gw_nippo_ai_evals_prune')
      where exists (select 1 from cron.job where jobname = 'gw_nippo_ai_evals_prune');
    perform cron.schedule(
      'gw_nippo_ai_evals_prune', '40 18 * * *',   -- 毎日 03:40 JST
      $cron$select public.gw_nippo_ai_evals_prune();$cron$
    );
  end if;
exception when others then
  raise notice '生の応答の自動削除は設定できませんでした: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- 確認:
--   select work_date, status, total_score, ai_comment
--     from public.gw_nippo_ai_evals order by created_at desc limit 20;


-- =============================================================================
-- 027_nippo_weekly_monthly.sql — 週次の100点評価と、月次の成長確認
--
-- 前提: db/026_nippo_ai_eval.sql（gw_is_internal_staff）と、
--       8/timecard/nippo-setup.sql（tc_weekly_review）が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 027: 週次の100点評価と、月次の成長確認（AI日報評価API 要件 Phase 3・4）
--
-- ■ 日次・週次・月次の役割を分ける
--   日次 … 行動改善。良かった点・改善点・明日のポイント（点数は出さない）
--   週次 … 評価。会社評価基準10項目 × 各10点 = 100点
--   月次 … 成長確認。週次の集計と、前月との比較
--
-- ■ AIの点と、管理者の点を分けて持つ
--   AI評価を最終評価にしない。
--   ai_scores  … AIが出した点（消さない。基準を見直すときの材料になる）
--   eval_scores … 管理者が確定した点（本人に見えるのはこちら）
--   本人に見えるのは submitted_at が入ってから。
--   下書きのまま見えると「評価が下がった」と誤解される。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 週次（tc_weekly_review に足す）
--    表そのものは 8/timecard/nippo-setup.sql が作っている。
--    1人1週1件（unique(user_id, week_start)）なので、行は増やさず列を足す。
-- -----------------------------------------------------------------------------
alter table public.tc_weekly_review add column if not exists ai_scores      jsonb;
alter table public.tc_weekly_review add column if not exists ai_total       integer;
alter table public.tc_weekly_review add column if not exists ai_strengths   jsonb;   -- 強み 最大3件
alter table public.tc_weekly_review add column if not exists ai_improvements jsonb;  -- 改善項目 最大3件
alter table public.tc_weekly_review add column if not exists ai_focus       jsonb;   -- 次週の重点行動 最大2件
alter table public.tc_weekly_review add column if not exists ai_summary     text;
alter table public.tc_weekly_review add column if not exists ai_model       text;
alter table public.tc_weekly_review add column if not exists ai_prompt_version text;
alter table public.tc_weekly_review add column if not exists ai_status      text;    -- pending/processing/completed/failed
alter table public.tc_weekly_review add column if not exists ai_error       text;
alter table public.tc_weekly_review add column if not exists ai_metrics     jsonb;   -- 提出率・KGI達成率など計算値
alter table public.tc_weekly_review add column if not exists ai_generated_at timestamptz;
alter table public.tc_weekly_review add column if not exists decided_by     uuid references auth.users(id) on delete set null;

comment on column public.tc_weekly_review.ai_scores is
  'AIが出した10項目の点。管理者が直しても、これは消さない';
comment on column public.tc_weekly_review.eval_scores is
  '管理者が確定した10項目の点。本人に見えるのは submitted_at が入ってから';


-- -----------------------------------------------------------------------------
-- 2) 月次
--    週次を集計すれば数字は出るが、AIの総括と管理者コメントは残す場所が要る。
--    1人1月1件。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_monthly (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- auth.users.id（tc_nippo.user_id と同じ）
  month      date not null,                 -- その月の1日
  user_name  text,

  -- 計算で出す値。AIには「計算済み」として渡す
  metrics    jsonb,                         -- 平均点・前月比・提出率・KGI達成率・項目別平均

  ai_status      text default 'pending'
                 check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_summary     text,
  ai_strengths   jsonb,                     -- 強み TOP3
  ai_improvements jsonb,                    -- 改善 TOP3
  ai_model       text,
  ai_prompt_version text,
  ai_error       text,
  ai_generated_at timestamptz,

  manager_comment text,
  decided_by      uuid references auth.users(id) on delete set null,
  -- 本人へ出した時刻。入るまでは本人の画面に出さない
  submitted_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month)
);

create index if not exists idx_gw_nippo_monthly_user
  on public.gw_nippo_monthly(user_id, month desc);

comment on table public.gw_nippo_monthly is
  '月次の成長確認。週次の集計＋AI総括＋管理者コメント。1人1月1件';


-- -----------------------------------------------------------------------------
-- 3) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--    書き込みは service_role の API だけなので、insert/update のポリシーは置かない。
--    （gw_is_internal_staff は 026 で作っている）
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_monthly enable row level security;

drop policy if exists gw_nippo_monthly_select on public.gw_nippo_monthly;
create policy gw_nippo_monthly_select on public.gw_nippo_monthly
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select week_start, user_name, ai_total, eval_total, submitted_at
--     from public.tc_weekly_review order by week_start desc limit 20;
--   select month, user_name, ai_status, metrics->>'avgScore'
--     from public.gw_nippo_monthly order by month desc limit 20;


-- =============================================================================
-- 028_probation.sql — 試用期間の判定
--
-- 前提: db/016_expenses.sql（gw_workflow_settings）と
--       db/026_nippo_ai_eval.sql（gw_is_internal_staff）が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 028: 試用期間の判定（AI日報評価API 要件 Phase 5）
--
-- 入社日から一定期間の日報・KGI・週次評価を集計し、
-- あらかじめ決めた基準を満たしているかを機械的に判定する。
--
-- ★ ここが自動化するのは「材料集めと基準の当てはめ」まで。
--   本採用・延長・不採用の決定そのものは人が押す。
--
--   理由: これは雇用に関わる決定で、取り消しがきかない。
--   日報の提出率が低い理由（長期の外出、体調、担当の性質）は日報に書かれない。
--   数字が基準を割ったことは機械が正確に出せるが、それが本採用の可否かは
--   数字の外にある事情まで見ないと決められない。
--   システムは「何が基準を満たし、何を割ったか」を漏れなく出すところまでを担い、
--   決定は decided_by に誰が押したかを残す形にしている。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 判定の基準（テナントごと）
--    gw_workflow_settings は既にある社内の運用設定。ここに1列足す。
--
--    {
--      "months": 3,                       試用期間の長さ
--      "checkpoints": ["1m", "3m"],       どこで見るか
--      "thresholds": {
--        "submitRate": 90,                日報の提出率（%）
--        "kgiRate": 70,                   KGIの達成率（%）
--        "weeklyAvg": 70,                 週次評価の平均（100点満点）
--        "consultRate": 50,               困りごとのうち相談まで書いた割合（%）
--        "resultRate": 80                 やったことのうち結果まで書いた割合（%）
--      }
--    }
--
--    既定値は「これを割ったら必ず見直す」ではなく「ここを下回ったら
--    理由を確認する」の線として置いている。運用しながら直す前提。
-- -----------------------------------------------------------------------------
alter table public.gw_workflow_settings
  add column if not exists probation jsonb not null default '{
    "months": 3,
    "checkpoints": ["1m", "3m"],
    "thresholds": {
      "submitRate": 90,
      "kgiRate": 70,
      "weeklyAvg": 70,
      "consultRate": 50,
      "resultRate": 80
    }
  }'::jsonb;

comment on column public.gw_workflow_settings.probation is
  '試用期間の判定基準。しきい値は運用しながら直す前提の初期値';


-- -----------------------------------------------------------------------------
-- 2) チェックポイントごとの記録
--    試用期間そのものは gw_employees.joined_on と上の設定から出せるので、
--    別の台帳は作らない。台帳を持つと入社日を直したときに食い違う。
--    ここには「その時点で集計した結果」と「人が押した決定」だけを残す。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_probation_reviews (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  -- auth.users.id。日報（tc_nippo.user_id）と突き合わせるために持つ
  user_id     uuid,

  checkpoint  text not null check (checkpoint in ('1m', '3m', '6m', 'final')),
  period_from date not null,
  period_to   date not null,

  -- 集計した数字（提出率・KGI達成率・週次平均・項目別平均など）
  metrics jsonb,
  -- 基準に当てはめた結果 {"submitRate":{"value":92,"threshold":90,"pass":true}, …}
  checks  jsonb,
  -- checks から機械的に決まる。meets（全部満たす）/ partial / below
  verdict text check (verdict in ('meets', 'partial', 'below')),
  computed_at timestamptz,

  -- AIの所見。点は付けさせない。事実の要約と、確認したほうがよい点まで
  ai_status   text default 'pending'
              check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_summary  text,
  ai_strengths jsonb,
  ai_concerns  jsonb,
  ai_questions jsonb,     -- 面談で本人に確認するとよいこと
  ai_model    text,
  ai_prompt_version text,
  ai_error    text,
  ai_generated_at timestamptz,

  -- ★ 決定は人が押す。AIも、上の verdict も、ここには何も書かない
  decision      text check (decision in ('pass', 'extend', 'fail')),
  decision_note text,
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, checkpoint)
);

create index if not exists idx_gw_probation_reviews_tenant
  on public.gw_probation_reviews(tenant_id, period_to);
create index if not exists idx_gw_probation_reviews_employee
  on public.gw_probation_reviews(employee_id);

comment on table public.gw_probation_reviews is
  '試用期間のチェックポイント。集計と基準の当てはめは自動、決定は人が押す';
comment on column public.gw_probation_reviews.verdict is
  '基準を満たしたかの機械判定。本採用の可否ではない';
comment on column public.gw_probation_reviews.decision is
  '人が押した決定。ここが空なら、まだ誰も決めていない';


-- -----------------------------------------------------------------------------
-- 3) 誰が読めるか
--    人事に関わる記録なので、本人には見せない。
--    管理者・人事・経営者だけ。書き込みは service_role の API だけが行う。
--
--    本人に見せないのは、面談で伝える前に画面で先に見えてしまうと、
--    伝え方を選ぶ余地が無くなるため。面談の内容は別途 1on1 で残す。
-- -----------------------------------------------------------------------------
alter table public.gw_probation_reviews enable row level security;

drop policy if exists gw_probation_reviews_select on public.gw_probation_reviews;
create policy gw_probation_reviews_select on public.gw_probation_reviews
  for select to authenticated
  using (public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, r.checkpoint, r.verdict, r.decision, r.period_to
--     from public.gw_probation_reviews r
--     join public.gw_employees e on e.id = r.employee_id
--    order by r.period_to desc;


-- =============================================================================
-- 029_contracts.sql — 雇用契約書と、そこから生まれる予定・評価
--
-- 前提: db/026_nippo_ai_eval.sql（gw_is_internal_staff）と
--       db/028_probation.sql（判定の基準）が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 029: 雇用契約書と、そこから生まれる予定・評価
--
-- 契約書のPDFを上げると、AIが期間・条件を読み取る。
-- 読み取った内容を人が確認して確定すると、そこから
--   ・試用期間の満了日
--   ・契約更新の面談日
--   ・契約の満了日
-- が予定として並び、期日が来たら日報・KGI・週次評価を集計して判断材料を出す。
--
-- ★ AIの読み取りは必ず人が確認してから確定する。
--   契約書は間違えられない書類で、読み違いがそのまま
--   「契約満了日」や「更新の有無」になると実害が出る。
--   status が 'draft' のあいだは、予定は1つも作らない。
--
-- ★ 更新するかどうかの決定も人が押す。
--   試用期間（028）と同じ考え方。集計と基準の当てはめまでが自動で、
--   決定は誰がいつ押したかを残す。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 契約書
--    実体は Storage の hr バケットに置く。ここには置き場所と、読み取った項目。
--    1人に複数（更新のたびに増える）。いま有効なものは period_to で判る。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_contracts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  -- hr バケットの中のパス。<tenant_id>/<employee_id>/contract/<uuid>.<ext>
  file_path text,
  filename  text,

  -- draft: AIが読んだだけ。確定するまで予定は作らない
  -- active: 確定済み。ここから予定が並ぶ
  -- superseded: 更新されて、新しい契約に置き換わった
  status text not null default 'draft'
         check (status in ('draft', 'active', 'superseded')),

  -- ---- 読み取った項目（人が直せる） ----
  contract_type text,          -- 正社員 / 契約社員 / パート / アルバイト / 業務委託 / その他
  -- 有期か無期か。無期なら period_to は空
  fixed_term    boolean,
  period_from   date,
  period_to     date,

  probation_months integer,    -- 試用期間の長さ（月）。無ければ null
  probation_end    date,       -- 試用期間の満了日

  renewable      boolean,      -- 更新の可能性があるか
  renewal_criteria text,       -- 更新の判断基準（契約書に書かれている文言）
  -- 更新の面談を、満了の何日前に置くか。既定30日
  renewal_notice_days integer default 30,

  work_hours   text,           -- 所定労働時間
  work_days    text,           -- 所定労働日・休日
  work_place   text,           -- 就業場所
  job_content  text,           -- 業務内容

  wage_type    text,           -- 月給 / 時給 / 日給 / 年俸 / その他
  wage_amount  numeric,        -- 金額
  wage_note    text,           -- 手当・控除など、金額だけでは足りない条件

  -- AIが読み取った生の結果。確定後に「元は何と読んだか」を追えるように残す
  extracted jsonb,
  ai_status text default 'pending'
            check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_model  text,
  ai_prompt_version text,
  ai_error  text,
  ai_confidence text,          -- high / mid / low。低いときは画面で強く注意する

  note text,

  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  uploaded_by  uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_contracts_employee
  on public.gw_contracts(employee_id, period_from desc);
create index if not exists idx_gw_contracts_tenant_status
  on public.gw_contracts(tenant_id, status);

comment on column public.gw_contracts.status is
  'draft のあいだは予定を作らない。AIの読み取りを人が確認してから active にする';
comment on column public.gw_contracts.extracted is
  'AIが読み取った生の結果。人が直したあとも、元の読み取りを残しておく';


-- -----------------------------------------------------------------------------
-- 2) 契約から生まれる予定
--    契約を確定したときに作る。日付は契約の内容から計算する。
--    契約を直したら作り直す（人が消したものは復活させない）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_contract_milestones (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  contract_id uuid not null references public.gw_contracts(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  kind text not null check (kind in (
    'probation_end',      -- 試用期間の満了
    'review',             -- 期中の面談（1か月・3か月など）
    'renewal_decision',   -- 更新するかどうかを決める面談
    'contract_end'        -- 契約の満了
  )),
  title  text not null,
  due_on date not null,

  -- 面談で何を見るかの期間。集計はこの範囲で行う
  period_from date,
  period_to   date,

  -- 集計と基準の当てはめ（試用期間と同じ形）
  metrics jsonb,
  checks  jsonb,
  verdict text check (verdict in ('meets', 'partial', 'below')),
  computed_at timestamptz,

  -- AIの所見。可否の判断はさせない
  ai_status text default 'pending'
            check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_summary  text,
  ai_strengths jsonb,
  ai_concerns  jsonb,
  ai_questions jsonb,
  ai_model  text,
  ai_error  text,

  -- ★ 決定は人が押す
  decision      text check (decision in ('renew', 'end', 'change', 'done')),
  decision_note text,
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,

  -- 人が「この予定は要らない」と消したもの。作り直しのときに復活させない
  dismissed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, kind, due_on)
);

create index if not exists idx_gw_contract_milestones_due
  on public.gw_contract_milestones(tenant_id, due_on)
  where decision is null and dismissed_at is null;

comment on table public.gw_contract_milestones is
  '契約から計算した予定。期日が来たら日報・KGIを集計して判断材料を出す。決定は人が押す';


-- -----------------------------------------------------------------------------
-- 3) 誰が読めるか
--    賃金と契約条件が入っているので、本人と、管理者・人事・経営者だけ。
--    本人が自分の契約書を見られないのは不自然なので、本人には見せる。
--    ただし milestones（面談の判断材料）は本人には見せない。
--    面談で伝える前に見えると、伝え方を選ぶ余地が無くなるため。
--
--    書き込みは service_role の API だけが行う。
-- -----------------------------------------------------------------------------
alter table public.gw_contracts           enable row level security;
alter table public.gw_contract_milestones enable row level security;

drop policy if exists gw_contracts_select on public.gw_contracts;
create policy gw_contracts_select on public.gw_contracts
  for select to authenticated
  using (
    public.gw_is_internal_staff()
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_contract_milestones_select on public.gw_contract_milestones;
create policy gw_contract_milestones_select on public.gw_contract_milestones
  for select to authenticated
  using (public.gw_is_internal_staff());


-- -----------------------------------------------------------------------------
-- 4) 契約書の実体は hr バケットへ
--    入退社の手続き書類と同じ場所。人事書類がバラバラの場所に散らないようにする。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('hr', 'hr', false)
  on conflict (id) do nothing;

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, c.status, c.contract_type, c.period_from, c.period_to,
--          c.probation_end, c.renewable
--     from public.gw_contracts c
--     join public.gw_employees e on e.id = c.employee_id
--    order by c.created_at desc;
--
--   select e.display_name, m.kind, m.title, m.due_on, m.verdict, m.decision
--     from public.gw_contract_milestones m
--     join public.gw_employees e on e.id = m.employee_id
--    where m.decision is null and m.dismissed_at is null
--    order by m.due_on;


-- =============================================================================
-- 030_dashboard_link.sql — ダッシュボード × 日報 × AI評価 をつなぐ
--
-- 前提: db/026_nippo_ai_eval.sql（gw_is_internal_staff）が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 030: ダッシュボード × 日報 × AI評価 をつなぐ
--      （「ダッシュボード × 日報 × AI評価 連動設計」§3① §18 §19 §20 §21）
--
-- ■ 何のための番号か
--   1) 100点の内訳を持つ列   … §18/§19。10か条の単純合計をやめた
--   2) gw_daily_kpis         … §3①。KPIは事前に決めておき、本人は実績だけ入れる
--   3) gw_action_items       … §21。ダッシュボードと日報をつなぐ中心の表
--
-- ■ §19 について
--   10か条を「10項目 × 10点 = 100点」にはしない。
--   成果40 / 行動30 / 成長20 / チーム10 で100点にし、
--   10か条は「なぜその評価なのか」を見るための内訳として残す。
--   その内訳を毎回計算し直さなくて済むよう、列に入れておく。
--   （計算そのものは lib/scoring.js が持つ）
--
-- ■ §21 の循環
--   日報の困りごと・AIの改善提案
--     → action_item ができる
--     → 翌日のダッシュボードの一番上に出る
--     → 本人が実行する
--     → 翌日の日報で「実施済み」
--     → action_item が閉じる
--   この循環が回らないと、日報は書いて終わりになる。
--
-- 前提: 026（gw_is_internal_staff）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 100点の内訳（成果40 / 行動30 / 成長20 / チーム10）
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_ai_evals
  add column if not exists categories         jsonb;
alter table public.gw_nippo_ai_evals
  add column if not exists manager_categories jsonb;

alter table public.tc_weekly_review
  add column if not exists ai_categories   jsonb;
alter table public.tc_weekly_review
  add column if not exists eval_categories jsonb;

comment on column public.gw_nippo_ai_evals.categories is
  '総合点の内訳。成果40/行動30/成長20/チーム10。10か条はこの内訳の理由として使う';
comment on column public.tc_weekly_review.ai_categories is
  '同上（週次）。10項目の単純合計ではない';

-- 025〜027 で書いた説明が「10項目 × 10点 = 100点」のままなので直す。
-- 中身の型は変わっていない（10か条 各0〜10点）。合計の出し方だけが変わった
comment on column public.gw_nippo_ai_evals.total_score is
  '総合点（0〜100）。10か条の合計ではなく 成果40/行動30/成長20/チーム10 の重み付け。'
  '材料不足の条は分母から外して按分する';
comment on column public.tc_weekly_review.ai_total is
  '同上（週次・AIの点）';
comment on column public.tc_weekly_review.eval_total is
  '同上（週次・管理者が確定した点）。本人に見えるのは submitted_at が入ってから';
comment on column public.tc_nippo.daily_flags is
  '10か条それぞれについて、その日の日報から機械的に拾った ○/△/― 。点数ではない';


-- 「今月できるようになったこと」（§17）。
-- この仕組みで一番残したいのは「昨日より今日、何ができるようになったか」。
-- 点数は月が変われば消えるが、できるようになったことは積み上がる
alter table public.gw_nippo_monthly
  add column if not exists ai_learned jsonb;

comment on column public.gw_nippo_monthly.ai_learned is
  '今月できるようになったこと（最大3件）。先月まで一人でできなかった行動。'
  '量が増えただけのものは入れない';


-- -----------------------------------------------------------------------------
-- 2) KPI（§3①）
--    「営業連絡20件」「商談2件」のように、目標は先に決めておく。
--    本人が毎朝それを考えるところから始めると、日報が目標設定の場になり、
--    数字が後から都合よく動いてしまう。
--
--    ・target は管理者か本人が事前に決める（決めた人を target_set_by に残す）
--    ・actual は本人が日報で入れる
--    ・1人1日1指標1件
-- -----------------------------------------------------------------------------
create table if not exists public.gw_daily_kpis (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- auth.users.id
  work_date  date not null,
  -- 表示順。ダッシュボードには3〜5個までしか出さない（§9②）
  sort_order integer not null default 0,

  label      text not null,                 -- 「営業連絡」「商談」「ENGER登録」
  unit       text,                          -- 「件」「本」「社」
  target     numeric,                       -- 事前に決めた目標
  actual     numeric,                       -- 本人が入れる実績

  -- どこから来た目標か。continued = 前日の設定をそのまま引き継いだもの
  source     text not null default 'manual'
             check (source in ('manual', 'template', 'continued', 'ai')),
  target_set_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, work_date, label)
);

create index if not exists idx_gw_daily_kpis_user
  on public.gw_daily_kpis(user_id, work_date desc);

comment on table public.gw_daily_kpis is
  'KPIは事前に決めておき、本人は実績だけ入れる。目標を毎朝本人が決める形にしない';


-- 毎日の入力を減らすための、その人の定番KPI。
-- 翌日ぶんを作るとき、ここから写す。
create table if not exists public.gw_kpi_templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  sort_order integer not null default 0,
  label      text not null,
  unit       text,
  target     numeric,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, label)
);

comment on table public.gw_kpi_templates is
  'その人の定番KPI。翌日のKPIを作るときの雛形';


-- -----------------------------------------------------------------------------
-- 3) 次にやること（§21）
--
--    出どころ（source）で分ける。
--      ai       … AIが日報から作った（tomorrow_advice / improvement_points）
--      self     … 本人が日報の「明日の最優先」に書いた
--      manager  … 上司が指示した
--
--    ひとつだけ priority = 1 にして、ダッシュボードの一番上に大きく出す（最重要UI）。
--
--    閉じ方は2通り。
--      done      … 実行した
--      dropped   … やらないと決めた（消さずに残す。判断も記録のうち）
--    消さないのは、「AIの提案がどれくらい実行されたか」を後から見るため。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_action_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                 -- auth.users.id
  title      text not null,                 -- 「営業文章を改善する」
  detail     text,

  source     text not null default 'self'
             check (source in ('ai', 'self', 'manager')),
  -- どの日報・どの評価から生まれたか。たどれるようにしておく
  from_nippo_id uuid,
  from_eval_id  uuid references public.gw_nippo_ai_evals(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,

  -- いつのダッシュボードに出すか。既定は翌営業日
  due_date   date,
  -- 1 = 今日の最優先（1人1日ひとつだけ）。2以降はその下に並べる
  priority   integer not null default 5,

  status     text not null default 'open'
             check (status in ('open', 'done', 'dropped')),
  -- 完了を報告した日報。日報で「実施済み」にすると入る
  done_nippo_id uuid,
  done_note  text,
  done_at    timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_action_items_open
  on public.gw_action_items(user_id, status, due_date);
create index if not exists idx_gw_action_items_nippo
  on public.gw_action_items(from_nippo_id);

-- 「今日の最優先」は1人1日ひとつ。2つあると、一番上に何を出すか決まらない
create unique index if not exists uq_gw_action_items_top
  on public.gw_action_items(user_id, due_date)
  where priority = 1 and status = 'open';

comment on table public.gw_action_items is
  'ダッシュボードと日報をつなぐ表。日報の課題 → 翌日の最優先 → 実行 → 日報で完了';
comment on column public.gw_action_items.status is
  'dropped も残す。やらないと決めたことも判断の記録';


-- -----------------------------------------------------------------------------
-- 4) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--
--    KPIの実績（actual）と、次にやることの完了は本人が自分で書く。
--    ただし RLS は列を絞れないので、本人に update を許すと
--    target まで書き換えられる（目標を下げれば達成率が上がってしまう）。
--    そのため書き込みは service_role の API だけにして、
--    「本人が触ってよい列か」は API 側で見る。
-- -----------------------------------------------------------------------------
alter table public.gw_daily_kpis    enable row level security;
alter table public.gw_kpi_templates enable row level security;
alter table public.gw_action_items  enable row level security;

drop policy if exists gw_daily_kpis_select on public.gw_daily_kpis;
create policy gw_daily_kpis_select on public.gw_daily_kpis
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_kpi_templates_select on public.gw_kpi_templates;
create policy gw_kpi_templates_select on public.gw_kpi_templates
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_action_items_select on public.gw_action_items;
create policy gw_action_items_select on public.gw_action_items
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select work_date, label, target, actual from public.gw_daily_kpis
--    order by work_date desc, sort_order limit 20;
--   select due_date, priority, status, source, title from public.gw_action_items
--    order by due_date desc, priority limit 20;
--   select work_date, total_score, categories from public.gw_nippo_ai_evals
--    order by work_date desc limit 5;


-- =============================================================================
-- 031_autonomy_blockers.sql — 止まっていること / 自走レベル / デキル履歴
--
-- 前提: db/026_nippo_ai_eval.sql（gw_is_internal_staff）と
--       db/030_dashboard_link.sql（gw_action_items）が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 031: Blocker / 自走レベル / デキル履歴
--      （「EIGHT 自律型事業運営システム 要件定義」§6 §7 §12 §21〜24 §27 §33）
--
-- ■ この番号で入れるもの
--   1) gw_blockers        … §12④ §21 §22 §24。PHASE 1 で残っていた最後の1つ
--   2) 自走レベル         … §6 §7。gw_employees に列を足し、判定の記録を別表に持つ
--   3) gw_growth_history  … §27「デキル履歴」
--
-- ■ Blocker を「困りごと」と別に持つ理由
--   日報の困りごと（tc_nippo.issues）は、その日の記録。翌日には流れる。
--   Blocker は「仕事が止まっていて、誰かが外さないと動かない状態」で、
--   何日も続く。日報の中に閉じ込めると、何日止まっているかが分からない。
--
--   §24 の「管理職の役割は命令ではなく Blocker を外すこと」を成立させるには、
--   止まった時刻と、外れた時刻が要る。
--
-- ■ 自走レベルは AI が決めない
--   §6 は裁量の話で、人の評価ではない。
--   システムは「条件を満たしたか」を数えるところまでやり、
--   上げる・下げるは人が押す。押した人と時刻を残す。
--   日報のAI評価・試用期間・契約更新と同じ扱いにしている。
--
-- 前提: 026（gw_is_internal_staff）、030（gw_action_items）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Blocker（§12④ §21 §22 §24）
--
--    status
--      open      … 止まっている
--      resolved  … 外れた（誰が外したかを残す）
--      dropped   … 止まりではなくなった（別の進め方にした等）
--
--    escalation_level
--      0 本人が抱えている / 1 上司へ / 2 経営者へ
--      長期化したものを自動で上げるのではなく、人が上げる。
--      自動で上げると、上がってきた時点で誰も中身を知らない状態になる。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_blockers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,                 -- auth.users.id。止まっている本人

  title       text not null,                 -- 「契約条件について判断待ち」
  description text,

  -- どの仕事が止まっているか。無くてもよい（仕事になる前に止まることがある）
  action_item_id uuid references public.gw_action_items(id) on delete set null,
  -- どの日報から上がったか
  from_nippo_id  uuid,

  status      text not null default 'open'
              check (status in ('open', 'resolved', 'dropped')),
  escalation_level smallint not null default 0
              check (escalation_level between 0 and 2),

  -- いつから止まっているか。§22「Blocker長期化」を数えるのに要る
  blocked_since date not null default (now() at time zone 'Asia/Tokyo')::date,

  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  resolution  text,                          -- どう外れたか。次に同じことで止まらないため

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_blockers_open
  on public.gw_blockers(status, blocked_since);
create index if not exists idx_gw_blockers_user
  on public.gw_blockers(user_id, status, blocked_since desc);

comment on table public.gw_blockers is
  '仕事が止まっている状態。日報の困りごとと違い、外れるまで残る。'
  '管理職の仕事はこれを外すこと（要件定義 §24）';
comment on column public.gw_blockers.blocked_since is
  '止まった日。何日止まっているかを数えるのに使う';
comment on column public.gw_blockers.escalation_level is
  '0=本人 1=上司 2=経営者。自動では上げない。上げるのは人';


-- 日次のAI評価に、止まりそうな困りごとの候補と、そのとき何レベルだったかを残す。
-- レベルは点数には効かせない。効くのは返し方だけだが、
-- 「この評価はどの話し方で出たか」が後から分からないと、基準の見直しができない
alter table public.gw_nippo_ai_evals
  add column if not exists blocker_candidates jsonb;
alter table public.gw_nippo_ai_evals
  add column if not exists autonomy_level smallint;

comment on column public.gw_nippo_ai_evals.blocker_candidates is
  '止まっていそうな困りごとの候補（最大2件）。ここではまだBlockerにしない。上げるのは本人';
comment on column public.gw_nippo_ai_evals.autonomy_level is
  'この評価を出したときの自走レベル。点数には効かない。返し方だけが変わる';


-- -----------------------------------------------------------------------------
-- 2) 自走レベル（§6 §7）
--
--    1 指示実行型 / 2 選択実行型 / 3 自律実行型 / 4 自主経営型
--
--    新しく入った人が 1 から始まるのは、能力が低いという意味ではない。
--    「まだ会社の仕事の進め方を知らない」というだけなので、
--    既定値は 1 にして、上げるのは人が押す。
--
--    レベルは AI の話し方も変える（§17 §18）。
--      L1 … 手順まで出す
--      L2 … 選択肢を出して選ばせる
--      L3 … 原因を先に聞く。答えを全部は出さない
--      L4 … 数字だけ出して、口を出さない
-- -----------------------------------------------------------------------------
alter table public.gw_employees
  add column if not exists autonomy_level smallint not null default 1
    check (autonomy_level between 1 and 4);
alter table public.gw_employees
  add column if not exists autonomy_changed_at timestamptz;
alter table public.gw_employees
  add column if not exists autonomy_changed_by uuid references auth.users(id) on delete set null;

comment on column public.gw_employees.autonomy_level is
  '自走レベル 1〜4。裁量の広さであって、人の評価ではない。'
  'AIの話し方もこれで変わる（L1は手順、L3は問いかけ）';


-- 上げ下げの記録。いつ・誰が・何を根拠にしたか。
-- 上げるだけでなく下げることもあるので、履歴として残す
create table if not exists public.gw_autonomy_reviews (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid,                          -- auth.users.id（集計のため）

  from_level  smallint,
  to_level    smallint not null check (to_level between 1 and 4),

  -- 判定に使った数字。プログラムが数えたもの（AIには数えさせない）
  metrics     jsonb,
  -- 条件を満たしたか。{key: {label, ok, value, need}}
  checks      jsonb,

  -- AIの所見。可否は書かせない。材料の整理だけ
  ai_note     text,
  ai_model    text,

  reason      text,                          -- 人が書く理由
  decided_by  uuid references auth.users(id) on delete set null,
  decided_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_autonomy_reviews_emp
  on public.gw_autonomy_reviews(employee_id, decided_at desc);

comment on table public.gw_autonomy_reviews is
  '自走レベルを上げ下げした記録。可否はAIではなく人が決める。'
  '下げた記録も残す（下がったこと自体が次の材料になる）';


-- -----------------------------------------------------------------------------
-- 3) デキル履歴（§27）
--
--    「昨日より今日、何ができるようになったか」を積み上げる。
--    点数は月が変われば消えるが、できるようになったことは消えない。
--
--    source
--      monthly … 月次AIの「今月できるようになったこと」から
--      manual  … 上司か本人が書いた
--      lms     … 無限道場の修了（§32。連携は PHASE 3）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_history (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,                  -- auth.users.id
  happened_on date not null,                 -- できるようになった月（その月の1日でよい）

  title      text not null,                  -- 「問い合わせ営業を一人で実施できるようになった」
  evidence   text,                           -- どの記録から言えるか

  source     text not null default 'manual'
             check (source in ('monthly', 'manual', 'lms')),
  -- どこから来たか。月次から来たものは、その月を消せば作り直せる
  source_ref text,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),

  -- 同じ月の同じ内容を二度入れない（月次を作り直しても増えない）
  unique (user_id, happened_on, title)
);

create index if not exists idx_gw_growth_history_user
  on public.gw_growth_history(user_id, happened_on desc);

comment on table public.gw_growth_history is
  'できるようになったことの積み上げ。この仕組みで一番残したいもの';


-- -----------------------------------------------------------------------------
-- 4) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--    書き込みは service_role の API だけなので insert/update のポリシーは置かない。
--
--    Blocker だけは、社内の誰でも読めてよい。
--    §24 のとおり、外すのは管理職に限らないため
--    （手が空いている人が外せるほうが早い）。
-- -----------------------------------------------------------------------------
alter table public.gw_blockers          enable row level security;
alter table public.gw_autonomy_reviews  enable row level security;
alter table public.gw_growth_history    enable row level security;

drop policy if exists gw_blockers_select on public.gw_blockers;
create policy gw_blockers_select on public.gw_blockers
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_autonomy_reviews_select on public.gw_autonomy_reviews;
create policy gw_autonomy_reviews_select on public.gw_autonomy_reviews
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_growth_history_select on public.gw_growth_history;
create policy gw_growth_history_select on public.gw_growth_history
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select blocked_since, title, status, escalation_level from public.gw_blockers
--    where status = 'open' order by blocked_since;
--   select display_name, autonomy_level, autonomy_changed_at from public.gw_employees
--    order by autonomy_level desc, display_name;
--   select happened_on, title, source from public.gw_growth_history
--    order by happened_on desc limit 20;


-- =============================================================================
-- 032_growth_plan.sql — 労働条件通知書 → 3か月育成計画 → 月間KGI/KPI → 今日のKPI
--
-- 前提: db/029_contracts.sql（gw_contracts）、db/030_dashboard_link.sql（gw_daily_kpis）、
--       db/031_autonomy_blockers.sql が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 032: 労働条件通知書 → 3か月育成計画 → 月間KGI/KPI → 今日のKPI
--      （「労働条件通知書連動型 3か月育成・KPI・日報・AIフィードバックシステム」）
--
-- ■ この番号で入れるもの
--   1) gw_contracts に育成条件の列を足す（§3-2 §5 §44 employment_profiles）
--   2) gw_growth_plans   … 3か月計画（§6-9 §44 growth_plans）
--   3) gw_growth_months  … 月間KGI（§10 §44 monthly_goals）
--   4) gw_growth_kpis    … 月間KPI（§11 §12 §44 kpis）
--   5) gw_daily_kpis に kpi_id を足して、日々の実績が月間KPIへ積み上がるようにする（§22）
--
-- ■ 労働条件通知書のための表を新しく作らない
--   §44 は employment_documents / employment_profiles を分けているが、
--   029 の gw_contracts が既に「書類の置き場所 + AIが読んだ項目 + 人が確認して確定」
--   を持っている。同じものを2つ作ると、どちらを見ればよいか分からなくなる。
--   足りない列（育成期間・週所定労働時間・業務範囲）だけを足す。
--
-- ■ 労働条件と評価目標を分ける（§2-1）
--   契約の条件（賃金・労働時間・雇用形態）と、育成の目標（KGI/KPI）は別の表。
--   KPIの達成状況を理由に、賃金や契約条件が動くことがあってはならない。
--   gw_growth_* から gw_contracts へ書き戻す経路は作らない。
--   参照するのは「どんな業務のためのKPIか」を決めるときだけ。
--
-- ■ 3か月KGIは固定、月間KGI/KPIは毎月見直す（§10）
--   3か月の行き先を毎月変えると、何に向かっているか分からなくなる。
--   一方で、月の目標は実績を見て調整できないと、初月の想定のまま
--   達成不能な数字が3か月残る。
--
-- 前提: 029（gw_contracts）、030（gw_daily_kpis）、031（自走レベル）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 労働条件通知書として読む項目を足す（§3-2）
-- -----------------------------------------------------------------------------
-- 雇用契約書と労働条件通知書は書式が違う。どちらとして読んだかを残す
alter table public.gw_contracts
  add column if not exists document_type text
    check (document_type in ('労働条件通知書', '雇用契約書', 'その他'));

-- 試用期間とは別。育成の枠として何か月見るか（例：試用6か月／育成は3か月）
alter table public.gw_contracts add column if not exists training_months integer;
-- 「週29時間モデル」のような、育成期間中の所定労働時間
alter table public.gw_contracts add column if not exists weekly_hours numeric;
alter table public.gw_contracts add column if not exists remote_ok boolean;
-- 雇入れ直後の業務の候補。["バックオフィス","事業推進",…]
alter table public.gw_contracts add column if not exists work_scope jsonb;
-- 業務変更の範囲（書類の文言のまま）
alter table public.gw_contracts add column if not exists scope_change text;
-- 指定研修。["無限道場",…]
alter table public.gw_contracts add column if not exists training_programs jsonb;
-- 育成終了時に何を見るか（書類の文言のまま）
alter table public.gw_contracts add column if not exists training_review_note text;

comment on column public.gw_contracts.training_months is
  '育成期間（月）。試用期間とは別。試用6か月・育成3か月のような組み合わせがある';
comment on column public.gw_contracts.work_scope is
  '雇入れ直後の業務の候補。3か月計画のKPIを決めるときの材料にする';


-- -----------------------------------------------------------------------------
-- 2) 3か月育成計画（§6-9）
--
--    1人につき、期間が重ならない範囲で複数持てる。
--    3か月が終わったら次の3か月を作る（前の計画は残す）。
--
--    ★ AIが作るのはドラフトまで。管理者と本人が確認して確定する（§6）。
--      status が 'draft' のあいだは、KPIは日々の画面に出さない。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_plans (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid,                          -- auth.users.id（日々の集計用）

  -- どの書類から始まったか。労働条件を書き換えることはしない（§2-1）
  contract_id uuid references public.gw_contracts(id) on delete set null,

  start_date date not null,
  end_date   date not null,

  -- 「○○ができるようになる」の形で書く（§7）
  three_month_kgi text,

  status text not null default 'draft'
         check (status in ('draft', 'active', 'done', 'cancelled')),

  -- AIが作ったドラフト。人が直したあとも、元の案を残す
  ai_draft  jsonb,
  ai_model  text,
  ai_prompt_version text,
  ai_status text default 'pending'
            check (ai_status in ('pending', 'processing', 'completed', 'failed')),
  ai_error  text,

  note text,
  created_by  uuid references auth.users(id) on delete set null,
  -- 確定した人。管理者と本人の両方が見た、という運用は画面側で促す
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (end_date > start_date)
);

create index if not exists idx_gw_growth_plans_emp
  on public.gw_growth_plans(employee_id, start_date desc);
create index if not exists idx_gw_growth_plans_user
  on public.gw_growth_plans(user_id, status);

comment on table public.gw_growth_plans is
  '3か月の育成計画。3か月KGIは固定し、月間KGI/KPIは毎月見直す。'
  'AIはドラフトまでで、確定は人が押す';


-- -----------------------------------------------------------------------------
-- 3) 月間KGI（§10 §11）
--    3か月を3段階に分ける（§8）。
--      MONTH 1 基本業務を安定して実行できる
--      MONTH 2 自分で優先順位を決めて進める
--      MONTH 3 自分で考え、改善までできる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_months (
  id       uuid primary key default gen_random_uuid(),
  plan_id  uuid not null references public.gw_growth_plans(id) on delete cascade,
  user_id  uuid,

  month_no smallint not null check (month_no between 1 and 12),
  month    date not null,                    -- その月の1日

  kgi   text,
  -- その月に想定している自走レベル。判定そのものは 031 が持つ
  target_level smallint check (target_level between 1 and 4),

  status text not null default 'planned'
         check (status in ('planned', 'active', 'reviewed')),

  -- 月末の振り返り。gw_nippo_monthly とは別で、こちらは目標に対する結果
  review_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, month_no)
);

create index if not exists idx_gw_growth_months_user
  on public.gw_growth_months(user_id, month);


-- -----------------------------------------------------------------------------
-- 4) 月間KPI（§11 §12）
--
--    kind（§12）
--      number    数値      例：営業20件
--      rate      達成率    例：業務完了率90%
--      count     回数      例：AI活用12回
--      output    成果物    例：マニュアル2本
--      onoff     ON/OFF    例：成果発表 実施
--      score     評価      例：上長レビュー80点
--
--    集め方（roll）… 日々の実績をどう月の実績にするか。ここが型ごとに違う。
--      sum   足す（回数・成果物・数値）
--      last  最後の値（達成率・評価。日ごとに足しても意味がない）
--      any   1日でもあれば達成（ON/OFF）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_growth_kpis (
  id       uuid primary key default gen_random_uuid(),
  month_id uuid not null references public.gw_growth_months(id) on delete cascade,
  user_id  uuid,

  sort_order smallint not null default 0,
  name  text not null,
  kind  text not null default 'number'
        check (kind in ('number', 'rate', 'count', 'output', 'onoff', 'score')),
  target_value numeric,
  unit  text,
  -- 重み。月間KGIの進捗を出すときに使う。全部同じでよければ 1 のまま
  weight numeric not null default 1,

  -- 日々の実績から積み上げるか、月末に人が入れるか。
  -- 「上長レビュー80点」のようなものは、日々の日報からは出ない
  from_daily boolean not null default true,
  -- 月末に人が入れた値（from_daily = false のとき使う）
  manual_value numeric,

  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_growth_kpis_month
  on public.gw_growth_kpis(month_id, sort_order);
create index if not exists idx_gw_growth_kpis_user
  on public.gw_growth_kpis(user_id);

comment on column public.gw_growth_kpis.kind is
  '数値/達成率/回数/成果物/ON-OFF/評価。型によって、日々の実績の積み上げ方が変わる';
comment on column public.gw_growth_kpis.from_daily is
  'false なら日報からは積み上げず、月末に人が入れる（上長レビュー点など）';


-- -----------------------------------------------------------------------------
-- 5) 日々のKPIを、月間KPIにつなぐ（§22）
--
--    日報の実績が、そのまま月間KPIの進捗になる。
--    つないでおかないと、同じ数字を2回入れることになる。
-- -----------------------------------------------------------------------------
alter table public.gw_daily_kpis
  add column if not exists kpi_id uuid references public.gw_growth_kpis(id) on delete set null;

create index if not exists idx_gw_daily_kpis_kpi
  on public.gw_daily_kpis(kpi_id, work_date);

comment on column public.gw_daily_kpis.kpi_id is
  '月間KPIへの紐づけ。入っていれば、日々の実績がそのまま月の進捗になる';

-- source に 'plan'（3か月計画から降りてきたもの）を足す
alter table public.gw_daily_kpis drop constraint if exists gw_daily_kpis_source_check;
alter table public.gw_daily_kpis add constraint gw_daily_kpis_source_check
  check (source in ('manual', 'template', 'continued', 'ai', 'plan'));


-- -----------------------------------------------------------------------------
-- 6) 誰が読めるか
--    本人と、社内の管理者・担当者・経営者。
--    書き込みは service_role の API だけなので insert/update のポリシーは置かない。
-- -----------------------------------------------------------------------------
alter table public.gw_growth_plans  enable row level security;
alter table public.gw_growth_months enable row level security;
alter table public.gw_growth_kpis   enable row level security;

drop policy if exists gw_growth_plans_select on public.gw_growth_plans;
create policy gw_growth_plans_select on public.gw_growth_plans
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_growth_months_select on public.gw_growth_months;
create policy gw_growth_months_select on public.gw_growth_months
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

drop policy if exists gw_growth_kpis_select on public.gw_growth_kpis;
create policy gw_growth_kpis_select on public.gw_growth_kpis
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());

notify pgrst, 'reload schema';

-- 確認:
--   select p.start_date, p.end_date, p.status, e.display_name, p.three_month_kgi
--     from public.gw_growth_plans p
--     join public.gw_employees e on e.id = p.employee_id
--    order by p.start_date desc;
--   select m.month_no, m.month, m.kgi, k.name, k.kind, k.target_value, k.unit
--     from public.gw_growth_months m
--     left join public.gw_growth_kpis k on k.month_id = m.id
--    order by m.month, k.sort_order;


-- =============================================================================
-- 033_intake.sql — 1ファイル登録（雇用・育成マスターの取り込み）
--
-- 前提: db/005_groupware_core.sql（gw_employees）と
--       db/032_growth_plan.sql（gw_growth_kpis）が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 033: 1ファイル登録（雇用・育成マスターの取り込み）
--      「1ファイル登録型 自走育成・業務運営システム」§3〜§12 §51
--
-- ■ この番号で入れるもの
--   1) gw_employees に、マスターの項目が入る列を足す
--   2) gw_import_batches / gw_import_rows … 取り込みの記録（§51）
--   3) gw_growth_kpis.template_code … どのテンプレート由来かを残す
--
-- ■ employment_profiles を新しく作らない
--   §51 は employment_profiles を別表にしているが、
--   雇用条件は 029 の gw_contracts が、氏名・入社日・所属は gw_employees が
--   既に持っている。3つ目の表を作ると、同じ人の情報が3か所に散る。
--   足りない列（社員コード・上長・職種・初期Role・勤務形態）だけを
--   gw_employees に足す。
--
-- ■ 取り込んだ行を、そのまま残す理由（§11）
--   10人ぶん取り込んで2人がエラー、というとき、
--   その2人だけを直して再取り込みしたい。
--   元データ（raw_json）を残しておけば、管理者は表を作り直さずに済む。
--
-- ■ 社員コードの自動採番（§10）
--   空欄なら自動で振るが、同時に2ファイル取り込むと衝突しうる。
--   一意制約で弾いて、その行だけエラーに落とす。
--   採番そのものはアプリ側で行い、DBは重複を許さないことだけを担保する。
--
-- 前提: 005（gw_employees）、032（gw_growth_kpis）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 社員名簿に、マスターの項目を足す
-- -----------------------------------------------------------------------------
alter table public.gw_employees add column if not exists employee_code text;
alter table public.gw_employees
  add column if not exists manager_id uuid references public.gw_employees(id) on delete set null;
alter table public.gw_employees add column if not exists job_family_code text;
alter table public.gw_employees add column if not exists initial_role text;
alter table public.gw_employees add column if not exists work_style text
  check (work_style in ('リモート', 'ハイブリッド', '出社'));
-- どの取り込みで作られた行か。取り消しややり直しの手がかりになる
alter table public.gw_employees add column if not exists import_row_id uuid;

-- 社員コードはテナントの中で一意。空欄（null）は何行あってもよい
create unique index if not exists uq_gw_employees_code
  on public.gw_employees(tenant_id, employee_code)
  where employee_code is not null;

comment on column public.gw_employees.employee_code is
  '社員コード。空欄で取り込むと自動採番。テナント内で一意';
comment on column public.gw_employees.manager_id is
  '管理責任者。マスターでは manager_email で指定し、取り込み時に引き当てる';
comment on column public.gw_employees.job_family_code is
  '職種コード。3か月計画のテンプレートを選ぶのに使う（lib/job-templates.js）';


-- -----------------------------------------------------------------------------
-- 2) 取り込みの記録（§51 import_batches / import_rows）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_import_batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  filename    text,
  uploaded_by uuid references auth.users(id) on delete set null,

  total_rows   integer not null default 0,
  success_rows integer not null default 0,
  error_rows   integer not null default 0,

  -- checked  … 検証しただけ。まだ1件も登録していない
  -- applied  … 登録した
  -- failed   … 全行エラーで、1件も登録できなかった
  status text not null default 'checked'
         check (status in ('checked', 'applied', 'failed')),

  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists idx_gw_import_batches_tenant
  on public.gw_import_batches(tenant_id, created_at desc);

comment on table public.gw_import_batches is
  '雇用・育成マスターの取り込み単位。まず checked で検証結果を出し、'
  '管理者が確認してから applied にする（誤ったファイルでアカウントを作らないため）';


create table if not exists public.gw_import_rows (
  id       uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.gw_import_batches(id) on delete cascade,
  row_no   integer not null,

  -- 表の1行をそのまま。直して再取り込みするときに、表を作り直さずに済む
  raw_json jsonb not null,

  -- ok      … 検証を通った（まだ登録していない）
  -- created … 登録してアカウントまで作った
  -- error   … 検証で弾いた
  -- skipped … 既に同じ人がいる
  status text not null default 'ok'
         check (status in ('ok', 'created', 'error', 'skipped')),

  -- どの項目がなぜ駄目か。[{field, message}]
  error_json jsonb,

  created_employee_id uuid references public.gw_employees(id) on delete set null,
  created_user_id     uuid,
  -- 初回パスワードは保存しない。平文で残るため、取り込みの応答にだけ出す

  created_at timestamptz not null default now(),
  unique (batch_id, row_no)
);

create index if not exists idx_gw_import_rows_batch
  on public.gw_import_rows(batch_id, row_no);

comment on column public.gw_import_rows.raw_json is
  '取り込んだ1行をそのまま。エラー行だけ直して再取り込みするのに使う';
comment on column public.gw_import_rows.error_json is
  'どの項目がなぜ駄目か。管理者が表のどこを直せばよいか分かる形で入れる';


-- -----------------------------------------------------------------------------
-- 3) KPIがどこから来たか
--    テンプレート由来か、AIが足したか、人が足したかを区別する。
--    「テンプレートのどのKPIが実際には使われていないか」を後から見るのに要る
-- -----------------------------------------------------------------------------
alter table public.gw_growth_kpis add column if not exists template_code text;

comment on column public.gw_growth_kpis.template_code is
  '<職種コード>:<KPI名>。テンプレート由来のものだけ入る。'
  'AIが足したものと人が足したものは空';


-- -----------------------------------------------------------------------------
-- 4) 誰が読めるか
--    取り込みの記録は人事情報そのものなので、社内の担当者だけ。
--    本人にも見せない（他の人の行が同じバッチに入っているため）。
--    書き込みは service_role の API だけ。
-- -----------------------------------------------------------------------------
alter table public.gw_import_batches enable row level security;
alter table public.gw_import_rows    enable row level security;

drop policy if exists gw_import_batches_select on public.gw_import_batches;
create policy gw_import_batches_select on public.gw_import_batches
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

drop policy if exists gw_import_rows_select on public.gw_import_rows;
create policy gw_import_rows_select on public.gw_import_rows
  for select to authenticated
  using (exists (
    select 1 from public.gw_import_batches b
     where b.id = batch_id and public.gw_is_hr(b.tenant_id)
  ));

notify pgrst, 'reload schema';

-- 確認:
--   select filename, total_rows, success_rows, error_rows, status, created_at
--     from public.gw_import_batches order by created_at desc limit 10;
--   select row_no, status, error_json from public.gw_import_rows
--    where batch_id = '...' order by row_no;
--   select display_name, employee_code, job_family_code, initial_role
--     from public.gw_employees where employee_code is not null order by employee_code;


-- =============================================================================
-- 034_nippo_loop.sql — 日報を「先に描いてから動く」形にする
--
-- 前提: db/025_nippo_v3.sql と db/026_nippo_ai_eval.sql が適用済みであること。
-- =============================================================================
-- =============================================================================
-- 034: 日報を「先に描いてから動く」形にする
--
--   ゴール → 今日成功した状態を先に描く → 行動する → できたことを記録する
--   → AIがフィードバック → 翌日の行動を決める
--
-- ■ なぜ朝と夜に分けるのか（ここがこの番号の本体）
--   これまでの日報は、全部を終業時に書いていた。
--   その形のまま「今日は良かったと言える状態」という欄を足しても、
--   結果を見てから、その結果に合う状態を書いてしまう。
--   つまり「先に描く」が成立しない。順番が逆になる。
--
--   朝に描いたことが morning_at の時刻とともに残っていて、
--   夜にそれと突き合わせる。だから分ける。
--
--     朝  success_image（今日の成功の定義） + work_items の task（今日やる3つ）
--     夜  work_items の result（できたこと） + success_met + tomorrow_change
--
-- ■ 3か月後の像は毎日書かせない
--   goal_image は本人の言葉で書く「3か月後どうなっていたいか」。
--   毎日入力させると作業になるので、前日ぶんを引き継いで、
--   変えたいときだけ書き直す。
--   （3か月KGI は gw_growth_plans が持っている。こちらは会社が決めた文言、
--     goal_image は本人の言葉。両方を並べて出す）
--
-- ■ success_met は点数にしない
--   o / d / x の3つだけ。朝に描いた状態になれたかどうかを、本人が選ぶ。
--   点数にすると「何点だったか」を気にする話に戻ってしまう。
--   見たいのは「描いた状態と、実際の差」で、その差が明日変えることになる。
--
-- 前提: 025（tc_nippo の6項目化）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- 朝の入力を出した時刻。これが入っていることが「先に描いた」の証拠になる。
-- 空のまま夜の入力だけ出すこともできる（朝に書き忘れた日を弾かない）
alter table public.tc_nippo add column if not exists morning_at timestamptz;

-- ① 3か月後どうなっていたいか（本人の言葉）。前日ぶんを引き継ぐ
alter table public.tc_nippo add column if not exists goal_image text;

-- ② 今日の終わりに「今日は良かった」と言える状態。朝に書く
alter table public.tc_nippo add column if not exists success_image text;

-- ④ 朝に描いた状態になれたか。o=なれた / d=途中まで / x=ならなかった
alter table public.tc_nippo add column if not exists success_met text
  check (success_met in ('o', 'd', 'x'));

-- ⑤ 明日変えること。「明日の最優先（tomorrow_plan）」とは別。
--   最優先＝何をやるか、変えること＝やり方をどう変えるか
alter table public.tc_nippo add column if not exists tomorrow_change text;

comment on column public.tc_nippo.morning_at is
  '朝の入力を出した時刻。これが入っていれば「結果を見る前に描いた」と分かる';
comment on column public.tc_nippo.success_image is
  '今日の終わりに「今日は良かった」と言える状態。朝に書く。'
  '夜に書き足せてしまうと、結果に合わせた後付けになるので、画面側で朝しか出さない';
comment on column public.tc_nippo.goal_image is
  '3か月後どうなっていたいか。本人の言葉。毎日は書かせず、前日ぶんを引き継ぐ';
comment on column public.tc_nippo.success_met is
  '朝に描いた状態になれたか。o/d/x の3つだけ。点数にしない';
comment on column public.tc_nippo.tomorrow_change is
  '明日変えること。tomorrow_plan（何をやるか）とは別で、こちらはやり方をどう変えるか';

-- AIが出す「朝に描いた状態と、実際の差」。
-- 良かった点・改善点とは別に持つ。この仕組みの中心にある材料なので、
-- 他のコメントに混ぜると埋もれる
alter table public.gw_nippo_ai_evals add column if not exists gap text;

comment on column public.gw_nippo_ai_evals.gap is
  '朝に描いた状態と実際の差。届いていた場合も「なぜ届いたか」を書かせる';


-- 朝の入力だけ出ている日を探すのに使う。
-- 「描いたが、夜に結果を書いていない」は、その日のうちに気づきたい
create index if not exists idx_tc_nippo_morning
  on public.tc_nippo(user_id, work_date desc)
  where morning_at is not null;

notify pgrst, 'reload schema';

-- 確認:
--   select work_date, morning_at is not null as 朝, success_met,
--          left(success_image, 30) as 今日の成功, left(tomorrow_change, 30) as 明日変えること
--     from public.tc_nippo order by work_date desc limit 10;


-- =============================================================================
-- 035_work_mode.sql — 勤務・育成区分／給与を読める人を絞る
-- =============================================================================

-- 勤務・育成区分。どう雇うか（期間・時間・権限・開始レベル）。
-- 何を目標にするかは job_family_code 側。2軸を掛け合わせて登録する。
-- 値の妥当性は lib/work-modes.js で見るので、check 制約は置かない
alter table public.gw_employees
  add column if not exists work_mode text;

comment on column public.gw_employees.work_mode is
  '勤務・育成区分。どう雇うか（期間・時間・権限・開始レベル）。'
  '何を目標にするかは job_family_code 側。値は lib/work-modes.js';

create index if not exists idx_gw_employees_work_mode
  on public.gw_employees(tenant_id, work_mode)
  where work_mode is not null;

-- 給与（wage_type / wage_amount / wage_note）を含む行なので、
-- 社内の誰でもではなく、人事と本人だけにする。
-- RLSは列を選べないので、行ごと絞る。
-- 画面はすべて service_role のAPI経由（入口で admin/owner/人事 に限定）なので、
-- これで見えなくなる画面は無い。塞ぐのはブラウザから直接読む経路
drop policy if exists gw_contracts_select on public.gw_contracts;
create policy gw_contracts_select on public.gw_contracts
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

notify pgrst, 'reload schema';


-- =============================================================================
-- 036_nippo_simple.sql — 日報をメンバー向けに絞る／みんなの日報
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 日報。朝と夜の新しい項目
-- -----------------------------------------------------------------------------
alter table public.tc_nippo add column if not exists top_priority   text;
alter table public.tc_nippo add column if not exists morning_note   text;
alter table public.tc_nippo add column if not exists consult_note   text;

comment on column public.tc_nippo.top_priority is
  '今日の最優先。朝に1つだけ書く。今日という日を何で判断するか';
comment on column public.tc_nippo.morning_note is
  '朝の時点で困っていること（任意）。始める前から詰まっているものを拾う';
comment on column public.tc_nippo.consult_note is
  '終業時の相談事項（任意）。本人と管理者だけが見る。みんなの日報には出さない';
comment on column public.tc_nippo.work_items is
  '朝に task を書き、夜に result（できたこと）か undone_reason（できなかった理由）を書く。'
  '最大3件。未完了の欄を別に作らず、ここで両方そろえる';


-- -----------------------------------------------------------------------------
-- 2) AI評価。本人向けに返す「達成度」
--    良かった点・改善点・明日の優先事項は既にある（026 / 030 / 034）
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_ai_evals add column if not exists achievement text;

comment on column public.gw_nippo_ai_evals.achievement is
  '達成度。朝に決めた最優先とやること3件に対して、実際どうだったか。1〜2文。'
  '点数ではなく言葉で返す';


-- -----------------------------------------------------------------------------
-- 3) みんなの日報（公開サマリー）
--
--    ★ この表には、公開してよい4項目しか入れない。
--      点数・未達理由・相談事項・個人評価・管理者コメントは入れない。
--      入っていないものは、間違って返すこともできない。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_shares (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- 日報1件につき1つ。作り直したら上書きする
  nippo_id  uuid not null unique,
  user_id   uuid not null references auth.users(id) on delete cascade,
  user_name text,
  work_date date not null,

  -- AIが作る4項目。どれも1〜2文
  did      text,   -- 今日やったこと
  result   text,   -- 成果
  learn    text,   -- 学び
  tomorrow text,   -- 明日やること

  -- 本人が「みんなには出さない」を選べる。
  -- 出したくない日を1日も作れないと、書く内容のほうが薄くなる
  visible boolean not null default true,

  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_nippo_shares_date
  on public.gw_nippo_shares(tenant_id, work_date desc);
create index if not exists idx_gw_nippo_shares_user
  on public.gw_nippo_shares(user_id, work_date desc);


-- -----------------------------------------------------------------------------
-- 4) 「参考になった」
--    1人1回。取り消せる。数だけを見せ、誰が押したかは名前まで出す
--    （社内なので匿名にする理由がなく、匿名だと押し合いの意味が薄れる）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_reactions (
  id       uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.gw_nippo_shares(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  user_name text,
  kind     text not null default 'helpful' check (kind in ('helpful')),
  created_at timestamptz not null default now(),
  unique (share_id, user_id, kind)
);

create index if not exists idx_gw_nippo_reactions_share
  on public.gw_nippo_reactions(share_id);


-- -----------------------------------------------------------------------------
-- 5) ひとことコメント
--    長文のやり取りは社内メッセージ（gw_messages）でやる。
--    ここは「参考になった」の一歩先くらいの短いものだけ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_nippo_comments (
  id       uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.gw_nippo_shares(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  user_name text,
  body     text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gw_nippo_comments_share
  on public.gw_nippo_comments(share_id, created_at);


-- -----------------------------------------------------------------------------
-- 6) RLS
--    読むのは社内の人だけ。書き込みは service_role の API だけが行う
--    （本人以外の名前で押せてしまうと、リアクションの意味が無くなる）。
-- -----------------------------------------------------------------------------
alter table public.gw_nippo_shares    enable row level security;
alter table public.gw_nippo_reactions enable row level security;
alter table public.gw_nippo_comments  enable row level security;

drop policy if exists gw_nippo_shares_select on public.gw_nippo_shares;
create policy gw_nippo_shares_select on public.gw_nippo_shares
  for select to authenticated
  using (public.gw_is_internal_staff() and (visible or user_id = auth.uid()));

drop policy if exists gw_nippo_reactions_select on public.gw_nippo_reactions;
create policy gw_nippo_reactions_select on public.gw_nippo_reactions
  for select to authenticated
  using (public.gw_is_internal_staff());

drop policy if exists gw_nippo_comments_select on public.gw_nippo_comments;
create policy gw_nippo_comments_select on public.gw_nippo_comments
  for select to authenticated
  using (public.gw_is_internal_staff());


notify pgrst, 'reload schema';

-- 確認:
--   -- 朝と夜の新しい欄
--   select work_date, top_priority, jsonb_array_length(coalesce(work_items,'[]')) as やること,
--          consult_note is not null as 相談あり
--     from public.tc_nippo order by work_date desc limit 10;
--
--   -- みんなの日報。ここに点数・相談事項が入っていないことを目で確かめる
--   select work_date, user_name, did, result, learn, tomorrow, visible
--     from public.gw_nippo_shares order by work_date desc limit 10;


-- =============================================================================
-- 037_onboard_form.sql — 入社フォーム（本人の情報・同意）
-- =============================================================================
-- 1) 本人が入れる情報
--    1人1行。入社フォームから保存する。
--    管理者が登録フォームで入れた項目（氏名・入社日・契約・勤務時間・
--    担当業務・給与）はここに持たない。二重に持つと、どちらが正かが決まらない。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_onboard_profiles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null unique references public.gw_employees(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,

  -- 本人
  name_kana     text,
  birth_date    date,
  postal_code   text,
  address       text,
  phone         text,

  -- 緊急連絡先
  emg_name      text,
  emg_relation  text,
  emg_phone     text,

  -- 通勤
  commute_from  text,          -- 最寄駅・出発地
  commute_route text,          -- 経路
  commute_cost  numeric,       -- 1か月の定期代

  -- 給与振込先
  bank_name     text,
  bank_branch   text,
  bank_type     text check (bank_type in ('普通', '当座') or bank_type is null),
  bank_number   text,
  bank_holder   text,          -- 名義（カナ）

  -- 社会保険・雇用保険の手続きに要るもの。
  -- 基礎年金番号と雇用保険番号は、番号法の対象ではないのでここで持つ。
  -- マイナンバーは持たない（このファイルの頭に理由を書いた）
  pension_number   text,
  employment_ins_number text,
  has_dependents   boolean,
  dependents_note  text,

  -- 本人からの一言。Slackの紹介文に使う
  greeting text,

  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gw_onboard_profiles is
  '入社時に本人が入れる情報。マイナンバーは保存しない（037の冒頭を参照）。'
  '管理者が登録フォームで入れた項目は gw_employees / gw_contracts 側が正';

create index if not exists idx_gw_onboard_profiles_tenant
  on public.gw_onboard_profiles(tenant_id, status);


-- -----------------------------------------------------------------------------
-- 2) 同意（誓約書・個人情報の取扱い・社内ルール）
--    いつ・どの版に同意したかを残す。版を上げたら取り直す
-- -----------------------------------------------------------------------------
create table if not exists public.gw_onboard_consents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,

  kind    text not null,          -- pledge / privacy / rules。値は lib/onboard-form.js
  version text not null default 'v1',
  agreed_at timestamptz not null default now(),

  unique (employee_id, kind, version)
);

create index if not exists idx_gw_onboard_consents_employee
  on public.gw_onboard_consents(employee_id);


-- -----------------------------------------------------------------------------
-- 3) チェックリストの項目に、機械で引ける鍵を付ける
--    自動で作った項目と、本人フォームの入力欄を突き合わせるのに使う。
--    題名で突き合わせると、題名を編集した瞬間に紐づかなくなる
-- -----------------------------------------------------------------------------
alter table public.gw_procedure_items
  add column if not exists item_key text;

comment on column public.gw_procedure_items.item_key is
  '自動生成した項目の識別子。本人フォームの入力欄と突き合わせるのに使う。'
  '人が手で足した項目は null';

create index if not exists idx_gw_procedure_items_key
  on public.gw_procedure_items(procedure_id, item_key)
  where item_key is not null;


-- -----------------------------------------------------------------------------
-- 4) RLS
--    個人情報は、人事と本人だけ。社労士（gw_is_advisor）は入れない。
--    社労士へは、人事が内容を確認したうえで連絡用テキストを渡す。
--    書き込みは service_role の API だけが行う（本人が status を
--    勝手に submitted にできると、確認前のものが揃った扱いになる）。
-- -----------------------------------------------------------------------------
alter table public.gw_onboard_profiles enable row level security;
alter table public.gw_onboard_consents enable row level security;

drop policy if exists gw_onboard_profiles_select on public.gw_onboard_profiles;
create policy gw_onboard_profiles_select on public.gw_onboard_profiles
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_onboard_consents_select on public.gw_onboard_consents;
create policy gw_onboard_consents_select on public.gw_onboard_consents
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );


notify pgrst, 'reload schema';

-- 確認:
--   -- 本人が出した情報（マイナンバーの列が無いことを目で確かめる）
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_onboard_profiles'
--    order by ordinal_position;
--
--   -- 入社準備の進み具合
--   select e.display_name, p.status,
--          count(*) filter (where i.status in ('done','na')) as 完了,
--          count(*) as 全体
--     from public.gw_procedures p
--     join public.gw_employees e on e.id = p.employee_id
--     left join public.gw_procedure_items i on i.procedure_id = p.id
--    where p.kind = 'onboarding'
--    group by e.display_name, p.status;
