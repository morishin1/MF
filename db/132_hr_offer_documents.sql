-- =============================================================================
-- 132: 採用HR：条件通知書PDF・本人の電子承諾記録・LegalSign による正式契約（gw_hr_offers に列を足す）
--
-- ■ 何をするか（列を足すだけ。既存の行・既存の列・ステータスは変えない）
--   1 offer version（gw_hr_offers の1行）＝ 1条件通知書 ＝ 1承諾記録 ＝ 1正式契約。新しい表は作らない。
--
--   1) 条件通知書PDF（送った時点の版から作る。送ったあとは変えない）
--        notice_title       … 書類名（労働条件通知書／育成参加条件通知書／業務委託条件通知書／案件条件通知書）
--        notice_pdf_path    … private バケット hr の中のパス
--        notice_pdf_sha256  … そのPDFの SHA-256（小文字16進64桁）
--   2) 本人の電子承諾記録（accepted_at は 081 の列をそのまま使う）
--        accept_name / accept_email … 承諾した時点の本人の氏名・メール
--        accept_ip / accept_ua      … 承諾したときの IP アドレス・利用環境（User-Agent）
--        accept_text                … 画面に出した同意の文言そのまま
--        accepted_pdf_path / accepted_pdf_sha256 … 条件通知書PDF＋「電子承諾記録」ページのPDF
--   3) 正式契約（LegalSign。最初は URL を登録して本人へ案内するだけ。API 連携はしない）
--        legalsign_url                    … https:// だけ
--        formal_sent_at / formal_sent_by  … 本人へ正式契約を案内した（初回）
--        formal_signed_at / formal_signed_by … 正式契約済みにした（誰が・いつ）
--
-- ■ 書き換えさせない（API だけでなく DB でも止める）
--   次の列は、一度値が入ったら変更も削除（null へ戻す）もできない（trigger で拒否する。service role でも同じ）。
--     notice_title・notice_pdf_path・notice_pdf_sha256、
--     accept_name・accept_email・accept_ip・accept_ua・accept_text・accepted_pdf_path・accepted_pdf_sha256、
--     accepted_at、formal_sent_at・formal_sent_by、formal_signed_at・formal_signed_by
--   legalsign_url は、正式契約を本人へ案内する前（formal_sent_at が空の間）だけ直せる。
--   本当に直す必要があるときは、理由を残したうえで、管理者が SQL で trigger を外して行う（通常の運用には無い）。
--
-- ■ URL は記録に残さない
--   legalsign_url は、この列にだけ持つ。監査ログ・選考タイムラインには「登録した」「案内した」の事実だけ（API 側）。
--
-- ■ 権限
--   既存の表に列を足すだけなので、RLS・ポリシーは変えない（081 のまま）。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、オファーの送信・本人の承諾はこれまでどおり動く
--   （条件通知書PDF・承諾記録・LegalSign の操作だけが「db/132 を流してください」と出る）。
--
-- ■ 番号
--   128（Office）・129（採用区分）・130（Sales の権限）は本番適用済み。131 は開いている PR #105（AI営業）が使う。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 081（gw_hr_offers）・129（offer_type）
-- 確認: 流したあと db/check_132_hr_offer_documents.sql を Run（1つの表で ✅／❌ を見る。読み取りだけ）
-- 戻す: db/rollback_132_hr_offer_documents.sql（列ごと消える。本番で流す前に必ず確認）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_hr_offers') is null then
    raise exception 'gw_hr_offers がありません。先に db/081_hr_recruiting.sql を流してください';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_hr_offers' and column_name = 'offer_type') then
    raise exception 'gw_hr_offers.offer_type がありません。先に db/129_hr_offer_type.sql を流してください';
  end if;
end $$;

alter table public.gw_hr_offers
  -- 1) 条件通知書PDF
  add column if not exists notice_title        text,
  add column if not exists notice_pdf_path     text,
  add column if not exists notice_pdf_sha256   text,
  -- 2) 本人の電子承諾記録
  add column if not exists accept_name         text,
  add column if not exists accept_email        text,
  add column if not exists accept_ip           text,
  add column if not exists accept_ua           text,
  add column if not exists accept_text         text,
  add column if not exists accepted_pdf_path   text,
  add column if not exists accepted_pdf_sha256 text,
  -- 3) 正式契約（LegalSign）
  add column if not exists legalsign_url       text,
  add column if not exists formal_sent_at      timestamptz,
  add column if not exists formal_sent_by      uuid references auth.users(id) on delete set null,
  add column if not exists formal_signed_at    timestamptz,
  add column if not exists formal_signed_by    uuid references auth.users(id) on delete set null;

