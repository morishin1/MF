-- =============================================================================
-- 121_retire_docs.sql — 退職手続き（退職理由）と退職書類（退職証明書・源泉徴収票・離職票・資格喪失証明書）
--
-- ■ 何のためか
--   退職（left）した本人が、退職者ポータル（/retiree/）で、自分の書類だけを見る・保存するため。
--   管理側（メンバー管理の「退職手続き」）は、同じ表を見て進み具合を出す。
--
-- ■ 2つの表
--   gw_retire_cases … 退職手続き（社員1人に1行）。退職理由を構造化して持つ（reason_code / reason_note）。
--                     退職理由は社員名簿ではなくこちら。退職証明書へは、発行のたびに「含める／含めない」を選ぶ
--                     （自動では印字しない）
--   gw_retire_docs  … 退職書類。1行＝1つの版。発行済みの版は上書きせず、再発行は新しい版（古い版は superseded で残す）
--                     state: processing（手続き中。ファイル無し）／draft（下書き）／issued（発行済み）／superseded（置き換え済み）
--                     published = 本人に公開しているか。公開は発行済みの版だけ。本人は、公開中の最新の版だけ見られる
--
-- ■ 権限・RLS
--   どちらも RLS を有効にして、読めるのは人事（gw_is_hr）だけ。書き込みのポリシーは作らない（サーバー＝service_role だけが書く）。
--   退職者本人は、この表を直接読めない。サーバー（api/retiree/*）が、ログイン中の本人の社員 ID を自分で引いて、
--   公開中の最新の版だけを返す（リクエストの値は信用しない）。
--
-- ■ 既存データへの影響
--   なし（新しい表だけ。既存の表・列・行は変えない）。社員を削除しようとして、この表に行があれば外部キーが止める
--   （on delete restrict。退職書類を黙って消さない。api/employees の「記録が残っています」の案内が出る）
--
-- ■ 実行方法
--   1. このファイルを Supabase の SQL Editor に貼って Run（べき等）
--   2. db/check_retire_docs.sql を流して、合格条件を確認する（読み取りだけ）
--   やり直し: db/rollback_121_retire_docs.sql（表ごと消える。行がある場合は消える前に確認してください）
--
-- ■ 前提: db/005（gw_employees・gw_is_hr）・db/120_left_gate.sql が適用済み
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_employees') is null then
    raise exception 'gw_employees がありません。先に db/005_groupware_core.sql を流してください';
  end if;
  if to_regprocedure('public.gw_is_hr(uuid)') is null then
    raise exception 'gw_is_hr がありません。先に db/005_groupware_core.sql を流してください';
  end if;
end $$;

-- 1) 退職手続き（社員1人に1行）
create table if not exists public.gw_retire_cases (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete restrict,
  -- 退職理由（構造化）。コードは lib/retire.js の REASONS と同じ
  reason_code   text check (reason_code in ('contract_end', 'personal', 'company', 'retirement_age', 'other')),
  reason_note   text,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (employee_id)
);

create index if not exists idx_gw_retire_cases_tenant on public.gw_retire_cases(tenant_id);

-- 2) 退職書類（1行＝1つの版）
create table if not exists public.gw_retire_docs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete restrict,
  -- certificate=退職証明書 / withholding=源泉徴収票 / separation=離職票 / insurance_loss=健康保険 資格喪失証明書
  kind          text not null check (kind in ('certificate', 'withholding', 'separation', 'insurance_loss')),
  version       integer not null default 1,
  state         text not null check (state in ('processing', 'draft', 'issued', 'superseded')),
  expected_on   date,                  -- 発行予定日（processing のとき、本人に「発行予定」として見せる）
  note          text,                  -- 社内向けのメモ（本人には出さない）
  -- 発行（issued）
  issued_no     text,                  -- 発行番号。退職証明書は RET-2026-0012 の形
  issued_on     date,
  issued_by     uuid references auth.users(id) on delete set null,
  storage_path  text,                  -- private バケット hr の中のパス（公開URLは作らない）
  file_name     text,
  file_size     integer,
  sha256        text,
  include_reason boolean not null default false,   -- 退職証明書に退職理由を含めたか（発行のたびに選ぶ）
  body_snapshot text,                  -- 退職証明書：発行時の本文（差し込み後）
  -- 本人への公開
  published     boolean not null default false,
  published_at  timestamptz,
  published_by  uuid references auth.users(id) on delete set null,
  revoked_at    timestamptz,           -- 公開を止めた日時（最後の1回）
  revoked_by    uuid references auth.users(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (employee_id, kind, version),
  -- 発行済みなら、実体と発行日が要る
  constraint gw_retire_docs_issued_needs_file
    check (state <> 'issued' or (storage_path is not null and issued_on is not null)),
  -- 公開できるのは発行済みの版だけ
  constraint gw_retire_docs_publish_only_issued
    check (not published or state = 'issued')
);

-- 発行番号は会社の中で重ならない（退職証明書。NULL は何行あってもよい）
create unique index if not exists uq_gw_retire_docs_issued_no
  on public.gw_retire_docs(tenant_id, issued_no) where issued_no is not null;

-- 1人・1種類につき、「いま有効な行」（置き換え済み以外）は1つだけ
create unique index if not exists uq_gw_retire_docs_live
  on public.gw_retire_docs(employee_id, kind) where state <> 'superseded';

create index if not exists idx_gw_retire_docs_emp on public.gw_retire_docs(employee_id, kind, version desc);
create index if not exists idx_gw_retire_docs_tenant on public.gw_retire_docs(tenant_id, state);

comment on table public.gw_retire_cases is '退職手続き（社員1人に1行）。退職理由を構造化して持つ。db/121';
comment on table public.gw_retire_docs is
  '退職書類（1行＝1つの版）。発行済みは上書きせず、再発行は新しい版。本人は公開中の最新の版だけ、サーバー経由で見る。db/121';

-- 3) RLS：読めるのは人事だけ。書き込みのポリシーは作らない（サーバー＝service_role だけが書く）
alter table public.gw_retire_cases enable row level security;
alter table public.gw_retire_docs  enable row level security;

drop policy if exists gw_retire_cases_select on public.gw_retire_cases;
create policy gw_retire_cases_select on public.gw_retire_cases
  for select using (public.gw_is_hr(tenant_id));

drop policy if exists gw_retire_docs_select on public.gw_retire_docs;
create policy gw_retire_docs_select on public.gw_retire_docs
  for select using (public.gw_is_hr(tenant_id));

notify pgrst, 'reload schema';

commit;
