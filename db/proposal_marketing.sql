-- 【提案・未適用】マーケティング（Office）：人ごとの既読・制作予定・動画の掲載記録。番号は適用を決めたときに振る。
--
-- ■ 何のためか（docs/office-marketing.md）
--   1. gw_marketing_reads           … 「対応が必要な業務」の人ごとの既読。未読と対応状態は別（開いただけで完了にしない）
--   2. gw_marketing_items           … 制作予定（コラム・SNS・YouTube・キャンペーン）。企画〜公開済みと担当・期限・公開URL
--   3. gw_marketing_video_placements … 既存のYouTube動画を、どのサイトのどこへ載せると確認したか（サイトごと）
--
-- ■ 別台帳を作らない
--   問い合わせ・注文・予約の本体はここに写さない（原本：採用HRの応募者・各事業のシステム）。
--   既読は「原本の種類＋原本ID」だけを持つ。表示名で紐づけない。
--   記事の本文もここに写さない。原本（自社サイトのお知らせ等）がある制作予定は source_type / source_id で原本を指し、
--   公開・下書きの状態は原本の値を画面で優先する。ここに持つのは、原本に項目が無い「企画・担当・期限・公開URL」だけ。
--
-- ■ 書き込み
--   API（api/marketing/index.js、service_role）だけ。画面（authenticated）からの直接の書き込みはさせない。
--   読むのも API 経由（画面に直接 select させる理由が無いので、authenticated には何も付けない）。
--
-- ■ 未適用のあいだ
--   API は「未準備」（not_ready）を返し、画面は「既読は確認できません」「制作予定の保存先が未準備です」と出す。0件にしない。
--   自社サイトのお知らせ（既存）・採用HRの無限道場リード（既存）は、この SQL が無くても読める。
--
-- ■ 前提
--   tenants・auth.users・gw_employees（db/005）
--
-- ■ 戻し方
--   db/proposal_rollback_marketing.sql（この3つの表と見張りだけを消す。原本には触れない）
--   確かめ方：db/check_proposal_marketing.sql（読むだけ）
begin;
do $$
begin
  if to_regclass('public.gw_employees') is null then
    raise exception '先に db/005_groupware_core.sql を適用してください';
  end if;
end $$;

