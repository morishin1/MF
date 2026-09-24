-- =============================================================================
-- 079: メンバー → 管理サイド共通チャット
--
-- ■ 目的
--   一般メンバーが「誰に送ればいいか分からない」状態をなくす。
--   メンバー側には［管理サイドへ連絡］という入口を1つだけ出し、
--   管理者個人を選ばせるのではなく、管理者・経営者・人事/事務側の
--   「共通受信箱」に届ける。
--
-- ■ 新しいチャット基盤は作らない
--   既存の gw_threads / gw_thread_members / gw_messages（010）をそのまま使う。
--   gw_threads.kind に 'admin_contact' を1つ足すだけで、
--   テーブルも RLS も増やさない（gw_in_thread による
--   「参加している人だけ見える」はそのまま。管理者であっても
--   参加していないスレッドは読めない、という010の方針も崩さない）。
--
-- ■ 「共通受信箱」をどう実現するか（参加者を固定で決め打ちしない）
--   本人 + そのときの管理サイド（gw_is_hr と同じ判定 = hr/owner ロール、
--   または memberships が admin/staff）を、
--     ・スレッドを開設した時点（api/messages/admin-contact.js）
--     ・以後、管理サイドの人がメッセージ一覧を開くたび（api/messages/index.js）
--   に gw_thread_members へ足す（010の方針どおり、参加者の追加はRLSでは
--   許可せず service_role のみで書く）。
--   新しく管理側になった人も、次にメッセージ画面を開けば過去のやりとりごと
--   見えるようになる。抜けた人を自動では外さない（051と同じ考え方。
--   外すのは運用で）。
--
-- ■ 本人専用
--   1人につき、この種類のスレッドは1本だけ。contact_employee_id で
--   「誰の窓口か」を持ち、(tenant_id, contact_employee_id) の
--   一意インデックスで二重に作られないようにする。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 010_messages.sql / 041_admin_is_hr.sql が適用済み
-- =============================================================================

-- kind に 'admin_contact' を追加
alter table public.gw_threads drop constraint if exists gw_threads_kind_check;
alter table public.gw_threads
  add constraint gw_threads_kind_check
  check (kind in ('dm', 'group', 'admin_contact'));

-- 本人専用の窓口。kind='admin_contact' のときだけ入る
alter table public.gw_threads
  add column if not exists contact_employee_id uuid references public.gw_employees(id) on delete set null;

comment on column public.gw_threads.contact_employee_id is
  'admin_contact のときだけ入る。この窓口が誰のためのものか（管理サイドへ連絡してきた本人）。'
  'dm/group では常に null';

-- 1人1本。二重に作られない
create unique index if not exists uq_gw_threads_admin_contact
  on public.gw_threads(tenant_id, contact_employee_id)
  where kind = 'admin_contact';

notify pgrst, 'reload schema';

-- 確認:
--   -- 誰の窓口が、いま何人に見えているか
--   select e.display_name as 本人, t.id, t.created_at,
--          (select count(*) from public.gw_thread_members m where m.thread_id = t.id) as 参加人数
--     from public.gw_threads t
--     join public.gw_employees e on e.id = t.contact_employee_id
--    where t.kind = 'admin_contact'
--    order by t.created_at desc;
