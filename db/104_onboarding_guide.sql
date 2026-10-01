-- =============================================================================
-- 104: 入社案内（経営者が作る）・招待URL・メール送信履歴
--
--   ■ なぜ
--     入社準備の6ステップの ① 入社案内確認 は、これまで「案内を作る・渡す・本人が確認した」を
--     持つ表が無かった（入社の判定は、既存の段階 computeStage が持つ5つの事実で決まっている）。
--     判定を新しく作るのではなく、足りなかった「事実」だけを、表として持つ。
--
--     gw_onboarding_guides         入社案内。経営者が下書きを書き、発行する。本人が確認した版を持つ
--     gw_onboarding_guide_issues   発行した時点の確定版（版ごと）。あとから直しても、送った内容は残る
--     gw_onboarding_invites        期限つきの案内URL。トークンそのものは持たず、ハッシュだけ
--     gw_mail_messages             メールの送信履歴（本文の確定版・送信者・時刻・提供元・結果）
--
--   ■ 見られる人
--     4つとも、経営者（owner）だけ（gw_is_owner。db/099 が前提）。
--     本人は、API（サービスロール）を通して、自分の発行済みの案内だけを読む。
--     人事・管理者・責任者・採用担当は、DB からも読めない（給与を含まないが、経営者が作る文書のため）。
--
--   ■ 入れないもの
--     給与・手当・時給の金額。案内は、集合時間・場所・持ち物・連絡先・メッセージなどだけ。
--     パスワード。案内URLは、開くだけの期限つきのURLで、パスワードの代わりにならない。
--
--   ■ 前提
--     099（gw_is_owner）。gw_employees・tenants は既存。035・041・094 には依存しない。
--     新しい表だけを作る。既存の表・列・ポリシーは変えない（流しても、いまの動きは変わらない）。
--
-- ■ 適用の順序
--     ① この SQL を流す（べき等）
--     ② 下の「B. 確認」の件数が出ること
--     ③ アプリを再デプロイ（表が無いあいだは、アプリは案内を「データ未連携」と表示し、止まらない）
--
-- ■ A. 元に戻す（必要なときだけ。案内・履歴が消える）
--     drop table if exists public.gw_mail_messages;
--     drop table if exists public.gw_onboarding_invites;
--     drop table if exists public.gw_onboarding_guide_issues;
--     drop table if exists public.gw_onboarding_guides;
--
-- ■ B. 確認
--     select tablename, rowsecurity from pg_tables
--      where schemaname = 'public' and tablename in
--        ('gw_onboarding_guides','gw_onboarding_guide_issues','gw_onboarding_invites','gw_mail_messages');
--     -- → 4行、rowsecurity はすべて true
--     select tablename, policyname, cmd from pg_policies
--      where tablename in ('gw_onboarding_guides','gw_onboarding_guide_issues','gw_onboarding_invites','gw_mail_messages');
--     -- → 4行（*_owner）。using / with check は gw_is_owner(tenant_id)
-- =============================================================================

begin;

-- 1) 入社案内。1人に1つ。下書きの項目は、経営者が書く（自由記述）
create table if not exists public.gw_onboarding_guides (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,

  -- 下書き（経営者が書く）。氏名・入社日・所属・役割は、発行のときに名簿から写す（ここには持たない）
  meeting_time  text,       -- 初日の集合時間（例: 9:45）
  start_time    text,       -- 勤務開始（例: 10:00）
  location      text,       -- 勤務場所
  schedule      text,       -- 初日の予定
  belongings    text,       -- 持ち物
  contact       text,       -- 当日の連絡先
  staff         text,       -- 担当者
  message       text,       -- 会社からのメッセージ

  version            int not null default 0,   -- いま発行している版（0 = まだ一度も発行していない）
  issued_at          timestamptz,
  issued_by          uuid references auth.users(id) on delete set null,
  confirmed_version  int,                      -- 本人が確認した版
  confirmed_at       timestamptz,

  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (employee_id)
);
create index if not exists idx_gw_onboarding_guides_tenant on public.gw_onboarding_guides(tenant_id);

