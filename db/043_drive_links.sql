-- =============================================================================
-- 043: メンバーに渡すフォルダのリンク
--
-- ■ 何のためか
--   「今福さんが使うフォルダはここ」を、管理者がURLで貼れるようにする。
--   本人はマイページから開ける。
--   毎回チャットで送り直したり、ブックマークを各自で管理したりしなくてよくなる。
--
-- ■ 入社手続きのフォルダとは別
--   gw_procedures.drive_link は「入社の書類を出す場所」で、
--   手続きが終われば役目も終わる。
--   こちらは在籍しているあいだ使い続ける、仕事用のフォルダ。
--   同じ列に相乗りさせると、手続きが完了したときにどちらも消すことになる。
--
-- ■ 全員向けにも置ける
--   employee_id が null の行は、全員のマイページに出る。
--   「社内共有」「営業資料」のような、みんなが使うフォルダ。
--
-- ■ mf に貼っても、権限は増えない
--   ここに入るのはリンクだけ。
--   実際に開けるかどうかは Google ドライブ側の共有設定で決まる。
--   貼る前に、そのフォルダを本人に共有しておく必要がある。
--   画面にもそう書いてある（開けなかったときに、ここを疑わせないため）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

create table if not exists public.gw_drive_links (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- null なら全員向け。誰かを指すとその人だけに出る
  employee_id uuid references public.gw_employees(id) on delete cascade,

  label       text not null,              -- 「営業資料」「今福さん作業用」など
  url         text not null,              -- 開くURL（?usp=… は保存時に落とす）
  folder_id   text,                       -- URLから取り出したフォルダID。突き合わせ用
  note        text,                       -- 使い方の一言（任意）

  sort_order  integer not null default 0,

  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_gw_drive_links_emp
  on public.gw_drive_links(tenant_id, employee_id, sort_order);

comment on table public.gw_drive_links is
  'メンバーに渡すフォルダのリンク。employee_id が null なら全員向け。'
  'ここに貼っても権限は増えない。共有は Google ドライブ側で行う';


-- -----------------------------------------------------------------------------
-- RLS
--   本人は「自分向け」と「全員向け」だけ読める。
--   他人のフォルダのURLは見せない。URLそのものが、その場所への案内になる。
--   書き込みは service_role の API（api/drive-links.js）だけ
-- -----------------------------------------------------------------------------
alter table public.gw_drive_links enable row level security;

drop policy if exists gw_drive_links_read on public.gw_drive_links;
create policy gw_drive_links_read on public.gw_drive_links
  for select to authenticated
  using (
    employee_id is null
    or employee_id = public.gw_employee_id(tenant_id)
    or public.gw_is_hr(tenant_id)
  );


notify pgrst, 'reload schema';

-- 確認:
--   select coalesce(e.display_name, '（全員）') as 相手, l.label, l.url
--     from public.gw_drive_links l
--     left join public.gw_employees e on e.id = l.employee_id
--    order by e.display_name nulls first, l.sort_order;
