-- =============================================================================
-- 105: 給与管理（/keiei）— 給与の履歴と監査ログ
--
--   ■ なぜ
--     給与（基本給・手当・通勤手当）は、これまで契約（gw_contracts.wage_*）・内定（gw_hr_applicants /
--     gw_hr_offers / gw_hr_pay）・入社情報の届出（gw_onboard_profiles.commute_cost）・労働条件通知書の
--     「賃金」欄（文字列）・給与CSV に、別々に散っていた。手当は文章（wage_note）の中にしかなく、
--     「いつから、いくらか」を追える表がなかった。
--     経営（/keiei）を給与の正式な管理場所にするため、履歴が必ず残る表を1つ足す。
--
--   ■ 何を「正」とするか（Single Source of Truth）  docs/keiei-pay-management.md
--     現在の給与額（基本給・手当・通勤手当）          … gw_compensations（この表）
--     契約上の賃金（署名した書面が言っていること）      … gw_contracts / 署名済みPDF。記録するたびに、その時点の写しをここに残し、食い違いを見せる
--     内定時の給与                                      … gw_hr_pay。入社前の条件。入社時に、経営者が明示的に取り込む（自動では移さない）
--     本人が届け出た定期代                              … gw_onboard_profiles.commute_cost。参照だけ（会社が決めた通勤手当ではない）
--     この表と既存の表を、二重に書くことはしない。/keiei は既存の表へ書かない。
--
--   ■ 履歴が必ず残る（追記だけ）
--     ・行は、変更も削除もできない（トリガが止める。SQL Editor からでも）。
--     ・給与を変えるときは、新しい適用開始日の行を足す（kind=change）。
--     ・入力の誤りは、同じ適用開始日の「次の版」を足して直す（kind=correction、revision+1）。
--       前の版も残り、訂正の前後が監査できる。
--     ・変更前の値（before）と、変更した人・日時・理由を、行そのものに持つ。
--     ・初回給与を「候補」（契約・内定・本人の届出から作る。自動では登録しない）から登録したときは、
--       どのデータを基準にしたか・経営者がどの項目を直したかを basis に持つ。
--     ・いつからその給与か = effective_from。いまの給与は、適用開始日が今日以前で、いちばん新しい行の、最新の版。
--     ・社員の削除は止める（履歴を残すため。退職にする）。テナントごと消えるときだけ、一緒に消える。
--
--   ■ 監査ログ（gw_pay_audit）
--     記録の追加は、この表への INSERT トリガが自動で書く（API を通らない INSERT でも残る）。
--     開いた（一覧・個人・監査）は API が書く。書けなければ、API は給与を返さない。追記だけ。
--
--   ■ 見られる人
--     経営者（owner）だけ。加えて、本人は自分の行だけ読める。書くのはサーバ（service_role）だけ。
--     人事・管理者・責任者・採用担当・経理は読めない。既存の給与の権限（gw_can_see_salary など）は変えない。
--
--   ■ 入れないもの
--     unit_price（PP・BPの現場単価）は、この表に混ぜない。
--
--   ■ 前提
--     099（gw_is_owner）。gw_employees・tenants は既存。既存の表・列・ポリシーは変えない
--     （流しても、既存の画面・API の動きは変わらない）。
--
-- ■ 適用の順序
--     ① この SQL を流す（べき等）
--     ② 下の「B. 確認」
--     ③ アプリを再デプロイ（表が無いあいだは、アプリは「給与管理がまだ使えません」と案内し、止まらない）
--
-- ■ A. 元に戻す（履歴が消える。記録が1件でもあれば、実行の前に必ず控えを取る）
--     drop table if exists public.gw_pay_audit;
--     drop table if exists public.gw_compensations;
--     drop function if exists public.gw_comp_allowances_valid(jsonb);
--     drop function if exists public.gw_comp_immutable();
--     drop function if exists public.gw_comp_audit();
--     drop function if exists public.gw_pay_audit_immutable();
--
-- ■ B. 確認
--     select tablename, rowsecurity from pg_tables
--      where schemaname = 'public' and tablename in ('gw_compensations','gw_pay_audit');   -- → 2行、rowsecurity は true
--     select tablename, policyname, cmd from pg_policies where tablename in ('gw_compensations','gw_pay_audit');
--     -- → gw_compensations_owner / gw_compensations_self / gw_pay_audit_owner
--     select tgname from pg_trigger where tgname in ('gw_comp_immutable_trg','gw_comp_no_truncate_trg','gw_comp_audit_trg',
--                                                    'gw_pay_audit_immutable_trg','gw_pay_audit_no_truncate_trg');   -- → 5行
-- =============================================================================

