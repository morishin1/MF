-- =============================================================================
-- 055: 端末管理の運用まわり
--
-- 054 の続き。**053 → 054 → 055 の順で流す。**
--
-- ■ 登録コードは消さない。取り消す
--   使われたコードを消してしまうと、「誰がいつ何に使ったか」が残らない。
--   取り消すときも行は残して、revoked_at を立てるだけにする。
--   監査の本体は、コードそのものではなく「使われた記録」のほう。
--
-- ■ 紐付け解除は、記録を消さない
--   ブラウザとパソコンの紐付けを外しても、
--   それぞれの端末の記録はそのまま残る。
--   「間違って繋いだ」を直すための操作であって、消すためのものではない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 登録コードの取り消し
-- -----------------------------------------------------------------------------
alter table public.gw_device_enrollments add column if not exists revoked_at timestamptz;
alter table public.gw_device_enrollments add column if not exists revoked_by uuid
  references auth.users(id) on delete set null;

-- 発行した人・使われた端末をたどるため。
-- 監査で見るのはたいてい「最近のもの」なので、新しい順に引けるようにする
create index if not exists idx_gw_device_enrollments_recent
  on public.gw_device_enrollments(tenant_id, created_at desc);

comment on column public.gw_device_enrollments.revoked_at is
  '取り消した時刻。行は消さない。誰がいつ何に使ったかが監査の本体なので、'
  '使用済みのコードも取り消したコードも残す';

-- -----------------------------------------------------------------------------
-- 2) 台帳に、管理者が最後に触った記録
--
--    所有者変更・紐付け解除は、あとから「誰がやったか」を聞かれる操作。
--    gw_activity_log にも残すが、台帳の行を見たときにも分かるようにしておく
-- -----------------------------------------------------------------------------
alter table public.gw_devices add column if not exists admin_touched_at timestamptz;
alter table public.gw_devices add column if not exists admin_touched_by uuid
  references auth.users(id) on delete set null;
alter table public.gw_devices add column if not exists admin_touched_what text;

comment on column public.gw_devices.admin_touched_what is
  '管理者が最後にした操作（assign / unlink / suspend / retire など）。'
  'くわしい経緯は gw_activity_log を見る';

-- -----------------------------------------------------------------------------
-- 3) できごとに、管理者の操作を足す
-- -----------------------------------------------------------------------------
alter table public.gw_device_events drop constraint if exists gw_device_events_kind_check;
alter table public.gw_device_events add constraint gw_device_events_kind_check
  check (kind in (
    -- 053（ブラウザ側）
    'first_seen', 'confirmed', 'installed', 'renamed',
    'suspended', 'resumed', 'retired', 'forgotten', 'linked',
    -- 055（管理者の操作）
    'assigned', 'unlinked', 'token_revoked',
    -- 054（エージェント側）
    'boot', 'shutdown', 'logon', 'logoff', 'lock', 'unlock', 'sleep', 'wake',
    'usb_attach', 'usb_detach', 'app_install', 'app_uninstall',
    'agent_start', 'agent_update', 'agent_error'))
  not valid;

notify pgrst, 'reload schema';

-- ちゃんと入ったか、その場で出す
select
  case when exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'gw_device_enrollments'
                       and column_name = 'revoked_at')
       then '✓ 登録コードの取り消しを足しました' else '✗ 足せていません' end as 登録コード,
  case when exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'gw_devices'
                       and column_name = 'admin_touched_at')
       then '✓ 管理者の操作あとを足しました' else '✗ 足せていません' end as 台帳,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'gw_device%') as ポリシー数;

-- 確認:
--   -- 登録コードの発行と使用（監査）
--   select e.created_at as 発行, u.email as 発行者, emp.display_name as 宛先,
--          e.expires_at as 期限, e.used_at as 使用, d.hostname as 使った端末,
--          e.revoked_at as 取り消し
--     from public.gw_device_enrollments e
--     left join auth.users u on u.id = e.created_by
--     left join public.gw_employees emp on emp.id = e.employee_id
--     left join public.gw_devices d on d.id = e.used_by
--    order by e.created_at desc limit 50;
--
--   -- 24時間以上届いていないエージェント
--   select hostname, last_seen_at from public.gw_devices
--    where source = 'agent' and status = 'active' and notified_at is not null
--      and (last_seen_at is null or last_seen_at < now() - interval '24 hours');