-- 2) 発行した時点の確定版（版ごと）。本人が見るのは、常に「いまの版」のスナップショット
create table if not exists public.gw_onboarding_guide_issues (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  guide_id    uuid not null references public.gw_onboarding_guides(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  version     int not null,
  snapshot    jsonb not null,        -- 確定した本文（氏名・入社日・所属・役割・下書きの項目）。金額は入れない
  issued_by   uuid references auth.users(id) on delete set null,
  issued_at   timestamptz not null default now(),
  unique (guide_id, version)
);
create index if not exists idx_gw_onboarding_guide_issues_guide on public.gw_onboarding_guide_issues(guide_id, version desc);

-- 3) 期限つきの案内URL。トークンは平文で持たない（ハッシュだけ）。失効できる
create table if not exists public.gw_onboarding_invites (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  employee_id     uuid not null references public.gw_employees(id) on delete cascade,
  guide_id        uuid references public.gw_onboarding_guides(id) on delete set null,
  token_hash      text not null unique,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  open_count      int not null default 0
);
create index if not exists idx_gw_onboarding_invites_employee on public.gw_onboarding_invites(employee_id, created_at desc);

-- 4) メールの送信履歴。本文の確定版・送信者・時刻・提供元・結果。再送も1通ずつ残る
create table if not exists public.gw_mail_messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid references public.gw_employees(id) on delete set null,
  purpose       text not null default 'onboarding_guide',
  kind          text not null default 'send' check (kind in ('send', 'test')),
  invite_id     uuid references public.gw_onboarding_invites(id) on delete set null,
  guide_version int,
  to_email      text not null,
  from_email    text,
  reply_to      text,
  subject       text not null,
  body_text     text not null,         -- 送った本文の確定版
  provider      text,                  -- 送信サービス（none / resend など）。実送信しなかったときは none
  status        text not null check (status in ('sent', 'failed', 'skipped')),
  provider_message_id text,
  error         text,
  sent_by       uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_gw_mail_messages_employee on public.gw_mail_messages(employee_id, created_at desc);

-- RLS: 経営者だけ
alter table public.gw_onboarding_guides       enable row level security;
alter table public.gw_onboarding_guide_issues enable row level security;
alter table public.gw_onboarding_invites      enable row level security;
alter table public.gw_mail_messages           enable row level security;

drop policy if exists gw_onboarding_guides_owner on public.gw_onboarding_guides;
create policy gw_onboarding_guides_owner on public.gw_onboarding_guides
  for all using (public.gw_is_owner(tenant_id)) with check (public.gw_is_owner(tenant_id));
drop policy if exists gw_onboarding_guide_issues_owner on public.gw_onboarding_guide_issues;
create policy gw_onboarding_guide_issues_owner on public.gw_onboarding_guide_issues
  for all using (public.gw_is_owner(tenant_id)) with check (public.gw_is_owner(tenant_id));
drop policy if exists gw_onboarding_invites_owner on public.gw_onboarding_invites;
create policy gw_onboarding_invites_owner on public.gw_onboarding_invites
  for all using (public.gw_is_owner(tenant_id)) with check (public.gw_is_owner(tenant_id));
drop policy if exists gw_mail_messages_owner on public.gw_mail_messages;
create policy gw_mail_messages_owner on public.gw_mail_messages
  for all using (public.gw_is_owner(tenant_id)) with check (public.gw_is_owner(tenant_id));

comment on table public.gw_onboarding_guides is
  '入社案内。経営者だけが作る（/keiei）。本人が確認した版を持つ。判定（段階）は持たない: lib/onboard-six.js が事実から並べる';
comment on table public.gw_onboarding_invites is
  '期限つきの案内URL。トークンは平文で持たない（sha256）。開くだけで、パスワードの代わりにはならない';
comment on table public.gw_mail_messages is
  'メールの送信履歴。本文の確定版・送信者・時刻・提供元・結果。実送信しなかったとき（未設定）は status=skipped';

commit;

notify pgrst, 'reload schema';
