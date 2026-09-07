-- =============================================================================
-- 044: タスクと予定を、メンバー同士でシェアできるようにする
--
-- ■ いままで
--   タスク … 作れるのは管理者・人事だけ。メンバーは頼まれる側だった。
--   予定   … 完全に本人だけ。管理者にも見えない。
--   その結果、「これお願いします」も「今日空いてますか」も、
--   結局チャットで聞くことになっていた。
--
-- ■ これから
--   タスク … メンバーが他のメンバーに頼める。頼んだ人は自分が頼んだ分を
--            直せる・取り消せる。他人が頼んだ分には触れない。
--   予定   … 1件ごとに公開範囲を選ぶ。既定は「自分だけ」のまま。
--
-- ■ 予定の公開範囲を3段にした理由
--   private … 自分だけ（既定）。今までと同じ
--   busy    … 時間だけ見せる。「予定あり」とだけ出る。
--             空いている時間を知りたいだけなら、中身はいらない
--   shared  … 件名と場所まで見せる
--   メモ（body）はどの段でも他人に返さない。API 側で外している。
--   列単位の制限は RLS では書けないので、そこはサーバの仕事
--   （api/schedule/team.js）。
--
-- ■ 既存の予定は勝手に公開しない
--   default 'private' で足すので、いま入っている行は全部「自分だけ」になる。
--   本人が選び直したものだけが人に見える。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. タスク: メンバー同士で頼めるようにする
-- -----------------------------------------------------------------------------
-- 009 は for all の1本だったので、insert / update / delete に分ける。
-- 「作るのは社員なら誰でも」「直せるのは自分が作った分だけ」を書き分けるため。
drop policy if exists gw_tasks_write on public.gw_tasks;

drop policy if exists gw_tasks_insert on public.gw_tasks;
create policy gw_tasks_insert on public.gw_tasks
  for insert to authenticated
  with check (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    -- 名簿に載っている人が、自分の名前で作る場合だけ。
    -- created_by を他人にして作れると、誰が頼んだのか分からなくなる
    or (public.gw_employee_id(tenant_id) is not null and created_by = auth.uid())
  );

drop policy if exists gw_tasks_update on public.gw_tasks;
create policy gw_tasks_update on public.gw_tasks
  for update to authenticated
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or created_by = auth.uid()
  )
  with check (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or created_by = auth.uid()
  );

drop policy if exists gw_tasks_delete on public.gw_tasks;
create policy gw_tasks_delete on public.gw_tasks
  for delete to authenticated
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or created_by = auth.uid()
  );

-- 担当された側が状態だけ変えるのは、いままで通り
-- api/tasks/index.js（service_role）が唯一の口。
-- 担当者に update を許すと、担当者や期限まで書き換えられてしまう。

create index if not exists idx_gw_tasks_creator
  on public.gw_tasks(tenant_id, created_by, status);


-- -----------------------------------------------------------------------------
-- 2. 予定: 1件ごとの公開範囲
-- -----------------------------------------------------------------------------
alter table public.gw_calendar_events
  add column if not exists visibility text not null default 'private';

do $$
begin
  alter table public.gw_calendar_events
    add constraint gw_calendar_events_visibility_chk
    check (visibility in ('private', 'busy', 'shared'));
exception
  when duplicate_object then null;
end $$;

comment on column public.gw_calendar_events.visibility is
  'private=自分だけ / busy=時間だけ見せる / shared=件名と場所まで見せる。'
  'メモ（body）はどの段でも他人には返さない（api/schedule/team.js で外す）';

-- 人の予定を見るときは「公開されている行」だけを日付で引く。
-- 自分の予定を引く索引（owner）とは向きが違うので、別に置く
create index if not exists idx_gw_calendar_events_shared
  on public.gw_calendar_events(tenant_id, starts_at)
  where visibility <> 'private';


-- 参照だけを足す。017 の gw_calendar_events_own（for all）はそのまま。
-- 直す・消すは、いままで通り本人だけ。
drop policy if exists gw_calendar_events_peer_select on public.gw_calendar_events;
create policy gw_calendar_events_peer_select on public.gw_calendar_events
  for select to authenticated
  using (
    visibility <> 'private'
    -- 名簿に載っている人だけ。顧問先ロールのユーザーには見せない
    and public.gw_employee_id(tenant_id) is not null
  );


notify pgrst, 'reload schema';

-- 確認:
--   select visibility, count(*) from public.gw_calendar_events group by 1;
--   -- 044 を当てた直後は private だけのはず
--
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.gw_tasks'::regclass order by polname;