-- ---- 1. 既読 -------------------------------------------------------------------------------
create table if not exists public.gw_marketing_reads (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source    text not null check (source in ('hr_lead')),
  source_id text not null check (length(source_id) between 1 and 200),
  user_id   uuid not null references auth.users(id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (tenant_id, source, source_id, user_id)
);
comment on table public.gw_marketing_reads is
  'マーケティング「対応が必要な業務」の人ごとの既読。原本の種類＋原本IDだけを持つ（中身は写さない）。'
  '未読と対応状態は別。書き込みはAPI（service_role）だけ。source は接続した原本を足すときに check へ足す';

-- ---- 2. 制作予定 ---------------------------------------------------------------------------
create table if not exists public.gw_marketing_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  biz               text not null check (biz in ('mugen', 'space', 'ec', 'site')),
  medium            text not null check (medium in ('column', 'sns', 'youtube', 'campaign')),
  sns_channel       text check (sns_channel is null or sns_channel in ('x', 'instagram', 'facebook', 'note', 'line', 'other')),
  title             text not null check (length(btrim(title)) between 1 and 200),
  -- 企画内容の要点・SNS文案。公開前の下書き。問い合わせの全文・個人情報は書かない（画面とAPIで注意を出す）
  summary           text check (summary is null or length(summary) <= 4000),
  owner_employee_id uuid references public.gw_employees(id) on delete set null,
  due_on            date,
  state             text not null default 'plan'
                      check (state in ('plan', 'drafting', 'review', 'scheduled', 'published')),
  -- 公開予定日。登録しても自動では公開しない（自動公開の許可・設定ではない）
  scheduled_on      date,
  public_url        text check (public_url is null or (public_url ~ '^https://[^[:space:]]+$' and length(public_url) <= 500)),
  -- 原本（いまは自社サイトのお知らせだけ）。原本がある項目は、公開・下書きを原本の値で見る
  source_type       text check (source_type is null or source_type in ('site_news')),
  source_id         text check (source_id is null or length(source_id) between 1 and 200),
  youtube_video_id  text check (youtube_video_id is null or youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  -- 企画のもとになった問い合わせ（[{source, id}]）。権限の無い人には API が出さない
  inquiry_refs      jsonb not null default '[]'::jsonb,
  version           integer not null default 1,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((source_type is null) = (source_id is null)),
  check (medium = 'sns' or sns_channel is null),
  check (medium = 'youtube' or youtube_video_id is null),
  check (jsonb_typeof(inquiry_refs) = 'array' and jsonb_array_length(inquiry_refs) <= 20),
  -- 公開済みは、公開URL（手で投稿したら記録）か原本のどちらかが要る
  check (state <> 'published' or public_url is not null or source_type is not null)
);
create unique index if not exists gw_marketing_items_source
  on public.gw_marketing_items (tenant_id, source_type, source_id) where source_type is not null;
create index if not exists gw_marketing_items_tenant
  on public.gw_marketing_items (tenant_id, state, due_on);
comment on table public.gw_marketing_items is
  '制作予定（コラム・SNS・YouTube・キャンペーン）。本文は原本（CMS）に置き、ここは企画・担当・期限・状態・公開URLだけ。'
  '公開予定の登録は自動公開ではない。書き込みはAPI（service_role）だけ';

-- 担当は同じテナントの社員だけ
create or replace function public.gw_marketing_items_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.owner_employee_id is not null and not exists (
    select 1 from public.gw_employees e where e.id = new.owner_employee_id and e.tenant_id = new.tenant_id
  ) then
    raise exception 'owner tenant mismatch' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id then
      raise exception 'tenant is immutable' using errcode = '23514';
    end if;
    new.version := old.version + 1;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists gw_marketing_items_guard on public.gw_marketing_items;
create trigger gw_marketing_items_guard
  before insert or update on public.gw_marketing_items
  for each row execute function public.gw_marketing_items_guard();

-- ---- 3. 動画の掲載記録 ---------------------------------------------------------------------
-- 「このサイトのこの位置に、この動画を、この説明で載せる」と人が確認した記録。サイトごとに1行。
-- 掲載先の仕組み（アダプタ）が無いサイトには行を作らない（API が「未対応」と返すだけ）。
create table if not exists public.gw_marketing_video_placements (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  item_id      uuid not null references public.gw_marketing_items(id) on delete cascade,
  video_id     text not null check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  site         text not null check (site in ('mugen', 'space', 'ec', 'site')),
  position     text not null check (length(btrim(position)) between 1 and 80),
  title        text not null check (length(btrim(title)) between 1 and 200),
  description  text check (description is null or length(description) <= 1000),
  -- 確認した内容（動画ID・掲載先・位置・タイトル・説明）のハッシュ。変わったら確認し直し
  confirm_hash text not null check (confirm_hash ~ '^[0-9a-f]{64}$'),
  state        text not null check (state in ('confirmed', 'published', 'failed', 'withdrawn')),
  result_note  text check (result_note is null or length(result_note) <= 500),
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- 二重掲載を防ぐ：同じ動画を同じサイトの同じ位置に、有効な掲載は1つだけ
create unique index if not exists gw_marketing_video_placements_live
  on public.gw_marketing_video_placements (tenant_id, video_id, site, position)
  where state in ('confirmed', 'published');
create index if not exists gw_marketing_video_placements_item
  on public.gw_marketing_video_placements (item_id);

create or replace function public.gw_marketing_video_placements_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.gw_marketing_items i where i.id = new.item_id and i.tenant_id = new.tenant_id) then
    raise exception 'tenant mismatch' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.item_id <> old.item_id or new.video_id <> old.video_id
       or new.site <> old.site then
      raise exception 'placement target is immutable' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists gw_marketing_video_placements_guard on public.gw_marketing_video_placements;
create trigger gw_marketing_video_placements_guard
  before insert or update on public.gw_marketing_video_placements
  for each row execute function public.gw_marketing_video_placements_guard();

-- ---- 権限：画面からは触らせない（API の service_role だけ） --------------------------------
alter table public.gw_marketing_reads enable row level security;
alter table public.gw_marketing_items enable row level security;
alter table public.gw_marketing_video_placements enable row level security;
revoke all on public.gw_marketing_reads, public.gw_marketing_items, public.gw_marketing_video_placements
  from anon, authenticated;
grant all on public.gw_marketing_reads, public.gw_marketing_items, public.gw_marketing_video_placements
  to service_role;

notify pgrst, 'reload schema';
commit;
