-- =============================================================================
-- 046: 契約・電子署名
--
-- ■ 何をするものか
--   会社が契約書を作って本人に送り、本人が画面で内容を読んで署名する。
--   紙に印刷して、押印して、スキャンして、送り返す、をやめる。
--
-- ■ 外部サービスは使わない（いまは）
--   クラウドサインのような立会人型のサービスは使わず、mf の中で完結させる。
--   そのぶん、何を根拠に「本人が同意した」と言えるのかを、
--   自分たちで残しておく必要がある。残すのは次の3つ。
--
--     1. 文書そのもの   … 送った時点のPDFと、そのSHA-256
--     2. 誰が・いつ・どこから … ログイン中の社員、日時、IP、ブラウザ
--     3. 何に同意したか … 画面に出した文言をそのまま
--
--   これで「この人が、この文面に、この時刻に同意した」までは言える。
--   本人確認の強さは、mf のログイン（メール＋パスワード）と同じ。
--   認定認証業務による電子署名ではないので、PDFにもそう書いてある。
--
-- ■ 送った時点の文面を必ず残す
--   雛形（gw_sign_templates）は後から直せる。直したあとに
--   「あのとき何に署名したのか」を雛形から復元することはできない。
--   だから依頼の行に、差し込み済みの本文（body_snapshot）を丸ごと持つ。
--   雛形を消しても、署名済みの契約書は読める。
--
-- ■ 署名後は変えない
--   status が signed になった依頼は、API が一切の更新を受け付けない。
--   PDFも上書きしない（署名前と署名済みを別のパスに置く）。
--
-- ■ 「期限切れ」は状態として持たない
--   持つと、日付が来た瞬間に誰かが書き換える仕組みが要る。
--   期限を過ぎた未署名は、due_on と今日を比べれば分かる。
--   毎晩バッチを回して状態を書き換えるより、見るときに数えるほうが確か。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 契約書の雛形
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sign_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  name        text not null,               -- 「労働条件通知書 兼 雇用契約書」
  doc_kind    text not null default 'other'
              check (doc_kind in ('employment', 'pledge', 'equipment', 'training', 'other')),

  -- 本文。{{氏名}} などの差し込みを含む。差し込みの一覧は lib/esign.js
  body        text not null default '',
  note        text,                        -- 社内向けの補足（本人には出さない）

  -- 本文を直すたびに1つ増える。署名済みの依頼は、そのときの版を控えている
  version     integer not null default 1,

  -- 期限の既定値（送るときに変えられる）
  due_days    integer not null default 7,

  active      boolean not null default true,

  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_sign_templates_tenant
  on public.gw_sign_templates(tenant_id, doc_kind, name);


-- -----------------------------------------------------------------------------
-- 2) 署名依頼（1件＝1人ぶんの契約書）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sign_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- 雛形は消えることがある。消えても契約書は残す
  template_id uuid references public.gw_sign_templates(id) on delete set null,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  title       text not null,
  doc_kind    text not null default 'other',
  doc_version integer,                      -- 送った時点の雛形の版

  -- 送った時点の本文。差し込み済み。これが契約書の中身そのもの
  body_snapshot text not null,
  -- 差し込みに使った値。あとから「何が入っていたか」を追えるように
  merged_fields jsonb not null default '{}'::jsonb,

  status      text not null default 'sent'
              check (status in ('sent', 'signed', 'cancelled')),
  due_on      date,

  -- 署名前のPDF。hr バケットの中のパス
  pdf_path    text,
  pdf_sha256  text,

  -- 署名済みのPDF。署名前のPDFに「電子署名記録」のページを足したもの
  signed_pdf_path   text,
  signed_pdf_sha256 text,

  -- ---- 署名したときの記録 ----
  signed_at    timestamptz,
  signer_name  text,                        -- 本人が入力した氏名
  signer_email text,                        -- 署名時点の登録メール
  signer_ip    text,
  signer_ua    text,
  agreed_text  text,                        -- 画面に出した同意の文言をそのまま

  sent_at     timestamptz not null default now(),
  sent_by     uuid references auth.users(id) on delete set null,
  resent_at   timestamptz,
  resent_count integer not null default 0,
  first_viewed_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_sign_requests_emp
  on public.gw_sign_requests(employee_id, status, due_on);
create index if not exists idx_gw_sign_requests_tenant
  on public.gw_sign_requests(tenant_id, status, sent_at desc);

comment on column public.gw_sign_requests.body_snapshot is
  '送った時点の本文（差し込み済み）。雛形を直しても、署名済みの契約書は変わらない';
comment on column public.gw_sign_requests.pdf_sha256 is
  '署名前PDFのSHA-256。署名済みPDFの「電子署名記録」に印字される値と同じ';


-- -----------------------------------------------------------------------------
-- 3) 監査ログ（追記のみ）
--
--    誰が・いつ・何をしたか。開いただけでも残す。
--    「送っていない」「見ていない」の言い合いになったときに、
--    これしか手がかりが無い
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sign_events (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  request_id  uuid references public.gw_sign_requests(id) on delete cascade,

  action      text not null
              check (action in ('created', 'sent', 'viewed', 'signed',
                                'resent', 'cancelled', 'downloaded')),
  actor_id    uuid references auth.users(id) on delete set null,
  actor_name  text,
  ip          text,
  user_agent  text,
  detail      jsonb,
  at          timestamptz not null default now()
);

create index if not exists idx_gw_sign_events_req
  on public.gw_sign_events(request_id, at desc);


-- -----------------------------------------------------------------------------
-- 4) RLS
--
--    雛形と監査ログ … 人事・管理者だけ
--    依頼           … 人事・管理者は全件、本人は自分の分
--
--    書き込みは api/sign/*（service_role）だけ。
--    本人に update を許すと、列を絞れないので status や本文まで
--    書き換えられてしまう（RLS は行しか絞れない）
-- -----------------------------------------------------------------------------
alter table public.gw_sign_templates enable row level security;
alter table public.gw_sign_requests  enable row level security;
alter table public.gw_sign_events    enable row level security;

drop policy if exists gw_sign_templates_read on public.gw_sign_templates;
create policy gw_sign_templates_read on public.gw_sign_templates
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

drop policy if exists gw_sign_requests_read on public.gw_sign_requests;
create policy gw_sign_requests_read on public.gw_sign_requests
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_sign_events_read on public.gw_sign_events;
create policy gw_sign_events_read on public.gw_sign_events
  for select to authenticated
  using (public.gw_is_hr(tenant_id));


notify pgrst, 'reload schema';

-- 確認:
--   select status, count(*) from public.gw_sign_requests group by 1;
--
--   -- 期限を過ぎた未署名
--   select e.display_name, r.title, r.due_on
--     from public.gw_sign_requests r
--     join public.gw_employees e on e.id = r.employee_id
--    where r.status = 'sent' and r.due_on < current_date
--    order by r.due_on;
