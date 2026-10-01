-- =============================================================================
-- 110: 社内AIチャット（messages.html を「社員同士のチャット」から
--      「社内業務について相談できるAI」へ置き換える）
--
-- ■ 何のための表か
--   社員とAIの相談（gw_ai_threads / gw_ai_messages）、AIが参照する社内ナレッジ
--   （gw_ai_knowledge）、回答の出典（gw_ai_sources）、回答への評価
--   （gw_ai_feedback）、AIで解決しなかったときに管理部へ送る問い合わせ
--   （gw_ai_inquiries / gw_ai_inquiry_messages）の7つ。
--
--   社員同士のチャット（gw_threads / gw_thread_members / gw_messages, db/010・079）
--   は廃止対象だが、このPRでは一切触らない・削除しない（他機能からの参照を
--   調査してから段階的に止める。要件定義書 §25・§32 のとおり）。
--   新しい相談はすべてこちらの7表を使う。
--
-- ■ user_id ではなく employee_id にした理由
--   このリポジトリの社内機能（gw_messages.sender_id・gw_quick_memos.employee_id
--   など）はすべて gw_employees.id を主語にしている。要件定義書の DB 案（§19）は
--   user_id だが、既存の並びにそろえた（表示名・部署など、結局 gw_employees を
--   引く必要があるため）。
--
-- ■ ナレッジ検索（RAG）の実装方針
--   pgvector も、日本語の形態素解析辞書もこの環境には無い（package.json・
--   拡張機能とも未導入）。今回は文字2-gram（lib/ai-knowledge.js）で
--   質問文とナレッジ本文の重なりを見るシンプルな方式にする。
--   埋め込み検索は、要件になくても後から gw_ai_knowledge に列を足せば移行できる
--   （この表の形はそのまま使える）。
--
-- ■ カテゴリ
--   要件定義書は「よくある質問のカテゴリ（総務/人事・労務/経理/IT/営業/社内ルール）」
--   と「ナレッジのカテゴリ（総務/人事・労務/経理/IT/社内システム/その他）」を
--   別々に挙げているが、2系統持つと画面とナレッジの分類がずれるだけなので、
--   1つにそろえた: general_affairs(総務) / hr(人事・労務) / accounting(経理) /
--   it(IT) / sales(営業) / rules(社内ルール) / other(その他)。
--   「社内システムの使い方」はIT、または該当する担当カテゴリに割り当てる。
--
-- ■ 公開範囲（access_scope）— 要件定義書 §9 の4段階
--   all      … 一般社員も含め全員
--   hr       … 人事情報（gw_is_hr と同じ判定が必要）
--   finance  … 経理情報（gw_is_office と同じ判定が必要。db/099）
--   admin    … 管理者限定（is_tenant_staff）
--   「個人の給与・評価・マイナンバー・銀行口座・パスワード」等（要件 §10）は
--   そもそもナレッジとして登録しない運用とする（表の制約では縛れないため、
--   管理画面側の注意書きと運用でカバーする）。
--
-- ■ RLS
--   書き込みは既存の gw_threads / gw_quick_memos と同じ方針で、すべて
--   サーバ側（service_role）のみ。RLS に insert/update ポリシーは置かない
--   （参照のみ）。
--     gw_ai_threads/messages/sources/feedback … 本人だけが読める
--       （AIとの相談は個人の相談であり、人事・管理者であっても覗かない。
--        解決しなかった分だけ、要約して gw_ai_inquiries へ本人の操作で渡す）
--     gw_ai_knowledge … 公開範囲に応じて全社員 + 管理者/人事は無効行も含め全部
--     gw_ai_inquiries/inquiry_messages … 本人 + 管理サイド（gw_is_hr。
--       db/041 で管理者＝人事と同じ扱いになっているので canManageHr と同じ基準）
--
-- ■ 既存データへの影響
--   新しい表の追加のみ。既存表・既存ポリシーは一切変更しない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 005_groupware_core.sql（gw_employee_id・gw_is_hr・is_tenant_staff）、
--       041_admin_is_hr.sql（gw_is_hr に管理者を含める）、
--       099_access_hr_office.sql（gw_is_office）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) AIとの相談（スレッド）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_threads (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  -- 最初の質問から自動で付ける短い見出し。画面の一覧表示用
  title       text,
  category    text check (category in
               ('general_affairs','hr','accounting','it','sales','rules','other')),
  status      text not null default 'open' check (status in ('open','closed')),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_ai_threads_employee
  on public.gw_ai_threads(tenant_id, employee_id, updated_at desc);


-- -----------------------------------------------------------------------------
-- 2) AIとのメッセージ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_messages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  thread_id  uuid not null references public.gw_ai_threads(id) on delete cascade,

  role       text not null check (role in ('user','assistant','system')),
  content    text not null,

  created_at timestamptz not null default now()
);

