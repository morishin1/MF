-- =============================================================================
-- 058: 更新ファイルを、自前の鍵で確かめる
--
-- ■ なぜ要るのか
--   商用のコード署名証明書は使わない（費用をかけない方針）。
--   そうすると Windows は「このEXEを誰が作ったか」を確かめてくれない。
--
--   だからといって「落としたEXEをそのまま実行する」自動更新にはできない。
--   配布先のURLが乗っ取られたら、全台で任意のプログラムが動く。
--   商用証明書が無いぶん、**こちらで確かめる**。
--
-- ■ どう確かめるか
--   リリースのたびに、社内で持っている Ed25519 の秘密鍵で1行に署名する。
--
--     version \n url \n sha256 \n size
--
--   エージェントには対になる公開鍵が焼き込んである（組み立てのときに埋める）。
--   署名が合わなければ、URLを開きにすらいかない。
--   落としたあとも SHA-256 を確かめ、合わなければ捨てる。
--   **どちらか一方でも合わなければ、絶対に実行しない。**
--
-- ■ 商用証明書の代わりではない
--   これは「配るものが、うちが作ったものか」を確かめるだけ。
--   Windows の SmartScreen は黙らない（初回に警告が出る）。
--   社内PCだけが対象で、最初の1回は管理者が入れるので、それでよいと決めた。
--   将来、証明書を用意したくなったら足せる（この仕組みは残したままでよい）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 054 を先に流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) リリースに、署名と大きさを足す
-- -----------------------------------------------------------------------------
alter table public.gw_device_releases
  add column if not exists signature text;
alter table public.gw_device_releases
  add column if not exists size_bytes bigint;
-- どの鍵で署名したか（鍵を入れ替えたときに、どれが古いか分かるように）
alter table public.gw_device_releases
  add column if not exists key_id text;

comment on column public.gw_device_releases.signature is
  'Ed25519 の署名（base64url）。署名した文字列は '
  '"version\nurl\nsha256\nsize" の4行。'
  'エージェントは公開鍵で確かめ、合わなければ URL を開きにいかない';
comment on column public.gw_device_releases.key_id is
  '署名に使った公開鍵の先頭8文字。鍵を入れ替えたときの目印';


-- -----------------------------------------------------------------------------
-- 2) 署名の無いリリースを、公開できないようにする
--
--    「とりあえず公開して、署名はあとで」を作らない。
--    署名が無い行は published にできない
-- -----------------------------------------------------------------------------
alter table public.gw_device_releases
  drop constraint if exists gw_device_releases_signed;
alter table public.gw_device_releases
  add constraint gw_device_releases_signed
  check (
    not published
    or (signature is not null and sha256 is not null and size_bytes is not null)
  )
  not valid;

-- 既にある行は、published を落としてから確かめる（署名がまだ無いため）
update public.gw_device_releases set published = false
 where published and signature is null;

alter table public.gw_device_releases validate constraint gw_device_releases_signed;


notify pgrst, 'reload schema';

-- 確認:
--   select version, published, key_id, left(signature, 12) as sig, size_bytes
--     from public.gw_device_releases order by created_at desc;
