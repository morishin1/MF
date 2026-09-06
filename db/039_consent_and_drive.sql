-- =============================================================================
-- 039: 電子同意（版付きの書類）／提出書類の Drive 自動整理
--
-- ■ 電子同意
--   誓約書・個人情報の取扱い・社内ルール確認書を、紙の署名ではなく
--   画面の「読みました。内容に同意します」で確認してもらう。
--
--   氏名・日付・手書きサインの欄は無くした。
--   誰が同意したかはログインしているアカウントで分かるし、
--   いつ同意したかはシステムが記録する。
--
--   書類には版を持たせる。内容を直したら版を上げ、
--   「誰がどの版にいつ同意したか」は版ごとに残す（同意の行は消さない）。
--   重要な改定（major）は、全員に読み直して再同意してもらう。
--
--   同意した時点の全文を、同意の行に写しておく（body_snapshot）。
--   書類のほうを後から直しても、本人が何に同意したかは変わらない。
--
--   労働条件通知書・雇用契約は、ここには入れない。
--   あれは合意して決めるもので、「読みました」で済ませてよいものではない。
--
-- ■ 提出書類
--   本人は mf の画面で 雛形をダウンロード → 記入 → アップロード だけ。
--   Drive のどこに置くか、名前をどう付けるかは、こちらが決める。
--
--   個人フォルダは5つに分ける（01_採用・履歴書 〜 05_その他）。
--   社労士に共有するのは 04_社会保険・労務 だけ。
--   マイナンバー確認書類は個人フォルダの外（機微情報）に置き、
--   個人フォルダを共有しても付いてこないようにする。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 同意してもらう書類（版付き）
--    本文は lib/consent-docs.js が正で、起動時にここへ写す。
--    この表は「本人が全文を読める」「同意時の版を引ける」ためにある。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_consent_docs (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  doc_key   text not null,              -- pledge / privacy / rules
  title     text not null,              -- 誓約書
  subtitle  text,                       -- 機密情報・個人情報・成果物の取扱いに関する確認
  summary   text,                       -- カードに出す1行
  body      text not null,              -- 全文（電子確認の説明まで含む）
  version   text not null,              -- 1.0
  -- 重要な改定か。true なら、前の版に同意していた人にも読み直してもらう
  major     boolean not null default true,

  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),

  unique (tenant_id, doc_key, version)
);

create index if not exists idx_gw_consent_docs_active
  on public.gw_consent_docs(tenant_id, doc_key)
  where status = 'active';


-- -----------------------------------------------------------------------------
-- 2) 同意の記録に、残すべきものを足す
--    037 で作った表に列を足す。(employee_id, kind, version) の一意はそのまま
-- -----------------------------------------------------------------------------
alter table public.gw_onboard_consents add column if not exists doc_id        uuid references public.gw_consent_docs(id) on delete set null;
alter table public.gw_onboard_consents add column if not exists doc_title     text;
alter table public.gw_onboard_consents add column if not exists display_name  text;
-- 同意した時点の全文。書類を後から直しても、何に同意したかは変わらない
alter table public.gw_onboard_consents add column if not exists body_snapshot text;
alter table public.gw_onboard_consents add column if not exists ip            text;
alter table public.gw_onboard_consents add column if not exists user_agent    text;

comment on column public.gw_onboard_consents.body_snapshot is
  '同意した時点の全文。書類側を後から直しても、本人が何に同意したかはここで分かる';


-- -----------------------------------------------------------------------------
-- 3) 個人フォルダの構成を覚える
--    ルート（drive_folder_id）はもうある。その下の5つと、機微情報の置き場所
-- -----------------------------------------------------------------------------
alter table public.gw_procedures add column if not exists drive_folders jsonb;
alter table public.gw_procedures add column if not exists drive_sensitive_folder_id text;
-- 社労士に 04 を共有した記録。誰に・いつ
alter table public.gw_procedures add column if not exists advisor_shared_to text;
alter table public.gw_procedures add column if not exists advisor_shared_at timestamptz;

comment on column public.gw_procedures.drive_folders is
  '個人フォルダの下の5つ。{"01": folderId, ..., "05": folderId}';
comment on column public.gw_procedures.drive_sensitive_folder_id is
  'マイナンバー等の置き場所。個人フォルダの外（人事ルート/機微情報/年/氏名）';


-- -----------------------------------------------------------------------------
-- 4) 提出の記録
-- -----------------------------------------------------------------------------
alter table public.gw_procedure_items add column if not exists submitted_at timestamptz;
alter table public.gw_procedure_files add column if not exists drive_folder_key text;
alter table public.gw_procedure_files add column if not exists drive_name text;

comment on column public.gw_procedure_files.drive_folder_key is
  '01〜05、または sensitive。どこに置いたか';
comment on column public.gw_procedure_files.drive_name is
  'Drive 上の名前。YYYYMMDD_書類名_氏名.拡張子';


-- -----------------------------------------------------------------------------
-- 5) RLS
--    書類の全文は社内の誰でも読める（同意する前に読むものなので）。
--    書き込みは service_role の API だけ
-- -----------------------------------------------------------------------------
alter table public.gw_consent_docs enable row level security;

drop policy if exists gw_consent_docs_select on public.gw_consent_docs;
create policy gw_consent_docs_select on public.gw_consent_docs
  for select to authenticated
  using (public.gw_is_internal_staff());


notify pgrst, 'reload schema';

-- 確認:
--   -- 書類の版
--   select doc_key, version, major, status, left(body, 40)
--     from public.gw_consent_docs order by doc_key, version;
--
--   -- 誰がどの版にいつ同意したか
--   select display_name, doc_title, version, agreed_at
--     from public.gw_onboard_consents order by agreed_at desc;
--
--   -- 個人フォルダの構成
--   select e.display_name, p.drive_link, p.drive_folders, p.drive_sensitive_folder_id is not null as 機微
--     from public.gw_procedures p join public.gw_employees e on e.id = p.employee_id
--    where p.kind = 'onboarding';
