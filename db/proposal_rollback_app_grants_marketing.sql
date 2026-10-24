-- =============================================================================
-- 戻す：db/proposal_app_grants_marketing.sql（app_key に 'marketing' を足した）を元に戻す
--
-- ■ 付けた marketing の行が1つでもあれば、止まる（黙って権限を消さない）
--   消してよいと決めたときだけ、下の「2段目」のコメントを外して流す。
-- ■ 戻したあとの制約は db/119 と同じ（'hr','sales','office'）
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.gw_app_grants') is null then
    raise notice 'gw_app_grants がありません。戻すものはありません';
    return;
  end if;
end $$;

-- 2段目（必要なときだけコメントを外す）：付けた marketing の行を消す
-- delete from public.gw_app_grants where app_key = 'marketing';

do $$
declare
  n int;
begin
  select count(*) into n from public.gw_app_grants where app_key = 'marketing';
  if n > 0 then
    raise exception 'marketing の権限が % 件あります。戻す前に、消してよいかを決めてください（この SQL の2段目）', n;
  end if;
end $$;

alter table public.gw_app_grants drop constraint if exists gw_app_grants_app_key_check;
alter table public.gw_app_grants
  add constraint gw_app_grants_app_key_check check (app_key in ('hr', 'sales', 'office'));

comment on table public.gw_app_grants is
  'アプリ利用権限（どのアプリへ入れるか）。hr=採用HR / sales=Sales / office=Office。経営は owner から導出するので保存しない。'
  'アプリの中で何ができるかは、内部ロール（gw_role_grants）が決める（db/119）';

notify pgrst, 'reload schema';

commit;
