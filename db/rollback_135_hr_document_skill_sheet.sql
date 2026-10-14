-- db/135_hr_document_skill_sheet.sql のやり直し（doc_type の CHECK を、元の3種類（resume・work_history・other）に戻す）。
--
-- ■ 何をするか
--   gw_hr_documents の「doc_type 1列だけを見ていて、許す値がちょうど resume・work_history・skill_sheet・other の4つ」の CHECK だけを、
--   同じ名前で3種類の CHECK に作り直す（db/135 と同じ見つけ方。他の CHECK は触らない。データは変えない）。
--   対象がちょうど1つに決まらないとき（0個・2個以上）は、何も変えずにエラーで止まる。すでに3種類なら何もしない（べき等）。
--
-- ■ 注意：スキルシート（skill_sheet）の行があると戻せない（行を残したまま CHECK を戻すと、その行が引っかかる）
--   その場合は、何も変えずにエラーで止まる。戻す前に、残したい行を控え、行を消すか、種類を other に直す。
--     select id, applicant_id, filename, created_at from public.gw_hr_documents where doc_type = 'skill_sheet';
--   種類を other にする場合（ファイルはそのまま。画面では「その他の書類」に出る）:
--     update public.gw_hr_documents set doc_type = 'other' where doc_type = 'skill_sheet';
--
-- 戻したあとも、履歴書・職務経歴書・その他はこれまでどおり動く（スキルシートのアップロードだけが、また「db/135 を流してください」になる）。
begin;

do $$
declare
  v_attnum smallint;
  v_lits   text[];
  c        record;
  v_old    text[] := array['resume', 'work_history', 'skill_sheet', 'other'];   -- 戻す前（db/135 の後）
  v_new    text[] := array['resume', 'work_history', 'other'];                  -- 戻した後（db/093）
  v_name   text;
  n_old    int := 0;
  n_new    int := 0;
  n_rows   bigint;
begin
  if to_regclass('public.gw_hr_documents') is null then
    raise exception 'gw_hr_documents がありません';
  end if;

  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.gw_hr_documents'::regclass
     and a.attname = 'doc_type'
     and not a.attisdropped;
  if v_attnum is null then
    raise exception 'gw_hr_documents に doc_type 列がありません';
  end if;

  for c in
    select con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
     where con.conrelid = 'public.gw_hr_documents'::regclass
       and con.contype = 'c'
       and con.conkey = array[v_attnum]
  loop
    select coalesce(array_agg(distinct m[1]), '{}'::text[]) into v_lits
      from regexp_matches(c.def, '''([^'']+)''', 'g') as t(m);

    if v_lits @> v_old and v_lits <@ v_old then
      n_old := n_old + 1;
      v_name := c.conname;
    elsif v_lits @> v_new and v_lits <@ v_new then
      n_new := n_new + 1;
    end if;
  end loop;

  if n_old = 0 and n_new = 1 then
    raise notice 'rollback 135: doc_type の CHECK はすでに3種類です（何も変えていません）';
    return;
  end if;

  if n_old <> 1 or n_new <> 0 then
    raise exception 'rollback 135: 戻す doc_type の CHECK を1つに特定できません（4種類の CHECK: % 個／3種類の CHECK: % 個）。何も変えていません', n_old, n_new;
  end if;

  select count(*) into n_rows from public.gw_hr_documents where doc_type = 'skill_sheet';
  if n_rows > 0 then
    raise exception 'rollback 135: スキルシート（skill_sheet）の書類が % 件あります。何も変えていません。先に行を消すか、種類を other に直してください（このファイル冒頭の SQL を参照）', n_rows;
  end if;

  execute format('alter table public.gw_hr_documents drop constraint %I', v_name);
  execute format(
    'alter table public.gw_hr_documents add constraint %I check (doc_type in (%L, %L, %L))',
    v_name, 'resume', 'work_history', 'other');
end $$;

notify pgrst, 'reload schema';

commit;
