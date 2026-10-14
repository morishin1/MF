-- db/135_hr_document_skill_sheet.sql のやり直し（doc_type の CHECK を、元の3種類（resume・work_history・other）に戻す）。
--
-- ■ 注意：スキルシート（skill_sheet）の行があると戻せない（CHECK がその行に引っかかり、エラーで止まる）
--   戻す前に、残したい行を控え、行を消すか、種類を other に直す。
--     select id, applicant_id, filename, created_at from public.gw_hr_documents where doc_type = 'skill_sheet';
--   種類を other にする場合（ファイルはそのまま。画面では「その他の書類」に出る）:
--     update public.gw_hr_documents set doc_type = 'other' where doc_type = 'skill_sheet';
--
-- 戻したあとも、履歴書・職務経歴書・その他はこれまでどおり動く（スキルシートのアップロードだけが、また「db/135 を流してください」になる）。
begin;

do $$
declare
  c record;
begin
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
  check (doc_type in ('resume', 'work_history', 'other'));

comment on column public.gw_hr_documents.doc_type is null;

commit;

notify pgrst, 'reload schema';
