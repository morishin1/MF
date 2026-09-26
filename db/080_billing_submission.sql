-- =============================================================================
-- 080: 月初業務 D1 — 外部提出フォーム（勤務表・請求書の提出/回収/進捗管理）
--
-- ■ 外部提出フォームと外部メンバーは分ける（設計方針の §32）
--   月1回、勤務表・請求書を出すだけの会社に、GWのログインは要らない。
--   「誰の、いつの分か」はURLに埋め込んだトークンで表す。
--   gw_guest_invites とは違い、毎月同じURLを使い回す（使い捨てにしない）。
--
-- ■ 既存の進捗（gw_billing_progress、db/077）へそのままつなぐ
--   提出が届いたら、対応する行の timesheet_received / bp_invoice_received を
--   立てるだけ。進捗の5段階じたいは増やさない・作り直さない。
--   請求書そのもの・PDF解析（日別合計・稼働時間・精算幅チェック）はD2で足す。
--   ここ（D1）は提出・回収・進捗一覧だけ。
--
-- ■ トークンの持ち方（gw_guest_invitesと違う理由）
--   招待は「1回使ったら終わり」。ここは毎月使う定期の窓口なので使い切りに
--   しない。平文をDBに保存せずハッシュ化して持つのは同じ
--   （lib/devices.js・lib/guests.js と同じやり方）。「必ず期限付きトークンで
--   安全に制御」の指示どおり expires_at を持たせるが、毎月の再発行を強いない
--   よう、既定は長め（アプリ側で1年）にして、いつでも管理者が再発行・無効化できる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 075_partner_bp.sql（gw_employees.employee_kind）・
--       076_site_contracts.sql・077_billing_progress.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 提出の窓口（本人1人につき1本）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_submission_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,

  token_hash    text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,

  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),

  unique (employee_id)
);

create unique index if not exists uq_gw_submission_links_token
  on public.gw_submission_links(token_hash);

comment on table public.gw_submission_links is
  '外部提出フォームの窓口。1人1本、毎月使い回す（招待と違い使い切りにしない）。'
  'token_hash はSHA-256。平文はAPIの応答にだけ、発行・再発行の直後に1度だけ入る';

-- -----------------------------------------------------------------------------
-- 2) 届いた1件（勤務表 or 請求書）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_submissions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  employee_id       uuid not null references public.gw_employees(id) on delete cascade,
  site_contract_id  uuid not null references public.gw_site_contracts(id) on delete cascade,

  target_month  text not null, -- 'YYYY-MM'
  kind          text not null check (kind in ('timesheet', 'invoice')),

  file_name     text not null,
  mime_type     text not null,
  size_bytes    integer,
  storage_path  text not null,

  submitted_at  timestamptz not null default now()
);

create index if not exists idx_gw_submissions_lookup
  on public.gw_submissions(employee_id, target_month, site_contract_id);
create index if not exists idx_gw_submissions_tenant_month
  on public.gw_submissions(tenant_id, target_month);

comment on table public.gw_submissions is
  '外部提出フォームから届いた1件。ログイン不要で届くので、送った本人の'
  'アカウントは持たない（トークンが「誰の分か」を保証する）。'
  'D1はここまで。日別集計・稼働時間・精算幅チェックはD2で見る側（画面）に足す';

-- -----------------------------------------------------------------------------
-- 3) Storage（非公開）。パスは <tenant_id>/<employee_id>/<submission_id>.<ext>
--    書き込みポリシーは置かない。公開フォーム側は誰か分からないので、
--    署名付きアップロードURLの発行・確認とも service_role（API）でだけ行う
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('billing-submissions', 'billing-submissions', false)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 4) RLS：どちらも社内スタッフだけが読める。書き込みは全部 service_role
--   （gw_site_contracts・gw_billing_progress と同じ、is_tenant_staff）
-- -----------------------------------------------------------------------------
alter table public.gw_submission_links enable row level security;
alter table public.gw_submissions      enable row level security;

drop policy if exists gw_submission_links_staff on public.gw_submission_links;
create policy gw_submission_links_staff on public.gw_submission_links
  for select using (public.is_tenant_staff(tenant_id));

drop policy if exists gw_submissions_staff on public.gw_submissions;
create policy gw_submissions_staff on public.gw_submissions
  for select using (public.is_tenant_staff(tenant_id));

notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, s.target_month, s.kind, s.file_name, s.submitted_at
--     from public.gw_submissions s
--     join public.gw_employees e on e.id = s.employee_id
--    order by s.submitted_at desc
--    limit 50;