create index if not exists idx_gw_ai_messages_thread
  on public.gw_ai_messages(thread_id, created_at);


-- -----------------------------------------------------------------------------
-- 3) AIが参照する社内ナレッジ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_knowledge (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,

  title        text not null,
  category     text not null check (category in
               ('general_affairs','hr','accounting','it','sales','rules','other')),
  content      text not null,

  -- manual … 管理者が直接入力 / file … PDF・Word等から取り込み（要件 §21）
  source_type  text not null default 'manual' check (source_type in ('manual','file')),
  source_id    text,

  access_scope text not null default 'all' check (access_scope in ('all','hr','finance','admin')),

  -- 回答の最後に出す「関連する社内画面へのリンク」（要件 §6）
  link_url     text,
  link_label   text,

  is_active    boolean not null default true,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gw_ai_knowledge_tenant
  on public.gw_ai_knowledge(tenant_id, is_active, category);

comment on column public.gw_ai_knowledge.access_scope is
  '誰に見えるナレッジか。all=全員 / hr=人事情報 / finance=経理情報 / admin=管理者限定。'
  '個人の給与・評価・マイナンバー等（要件 §10）はそもそもここに登録しない運用とする';


-- -----------------------------------------------------------------------------
-- 4) 回答が参照した資料（出典）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_sources (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  message_id   uuid not null references public.gw_ai_messages(id) on delete cascade,

  -- ナレッジが後から編集・削除されても出典の表示は変わらないよう、
  -- 回答した時点の内容を複製しておく
  knowledge_id uuid references public.gw_ai_knowledge(id) on delete set null,
  title        text not null,
  excerpt      text,
  link_url     text,
  link_label   text,

  created_at   timestamptz not null default now()
);

create index if not exists idx_gw_ai_sources_message
  on public.gw_ai_sources(message_id);


-- -----------------------------------------------------------------------------
-- 5) 回答への評価
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_feedback (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  message_id  uuid not null references public.gw_ai_messages(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  rating      text not null check (rating in ('up','down')),
  comment     text,

  created_at  timestamptz not null default now(),
  unique (message_id, employee_id)
);


-- -----------------------------------------------------------------------------
-- 6) 管理部への問い合わせ（AIで解決しなかった分）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_inquiries (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  employee_id          uuid not null references public.gw_employees(id) on delete cascade,

  -- 引き継いだAI会話。直接問い合わせた場合は null
  ai_thread_id         uuid references public.gw_ai_threads(id) on delete set null,

  category             text check (category in
               ('general_affairs','hr','accounting','it','sales','rules','other')),
  subject              text not null,
  summary              text not null,

  status               text not null default 'new'
                        check (status in ('new','in_progress','waiting_user','resolved','closed')),
  assigned_employee_id uuid references public.gw_employees(id) on delete set null,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_gw_ai_inquiries_tenant
  on public.gw_ai_inquiries(tenant_id, status, created_at desc);
create index if not exists idx_gw_ai_inquiries_employee
  on public.gw_ai_inquiries(tenant_id, employee_id, created_at desc);

-- 1つのAI相談から問い合わせを作れるのは1本だけ（二度押しで2本できない。
-- api/ai/inquiries.js は、既にあればそれを返す＝admin-contact と同じ「開くか、合流するか」）
create unique index if not exists uq_gw_ai_inquiries_thread
  on public.gw_ai_inquiries(ai_thread_id) where ai_thread_id is not null;


-- -----------------------------------------------------------------------------
-- 7) 問い合わせの返信（社員 ⇔ 管理部）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_ai_inquiry_messages (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  inquiry_id         uuid not null references public.gw_ai_inquiries(id) on delete cascade,

  sender_type        text not null check (sender_type in ('employee','admin','system')),
  sender_employee_id uuid references public.gw_employees(id) on delete set null,
  content            text not null,

  created_at         timestamptz not null default now()
);

create index if not exists idx_gw_ai_inquiry_messages_inquiry
  on public.gw_ai_inquiry_messages(inquiry_id, created_at);


-- -----------------------------------------------------------------------------
-- 8) ヘルパ: 自分のAI相談か（RLSの中から呼ぶので SECURITY DEFINER）
-- -----------------------------------------------------------------------------
create or replace function public.gw_owns_ai_thread(p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gw_ai_threads t
     where t.id = p_thread
       and t.employee_id = public.gw_employee_id(t.tenant_id)
  )
