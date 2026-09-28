-- =============================================================================
-- 091: 会社の印鑑（印影画像）と、署名依頼への押印スナップショット
--
-- ■ 何をするものか
--   代表者印・角印などの印影画像を登録しておき、電子署名の依頼を送るときに
--   選べるようにする。選んだ印影は、署名済みPDFの「電子署名記録」ページに
--   会社印として描かれる（lib/pdf-jp.js appendSignaturePage）。
--
-- ■ 印影は電子署名の証跡ではない
--   署名の正式な記録は 046 のまま（ログイン・署名者名・日時・IP・UA・同意文言・
--   PDF の SHA-256）。印影は契約書上の視覚的な押印として足すだけ。
--
-- ■ 送った時点の印影を固める（スナップショット）
--   印鑑マスタの画像は後から差し替えられる。差し替えたときに、送付済み・
--   締結済みの契約書の印影まで変わってはいけない。
--   だから送る時点で、印影画像を署名依頼ごとの場所
--     hr/<tenant>/esign/<request_id>/seal.(png|jpg)
--   へ複製し、そのパスとハッシュ・名前を依頼の行に持たせる。
--   署名するときはマスタではなく、この複製を読む（ハッシュも突き合わせる）。
--
-- ■ 画像は非公開のまま
--   既存の private バケット hr を使う（公開バケットは作らない）。
--   マスタの画像は hr/<tenant>/seals/<uuid>.(png|jpg)。差し替えのたびに別パスにする。
--   画面に出すときは api/sign/seals.js が数分だけ有効な signed URL を発行する。
--
-- ■ 書き込みは API（service_role）だけ
--   登録・変更・無効化は owner / admin のみ（lib/gw.js canManageSeals）。
--   読むのは署名依頼を出せる人（gw_is_hr）まで。
--
-- ■ 既存のものは変えない
--   新しい表と、gw_sign_requests への列の追加だけ。既存の列・関数・ポリシーには触らない。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 046_esign.sql（gw_sign_requests）
-- =============================================================================

begin;

create table if not exists public.gw_seals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,

  name         text not null,                 -- 「代表者印」「角印」
  seal_type    text not null default 'other'
               check (seal_type in ('representative', 'square', 'contract', 'other')),

  -- hr バケットの中のパス。差し替えのたびに別パス（上書きしない）
  image_path   text not null,
  image_mime   text not null default 'image/png'
               check (image_mime in ('image/png', 'image/jpeg')),
  image_sha256 text,
  image_size   integer,

  is_active    boolean not null default true,
  sort_order   integer not null default 0,

  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_gw_seals_tenant
  on public.gw_seals(tenant_id, is_active, sort_order);

comment on table public.gw_seals is
  '会社の印鑑（印影画像）。契約書上の視覚的な押印であり、電子署名の証跡ではない';

alter table public.gw_seals enable row level security;

drop policy if exists gw_seals_read on public.gw_seals;
create policy gw_seals_read on public.gw_seals
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

-- 署名依頼に、送った時点の印影を持たせる
alter table public.gw_sign_requests
  add column if not exists seal_id           uuid references public.gw_seals(id) on delete set null,
  add column if not exists seal_name         text,
  add column if not exists seal_type         text,
  add column if not exists seal_image_path   text,
  add column if not exists seal_image_sha256 text;

comment on column public.gw_sign_requests.seal_image_path is
  '送った時点の印影の複製（hr バケット）。印鑑マスタを差し替えても、この画像は変わらない';

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select name, seal_type, is_active from public.gw_seals order by sort_order;
--   select id, title, seal_name, seal_image_sha256 from public.gw_sign_requests where seal_id is not null;
