-- =============================================================================
-- 037: 入社手続きを「管理者1回・本人1回」にする
--
-- ■ 何を変えるか
--   これまで入社手続きは、管理者が新規メンバー登録とは別に
--   admin-hr.html から手で作っていた。本人側も、書類の提出チェックが
--   home.html に並ぶだけで、住所や口座を入れる場所が無かった。
--   結果、同じことを 登録フォーム → 手続き作成 → 紙やメール → 社労士へ転記
--   と何度も書き写すことになっていた。
--
--   登録フォームを1回出せば、手続き・チェックリスト・準備タスク・
--   個人フォルダまで自動で作る。本人は入社フォーム1つで、
--   個人情報・書類・同意をまとめて終わらせる。
--   集まった情報から、社労士連絡用のテキストとSlack投稿文を組み立てる。
--
-- ■ マイナンバーは、この仕組みでは保存しない
--   番号法（マイナンバー法）は、番号そのものに別立ての安全管理措置を求める。
--   取扱区域・アクセス記録・保管期限後の確実な廃棄まで含むので、
--   ふつうのアプリのテーブルに1列足して済ませてよいものではない。
--
--   ここでは「本人が書類を出したか」だけを持ち、番号は列に置かない。
--   書類そのものは hr バケット（人事だけが見られる）に入れ、
--   社労士へは既存の共有項目（share_with_advisor）の経路で渡す。
--
-- ■ 個人情報は、人事と本人だけが読む
--   社労士にも必要だが、テーブルを直接見せるのではなく、
--   人事が確認したうえで「社労士連絡用」のテキストを渡す形にする。
--   何を渡したかが、渡す前に画面で見えるようにするため。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 本人が入れる情報
--    1人1行。入社フォームから保存する。
--    管理者が登録フォームで入れた項目（氏名・入社日・契約・勤務時間・
--    担当業務・給与）はここに持たない。二重に持つと、どちらが正かが決まらない。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_onboard_profiles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null unique references public.gw_employees(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,

  -- 本人
  name_kana     text,
  birth_date    date,
  postal_code   text,
  address       text,
  phone         text,

  -- 緊急連絡先
  emg_name      text,
  emg_relation  text,
  emg_phone     text,

  -- 通勤
  commute_from  text,          -- 最寄駅・出発地
  commute_route text,          -- 経路
  commute_cost  numeric,       -- 1か月の定期代

  -- 給与振込先
  bank_name     text,
  bank_branch   text,
  bank_type     text check (bank_type in ('普通', '当座') or bank_type is null),
  bank_number   text,
  bank_holder   text,          -- 名義（カナ）

  -- 社会保険・雇用保険の手続きに要るもの。
  -- 基礎年金番号と雇用保険番号は、番号法の対象ではないのでここで持つ。
  -- マイナンバーは持たない（このファイルの頭に理由を書いた）
  pension_number   text,
  employment_ins_number text,
  has_dependents   boolean,
  dependents_note  text,

  -- 本人からの一言。Slackの紹介文に使う
  greeting text,

  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.gw_onboard_profiles is
  '入社時に本人が入れる情報。マイナンバーは保存しない（037の冒頭を参照）。'
  '管理者が登録フォームで入れた項目は gw_employees / gw_contracts 側が正';

create index if not exists idx_gw_onboard_profiles_tenant
  on public.gw_onboard_profiles(tenant_id, status);


-- -----------------------------------------------------------------------------
-- 2) 同意（誓約書・個人情報の取扱い・社内ルール）
--    いつ・どの版に同意したかを残す。版を上げたら取り直す
-- -----------------------------------------------------------------------------
create table if not exists public.gw_onboard_consents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,

  kind    text not null,          -- pledge / privacy / rules。値は lib/onboard-form.js
  version text not null default 'v1',
  agreed_at timestamptz not null default now(),

  unique (employee_id, kind, version)
);

create index if not exists idx_gw_onboard_consents_employee
  on public.gw_onboard_consents(employee_id);


-- -----------------------------------------------------------------------------
-- 3) チェックリストの項目に、機械で引ける鍵を付ける
--    自動で作った項目と、本人フォームの入力欄を突き合わせるのに使う。
--    題名で突き合わせると、題名を編集した瞬間に紐づかなくなる
-- -----------------------------------------------------------------------------
alter table public.gw_procedure_items
  add column if not exists item_key text;

comment on column public.gw_procedure_items.item_key is
  '自動生成した項目の識別子。本人フォームの入力欄と突き合わせるのに使う。'
  '人が手で足した項目は null';

create index if not exists idx_gw_procedure_items_key
  on public.gw_procedure_items(procedure_id, item_key)
  where item_key is not null;


-- -----------------------------------------------------------------------------
-- 4) RLS
--    個人情報は、人事と本人だけ。社労士（gw_is_advisor）は入れない。
--    社労士へは、人事が内容を確認したうえで連絡用テキストを渡す。
--    書き込みは service_role の API だけが行う（本人が status を
--    勝手に submitted にできると、確認前のものが揃った扱いになる）。
-- -----------------------------------------------------------------------------
alter table public.gw_onboard_profiles enable row level security;
alter table public.gw_onboard_consents enable row level security;

drop policy if exists gw_onboard_profiles_select on public.gw_onboard_profiles;
create policy gw_onboard_profiles_select on public.gw_onboard_profiles
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_onboard_consents_select on public.gw_onboard_consents;
create policy gw_onboard_consents_select on public.gw_onboard_consents
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );


notify pgrst, 'reload schema';

-- 確認:
--   -- 本人が出した情報（マイナンバーの列が無いことを目で確かめる）
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_onboard_profiles'
--    order by ordinal_position;
--
--   -- 入社準備の進み具合
--   select e.display_name, p.status,
--          count(*) filter (where i.status in ('done','na')) as 完了,
--          count(*) as 全体
--     from public.gw_procedures p
--     join public.gw_employees e on e.id = p.employee_id
--     left join public.gw_procedure_items i on i.procedure_id = p.id
--    where p.kind = 'onboarding'
--    group by e.display_name, p.status;
