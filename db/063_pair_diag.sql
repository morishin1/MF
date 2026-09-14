-- =============================================================================
-- 063: 設定がどこで止まったのか、分かるようにする
--
-- ■ なぜ要るのか
--
--   Windows 実機で EIGHT-Agent-Setup.exe を実行したら、
--   「時間内に終わりませんでした。パソコンのソフトが起動していない
--     可能性があります。」で止まった。
--
--   ところが本当の原因は、PC側ではなくサーバ側だった。
--   api/devices/pair.js が enrollment_id を SELECT しておらず、
--   インストーラへ登録コードを渡していなかった。
--
--   画面のメッセージは「ソフトが起動していない可能性」としか言わない。
--   実際にはソフトは動いていて、3秒おきに取りにきていた。
--   **取りに来ているのか、来ていないのか**が分からないので、
--   PC側を疑うしかなかった。
--
--   そこで、取りに来た時刻を残す。これがあれば、
--
--     取りに来ていない → ソフトが動いていない（PC側）
--     取りに来ているのに渡っていない → サーバ側
--
--   を、その場で見分けられる。
--
-- ■ 個人のことは増やさない
--
--   足すのは時刻1つだけ。誰が・何を見たかは残さない。
--   札の行は、もともと組み立てのあいだしか生きていない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 057_device_one_pc.sql まで流してあること
-- =============================================================================

alter table public.gw_device_pairings
  add column if not exists last_poll_at timestamptz;

comment on column public.gw_device_pairings.last_poll_at is
  'インストーラが登録コードを取りにきた、いちばん新しい時刻。'
  '設定が終わらないときに「ソフトが動いていない」のか'
  '「動いているのに渡っていない」のかを見分けるために使う';


notify pgrst, 'reload schema';

-- 確認:
--   select id, kind, used_at is not null as claimed,
--          code_once is not null as code_waiting,
--          last_poll_at, expires_at
--     from public.gw_device_pairings
--    order by expires_at desc limit 10;
