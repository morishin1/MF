-- =============================================================================
-- 127: 退職証明書の本人申請（記載してほしい項目・NDA等の誓約の証跡・承認と発行）
--      2026-10-08 入退社管理画面の改修 ４
--
-- ■ 何を残すか
--   本人（退職手続き中・退職者）が、退職証明書に記載してほしい項目を選び、誓約にチェックして申請する。
--   人事が内容を確かめ、経営者・管理者が「承認して発行」すると、選んだ項目だけを印字した証明書を発行して本人に公開する。
--     items          … 本人が選んだ項目（period=使用期間／job=業務の種類／position=その事業における地位／wage=賃金／cause=退職の事由）
--                      労働基準法22条：本人が請求しない事項は記入してはならない。発行はこの items だけを印字する
--     nda_*          … 誓約の証跡。本人に見せた文面そのもの・版・同意した日時・接続元・ブラウザ（書き換えない）
--     status         … requested（申請中）→ issued（発行済み）／cancelled（取り下げ・差し戻し）
--     decided_*      … 承認して発行した人・日時。doc_id は発行した退職証明書（gw_retire_docs）
--   1人につき、申請中は1件だけ（uq_gw_retire_cert_requests_open）。発行後に、別の項目でもう一度申請できる
--
-- ■ 誰が読み書きするか
--   RLS を有効にし、ポリシーは置かない（ログインした人は直接読めない・書けない）。
--   読み書きは API（api/employees/cert-request.js・api/retiree/index.js・api/employees/retire-case.js）だけで、
--   本人の申請は本人だけ（社員 ID はサーバーがログイン中の人から引く）、承認して発行は経営者・管理者だけ。
--
-- ■ 前提
--   db/005（gw_employees）・db/121（gw_retire_docs）
--
-- ■ 流し方
--   Supabase の SQL Editor に全文を貼って Run。何度流しても同じ結果（べき等）。
--
-- ■ 確認（流したあと）
--   確認1: 表が1つ・RLS 有効・ポリシー 0
--     select c.relname, c.relrowsecurity as rls, (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
--       from pg_class c where c.relname = 'gw_retire_cert_requests';
--     → 1行、rls = true、policies = 0
--   確認2: 申請中は1人1件の一意インデックス
--     select indexname from pg_indexes where tablename = 'gw_retire_cert_requests' and indexname = 'uq_gw_retire_cert_requests_open';
--     → 1行
--
-- ■ 元に戻す（必要なときだけ。申請の記録も消える）
--   drop table if exists public.gw_retire_cert_requests;
-- =============================================================================

begin;

create table if not exists public.gw_retire_cert_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  employee_id     uuid not null references public.gw_employees(id) on delete restrict,
  items           text[] not null,
  status          text not null default 'requested' check (status in ('requested', 'issued', 'cancelled')),
  -- 誓約（NDA・就業規則に定める退職後の義務）
  nda_text        text not null,
  nda_version     text not null,
  nda_agreed_at   timestamptz not null,
  nda_ip          text,
  nda_user_agent  text,
  requested_by    uuid references auth.users(id) on delete set null,
  requested_at    timestamptz not null default now(),
  -- 承認して発行（または取り下げ・差し戻し）
  decided_by      uuid references auth.users(id) on delete set null,
  decided_by_name text,
  decided_at      timestamptz,
  decision_note   text,
  doc_id          uuid references public.gw_retire_docs(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint gw_retire_cert_requests_items check (
    cardinality(items) between 1 and 5
    and items <@ array['period', 'job', 'position', 'wage', 'cause']::text[]
  ),
  constraint gw_retire_cert_requests_nda check (length(nda_text) between 1 and 2000 and length(nda_version) between 1 and 40),
  constraint gw_retire_cert_requests_decided check ((status = 'requested') = (decided_at is null))
);

create unique index if not exists uq_gw_retire_cert_requests_open
  on public.gw_retire_cert_requests(tenant_id, employee_id) where status = 'requested';
create index if not exists idx_gw_retire_cert_requests_emp
  on public.gw_retire_cert_requests(tenant_id, employee_id, requested_at desc);

comment on table public.gw_retire_cert_requests is
  '退職証明書の本人申請（記載してほしい項目・NDA等の誓約の証跡・承認と発行）。誓約の文面・日時は書き換えない。db/127';
comment on column public.gw_retire_cert_requests.items is
  '本人が選んだ記載項目（period/job/position/wage/cause）。労働基準法22条により、発行はこの項目だけを印字する';
comment on column public.gw_retire_cert_requests.nda_text is
  '本人に見せた誓約の文面そのもの（同意の証跡。あとから文面を変えても、この行は変わらない）';

alter table public.gw_retire_cert_requests enable row level security;

commit;

notify pgrst, 'reload schema';
