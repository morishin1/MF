-- =============================================================================
-- 067: ブラウザ拡張が「外れている」を、誤検知せずに見つける
--
-- ■ 何が足りていなかったか
--
--   登録を台帳から外せるのは管理者だけ、と決めてある。
--   ところがブラウザから拡張を消すことまでは止められない。
--   そして台帳は「つないだ」と書いたきりだったので、
--   外されても ○ のまま残っていた。つまり黙って外せた。
--
-- ■ その場の一瞬で判断すると、誤検知する
--
--   「グループウェアの合図は来ているのに、拡張からは届かない」
--   という状態は、外していなくても普通に起きる。
--
--     ・ブラウザを立ち上げ直した直後（拡張がまだ1回も送っていない）
--     ・拡張の自動更新中
--     ・拡張が落ちて、すぐ上がった
--
--   その瞬間を見て × にすると、毎日どこかの誰かが赤くなる。
--   赤が日常になると、本当に外した人が埋もれる。
--
-- ■ だから「いつから続いているか」を持つ
--
--   合図が来るたび（画面から5分おき）に、拡張の様子を見て
--
--     拡張から最近届いている   → ext_missing_since を消す
--     しばらく届いていない     → ext_missing_since を（空なら）立てる
--
--   × にするのは、立ってから **合図が来つづけた時間** が一定を超えたときだけ
--   （last_seen_at − ext_missing_since。lib/watch.js の extGone）。
--   いまからの経過で見ると、帰ったあと時間が経つだけで × になり、
--   翌朝それが消える。管理者が見る前に、無かったことになってしまう。
--
--   立ち上げ直しや更新なら、次の合図までに拡張が送ってきて消える。
--   閉じていたあいだのぶんは、置き直すときに捨てる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 053 → 054 → 057 を流してあること
-- =============================================================================

alter table public.gw_devices
  add column if not exists ext_missing_since timestamptz;

comment on column public.gw_devices.ext_missing_since is
  'グループウェアは使っているのに、ブラウザ拡張から届かなくなった時刻。'
  '拡張が送ってくれば消える。ここが一定時間以上続いたときだけ「連携異常」にする。'
  '一瞬で判断すると、立ち上げ直し・自動更新・一時的な停止で誤検知する';

-- 続いている人を引くための索引。全社員ぶん毎回なめない
create index if not exists idx_gw_devices_ext_missing
  on public.gw_devices(tenant_id, ext_missing_since)
  where ext_missing_since is not null;

-- -----------------------------------------------------------------------------
-- 管理者の操作を、できごとにも残す
--
--   誰が・いつ・誰のブラウザ登録を変えたかは gw_activity_log に残るが、
--   その端末の履歴からも辿れないと、1台ぶんを見るのに2画面を行き来する
-- -----------------------------------------------------------------------------
alter table public.gw_device_events drop constraint if exists gw_device_events_kind_check;
alter table public.gw_device_events add constraint gw_device_events_kind_check
  check (kind in (
    -- 053（ブラウザ側）
    'first_seen', 'confirmed', 'installed', 'renamed',
    'suspended', 'resumed', 'retired', 'forgotten', 'linked',
    -- 055（管理者の操作）
    'assigned', 'unlinked', 'token_revoked',
    -- 064（端末の一生）
    'lost', 'wipe_requested', 'wipe_canceled', 'wiped',
    -- 067（ブラウザ拡張）
    'ext_unlinked', 'ext_reinvited', 'ext_missing',
    -- 054（エージェント側）
    'boot', 'shutdown', 'logon', 'logoff', 'lock', 'unlock', 'sleep', 'wake',
    'usb_attach', 'usb_detach', 'app_install', 'app_uninstall',
    'agent_start', 'agent_update', 'agent_error',
    -- 0.3.2（自分の重さ）
    'agent_load_high', 'agent_load_ok'))
  not valid;


notify pgrst, 'reload schema';

-- 確認:
--   select e.display_name, d.label,
--          d.installed_at is not null as 登録済,
--          d.last_seen_at, d.ext_missing_since
--     from public.gw_devices d
--     join public.gw_employees e on e.id = d.employee_id
--    where d.source = 'browser'
--    order by d.ext_missing_since nulls last;