-- 値の形・順番（既存の行はどの列も空なので、そのまま満たす）
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_notice_sha_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_notice_sha_chk
      check (notice_pdf_sha256 is null or notice_pdf_sha256 ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_accepted_sha_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_accepted_sha_chk
      check (accepted_pdf_sha256 is null or accepted_pdf_sha256 ~ '^[0-9a-f]{64}$');
  end if;
  -- 承諾済みPDFは、条件通知書PDFがある版にだけ
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_accepted_pdf_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_accepted_pdf_chk
      check (accepted_pdf_path is null or (notice_pdf_path is not null and accepted_at is not null));
  end if;
  -- 承諾の記録は、承諾した版にだけ
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_accept_record_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_accept_record_chk
      check (accepted_at is not null
             or (accept_name is null and accept_email is null and accept_ip is null and accept_ua is null and accept_text is null));
  end if;
  -- LegalSign の URL は https:// だけ（javascript: data: などは入れられない）。空白・改行を含めない
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_legalsign_url_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_legalsign_url_chk
      check (legalsign_url is null or (legalsign_url ~ '^https://[^[:space:]]+$' and char_length(legalsign_url) <= 2000));
  end if;
  -- 正式契約の案内は URL があるときだけ。正式契約済みは、本人が条件を承諾した版にだけ
  if not exists (select 1 from pg_constraint where conname = 'gw_hr_offers_formal_order_chk') then
    alter table public.gw_hr_offers add constraint gw_hr_offers_formal_order_chk
      check ((formal_sent_at is null or legalsign_url is not null)
             and (formal_signed_at is null or accepted_at is not null));
  end if;
end $$;

-- 一度入ったら変えさせない（API の確かめに加えて、DB でも止める）
create or replace function public.gw_hr_offers_lock_documents()
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
    'notice_title', 'notice_pdf_path', 'notice_pdf_sha256',
    'accept_name', 'accept_email', 'accept_ip', 'accept_ua', 'accept_text',
    'accepted_pdf_path', 'accepted_pdf_sha256', 'accepted_at',
    'formal_sent_at', 'formal_sent_by', 'formal_signed_at', 'formal_signed_by'
  ] loop
    if o ->> c is not null and (n ->> c) is distinct from (o ->> c) then
      raise exception 'gw_hr_offers.% は確定後に変更できません（db/132）', c
        using errcode = '55000', hint = '条件通知書・承諾記録・正式契約済みの記録は書き換えられません';
    end if;
  end loop;
  -- LegalSign の URL は、本人へ正式契約を案内する前だけ直せる
  if old.formal_sent_at is not null and new.legalsign_url is distinct from old.legalsign_url then
    raise exception 'gw_hr_offers.legalsign_url は正式契約の案内後に変更できません（db/132）'
      using errcode = '55000', hint = '本人へ案内した URL は変えられません';
  end if;
  return new;
end $$;

comment on function public.gw_hr_offers_lock_documents() is
  '採用HR：条件通知書PDF・承諾記録・正式契約の記録を、一度入ったら変えさせない（db/132）';

drop trigger if exists gw_hr_offers_lock_documents on public.gw_hr_offers;
create trigger gw_hr_offers_lock_documents
  before update on public.gw_hr_offers
  for each row execute function public.gw_hr_offers_lock_documents();

comment on column public.gw_hr_offers.notice_title is '条件通知書の書類名（送った時点）。一度入ったら変えない（db/132）';
comment on column public.gw_hr_offers.notice_pdf_path is '条件通知書PDF（private バケット hr のパス）。送った時点の版から作る。一度入ったら変えない（db/132）';
comment on column public.gw_hr_offers.notice_pdf_sha256 is '条件通知書PDFの SHA-256。電子承諾記録ページに印字する値と同じ（db/132）';
comment on column public.gw_hr_offers.accept_name is '承諾した時点の本人の氏名（db/132）';
comment on column public.gw_hr_offers.accept_email is '承諾した時点の本人のメールアドレス（db/132）';
comment on column public.gw_hr_offers.accept_ip is '承諾したときの IP アドレス（db/132）';
comment on column public.gw_hr_offers.accept_ua is '承諾したときの利用環境（User-Agent）（db/132）';
comment on column public.gw_hr_offers.accept_text is '承諾の画面に出した同意の文言そのまま（db/132）';
comment on column public.gw_hr_offers.accepted_pdf_path is '承諾済みPDF（条件通知書PDF＋電子承諾記録ページ）。一度入ったら変えない（db/132）';
comment on column public.gw_hr_offers.accepted_pdf_sha256 is '承諾済みPDFの SHA-256（db/132）';
comment on column public.gw_hr_offers.legalsign_url is '正式契約（LegalSign）の URL。https:// だけ。本人へ案内する前だけ直せる。監査ログには残さない（db/132）';
comment on column public.gw_hr_offers.formal_sent_at is '本人へ正式契約（LegalSign）を案内した日時（初回）（db/132）';
comment on column public.gw_hr_offers.formal_signed_at is '正式契約済みにした日時。一度入ったら変えない（db/132）';
comment on column public.gw_hr_offers.formal_signed_by is '正式契約済みにした人（db/132）';

commit;

notify pgrst, 'reload schema';

-- ■ 確認：db/check_132_hr_offer_documents.sql を Supabase の SQL Editor で Run（読み取りだけ）