begin;

-- 手当の内訳（[{name, amount}]）の形を、DB でも確かめる。名前は空でなく、金額は 0 以上の数、20 行まで
create or replace function public.gw_comp_allowances_valid(a jsonb)
returns boolean
language sql
immutable
as $$
  select a is not null
     and jsonb_typeof(a) = 'array'
     and jsonb_array_length(a) <= 20
     and not exists (
       select 1 from jsonb_array_elements(a) e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e -> 'name') is distinct from 'string'
           or length(btrim(e ->> 'name')) = 0
           or length(e ->> 'name') > 40
           or jsonb_typeof(e -> 'amount') is distinct from 'number'
           or (e ->> 'amount')::numeric < 0
           or (e ->> 'amount')::numeric > 10000000)
$$;

-- 1) 給与の履歴（追記だけ）
create table if not exists public.gw_compensations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  -- 社員は消せない（履歴を残す。退職にする）。「制限」ではなく既定の no action にしているのは、
  -- テナントごと消える cascade（履歴も一緒に消える唯一の場合）を通すため
  employee_id    uuid not null references public.gw_employees(id),

  effective_from date not null,                      -- 適用開始日（いつからこの給与か）
  revision       int  not null default 1 check (revision >= 1),   -- 同じ適用開始日の訂正の版

  wage_type      text not null check (wage_type in ('月給', '年俸', '時給', '日給')),
  base_amount    numeric(12, 0) not null check (base_amount >= 0 and base_amount <= 100000000),   -- 基本給（円。月給なら月額、年俸なら年額）
  allowances     jsonb not null default '[]'::jsonb check (public.gw_comp_allowances_valid(allowances)),   -- 手当 [{name, amount}]（月額・円）
  commute_amount numeric(10, 0) check (commute_amount is null or (commute_amount >= 0 and commute_amount <= 10000000)),   -- 通勤手当（月額・円）
  commute_note   text check (commute_note is null or length(commute_note) <= 200),

  -- 契約上の賃金（記録した時点の、その人の有効な契約の写し）。食い違いを見つけるための記録で、給与の正ではない
  contract_id          uuid,
  contract_wage_type   text,
  contract_wage_amount numeric,

  kind    text not null check (kind in ('initial', 'change', 'correction')),   -- 初回 / 変更 / 訂正
  source  text not null default 'owner' check (source in ('owner', 'contract_import', 'offer_import')),   -- 経営者の入力 / 契約から / 内定から
  reason  text not null check (length(btrim(reason)) between 1 and 500),       -- 変更理由・メモ

  -- 変更前（記録した時点で有効だった値の写し）。初回は null
  before  jsonb,

  -- 初回給与の「候補」（契約・内定・本人の届出から作る。自動では登録しない）から登録したとき、
  -- どのデータを基準に候補を作り、経営者がどの項目を直したか（lib/compensation-candidate.js）。候補を使わなければ null
  basis   jsonb,

  created_by      uuid references auth.users(id) on delete set null,
  created_by_name text,
  created_at      timestamptz not null default now(),

  unique (employee_id, effective_from, revision),
  -- 訂正（revision>1）と、そうでないもの（初回・変更）がずれないように
  check ((revision = 1 and kind in ('initial', 'change')) or (revision > 1 and kind = 'correction'))
);
-- 候補の基準の列は、後から足した。古い版の 105 を流した環境でも、もう一度流せば足される（べき等）
alter table public.gw_compensations add column if not exists basis jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gw_compensations_basis_shape' and conrelid = 'public.gw_compensations'::regclass) then
    alter table public.gw_compensations add constraint gw_compensations_basis_shape
      check (basis is null or (jsonb_typeof(basis) = 'object' and octet_length(basis::text) <= 4000));
  end if;
end
$$;
create index if not exists idx_gw_compensations_employee on public.gw_compensations(employee_id, effective_from desc, revision desc);
create index if not exists idx_gw_compensations_tenant on public.gw_compensations(tenant_id);

