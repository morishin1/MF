-- =============================================================================
-- 105: Office 月次業務の土台 — 操作履歴・届いた勤務表ファイルの確認情報
--
-- ■ 何をするか
--   1) gw_office_events を新設する … Office の操作履歴（追記専用）。ドロワーの「履歴」に出す
--        「誰が・いつ・何をしたか」。勤務表の受領・AI読取・確認・確定・確定の取消し・契約条件の変更など
--   2) gw_submissions（db/080：届いた勤務表・請求書のファイル）に、確認用の列を足す
--        sha256       … ファイルの中身のハッシュ。同じファイルの二重提出・別の人／別の月への流用を見つける
--        verified_at  … 中身（形式・サイズ・ハッシュ）をサーバーで確かめた日時。空なら未確認
--        uploaded_by  … Office からアップロードした人（外部フォームからは空）
--        source       … 届いた経路（form＝外部提出フォーム／office＝Office から）
--
-- ■ 既存の gw_submissions の行は、そのまま使える
--   列は足すだけで、既存の行・既存の外部提出フォームには影響しない（source は既定で form）。
--   外部提出フォームは「行を作ってから、署名付きURLでアップロードする」順なので、
--   ファイルが実際には届いていない行もあり得る。verified_at が空の行は、
--   Office が最初に開くとき（AI読取・ファイル閲覧）にサーバーで確かめてから埋める。
--
-- ■ RLS：読み取りだけを Office 権限（gw_is_office）に絞る
--   書き込み（insert / update / delete）のポリシーは置かない。書き込みは、権限を確かめたあとの
--   API（service_role）だけが行う。ブラウザから直接書き換えて、確認の手順（要確認の日の確認済み、
--   確定の条件、履歴）を飛ばせないようにするため。
--   既存の4表（gw_site_contracts / gw_billing_progress / gw_submissions / gw_submission_links）の
--   RLS は変えない（db/100 の方針A）。
--
-- ■ 適用の順番（重要）
--   099 → 100 → この 105 → 106 → 107 → アプリのデプロイ。
--   （099・100 は本番適用済み。105〜107 は、main と他の PR が使っていない番号として採番した）
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 080_billing_submission.sql（gw_submissions）、099（gw_is_office）
-- =============================================================================

begin;

create table if not exists public.gw_office_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  billing_month     text not null,
  employee_id       uuid references public.gw_employees(id) on delete set null,
  site_contract_id  uuid references public.gw_site_contracts(id) on delete set null,
  kind              text not null
    check (kind ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$'),
  actor_id          uuid references auth.users(id) on delete set null,
  actor_name        text,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  check (billing_month ~ '^\d{4}-(0[1-9]|1[0-2])$')
);

comment on table public.gw_office_events is
  'Office の操作履歴（追記専用）。kind は timesheet.upload / timesheet.read / timesheet.save / '
  'timesheet.confirm / timesheet.reopen / timesheet.return / terms.create / terms.update / terms.delete など。'
  'detail には金額・単価・個人情報を入れない（何を・どの件数か、まで）';

create index if not exists idx_gw_office_events_month
  on public.gw_office_events(tenant_id, billing_month, created_at desc);
create index if not exists idx_gw_office_events_employee
  on public.gw_office_events(employee_id, billing_month);

alter table public.gw_submissions
  add column if not exists sha256      text,
  add column if not exists verified_at timestamptz,
  add column if not exists uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists source      text not null default 'form';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'gw_submissions_source_check' and conrelid = 'public.gw_submissions'::regclass
  ) then
    alter table public.gw_submissions
      add constraint gw_submissions_source_check check (source in ('form', 'office'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'gw_submissions_sha256_check' and conrelid = 'public.gw_submissions'::regclass
  ) then
    alter table public.gw_submissions
      add constraint gw_submissions_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

comment on column public.gw_submissions.sha256 is
  'ファイルの中身の SHA-256（小文字16進）。空＝まだ確かめていない。同じ値が複数あれば、同じファイルの再提出か流用';
comment on column public.gw_submissions.verified_at is
  '形式・サイズ・ハッシュをサーバーで確かめた日時。空＝未確認（外部フォームの行は、Office が最初に開くときに埋める）';
comment on column public.gw_submissions.source is
  'form＝外部提出フォームから／office＝Office からアップロード';

-- 同じ中身のファイルを探す（テナントの中で）
create index if not exists idx_gw_submissions_sha256
  on public.gw_submissions(tenant_id, sha256) where sha256 is not null;

alter table public.gw_office_events enable row level security;

drop policy if exists gw_office_events_office_select on public.gw_office_events;
create policy gw_office_events_office_select on public.gw_office_events
  for select using (public.gw_is_office(tenant_id));

commit;

notify pgrst, 'reload schema';

-- 確認1（適用後）: 足した列と表
--
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_submissions'
--      and column_name in ('sha256', 'verified_at', 'uploaded_by', 'source');
--   select count(*) from public.gw_office_events;
--
-- 確認2（適用後）: gw_office_events のポリシーが「読み取りだけ・Office 権限」か
--
--   select policyname, cmd, qual from pg_policies
--    where schemaname = 'public' and tablename = 'gw_office_events';
