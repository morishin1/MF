-- =============================================================================
-- 提案（未適用）：アプリ利用権限（gw_app_grants）に「marketing（マーケティング）」を足せるようにする
--
-- ■ この SQL はまだどこにも流していない。流すかは、代表の個別の承認のあと
--   docs/member-list-bulk-ux.md「Marketing の割当」に、流す順番・確かめ方・戻し方をまとめてある。
--
-- ■ 何をするか（これだけ）
--   db/119 の app_key の制約（'hr','sales','office' だけ）を、'marketing' も入れられるように広げる。
--   ・既存のメンバーには、1人も付けない（自動で付与しない。INSERT は無い）
--   ・内部ロールからの移行の規則（APP_FROM_ROLES）にも足さない（誰も「導出」で入れない）
--   ・RLS・関数（gw_has_app）は db/119 のまま。gw_has_app(tenant, 'marketing') は、行がある人だけ true
--
-- ■ 流しただけでは、画面も API も何も変わらない
--   コード側（lib/app-grants.js の APP_KEYS・lib/gw.js の accessOf・api/employees/apps.js・ヘッダーのボタン）は
--   まだ marketing を知らない。api/employees/apps.js は 'marketing' を 400 invalid_app で断る。
--   コードを足すのは、Marketing の画面と、その API の入口のサーバ側の判定ができてから（ボタンだけ先に出さない）。
--
-- ■ 前提：db/119_app_grants.sql が適用済み（gw_app_grants がある）
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等。2回流しても同じ）
-- 確かめる: db/check_proposal_app_grants_marketing.sql（読むだけ）
-- 戻す    : db/proposal_rollback_app_grants_marketing.sql
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_app_grants') is null then
    raise exception 'gw_app_grants がありません。先に db/119_app_grants.sql を流してください';
  end if;
end $$;

-- app_key の制約を、名前を決めて付け直す（db/119 は名前なしの check。自動で付いた名前は環境で違いうるので、列で探して外す）
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
     where con.conrelid = 'public.gw_app_grants'::regclass
       and con.contype = 'c'
       and att.attname = 'app_key'
  loop
    execute format('alter table public.gw_app_grants drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.gw_app_grants
  add constraint gw_app_grants_app_key_check check (app_key in ('hr', 'sales', 'office', 'marketing'));

comment on table public.gw_app_grants is
  'アプリ利用権限（どのアプリへ入れるか）。hr=採用HR / sales=Sales / office=Office / marketing=マーケティング（提案：未付与が既定）。'
  '経営は owner から導出するので保存しない。アプリの中で何ができるかは、内部ロール（gw_role_grants）が決める（db/119）';

notify pgrst, 'reload schema';

commit;
