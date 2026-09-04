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
