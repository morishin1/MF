-- =============================================================================
-- 056: 書類の作成依頼（社労士に頼む → 届いた書面に、そのまま署名依頼）
--
-- ■ 何を解いているか
--   労働条件通知書は、社労士が作る。いまは
--     メールで条件を送る → PDFが返ってくる → どこかに置く →
--     電子署名の画面で宛先を打ち直す
--   と、人が4回つなぎ直している。つなぎ目ごとに
--   「誰あての書面か」が人の記憶になっていて、取り違えが起きる。
--
--   だから最初に「誰あてか」を決めてから頼む。
--   届いたPDFはその行にぶら下がるので、あとから紐づけ直す作業が要らない。
--   送るときも、宛先はもう決まっている（1クリック）。
--
-- ■ 046 の署名は「本文から作ったPDF」だけだった
--   雛形に差し込んで、こちらでPDFを作る形。社労士が作った書面は載せられない。
--   gw_sign_requests に source を足して、
--     generated … 雛形から作った（046 までと同じ）
--     uploaded  … 受け取ったPDFをそのまま送った
--   の2つを持てるようにする。署名の記録の残し方は、どちらも同じ。
--   （lib/pdf-jp.js の appendSignaturePage は、どのPDFにも足せる）
--
-- ■ 依頼の行と、署名依頼の行は分ける
--   依頼は書き換わる（条件を直す、PDFを差し替える）。
--   署名依頼は、送った瞬間に固まって二度と変わらない。
--   同じ行にすると、署名済みの隣で条件が書き換わることになる。
--
-- ■ 本人には、署名依頼を送るまで見せない
--   「確認待ち」で本人の画面に先に出すと、会社が中身を確かめる前の版を
--   読まれてしまう。社労士から届いた時点では、まだ会社の中の書類。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 046_esign.sql を先に流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 作成依頼
-- -----------------------------------------------------------------------------
create table if not exists public.gw_doc_orders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- 誰あての書面か。最初に決める。ここが空のまま進めない
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  doc_kind    text not null default 'employment'
              check (doc_kind in ('employment', 'pledge', 'equipment', 'training', 'other')),
  title       text not null,

  -- 誰に頼んだか。メールはここから送らない（記録として持つだけ）
  assignee_name  text,
  assignee_email text,

  -- 提示した条件。あとから「何を頼んだか」を追えるように、そのまま持つ
  conditions  jsonb not null default '{}'::jsonb,
  note        text,

  status      text not null default 'requested'
              check (status in ('requested', 'uploaded', 'sent', 'signed', 'cancelled')),
  -- 社労士に「いつまでに」。署名の期限ではない
  due_on      date,

  -- 届いた書面。hr バケットの中のパス
  file_path   text,
  file_name   text,
  file_sha256 text,
  file_size   integer,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_at timestamptz,

  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gw_doc_orders_tenant
  on public.gw_doc_orders(tenant_id, status, requested_at desc);
create index if not exists idx_gw_doc_orders_emp
  on public.gw_doc_orders(employee_id, status);

comment on table public.gw_doc_orders is
  '社労士などに書面の作成を頼んだ記録。届いたPDFがぶら下がり、'
  'そのまま署名依頼（gw_sign_requests）に渡せる';
comment on column public.gw_doc_orders.conditions is
  '依頼のときに伝えた条件。雇用区分・期間・就業場所・賃金など。'
  '文字列の入れ物で、システムは中身を解釈しない';


-- -----------------------------------------------------------------------------
-- 2) 署名依頼に「どこから来たか」を足す
--
--    既にある行は generated（雛形から作ったもの）。既定値でそう入る
-- -----------------------------------------------------------------------------
alter table public.gw_sign_requests
  add column if not exists source text not null default 'generated';

alter table public.gw_sign_requests drop constraint if exists gw_sign_requests_source_check;
alter table public.gw_sign_requests add constraint gw_sign_requests_source_check
  check (source in ('generated', 'uploaded'));

-- 受け取ったPDFの、元のファイル名。画面に出す
alter table public.gw_sign_requests
  add column if not exists file_name text;

alter table public.gw_sign_requests
  add column if not exists order_id uuid references public.gw_doc_orders(id) on delete set null;

create index if not exists idx_gw_sign_requests_order
  on public.gw_sign_requests(order_id);

comment on column public.gw_sign_requests.source is
  'generated … 雛形に差し込んでこちらで作ったPDF / '
  'uploaded … 社労士などから受け取ったPDFをそのまま送った';


-- -----------------------------------------------------------------------------
-- 3) 依頼から、送った署名依頼へ
--
--    2) のあとに足す。先に足すと、まだ無い列を参照することになる
-- -----------------------------------------------------------------------------
alter table public.gw_doc_orders
  add column if not exists sign_request_id uuid
  references public.gw_sign_requests(id) on delete set null;


-- -----------------------------------------------------------------------------
-- 4) RLS
--
--    人事・管理者だけ。本人には出さない（署名依頼を送れば contracts.html に出る）。
--    書き込みは api/sign/orders.js（service_role）だけ
-- -----------------------------------------------------------------------------
alter table public.gw_doc_orders enable row level security;

drop policy if exists gw_doc_orders_read on public.gw_doc_orders;
create policy gw_doc_orders_read on public.gw_doc_orders
  for select to authenticated
  using (public.gw_is_hr(tenant_id));


notify pgrst, 'reload schema';

-- 確認:
--   select status, count(*) from public.gw_doc_orders group by 1;
--
--   -- 届いたのに、まだ署名依頼を出していないもの
--   select e.display_name, o.title, o.uploaded_at
--     from public.gw_doc_orders o
--     join public.gw_employees e on e.id = o.employee_id
--    where o.status = 'uploaded'
--    order by o.uploaded_at;
