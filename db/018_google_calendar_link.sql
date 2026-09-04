-- =============================================================================
-- 018_google_calendar_link.sql — 各自の Google カレンダー連携
--
-- 前提: db/017_schedule.sql が適用済みであること。
--
-- 何を保存するか
--   本人が同意して発行された refresh token を1人1行で持つ。
--   これは「その人のカレンダーを読み続けられる鍵」なので、
--   ・列の中身は暗号化して入れる（api/google/* が AES-256-GCM で出し入れする）
--   ・RLS のポリシーを1つも置かない ＝ anon / authenticated からは読めない
--   の二重で守る。service_role（サーバ側の API）だけが触れる。
--
--   連携しているかどうか、どのアドレスか、は画面に出す必要があるので、
--   API が必要な列だけを選んで返す。トークンそのものは返さない。
--
-- スペース予約（015）が使っているサービスアカウントとは別の仕組み。
-- あちらは「会社の共有カレンダーに書く」、こちらは「各自のカレンダーを読む」。
-- サービスアカウントで個人のカレンダーを読むにはドメイン全体の委任が必要で、
-- それは全社員のカレンダーを本人の同意なく読める強すぎる権限になるため使わない。
-- =============================================================================

create table if not exists public.gw_google_links (
  employee_id    uuid primary key references public.gw_employees(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,

  -- どの Google アカウントとつないだか。本人が確認するために出す
  google_email   text,

  -- AES-256-GCM で暗号化した refresh token（平文では入れない）
  refresh_token  text not null,
  scope          text,

  connected_at   timestamptz not null default now(),
  last_synced_at timestamptz,
  -- 直近の取得で失敗した理由。連携が切れたことに気づけるようにする
  sync_error     text
);

create index if not exists idx_gw_google_links_tenant
  on public.gw_google_links(tenant_id);


-- -----------------------------------------------------------------------------
-- RLS: ポリシーを置かない ＝ 誰も直接は読めない。
--      有効化だけして、service_role からのアクセスに限る。
-- -----------------------------------------------------------------------------
alter table public.gw_google_links enable row level security;

-- 念のため、以前の版で作ったポリシーが残っていたら消す
drop policy if exists gw_google_links_own on public.gw_google_links;