-- 2) 監査ログ（追記だけ）。employee_id に外部キーは張らない（社員の行が変わっても、ログは残す）
create table if not exists public.gw_pay_audit (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  actor_id    uuid,                      -- auth.users.id
  actor_name  text,
  action      text not null check (action in ('view_list', 'view_detail', 'view_audit', 'create', 'correct')),
  employee_id uuid,
  record_id   uuid,
  detail      jsonb
);
create index if not exists idx_gw_pay_audit_tenant_ts on public.gw_pay_audit(tenant_id, ts desc);
create index if not exists idx_gw_pay_audit_employee on public.gw_pay_audit(employee_id, ts desc);

-- 3) 追記だけにする。変更・削除・全消しは、SQL Editor からでも止める。
--    例外: テナントごと消えるとき（親の行が既に無い）だけ、一緒に消えてよい
create or replace function public.gw_comp_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    return old;
  end if;
  raise exception 'immutable: 給与の履歴は変更・削除できません。誤りは、同じ適用開始日の訂正（次の版）として追加してください'
    using errcode = 'P0001';
end
$$;

create or replace function public.gw_pay_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    return old;
  end if;
  raise exception 'immutable: 給与の監査ログは変更・削除できません' using errcode = 'P0001';
end
$$;

drop trigger if exists gw_comp_immutable_trg on public.gw_compensations;
create trigger gw_comp_immutable_trg before update or delete on public.gw_compensations
  for each row execute function public.gw_comp_immutable();
drop trigger if exists gw_comp_no_truncate_trg on public.gw_compensations;
create trigger gw_comp_no_truncate_trg before truncate on public.gw_compensations
  for each statement execute function public.gw_comp_immutable();

drop trigger if exists gw_pay_audit_immutable_trg on public.gw_pay_audit;
create trigger gw_pay_audit_immutable_trg before update or delete on public.gw_pay_audit
  for each row execute function public.gw_pay_audit_immutable();
drop trigger if exists gw_pay_audit_no_truncate_trg on public.gw_pay_audit;
create trigger gw_pay_audit_no_truncate_trg before truncate on public.gw_pay_audit
  for each statement execute function public.gw_pay_audit_immutable();

-- 4) 記録の追加を、監査ログへ自動で残す（API を通らない INSERT でも残る）。金額は写さない（記録そのものにある）
create or replace function public.gw_comp_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.gw_pay_audit (tenant_id, actor_id, actor_name, action, employee_id, record_id, detail)
  values (
    new.tenant_id, new.created_by, coalesce(new.created_by_name, case when new.created_by is null then 'db' end),
    case when new.kind = 'correction' then 'correct' else 'create' end,
    new.employee_id, new.id,
    jsonb_build_object('kind', new.kind, 'source', new.source, 'effective_from', new.effective_from,
                       'revision', new.revision, 'reason', new.reason, 'candidate', new.basis is not null));
  return new;
end
$$;
drop trigger if exists gw_comp_audit_trg on public.gw_compensations;
create trigger gw_comp_audit_trg after insert on public.gw_compensations
  for each row execute function public.gw_comp_audit();

-- 5) RLS: 経営者だけ。本人は自分の行だけ読める。書き込みのポリシーは無い（サーバ＝service_role だけが書く）
alter table public.gw_compensations enable row level security;
alter table public.gw_pay_audit     enable row level security;

drop policy if exists gw_compensations_owner on public.gw_compensations;
create policy gw_compensations_owner on public.gw_compensations
  for select using (public.gw_is_owner(tenant_id));
drop policy if exists gw_compensations_self on public.gw_compensations;
create policy gw_compensations_self on public.gw_compensations
  for select using (employee_id = public.gw_employee_id(tenant_id));
drop policy if exists gw_pay_audit_owner on public.gw_pay_audit;
create policy gw_pay_audit_owner on public.gw_pay_audit
  for select using (public.gw_is_owner(tenant_id));

comment on table public.gw_compensations is
  '給与の履歴（追記だけ）。現在の給与額の正。適用開始日ごとの行と、訂正の版。変更・削除はトリガが止める。unit_price は含めない';
comment on table public.gw_pay_audit is
  '給与管理の監査ログ（追記だけ）。記録の追加はトリガが自動で、開いた履歴は API が書く';

commit;

notify pgrst, 'reload schema';
