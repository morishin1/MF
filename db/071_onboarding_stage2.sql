-- =============================================================================
-- 071: 入社手続き 第2・第3段階
--
--   1. 社労士の「確認 → 修正 → 承認・発行」（gw_doc_orders に承認の記録）
--   2. オリエンテーション（教材の登録と、本人の「確認済み」）
--   3. 保存期限と削除（種別ごとの期限・削除の記録）
--   4. 二段階認証のリセット（管理者が外したことの記録。再登録の窓）
--
-- ■ 何を守るか
--
--   ・承認は「誰が・いつ」を行に残す。段階（stage）は事実から計算するので、
--     承認の事実が無いと ②→③ に進まない
--   ・オリエンテーションの「確認済み」は本人の行動の記録。消さない
--   ・削除の記録（gw_retention_log）は、削除そのものより長く残す。
--     何を・いつ・誰が・なぜ消したかが言えないと、消したことにならない
--   ・MFA のリセットは管理者だけ。本人が自分で外せないのは lib/mfa.js（強制日以降）
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 056 → 066 → 070
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 作成依頼に、社労士の承認・修正の記録
-- -----------------------------------------------------------------------------
alter table public.gw_doc_orders
  add column if not exists approved_by          uuid references auth.users(id) on delete set null,
  add column if not exists approved_at          timestamptz,
  add column if not exists advisor_note         text,
  add column if not exists conditions_edited_by uuid references auth.users(id) on delete set null,
  add column if not exists conditions_edited_at timestamptz;

comment on column public.gw_doc_orders.approved_at is
  '社労士が「承認・発行」を押した時刻。ここから署名依頼（gw_sign_requests）ができる';
comment on column public.gw_doc_orders.advisor_note is
  '社労士から会社への申し送り（条件を直した理由など）。本人には出さない';

-- 署名依頼の「どこから来たか」に、社労士の承認から作ったものを足す
alter table public.gw_sign_requests drop constraint if exists gw_sign_requests_source_check;
alter table public.gw_sign_requests add constraint gw_sign_requests_source_check
  check (source in ('generated', 'uploaded', 'advisor'));

-- 社労士は、労働条件の依頼だけ読める（書くのは api/sign/orders.js の service_role）
drop policy if exists gw_doc_orders_advisor_read on public.gw_doc_orders;
create policy gw_doc_orders_advisor_read on public.gw_doc_orders
  for select to authenticated
  using (doc_kind = 'employment' and public.gw_is_advisor(tenant_id));


-- -----------------------------------------------------------------------------
-- 2) オリエンテーション
--
--    教材（動画・PDF・リンク・本文）を管理者が登録し、本人が「確認済み」を押す。
--    同意書類（gw_consent_docs）と違い、版は持たない。
--    内容を直したら「確認済み」はそのまま（読み直しが要るなら、新しい項目にする）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_orientation_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  title       text not null,
  kind        text not null default 'link'
              check (kind in ('video', 'pdf', 'link', 'text')),
  url         text,
  body        text,
  description text,
  required    boolean not null default true,
  sort_order  integer not null default 100,
  active      boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_gw_orientation_items_tenant
  on public.gw_orientation_items(tenant_id, active, sort_order);

create table if not exists public.gw_orientation_checks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  employee_id  uuid not null references public.gw_employees(id) on delete cascade,
  item_id      uuid not null references public.gw_orientation_items(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  unique (employee_id, item_id)
);
create index if not exists idx_gw_orientation_checks_emp
  on public.gw_orientation_checks(employee_id);

alter table public.gw_orientation_items  enable row level security;
alter table public.gw_orientation_checks enable row level security;

drop policy if exists gw_orientation_items_read on public.gw_orientation_items;
create policy gw_orientation_items_read on public.gw_orientation_items
  for select to authenticated
  using (
    active
    or public.gw_is_hr(tenant_id)
  );

drop policy if exists gw_orientation_checks_read on public.gw_orientation_checks;
create policy gw_orientation_checks_read on public.gw_orientation_checks
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or exists (select 1 from public.gw_employees e
               where e.id = employee_id and e.user_id = auth.uid())
  );


-- -----------------------------------------------------------------------------
-- 3) 保存期限と削除
--
--    種別（履歴書・本人確認資料・口座・契約・届出）ごとに
--    「何を起点に・何か月で」を持つ。既定値はコード（lib/retention.js）。
--    行があれば上書き。auto_delete が false のうちは、期限切れを知らせるだけ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_retention_rules (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null,
  months      integer not null check (months between 1 and 240),
  auto_delete boolean not null default false,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  unique (tenant_id, kind)
);

-- 削除の記録。消したものより長く残す。削除の policy は作らない（誰も消せない）
create table if not exists public.gw_retention_log (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  subject_id  uuid,                         -- 誰のぶんか（名簿の行が消えても残す）
  subject_name text,
  kind        text not null,
  target      text not null,                -- 'file:<uuid>' / 'profile:bank' / 'sign:<uuid>'
  label       text,                         -- ファイル名など、人が読める名前
  deleted_by  uuid references auth.users(id) on delete set null,   -- null は自動（cron）
  actor_name  text,
  reason      text not null,                -- 'expired' / 'manual'
  due_on      date,
  detail      jsonb,
  deleted_at  timestamptz not null default now()
);
create index if not exists idx_gw_retention_log_tenant
  on public.gw_retention_log(tenant_id, deleted_at desc);

alter table public.gw_retention_rules enable row level security;
alter table public.gw_retention_log   enable row level security;

drop policy if exists gw_retention_rules_read on public.gw_retention_rules;
create policy gw_retention_rules_read on public.gw_retention_rules
  for select to authenticated using (public.gw_is_hr(tenant_id));

drop policy if exists gw_retention_log_read on public.gw_retention_log;
create policy gw_retention_log_read on public.gw_retention_log
  for select to authenticated using (public.gw_is_hr(tenant_id));


-- -----------------------------------------------------------------------------
-- 4) 二段階認証のリセット
--
--    強制日以降、対象の人は自分で外せない。管理者がここに1行書いて外す。
--    本人はこの窓（expires_at まで）のあいだに登録し直す
-- -----------------------------------------------------------------------------
create table if not exists public.gw_mfa_resets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null,
  employee_id uuid references public.gw_employees(id) on delete set null,
  reset_by    uuid references auth.users(id) on delete set null,
  reset_at    timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  note        text
);
create index if not exists idx_gw_mfa_resets_user
  on public.gw_mfa_resets(user_id, reset_at desc);

alter table public.gw_mfa_resets enable row level security;
drop policy if exists gw_mfa_resets_read on public.gw_mfa_resets;
create policy gw_mfa_resets_read on public.gw_mfa_resets
  for select to authenticated
  using (public.gw_is_hr(tenant_id) or user_id = auth.uid());

notify pgrst, 'reload schema';