$$;

create or replace function public.gw_owns_ai_message(p_message uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gw_ai_messages m
     where m.id = p_message
       and public.gw_owns_ai_thread(m.thread_id)
  )
$$;

-- 自分の問い合わせ、または管理サイド（gw_is_hr＝db/041で管理者も含む）か
create or replace function public.gw_visible_ai_inquiry(p_inquiry uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gw_ai_inquiries i
     where i.id = p_inquiry
       and (i.employee_id = public.gw_employee_id(i.tenant_id) or public.gw_is_hr(i.tenant_id))
  )
$$;


-- -----------------------------------------------------------------------------
-- 9) RLS（参照のみ。書き込みはすべてサーバ側 service_role から）
-- -----------------------------------------------------------------------------
alter table public.gw_ai_threads         enable row level security;
alter table public.gw_ai_messages        enable row level security;
alter table public.gw_ai_knowledge       enable row level security;
alter table public.gw_ai_sources         enable row level security;
alter table public.gw_ai_feedback        enable row level security;
alter table public.gw_ai_inquiries       enable row level security;
alter table public.gw_ai_inquiry_messages enable row level security;

drop policy if exists gw_ai_threads_select on public.gw_ai_threads;
create policy gw_ai_threads_select on public.gw_ai_threads
  for select using (employee_id = public.gw_employee_id(tenant_id));

drop policy if exists gw_ai_messages_select on public.gw_ai_messages;
create policy gw_ai_messages_select on public.gw_ai_messages
  for select using (public.gw_owns_ai_thread(thread_id));

-- ナレッジ: 管理者・人事は無効行も含め全部。それ以外は公開範囲に応じて有効行だけ
drop policy if exists gw_ai_knowledge_select on public.gw_ai_knowledge;
create policy gw_ai_knowledge_select on public.gw_ai_knowledge
  for select using (
    public.gw_is_hr(tenant_id)
    or (
      public.gw_employee_id(tenant_id) is not null
      and is_active
      and (
        access_scope = 'all'
        or (access_scope = 'finance' and public.gw_is_office(tenant_id))
        or (access_scope = 'admin' and public.is_tenant_staff(tenant_id))
      )
    )
  );

drop policy if exists gw_ai_sources_select on public.gw_ai_sources;
create policy gw_ai_sources_select on public.gw_ai_sources
  for select using (public.gw_owns_ai_message(message_id));

drop policy if exists gw_ai_feedback_select on public.gw_ai_feedback;
create policy gw_ai_feedback_select on public.gw_ai_feedback
  for select using (employee_id = public.gw_employee_id(tenant_id) or public.gw_is_hr(tenant_id));

drop policy if exists gw_ai_inquiries_select on public.gw_ai_inquiries;
create policy gw_ai_inquiries_select on public.gw_ai_inquiries
  for select using (employee_id = public.gw_employee_id(tenant_id) or public.gw_is_hr(tenant_id));

drop policy if exists gw_ai_inquiry_messages_select on public.gw_ai_inquiry_messages;
create policy gw_ai_inquiry_messages_select on public.gw_ai_inquiry_messages
  for select using (public.gw_visible_ai_inquiry(inquiry_id));

notify pgrst, 'reload schema';

-- 確認:
--   -- 自分のAI相談
--   select id, title, category, status, updated_at from public.gw_ai_threads
--    where employee_id = public.gw_employee_id(
--      (select tenant_id from public.gw_employees where user_id = auth.uid() limit 1))
--    order by updated_at desc;
--
--   -- 管理サイドに見えている問い合わせ
--   select subject, status, created_at from public.gw_ai_inquiries order by created_at desc;

-- -----------------------------------------------------------------------------
-- ロールバック（必要なときだけ、手で実行する。相談・ナレッジ・問い合わせが消える）
-- -----------------------------------------------------------------------------
-- drop table if exists public.gw_ai_inquiry_messages;
-- drop table if exists public.gw_ai_inquiries;
-- drop table if exists public.gw_ai_feedback;
-- drop table if exists public.gw_ai_sources;
-- drop table if exists public.gw_ai_knowledge;
-- drop table if exists public.gw_ai_messages;
-- drop table if exists public.gw_ai_threads;
-- drop function if exists public.gw_visible_ai_inquiry(uuid);
-- drop function if exists public.gw_owns_ai_message(uuid);
-- drop function if exists public.gw_owns_ai_thread(uuid);
-- notify pgrst, 'reload schema';
