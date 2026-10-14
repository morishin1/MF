-- =============================================================================
-- 135: 採用の応募書類に「スキルシート」の種類を足す（gw_hr_documents.doc_type の CHECK を 3種類 → 4種類に置き換える）
--
-- ■ 何をするか（doc_type の CHECK 制約 1つを置き換えるだけ。行・列・データ・他の制約は変えない）
--   db/093 の gw_hr_documents は、書類の種類を resume（履歴書）／work_history（職務経歴書）／other（その他）の3つに絞っている。
--   HR の「書類」タブに、スキルシート（skill_sheet）の枠を足すため、4つに広げる。
--   既存の行はそのまま（3つのどれか）。広げるだけなので、いまある行が制約に引っかかることはない。UPDATE / DELETE は1行もしない。
--
-- ■ どの制約を置き換えるか（広く探して消さない。「既存の doc_type の制約」だけを特定する）
--   次の3つを「すべて」満たす CHECK だけが対象。
--     ① gw_hr_documents の CHECK 制約である
--     ② 見ている列が doc_type 1つだけ（複数の列を見る CHECK は対象外）
--     ③ 許している値が ちょうど resume・work_history・other の3つ（db/093 の定義）
--   名前は決め打ちしない（db/093 は列に直接 CHECK を書いたので、PostgreSQL が付けた名前＝既定では gw_hr_documents_doc_type_check）。
--   見つけた名前をそのまま使って外し、同じ名前で作り直す（名前も変わらない）。
--   将来、別の doc_type 関連の CHECK が増えても、上の①〜③に合わなければ触らない。
--   対象がちょうど1つに決まらないとき（0個・2個以上）は、何も変えずにエラーで止まる（推測で消さない）。
--   すでに4種類になっているときは何もしない（べき等。2回流してもよい）。
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
  v_attnum smallint;
  v_lits   text[];
  c        record;
  v_old    text[] := array['resume', 'work_history', 'other'];                  -- 置き換え前（db/093）
  v_new    text[] := array['resume', 'work_history', 'skill_sheet', 'other'];   -- 置き換え後（この SQL）
  v_name   text;                      -- 置き換える制約の名前（見つけたものをそのまま使う）
  n_old    int := 0;
  n_new    int := 0;
begin
  if to_regclass('public.gw_hr_documents') is null then
    raise exception 'gw_hr_documents がありません。先に db/093_hr_documents.sql を流してください';
  end if;

  select a.attnum into v_attnum
    from pg_attribute a
   where a.attrelid = 'public.gw_hr_documents'::regclass
     and a.attname = 'doc_type'
     and not a.attisdropped;
  if v_attnum is null then
    raise exception 'gw_hr_documents に doc_type 列がありません';
  end if;

  -- doc_type 1列だけを見ている CHECK を1つずつ見て、許している値の集合で「3種類」「4種類」を判別する
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
    raise notice 'db/135: doc_type の CHECK はすでに4種類です（何も変えていません）';
    return;
  end if;

  if n_old <> 1 or n_new <> 0 then
    raise exception 'db/135: 置き換える doc_type の CHECK を1つに特定できません（3種類の CHECK: % 個／4種類の CHECK: % 個）。何も変えていません。gw_hr_documents の CHECK を確認してください', n_old, n_new;
  end if;

  execute format('alter table public.gw_hr_documents drop constraint %I', v_name);
  execute format(
    'alter table public.gw_hr_documents add constraint %I check (doc_type in (%L, %L, %L, %L))',
    v_name, 'resume', 'work_history', 'skill_sheet', 'other');   -- 履歴書 / 職務経歴書 / スキルシート / その他
end $$;

notify pgrst, 'reload schema';

commit;
