-- =============================================================================
-- 128: Office 定例業務の「Excel 年間予定表を最新版として同期」の履歴（いつ・どの Excel を最新版にしたか）
--
-- ■ 何をするか（足すだけ。既存の表 gw_office_recurring_tasks / gw_office_calendar_events は変えない）
--   gw_office_excel_syncs … 同期1回ごとの記録
--     期（period_start＝YYYY-MM）・ファイル名・ファイルのハッシュ・Excel の定例の行数・新規／更新／変更なし／停止／再有効化の件数・
--     状態（applying＝同期中／committed＝完了／failed＝途中で止まった）・同期した人・日時
--   同じテナントで同時に2つの同期を走らせない：同期中だけ lock_key='sync' を立て、(tenant_id, lock_key) を一意にする
--   （完了・失敗にすると lock_key を外す。NULL どうしは重ならないので、履歴は何件でも残る）
--
-- ■ 権限
--   RLS を有効にし、ポリシーは置かない（ログインした人が直接は読めない・書けない）。
--   読み書きは API（api/office-tasks/recurring.js）だけで、Office の権限とカテゴリを確かめてから service role で行う。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、定例業務の画面は今までどおり使え、
--   「最新版として同期」だけが「SQL を流してください」と出る。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: db/125_office_recurring.sql
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_office_recurring_tasks') is null then
    raise exception 'gw_office_recurring_tasks がありません。先に db/125_office_recurring.sql を流してください';
  end if;
end $$;

create table if not exists public.gw_office_excel_syncs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  period_start      text not null check (period_start ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  original_filename text check (original_filename is null or char_length(original_filename) <= 255),
  file_hash         text check (file_hash is null or char_length(file_hash) <= 128),
  total_rows        integer not null default 0 check (total_rows >= 0),
  new_count         integer not null default 0 check (new_count >= 0),
  update_count      integer not null default 0 check (update_count >= 0),
  unchanged_count   integer not null default 0 check (unchanged_count >= 0),
  stop_count        integer not null default 0 check (stop_count >= 0),
  reactivate_count  integer not null default 0 check (reactivate_count >= 0),
  status            text not null default 'applying' check (status in ('applying', 'committed', 'failed')),
  lock_key          text check (lock_key is null or lock_key = 'sync'),
  error_detail      text check (error_detail is null or char_length(error_detail) <= 1000),
  created_by        uuid references auth.users(id) on delete set null,
  created_by_name   text check (created_by_name is null or char_length(created_by_name) <= 100),
  created_at        timestamptz not null default now(),
  committed_at      timestamptz,
  -- 同期中だけ鍵を持つ。完了なら完了日時がある
  constraint gw_office_excel_syncs_lock check ((status = 'applying') = (lock_key is not null)),
  constraint gw_office_excel_syncs_done check ((status = 'committed') = (committed_at is not null))
);

-- 同じテナントで同時に2つの同期を走らせない
create unique index if not exists uq_gw_office_excel_syncs_lock
  on public.gw_office_excel_syncs(tenant_id, lock_key);
create index if not exists idx_gw_office_excel_syncs_tenant
  on public.gw_office_excel_syncs(tenant_id, created_at desc);

comment on table public.gw_office_excel_syncs is
  'Office 定例業務：Excel 年間予定表を最新版として同期した履歴（期・ファイル・件数・状態・同期した人）。同期中は lock_key で同時実行を止める。db/128';

alter table public.gw_office_excel_syncs enable row level security;
-- ポリシーは置かない（API が Office の権限を確かめてから service role で読み書きする）

notify pgrst, 'reload schema';

commit;

-- 確認1（適用後）: 表があり、RLS が有効で、ポリシーが0件（1行。rls = true・policies = 0）
--
--   select c.relname, c.relrowsecurity as rls,
--          (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relname = 'gw_office_excel_syncs';
--
-- 確認2（適用後）: 同時実行を止める一意の索引（1行）
--
--   select indexname from pg_indexes where schemaname = 'public' and indexname = 'uq_gw_office_excel_syncs_lock';
--
-- 戻す（同期の履歴だけ消える。定例業務・予定は残る）:
--   drop table if exists public.gw_office_excel_syncs;
