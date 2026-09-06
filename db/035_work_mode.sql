-- =============================================================================
-- 035: 勤務・育成区分を持たせる／給与を読める人を絞る
--
-- ■ 登録を「勤務・育成区分 × 担当業務」の2軸にした
--   これまでは「新卒営業」「中途エンジニア」のように、雇い方と仕事内容を
--   1つのテンプレートに畳んでいた。雇い方が1つ増えるたびに職種のぶんだけ
--   増えるので、5×9 = 45通りを並べることになる。
--
--   区分（どう雇うか）と担当業務（何を目標にするか）を分けて掛け合わせる。
--   job_family_code は既にあるので、ここでは区分の側だけ足す。
--
-- ■ 給与を読める人を、人事と本人だけにする
--   029 で gw_contracts に wage_type / wage_amount / wage_note を作ってあるが、
--   select のポリシーが gw_is_internal_staff() なので、社内の誰でも
--   全員の給与額が読める状態になっている。
--
--   これまでは登録時に給与を入れていなかったので実害が無かったが、
--   新規登録フォームから給与を入れるようになると、入れた瞬間に
--   全社員に見えることになる。先に絞る。
--
--   RLSは列を選べないので、行ごと絞る。人事（gw_is_hr）と本人だけ。
--   契約の一覧・更新面談の画面は、もともと人事しか開けない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 勤務・育成区分
--    GROWTH（育成併用） / EXPERIENCED（経験者） / PART（短時間）
--    INTERN（インターン） / MANAGER（管理職）
--
--    値の妥当性は lib/work-modes.js で見る。check 制約は置かない。
--    区分を1つ足すたびにマイグレーションが要るのは、重すぎる。
-- -----------------------------------------------------------------------------
alter table public.gw_employees
  add column if not exists work_mode text;

comment on column public.gw_employees.work_mode is
  '勤務・育成区分。どう雇うか（期間・時間・権限・開始レベル）。'
  '何を目標にするかは job_family_code 側。値は lib/work-modes.js';

create index if not exists idx_gw_employees_work_mode
  on public.gw_employees(tenant_id, work_mode)
  where work_mode is not null;


-- -----------------------------------------------------------------------------
-- 2) 給与を含む契約行を、人事と本人だけに絞る
--
--    029 の gw_contracts_select を置き換える。
--    差し替えなので、先に drop してから作り直す。
-- -----------------------------------------------------------------------------
drop policy if exists gw_contracts_select on public.gw_contracts;
create policy gw_contracts_select on public.gw_contracts
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

-- 契約から生まれる予定（試用期間の満了・更新面談）は、給与を持たない。
-- ここは人事のまま変えない。
--
-- なお api/contracts/index.js は service_role で読むので RLS を通らない。
-- あちらは入口で admin / owner / 人事 に絞ってある。
-- このポリシーが塞ぐのは、ブラウザから直接テーブルを読む経路。
-- 画面はすべてAPI経由なので、この変更で見えなくなる画面は無い。


notify pgrst, 'reload schema';

-- 確認:
--   -- 区分の列があるか
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'gw_employees'
--      and column_name = 'work_mode';
--
--   -- 給与のポリシーが人事と本人だけになっているか
--   select polname, pg_get_expr(polqual, polrelid) as using_expr
--     from pg_policy
--    where polrelid = 'public.gw_contracts'::regclass;
--
--   -- 登録された人の区分と担当業務
--   select display_name, work_mode, job_family_code, initial_role, autonomy_level
--     from public.gw_employees
--    where work_mode is not null
--    order by created_at desc;
