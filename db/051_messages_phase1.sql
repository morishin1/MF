-- =============================================================================
-- 051: メッセージ フェーズ1（メンバー管理・既読）
--
-- ■ 位置づけ
--   mf のメッセージは「社内の記録に残す連絡・業務連絡」。
--   Slack の作り直しはしない。スレッド返信・リアクション・
--   高度なメンションは入れない（会話は Slack、記録は mf）。
--
-- ■ グループの持ち主を決める
--   誰でも人を出し入れできると、業務連絡の宛先が知らないうちに変わる。
--   作った人を owner にし、出し入れは owner と人事だけにする。
--
--   gw_threads.created_by は auth.users を指していて、社員名簿の id ではない。
--   人が抜けても持ち主が分かるように、参加者の行に持たせる。
--
-- ■ 抜けた人は、過去も読めなくなる
--   RLS（gw_in_thread）が参加者だけに絞っているので、外すと履歴も見えない。
--   業務連絡なので、これでよい。残す必要があるものは社内文書に置く。
--   外した記録そのものは gw_activity_log に残る。
-- =============================================================================

alter table public.gw_thread_members
  add column if not exists role text not null default 'member';

do $$
begin
  alter table public.gw_thread_members
    add constraint gw_thread_members_role
    check (role in ('owner', 'member'));
exception
  when duplicate_object then null;
end $$;

comment on column public.gw_thread_members.role is
  'owner=グループを作った人。人の出し入れとグループ名の変更ができる / member=参加者。'
  '1対1では使わない（どちらも member のまま）';

-- 既にあるグループの持ち主を埋める。
-- gw_threads.created_by（auth.users）から、社員名簿を引いて突き合わせる
update public.gw_thread_members m
   set role = 'owner'
  from public.gw_threads t
  join public.gw_employees e on e.user_id = t.created_by
 where m.thread_id = t.id
   and m.employee_id = e.id
   and t.kind = 'group'
   and m.role <> 'owner';

-- 持ち主が1人もいないグループ（作った人が退職した等）は、
-- いちばん先に入った人を持ち主にする。誰も動かせないグループを残さない
update public.gw_thread_members m
   set role = 'owner'
 where m.id in (
   select distinct on (x.thread_id) x.id
     from public.gw_thread_members x
     join public.gw_threads t on t.id = x.thread_id
    where t.kind = 'group'
      and not exists (
        select 1 from public.gw_thread_members o
         where o.thread_id = x.thread_id and o.role = 'owner')
    order by x.thread_id, x.joined_at, x.id
 );

-- 過去ぶんをさかのぼって読むための索引。
-- 「この時刻より前を50件」を繰り返し引くので、降順で持つ
create index if not exists idx_gw_messages_thread_desc
  on public.gw_messages(thread_id, created_at desc, id desc);

notify pgrst, 'reload schema';

-- 確認:
--   select t.title, e.display_name, m.role
--     from public.gw_thread_members m
--     join public.gw_threads t on t.id = m.thread_id
--     join public.gw_employees e on e.id = m.employee_id
--    where t.kind = 'group'
--    order by t.title, m.role, e.display_name;
