-- =============================================================================
-- 135: 採用の応募書類に「スキルシート」の種類を足す（gw_hr_documents.doc_type の CHECK を広げる）
--
-- ■ 何をするか（1つの CHECK 制約を作り直すだけ。行・列・データは変えない）
--   db/093 の gw_hr_documents は、書類の種類を resume（履歴書）／work_history（職務経歴書）／other（その他）の3つに絞っている。
--   HR の「書類」タブに、スキルシート（skill_sheet）の枠を足すため、4つに広げる。
--   既存の行はそのまま（3つのどれか）。広げるだけなので、いまある行が制約に引っかかることはない。
--
-- ■ 制約の名前
--   db/093 は列に直接 CHECK を書いたので、名前は PostgreSQL が付けている（既定では gw_hr_documents_doc_type_check）。
--   ここでは名前を決め打ちせず、doc_type を見ている CHECK を探して外し、同じ名前で作り直す（べき等。2回流してもよい）。
--
-- ■ 権限
--   RLS・ポリシーは変えない（093 のまま。読めるのは採用を扱える人、書き込みは API だけ）。
--
-- ■ 適用の順番
--   この SQL → アプリのデプロイ。デプロイが先でも、履歴書・職務経歴書・その他はこれまでどおり動く
--   （スキルシートのアップロードだけが、「db/135 を流してください」と出る）。
--
-- 実行方法: Supabase の SQL Editor に、このファイル全体を貼って Run（べき等）
-- 前提: db/093_hr_documents.sql
-- 確認: 流したあと db/check_135_hr_document_skill_sheet.sql を Run（読み取りだけ）
-- 戻す: db/rollback_135_hr_document_skill_sheet.sql（スキルシートの行があると戻せない。先に消す／種類を other に直す）
-- =============================================================================

begin;

do $$
declare
  c record;
begin
  if to_regclass('public.gw_hr_documents') is null then
    raise exception 'gw_hr_documents がありません。先に db/093_hr_documents.sql を流してください';
  end if;
  -- doc_type だけを見ている CHECK（列の CHECK でも表の CHECK でも）を外す
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.gw_hr_documents'::regclass
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%doc_type%'
  loop
    execute format('alter table public.gw_hr_documents drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.gw_hr_documents
  add constraint gw_hr_documents_doc_type_check
  check (doc_type in ('resume', 'work_history', 'skill_sheet', 'other'));   -- 履歴書 / 職務経歴書 / スキルシート / その他

comment on column public.gw_hr_documents.doc_type is
  '書類の種類：resume（履歴書）／work_history（職務経歴書）／skill_sheet（スキルシート。db/135）／other（その他）';

notify pgrst, 'reload schema';

commit;
