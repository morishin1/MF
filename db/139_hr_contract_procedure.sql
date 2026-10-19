-- =============================================================================
-- 139: 採用HR 契約手続き（社労士への作成依頼・正式PDFの受領と承認・版の照合・締結の証跡）
--
-- ■ 運用の正本（docs/hr-contract-procedure.md）
--   採用条件をHRで登録 → 社労士へ正式な通知書の作成を依頼（依頼文はHRが作り、人がコピーしてSlackで送る）
--   → 社労士がPDFを返送 → HRがアップロードし、権限者がHRの条件と照合して承認（版・SHA-256・ロック）
--   → 同じ確定版PDFを本人へ案内し、LegalSign にも同じPDFを登録 → 本人がHRで条件に同意
--   → LegalSign で署名・締結（担当者が証跡を確かめて記録）→ 担当者が Office へ引き渡す
--
-- ■ 作るもの（新しい表2つ＋gw_hr_offers への列の追加。既存の列・トリガー関数は変えない）
--   1) gw_hr_attorney_requests      … 社労士へ「依頼済み」と担当者が記録したこと（押したときだけ。コピーでは記録しない）。追記だけ
--   2) gw_hr_offer_official_docs    … 社労士が作った正式PDFの受領記録（1行＝1つの版）。中身・ハッシュは不変。承認／差し戻しは一度だけ
--   3) gw_hr_offers の列
--        doc_route            'official'＝社労士の正式PDFで本人へ案内する／'generated'＝これまでどおりHRが作るPDF
--        contract_route       'legalsign'＝LegalSign で正式契約／'other'＝例外ルート（紙・対面など）
--        official_doc_id      本人へ案内した正式PDF（gw_hr_offer_official_docs.id）。案内した時点で固定
--        legalsign_doc_id・legalsign_doc_sha256  LegalSign に登録した版（担当者が「同じPDF」と確認した版）
--        formal_evidence・formal_contract_ref・formal_doc_sha256  締結を確かめた証跡・LegalSign の文書ID・締結した版
--
-- ■ 本人へ案内した正式PDFは、既存の notice_title・notice_pdf_path・notice_pdf_sha256 にそのまま入れる
--   （db/132 のトリガーで不変。本人の画面・承諾の記録・承諾済みPDF・Office の閲覧は、この版をそのまま使う）。
--   HR が作る条件通知書PDFは「社労士へ依頼するときの条件案」になり、本人へは送らない（送付ルートを二重にしない）。
--
-- ■ 安全装置（API の確かめに加えて DB でも止める）
--   ・正式PDFで案内する版（doc_route='official'）は、正式PDFを固定しないと送付済みにできない
--   ・LegalSign に登録した版・締結を確かめた版は、本人へ案内した版と同じハッシュでなければ入らない
--   ・正式PDFの版は、本人へ案内したら差し替え（superseded）にできない
--   ・正式PDFの記録の中身（パス・ハッシュ・受領日・作成者）は変えられない。承認・差し戻しは一度だけ
--   ・条件同意（accepted_at）と正式契約（formal_signed_at）は別の事実。正式PDFで案内した版は、
--     本人がHRで同意する前に LegalSign で締結した場合も締結を記録できる（Office への引き渡しは両方そろってから＝db/133）
--
-- ■ 既存のオファーは変えない
--   doc_route は空のまま（アプリは「送っていない・区分つき・育成枠以外」の版だけを正式PDFの流れとして扱う）。
--   古いアプリ（db/139 を知らない版）は doc_route を書かないので、この SQL の制約には当たらない。
--
-- 何度流しても同じ結果になる。前提：081・129・132・133・137 が適用済み（無ければ何も変えずに止まる）。
-- 戻すとき：db/rollback_139_hr_contract_procedure.sql
-- 確認：db/check_139_hr_contract_procedure.sql（❌ が無いこと）
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0) 前提が無ければ止まる
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_hr_offers') is null or to_regclass('public.gw_hr_applicants') is null then
    raise exception 'db/139: gw_hr_offers・gw_hr_applicants がありません（先に db/081_hr_recruiting.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'offer_type') then
    raise exception 'db/139: gw_hr_offers.offer_type がありません（先に db/129_hr_offer_type.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'notice_pdf_path') then
    raise exception 'db/139: gw_hr_offers.notice_pdf_path がありません（先に db/132_hr_offer_documents.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'handoff_at') then
    raise exception 'db/139: gw_hr_offers.handoff_at がありません（先に db/133_hr_offer_handoff.sql）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'offer_pdf_path') then
    raise exception 'db/139: gw_hr_offers.offer_pdf_path がありません（先に db/137_hr_finish.sql）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_is_recruiting(uuid)') is null then
    raise exception 'db/139: gw_is_recruiting がありません（先に db/081_hr_recruiting.sql）。何も変更していません';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 社労士への依頼の記録（担当者が「依頼済み」を押したときだけ1行。追記だけ）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_attorney_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  applicant_id   uuid not null references public.gw_hr_applicants(id) on delete cascade,
  offer_id       uuid not null references public.gw_hr_offers(id) on delete cascade,
  -- initial＝最初の依頼／revision＝差し戻し・条件の修正のあとの再依頼
  kind           text not null default 'initial',
  -- 担当者の任意メモ（Slack のどのチャンネルで送ったか等）。依頼文そのもの（給与入り）は残さない
  note           text,
  -- 依頼文を作ったときに「要確認」だった項目名（未入力のまま依頼したことを後から確かめられるように）
  missing_labels text[] not null default '{}',
  requested_at   timestamptz not null default now(),
  requested_by   uuid not null references auth.users(id) on delete restrict,
  created_at     timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_attorney_requests_kind_chk') then
    alter table public.gw_hr_attorney_requests add constraint gw_hr_attorney_requests_kind_chk
      check (kind in ('initial', 'revision'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_attorney_requests_note_chk') then
    alter table public.gw_hr_attorney_requests add constraint gw_hr_attorney_requests_note_chk
      check (note is null or char_length(note) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_attorney_requests_missing_chk') then
    alter table public.gw_hr_attorney_requests add constraint gw_hr_attorney_requests_missing_chk
      check (cardinality(missing_labels) <= 40);
  end if;
end $$;

create index if not exists idx_gw_hr_attorney_requests_offer
  on public.gw_hr_attorney_requests(offer_id, requested_at desc);
create index if not exists idx_gw_hr_attorney_requests_applicant
  on public.gw_hr_attorney_requests(tenant_id, applicant_id, requested_at desc);

-- 書き換えない（記録は足すだけ）。削除は応募者の削除に伴うものだけ（cascade）
create or replace function public.gw_hr_attorney_requests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'gw_hr_attorney_requests は書き換えられません（db/139）'
    using errcode = '55000', hint = '社労士への依頼の記録は足すだけです（再依頼は新しい行）';
end $$;

comment on function public.gw_hr_attorney_requests_guard() is
  '採用HR：社労士への依頼の記録（担当者が依頼済みと記録した日時・人）を書き換えさせない（db/139）';

drop trigger if exists gw_hr_attorney_requests_guard on public.gw_hr_attorney_requests;
create trigger gw_hr_attorney_requests_guard
  before update on public.gw_hr_attorney_requests
  for each row execute function public.gw_hr_attorney_requests_guard();

-- -----------------------------------------------------------------------------
-- 2) 社労士が作った正式PDFの受領記録（1行＝1つの版）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_offer_official_docs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  applicant_id  uuid not null references public.gw_hr_applicants(id) on delete cascade,
  offer_id      uuid not null references public.gw_hr_offers(id) on delete cascade,
  -- そのオファー（条件の版）の中での受領の版（1, 2, 3 …）
  revision      integer not null,
  -- 書類の種類（雇用は 労働条件通知書／兼雇用契約書／雇用契約書、業務委託は 業務委託契約書／条件通知書）
  doc_kind      text not null,
  title         text not null,
  -- private バケット hr の中のパス・中身の SHA-256・大きさ（受け取ったときに API が計算する。変えない）
  file_path     text not null,
  file_sha256   text not null,
  file_size     integer not null,
  file_name     text,
  received_on   date not null,
  -- 作成者（社労士事務所名など）。任意
  author_name   text,
  uploaded_by   uuid not null references auth.users(id) on delete restrict,
  uploaded_at   timestamptz not null default now(),
  -- received＝確認待ち／approved＝HRの条件と照合して承認（この版で本人へ案内できる）
  -- returned＝差し戻し（社労士へ修正を依頼）／superseded＝新しい版・条件の修正で使わなくなった
  status        text not null default 'received',
  reviewed_by   uuid references auth.users(id) on delete restrict,
  reviewed_at   timestamptz,
  review_note   text,
  -- 照合の結果（項目ごとの確認。{"name":true,"joinDate":true,...}）
  checks        jsonb not null default '{}'::jsonb,
  -- 再発行（同じ条件の新しい版）へ引き継いだときの、元の受領記録
  carried_from  uuid,
  created_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_rev_uq') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_rev_uq unique (offer_id, revision);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_rev_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_rev_chk
      check (revision between 1 and 99);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_kind_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_kind_chk
      check (doc_kind in ('labor_notice', 'labor_notice_contract', 'employment_contract',
                          'contractor_contract', 'contractor_terms', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_title_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_title_chk
      check (char_length(title) between 1 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_file_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_file_chk
      check (file_sha256 ~ '^[0-9a-f]{64}$'
             and file_size between 1 and 15728640
             and char_length(file_path) between 1 and 500
             and (file_name is null or char_length(file_name) <= 200));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_author_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_author_chk
      check (author_name is null or char_length(author_name) <= 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_status_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_status_chk
      check (status in ('received', 'approved', 'returned', 'superseded'));
  end if;
  -- 承認・差し戻しには、確かめた人と日時が要る。確認待ちのあいだは空
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_review_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_review_chk
      check ((status not in ('approved', 'returned') or (reviewed_by is not null and reviewed_at is not null))
             and (status <> 'received' or (reviewed_by is null and reviewed_at is null)));
  end if;
  -- 差し戻しには理由が要る
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_return_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_return_chk
      check (status <> 'returned' or review_note is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_note_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_note_chk
      check (review_note is null or char_length(review_note) <= 1000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offer_official_docs_checks_chk') then
    alter table public.gw_hr_offer_official_docs add constraint gw_hr_offer_official_docs_checks_chk
      check (jsonb_typeof(checks) = 'object');
  end if;
end $$;

-- 1つの条件の版に、承認した正式PDFは1つだけ
create unique index if not exists uq_gw_hr_offer_official_docs_approved
  on public.gw_hr_offer_official_docs(offer_id) where status = 'approved';
create index if not exists idx_gw_hr_offer_official_docs_applicant
  on public.gw_hr_offer_official_docs(tenant_id, applicant_id, created_at desc);

-- 受け取った中身は変えない。承認・差し戻しは一度だけ。本人へ案内した版は差し替えにできない
create or replace function public.gw_hr_offer_official_docs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
begin
  foreach c in array array[
    'tenant_id', 'applicant_id', 'offer_id', 'revision', 'doc_kind', 'title', 'file_path', 'file_sha256',
    'file_size', 'file_name', 'received_on', 'author_name', 'uploaded_by', 'uploaded_at', 'carried_from', 'created_at'
  ] loop
    if (n -> c) is distinct from (o -> c) then
      raise exception 'gw_hr_offer_official_docs.% は変更できません（db/139）', c
        using errcode = '55000', hint = '受け取った正式PDFの記録は書き換えられません（直すときは新しい版をアップロード）';
    end if;
  end loop;
  if new.status is distinct from old.status then
    if not ((old.status = 'received' and new.status in ('approved', 'returned', 'superseded'))
            or (old.status = 'approved' and new.status = 'superseded')) then
      raise exception 'gw_hr_offer_official_docs.status は % から % へ変えられません（db/139）', old.status, new.status
        using errcode = '55000', hint = '確認待ち → 承認・差し戻し・差し替え、承認 → 差し替え、の向きだけです';
    end if;
    if old.status = 'approved' and exists (select 1 from public.gw_hr_offers o where o.official_doc_id = old.id) then
      raise exception 'gw_hr_offer_official_docs: 本人へ案内した正式PDFは差し替えにできません（db/139）'
        using errcode = '55000', hint = '条件を変えるときは、オファーを再発行して新しい版で進めます';
    end if;
  end if;
  foreach c in array array['reviewed_by', 'reviewed_at', 'review_note', 'checks'] loop
    if old.status <> 'received' and (n -> c) is distinct from (o -> c) then
      raise exception 'gw_hr_offer_official_docs.% は確認のあとに変更できません（db/139）', c
        using errcode = '55000', hint = '承認・差し戻しの記録は書き換えられません';
    end if;
  end loop;
  return new;
end $$;

comment on function public.gw_hr_offer_official_docs_guard() is
  '採用HR：正式PDFの受領記録の中身は不変、承認・差し戻しは一度だけ、本人へ案内した版は差し替えにさせない（db/139）';

drop trigger if exists gw_hr_offer_official_docs_guard on public.gw_hr_offer_official_docs;
create trigger gw_hr_offer_official_docs_guard
  before update on public.gw_hr_offer_official_docs
  for each row execute function public.gw_hr_offer_official_docs_guard();

-- -----------------------------------------------------------------------------
-- 3) gw_hr_offers：正式PDFの流れ・契約ルート・LegalSign に登録した版・締結の証跡
-- -----------------------------------------------------------------------------
alter table public.gw_hr_offers
  add column if not exists doc_route            text,
  add column if not exists contract_route       text,
  add column if not exists official_doc_id      uuid,
  add column if not exists legalsign_doc_id     uuid,
  add column if not exists legalsign_doc_sha256 text,
  add column if not exists formal_evidence      text,
  add column if not exists formal_contract_ref  text,
  add column if not exists formal_doc_sha256    text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_doc_route_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_doc_route_chk
      check (doc_route is null or doc_route in ('official', 'generated'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_contract_route_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_contract_route_chk
      check (contract_route is null or contract_route in ('legalsign', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_contract_text_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_contract_text_chk
      check ((formal_evidence is null or char_length(formal_evidence) between 1 and 1000)
             and (formal_contract_ref is null or char_length(formal_contract_ref) between 1 and 200)
             and (legalsign_doc_sha256 is null or legalsign_doc_sha256 ~ '^[0-9a-f]{64}$')
             and (formal_doc_sha256 is null or formal_doc_sha256 ~ '^[0-9a-f]{64}$'));
  end if;
  -- 正式PDFで案内する版は、正式PDFを固定してから送付済みにする
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_official_sent_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_official_sent_chk
      check (doc_route is distinct from 'official' or sent_at is null or official_doc_id is not null);
  end if;
  -- 固定した正式PDFは、本人に見せる通知書（notice_*）に入っている
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_official_notice_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_official_notice_chk
      check (official_doc_id is null or (notice_pdf_path is not null and notice_pdf_sha256 is not null));
  end if;
  -- LegalSign に登録した版・締結を確かめた版は、本人へ案内した版と同じ
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_legalsign_doc_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_legalsign_doc_chk
      check (legalsign_doc_sha256 is null or notice_pdf_sha256 is null or legalsign_doc_sha256 = notice_pdf_sha256);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_doc_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_formal_doc_chk
      check (formal_doc_sha256 is null or formal_doc_sha256 = notice_pdf_sha256);
  end if;
  -- 正式PDFで案内した版の締結は、証跡（何を確かめたか）と締結した版が要る
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_evidence_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_formal_evidence_chk
      check (doc_route is distinct from 'official' or formal_signed_at is null
             or (formal_evidence is not null and formal_doc_sha256 is not null));
  end if;
  -- 正式PDFで案内した版の Office への引き渡しは、正式PDFを固定した版だけ
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_handoff_official_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_handoff_official_chk
      check (doc_route is distinct from 'official' or handoff_at is null or official_doc_id is not null);
  end if;
end $$;

-- 正式契約の順番（db/132 の制約を置き換える）。
--   これまで：正式契約済み（formal_signed_at）は、本人が条件を承諾した版にだけ
--   これから：上に加えて、正式PDFで案内した版は、本人がHRで同意する前でも、LegalSign（または例外ルート）で
--             締結したことを記録できる（条件同意と正式契約は別の事実。Office への引き渡しは両方そろってから＝db/133）
--   既存の行はどれも「承諾した版にだけ」を満たしているので、置き換えても止まらない
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_order_chk'
              and pg_get_constraintdef(oid) not like '%doc_route%') then
    alter table public.gw_hr_offers drop constraint gw_hr_offers_formal_order_chk;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_order_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_formal_order_chk
      check ((formal_sent_at is null or legalsign_url is not null)
             and (formal_signed_at is null
                  or accepted_at is not null
                  or (doc_route = 'official' and sent_at is not null and official_doc_id is not null
                      and (legalsign_url is not null or contract_route = 'other'))));
  end if;
end $$;

-- 一度決まったら変えさせない（db/132・133 の trigger・function とは別。それらは変えない）
create or replace function public.gw_hr_offers_lock_contract()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
begin
  -- 流れ（正式PDF／HRのPDF）と、本人へ案内した正式PDFは、一度入ったら変えない
  foreach c in array array['doc_route', 'official_doc_id'] loop
    if o ->> c is not null and (n ->> c) is distinct from (o ->> c) then
      raise exception 'gw_hr_offers.% は確定後に変更できません（db/139）', c
        using errcode = '55000', hint = '本人へ案内した正式PDF・流れは書き換えられません';
    end if;
  end loop;
  -- 締結の証跡は、正式契約済みにしたら変えない
  if old.formal_signed_at is not null then
    foreach c in array array['formal_evidence', 'formal_contract_ref', 'formal_doc_sha256', 'contract_route'] loop
      if (n -> c) is distinct from (o -> c) then
        raise exception 'gw_hr_offers.% は正式契約済みのあとに変更できません（db/139）', c
          using errcode = '55000', hint = '締結の証跡は書き換えられません';
      end if;
    end loop;
  end if;
  -- LegalSign に登録した版は、URL と同じく、本人へ正式契約を案内したら変えない
  if old.formal_sent_at is not null then
    foreach c in array array['legalsign_doc_id', 'legalsign_doc_sha256', 'contract_route'] loop
      if (n -> c) is distinct from (o -> c) then
        raise exception 'gw_hr_offers.% は正式契約の案内後に変更できません（db/139）', c
          using errcode = '55000', hint = 'LegalSign に登録した版は、本人へ案内したあとは変えられません';
      end if;
    end loop;
  end if;
  return new;
end $$;

comment on function public.gw_hr_offers_lock_contract() is
  '採用HR：正式PDFの流れ・案内した正式PDF・LegalSign に登録した版・締結の証跡を、確定後に書き換えさせない（db/139）';

drop trigger if exists gw_hr_offers_lock_contract on public.gw_hr_offers;
create trigger gw_hr_offers_lock_contract
  before update on public.gw_hr_offers
  for each row execute function public.gw_hr_offers_lock_contract();

comment on column public.gw_hr_offers.doc_route is
  'official＝社労士の正式PDFで本人へ案内（HRのPDFは社労士への依頼の条件案）／generated＝HRが作るPDFで案内（これまで）。空＝db/139 より前の版。一度決めたら変えない（db/139）';
comment on column public.gw_hr_offers.contract_route is
  'legalsign＝LegalSign で正式契約／other＝例外ルート（紙・対面など。締結の証跡は担当者が記録）（db/139）';
comment on column public.gw_hr_offers.official_doc_id is
  '本人へ案内した正式PDF（gw_hr_offer_official_docs.id）。notice_* と同じ版。一度入ったら変えない（db/139）';
comment on column public.gw_hr_offers.legalsign_doc_sha256 is
  'LegalSign に登録した版の SHA-256（担当者が承認済みの正式PDFと同じと確認した版）。本人へ案内した版と同じでなければ入らない（db/139）';
comment on column public.gw_hr_offers.formal_evidence is
  '締結を確かめた証跡（LegalSign の締結完了の通知・締結済みPDFを確認、など）。正式契約済みのあとは変えない（db/139）';
comment on column public.gw_hr_offers.formal_contract_ref is
  'LegalSign の文書ID・契約番号など（任意）（db/139）';
comment on column public.gw_hr_offers.formal_doc_sha256 is
  '締結を確かめた版の SHA-256。本人へ案内した版と同じでなければ入らない（db/139）';

-- -----------------------------------------------------------------------------
-- 4) 見える範囲（RLS）：採用HRの人（gw_is_recruiting）が読むだけ。書くのはサーバ（service role）だけ
--    API が権限（承認は給与を見られる人だけ等）と状態を確かめてから書く。画面から直接は書けない
-- -----------------------------------------------------------------------------
alter table public.gw_hr_attorney_requests enable row level security;
alter table public.gw_hr_offer_official_docs enable row level security;

drop policy if exists gw_hr_attorney_requests_read on public.gw_hr_attorney_requests;
create policy gw_hr_attorney_requests_read on public.gw_hr_attorney_requests
  for select to authenticated using (public.gw_is_recruiting(tenant_id));

drop policy if exists gw_hr_offer_official_docs_read on public.gw_hr_offer_official_docs;
create policy gw_hr_offer_official_docs_read on public.gw_hr_offer_official_docs
  for select to authenticated using (public.gw_is_recruiting(tenant_id));

revoke all on public.gw_hr_attorney_requests from authenticated;
revoke all on public.gw_hr_offer_official_docs from authenticated;
do $$
begin
  -- Supabase には anon（ログインしていない人）のロールがある。ほかの環境でも止まらないよう、あるときだけ外す
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.gw_hr_attorney_requests from anon';
    execute 'revoke all on public.gw_hr_offer_official_docs from anon';
  end if;
end $$;
grant select on public.gw_hr_attorney_requests to authenticated;
grant select on public.gw_hr_offer_official_docs to authenticated;
grant all on public.gw_hr_attorney_requests to service_role;
grant all on public.gw_hr_offer_official_docs to service_role;

comment on table public.gw_hr_attorney_requests is
  '採用HR：社労士へ正式な通知書の作成を依頼した記録。担当者が「依頼済みにする」を押したときだけ1行（Slack への自動送信はしない）。追記だけ（db/139）';
comment on table public.gw_hr_offer_official_docs is
  '採用HR：社労士が作った正式PDFの受領記録（1行＝1つの版）。中身・SHA-256 は不変、承認・差し戻しは一度だけ（db/139）';

commit;

notify pgrst, 'reload schema';
