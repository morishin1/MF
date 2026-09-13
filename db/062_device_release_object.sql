-- =============================================================================
-- 062: 配布物を Storage に置き、URLはそのつど短時間だけ出す
--
-- ■ 何を変えるのか
--
--   これまで gw_device_releases.url に配布先を固定で持っていた。
--   非公開バケットに置くなら、長く生きるURLを表に持つのは筋が悪い。
--   漏れたらそのまま落とせるし、消すまで有効なままになる。
--
--   代わりに「どこに置いたか」（バケットとパス）だけを持ち、
--   落とすときに短時間だけ有効なURLをそのつど作る。
--
--     表に持つもの … version / bucket / object_path / sha256 / size / 署名
--     そのつど作る … 5分だけ有効な署名つきURL
--
-- ■ 署名の対象が変わる
--
--   058 では version / url / sha256 / size の4つに署名していた。
--   URLが毎回変わるなら、URLに署名しても合わない。
--
--   代わりに **置き場所**（object_path）に署名する。
--   場所は変わらないので、署名はそのまま通る。
--   「別の物にすり替える」は、落としたあとの SHA-256 で止まる。
--
--     署名の対象: version \n <object_path または url> \n sha256 \n size
--
--   外の場所（自社サーバなど）に置く版は、これまでどおり url に署名する。
--   両方が同じ関数を通るので、判定が2つに分かれない。
--
-- ■ 将来、社員が自分で入れられるようにするための設定も足す
--
--   いまは会社貸与PCへのソフト導入は管理者・IT担当が行う
--   （コード署名証明書を使わないので、Windows の警告を
--     社員に越えさせない、という判断）。
--   警告なしで配れる道ができたら、設定1つで切り替えられるようにしておく。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 058 → 061 まで流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 置き場所を持つ
-- -----------------------------------------------------------------------------
alter table public.gw_device_releases
  add column if not exists bucket text;
alter table public.gw_device_releases
  add column if not exists object_path text;

comment on column public.gw_device_releases.bucket is
  '配布物を置いた Storage のバケット。既定は agent';
comment on column public.gw_device_releases.object_path is
  'バケットの中のパス（例 0.3.0/EIGHT-Agent-Setup.exe）。'
  '落とすときは、ここから短時間だけ有効なURLをそのつど作る。'
  '署名の対象にもなる（URLは毎回変わるので、URLには署名しない）';
comment on column public.gw_device_releases.url is
  '外の場所（自社サーバなど）に置く場合の配布先。'
  'Storage に置くなら object_path を使い、ここは空でよい';

-- url は、Storage に置くなら要らない。
-- 054 では not null だったので、外せるようにする
do $$
begin
  alter table public.gw_device_releases alter column url drop not null;
exception when others then null;
end $$;

-- 置き場所か URL の、どちらかは要る
alter table public.gw_device_releases
  drop constraint if exists gw_device_releases_where;
alter table public.gw_device_releases
  add constraint gw_device_releases_where
  check (
    not published
    or object_path is not null
    or url is not null
  )
  not valid;
alter table public.gw_device_releases
  validate constraint gw_device_releases_where;


-- -----------------------------------------------------------------------------
-- 2) 社員が自分で入れられるようにするかどうか
--
--    いまは false。会社貸与PCへのソフト導入は管理者・IT担当が行う。
--
--    コード署名証明書を使わないので、初回に Windows の警告が出る。
--    「警告が出たら詳細情報→実行」を社員に覚えさせると、
--    本物の怪しいEXEでも同じことをするようになる。
--    セキュリティ教育として割に合わないので、社員には越えさせない。
--
--    警告なしで配れる道ができたら、ここを true にすれば
--    画面の案内が社員向けの手順に変わる
-- -----------------------------------------------------------------------------
alter table public.gw_device_policies
  add column if not exists self_install boolean not null default false;

comment on column public.gw_device_policies.self_install is
  'true=社員が自分でインストーラを実行する / '
  'false=管理者・IT担当が会社貸与PCで実行する（既定）。'
  'false のあいだ、社員向けの画面に Windows の警告の越え方は出さない';


notify pgrst, 'reload schema';

-- 確認:
--   select version, bucket, object_path, left(url, 40) as url,
--          size_bytes, key_id, published
--     from public.gw_device_releases order by created_at desc;
--
--   select self_install from public.gw_device_policies;
--
-- 版の登録（管理者が1回だけ）:
--   1. agent/build.sh で EIGHT-Agent-Setup.exe を作る
--   2. Supabase の Storage → agent バケットに
--      <版>/EIGHT-Agent-Setup.exe として上げる
--   3. 署名する（docs/device-zero-cost.md）
--        go run ./cmd/eight-agent-keygen -key <秘密鍵> \
--           -version 0.3.0 -locator 0.3.0/EIGHT-Agent-Setup.exe \
--           -file dist/EIGHT-Agent-Setup.exe
--   4. 出てきた値をこの表に入れて published = true にする
