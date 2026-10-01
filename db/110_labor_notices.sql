-- =============================================================================
-- 110: 労働条件通知書（会社がPDFを渡し、本人が閲覧して「確認しました」を押す）
--
-- ■ 何をするものか
--   入社予定者に、労働条件通知書のPDFを「見せて、確認してもらう」。電子署名ではない。
--   本人が内容を確認した事実（誰が・いつ・どの版を）だけを残す。
--
-- ■ 1行＝1版
--   差し替えは、行を書き換えず、新しい版（version+1）を足す。古い版は消さない（履歴として残る）。
--   本人に見せるのは「公開済みの、いちばん新しい版」だけ。確認（confirmed_at）はその版に付く。
--   新しい版を公開すると、その版は未確認から始まる。
--   ファイルの実体は、非公開バケット hr の <tenant>/labor-notice/<employee>/<uuid>.pdf（版ごとに別のファイル）。
--   署名付きURLは、見るときに API が数分だけ作る。このテーブルにも、監査ログにも、URLは残さない。
--
-- ■ 守る仕組み（トリガ）
--   版の中身（ファイルの場所・名前・ハッシュ・版番号・アップロードした人と日時）は、あとから書き換えられない。
--   公開した日時・確認した日時は、一度入ったら、書き換えも消去もできない（確認は1回だけ）。
--   公開していない版は、確認できない。service_role（API）からでも同じ。
--
-- ■ 電子署名との関係
--   gw_sign_requests（電子署名）は、この表とは別。ここで確認しても、署名依頼の status は変わらない。
--
-- ■ 見られる人（給与・個人情報を含む書類なので、owner と hr だけ）
--   DB から直接読めるのは、owner ロール・hr ロールを持つ人だけ（gw_has_role(tenant_id, 'owner') or 'hr'）。書き込みの方針は無い。
--   gw_is_hr は使わない。gw_is_hr は、会計側の管理者（admin / staff）も含む定義（db/041）で、広すぎる。
--   管理者・経理（finance）・責任者（manager）・採用担当（recruiter）・営業（sales）・社労士は、読めない。
--   本人は、API（service_role）を通して、自分の「公開済みの最新版」だけを見る。
--   API（api/onboarding/notice.js）も、同じ条件（lib/labor-notice.js canManageNotice）。
--
-- ■ 前提
--   tenants・gw_employees・gw_role_grants・gw_has_role（005）。
--   新しい表だけを作る。既存の表・列・ポリシーは変えない（流しても、いまの動きは変わらない）。
--   すでに前の版（gw_is_hr で読める）を流してしまっているときも、このファイルをもう一度流せば、
--   ポリシー gw_labor_notices_read が owner / hr だけのものに置き換わる（べき等）。
--
-- ■ 適用の順序
--   ① db/check_labor_notice.sql（読み取り専用）で、前提を確かめる
--   ② この SQL を流す（べき等）
--   ③ 下の「B. 確認」が通ること
--   ④ アプリを再デプロイ（表が無いあいだは、画面は「データ未連携」と出し、止まらない）
--
-- ■ A. 元に戻す（必要なときだけ。版・確認の記録が消える）
--     drop table if exists public.gw_labor_notices;
--     drop function if exists public.gw_labor_notices_guard();
--
-- ■ B. 確認
--     select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'gw_labor_notices';
--     -- → 1行、rowsecurity = true
--     select policyname, cmd from pg_policies where tablename = 'gw_labor_notices';
--     -- → 1行（gw_labor_notices_read・select）
--     select tgname from pg_trigger where tgrelid = 'public.gw_labor_notices'::regclass and not tgisinternal;
--     -- → gw_labor_notices_guard_trg
-- =============================================================================

begin;

create table if not exists public.gw_labor_notices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,
  version       int  not null check (version >= 1),

  -- ファイル（版ごとに別。上書きしない）
  storage_path  text not null,        -- hr バケット内: <tenant>/labor-notice/<employee>/<uuid>.pdf
  filename      text not null,
  size_bytes    int,
  sha256        text,

  uploaded_by   uuid references auth.users(id) on delete set null,
  uploaded_at   timestamptz not null default now(),

  -- 公開（null = 下書き。本人には見えない）
  published_by  uuid references auth.users(id) on delete set null,
  published_at  timestamptz,

  -- 本人の確認（公開した版にだけ付く）
  confirmed_by  uuid references auth.users(id) on delete set null,
  confirmed_at  timestamptz,

  unique (employee_id, version),
  constraint gw_labor_notices_confirm_needs_publish check (confirmed_at is null or published_at is not null)
);

create index if not exists idx_gw_labor_notices_tenant_employee
  on public.gw_labor_notices(tenant_id, employee_id);

-- 版の中身は書き換えない。公開・確認は一度きり。
-- （uploaded_by・published_by・confirmed_by は、ユーザーの削除で null になる（on delete set null）。null への変化だけは通す）
create or replace function public.gw_labor_notices_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.id            is distinct from old.id
       or new.tenant_id    is distinct from old.tenant_id
       or new.employee_id  is distinct from old.employee_id
       or new.version      is distinct from old.version
       or new.storage_path is distinct from old.storage_path
       or new.filename     is distinct from old.filename
       or new.size_bytes   is distinct from old.size_bytes
       or new.sha256       is distinct from old.sha256
       or new.uploaded_at  is distinct from old.uploaded_at
       or (new.uploaded_by is distinct from old.uploaded_by and new.uploaded_by is not null) then
      raise exception 'gw_labor_notices: 版の中身は変えられません（差し替えは、新しい版を足します）';
    end if;
    if old.published_at is not null
       and (new.published_at is distinct from old.published_at
            or (new.published_by is distinct from old.published_by and new.published_by is not null)) then
      raise exception 'gw_labor_notices: 公開した日時は変えられません';
    end if;
    if old.confirmed_at is not null
       and (new.confirmed_at is distinct from old.confirmed_at
            or (new.confirmed_by is distinct from old.confirmed_by and new.confirmed_by is not null)) then
      raise exception 'gw_labor_notices: 確認した日時は変えられません（確認は1回だけです）';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists gw_labor_notices_guard_trg on public.gw_labor_notices;
create trigger gw_labor_notices_guard_trg
  before update on public.gw_labor_notices
  for each row execute function public.gw_labor_notices_guard();

-- RLS: DB から直接読めるのは owner・hr ロールの人だけ。書き込みの方針は置かない（API の service_role だけ）。
--   gw_is_hr は、会計側の管理者（is_tenant_staff）を含むので使わない
alter table public.gw_labor_notices enable row level security;

drop policy if exists gw_labor_notices_read on public.gw_labor_notices;
create policy gw_labor_notices_read on public.gw_labor_notices
  for select to authenticated
  using (
    public.gw_has_role(tenant_id, 'owner')
    or public.gw_has_role(tenant_id, 'hr')
  );

comment on table public.gw_labor_notices is
  '労働条件通知書。1行＝1版。差し替えは新しい版を足す（旧版は消さない）。本人の確認（confirmed_at）はその版に付く。電子署名（gw_sign_requests）とは別';
comment on column public.gw_labor_notices.storage_path is
  '非公開バケット hr の中のパス。署名付きURLは見るときに作り、DB・監査ログには残さない';

commit;

notify pgrst, 'reload schema';
