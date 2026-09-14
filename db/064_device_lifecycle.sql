-- =============================================================================
-- 064: 端末を「止める」「失くした」「消す」を、台帳の上で扱えるようにする
--
-- ■ 何が足りていなかったか
--
--   退職・PC交換・故障・紛失のときに、管理画面からできることが
--   「停止」と「使用終了」しか無かった。どちらも台帳の状態を変えるだけで、
--
--     ・そのPCの中のエージェントは、そのまま動き続ける
--     ・資格情報も生きている
--     ・台帳には、もう無いPCが並び続ける
--
--   という状態になる。返ってこないPC（紛失・退職者の持ち出し）では、
--   これが一番まずい。
--
-- ■ どう分けるか
--
--   利用停止（suspended）
--     すぐに送信を止める。資格情報は生きたまま。あとで再開できる。
--     修理に出す・長期休職・様子を見たい、のときはこれ。
--
--   紛失（lost）
--     利用停止に加えて、資格情報をその場で失効させる。
--     手元に無いPCから記録が届き続けるほうが困る。
--     見つかれば「再開」で戻せる。
--
--   端末を削除（wipe）
--     資格情報を失効させたうえで、そのPCに「自分を消せ」と伝える。
--     エージェントが次にサーバへ来たときに受け取り、
--     サービス・拡張・継ぎ役・実行ファイル・自動起動をすべて外してから
--     「消し終わった」と報せてくる（api/devices/wiped）。
--     報せが来るまでは「削除待ち」。オフラインのPCは、次に
--     オンラインになった時点で消える。
--
-- ■ 「端末を消す」と「記録を消す」は別
--
--   ここで消えるのは、台帳に並ぶ1行と、そのPCの中のエージェント。
--   過去の監査記録・WEB利用・セキュリティのできごとは消さない。
--   消すのは保存期間（db/059 の掃除）に任せる。
--   端末を消したその場で記録まで消えると、
--   「辞める前に消しておけば残らない」が成り立ってしまう。
--
-- ■ 失効しているのに、なぜ資格情報を残すのか
--
--   「資格情報を失効させる」と「次の通信で消させる」は、
--   そのままだと両立しない。完全に殺すと、そのPCは自分への
--   消せという命令を受け取れなくなる。
--
--   そこで、失効とは「記録をもう受け取らない」こととして扱う。
--   残る力は、自分が消えるための2つだけ。
--
--     GET  /api/devices/config  … 消せという命令を受け取る
--     POST /api/devices/wiped   … 消し終わったと報せる
--
--   消し終わった報せが届いた時点で secret_hash を落とす。
--   そこではじめて、その資格情報は何もできなくなる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 053 → 054 → 055 → 057 → 059 → 060 → 061 の順で流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 台帳の列
-- -----------------------------------------------------------------------------
alter table public.gw_devices
  add column if not exists revoked_at        timestamptz,
  add column if not exists revoked_by        uuid,
  add column if not exists lost_at           timestamptz,
  add column if not exists wipe_requested_at timestamptz,
  add column if not exists wipe_requested_by uuid,
  add column if not exists wipe_reason       text,
  add column if not exists wipe_done_at      timestamptz,
  add column if not exists wipe_note         text,
  add column if not exists deleted_at        timestamptz;

comment on column public.gw_devices.revoked_at is
  '資格情報を失効させた時刻。これが入っている端末からは記録を受け取らない。'
  '残る力は「自分を消せという命令を受け取る」「消し終わったと報せる」だけ';
comment on column public.gw_devices.lost_at is
  '紛失として止めた時刻。見つかれば再開できる（この列も消える）';
comment on column public.gw_devices.wipe_requested_at is
  '管理者が「端末を削除」を押した時刻。これが入っていて wipe_done_at が'
  '空のあいだが「削除待ち」。オフラインのPCは、次につながったときに消える';
comment on column public.gw_devices.wipe_requested_by is
  '誰が削除を指示したか（auth.users.id）。gw_activity_log にも残る';
comment on column public.gw_devices.wipe_done_at is
  'そのPCから「消し終わった」と届いた時刻。ここで secret_hash を落とす';
comment on column public.gw_devices.wipe_note is
  'エージェントが消すときに、外せなかったものがあれば書いてくる';
comment on column public.gw_devices.deleted_at is
  '台帳から外した時刻。行は消さない。過去の記録が宙に浮くため。'
  '一覧には出さず、「削除済み」を開いたときだけ出す';

-- 削除待ちを引くための索引。台数が増えても、毎回の一覧で効く
create index if not exists idx_gw_devices_wipe_pending
  on public.gw_devices(tenant_id, wipe_requested_at)
  where wipe_requested_at is not null and wipe_done_at is null;

-- -----------------------------------------------------------------------------
-- 2) できごとに、この3つを足す
--
--    いつ誰が止めた・失効させた・消したかは gw_activity_log にも残るが、
--    端末の詳細（履歴タブ）からも辿れないと、その端末で何があったのかを
--    見るのに2画面を行き来することになる
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
    -- 054（エージェント側）
    'boot', 'shutdown', 'logon', 'logoff', 'lock', 'unlock', 'sleep', 'wake',
    'usb_attach', 'usb_detach', 'app_install', 'app_uninstall',
    'agent_start', 'agent_update', 'agent_error',
    -- 0.3.2（自分の重さ）
    'agent_load_high', 'agent_load_ok'))
  not valid;


notify pgrst, 'reload schema';

-- 確認:
--   select hostname, status,
--          revoked_at is not null  as 失効,
--          lost_at    is not null  as 紛失,
--          wipe_requested_at, wipe_done_at, deleted_at
--     from public.gw_devices
--    where tenant_id = (select id from public.gw_tenants limit 1)
--    order by last_seen_at desc nulls last limit 20;
