-- =============================================================================
-- 066: 入退社を「登録する画面」から「漏れなく進める画面」にする
--
-- ■ 何が足りていなかったか
--
--   入退社の画面は、チェックリストを作って並べるところまではできていた。
--   ところが、そのリストを **誰が見るのか** が決まっていなかった。
--
--     ・担当が hr / employee / labor_advisor の3つしか無い
--       PCの準備もメール発行も権限付与も、まとめて「人事」になる。
--       人事の人が「これ私の仕事だっけ」と毎回考えることになる
--     ・作っても誰にも知らされない
--       画面を開いた人だけが気づく。開かなければ入社日が来る
--     ・どの段階にいるのか分からない
--       「入社予定」なのか「準備中」なのか「初日対応」なのかが、
--       項目の消化数からしか読み取れない
--
--   結果、入社日の前日に「PCが無い」「メールが無い」が起きる。
--
-- ■ どう直すか
--
--   1. 担当を4つに分ける（人事 / IT・管理 / 上長 / 経理）
--      誰の仕事かが、リストを見た瞬間に分かるようにする
--   2. 段階（phase）を持つ
--      入社予定 → 入社準備 → 初日対応 → 完了
--      退社予定 → 退社準備 → 退社日対応 → 完了
--   3. 担当者を1人に決めて記録する（assignee_id）
--      「IT・管理の誰か」ではなく「この人」。決まっていないと誰もやらない
--   4. タスクから、その人の入退社画面へ直接飛べるようにする（gw_tasks.link）
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 005_groupware_core.sql / 008_onboarding.sql / 009_tasks.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 社内ロールに「IT・管理」と「経理」を足す
--
--    いままでは owner / hr / manager / labor_advisor の4つしか無く、
--    PCの準備も権限付与も給与確認も、ぜんぶ人事に寄っていた。
-- -----------------------------------------------------------------------------
alter table public.gw_role_grants drop constraint if exists gw_role_grants_role_check;
alter table public.gw_role_grants add constraint gw_role_grants_role_check
  check (role in ('owner', 'hr', 'manager', 'labor_advisor', 'it', 'finance'));

comment on column public.gw_role_grants.role is
  'owner=経営者 / hr=人事 / manager=責任者 / labor_advisor=社労士 / '
  'it=IT・管理（PC・アカウント・権限）/ finance=経理（給与・精算）';

-- -----------------------------------------------------------------------------
-- 2) チェックリストの項目に、担当と段階を持たせる
-- -----------------------------------------------------------------------------
alter table public.gw_procedure_items drop constraint if exists gw_procedure_items_owner_check;
alter table public.gw_procedure_items add constraint gw_procedure_items_owner_check
  check (owner in ('employee', 'hr', 'labor_advisor', 'it', 'manager', 'finance'));

alter table public.gw_procedure_items
  -- 入社準備 / 初日対応 / 退社準備 / 退社日対応。
  -- 「いつやるか」であって「終わったか」ではない
  add column if not exists phase       text,
  -- 誰がやるか。ロールではなく人。決まっていないと誰もやらない
  add column if not exists assignee_id uuid references public.gw_employees(id) on delete set null;

comment on column public.gw_procedure_items.phase is
  'prep=準備 / day1=初日対応 / lastday=退社日対応。段階の判定に使う';
comment on column public.gw_procedure_items.assignee_id is
  'この項目をやる人。ロール（owner列）から自動で決めて入れる。'
  '空のままだと「IT・管理の誰か」になり、誰もやらない';

create index if not exists idx_gw_procedure_items_assignee
  on public.gw_procedure_items(assignee_id, status)
  where assignee_id is not null;

-- -----------------------------------------------------------------------------
-- 3) 手続き本体に、いまの段階を持たせる
--
--    項目の消化数から毎回計算してもよいが、一覧で200件並べるたびに
--    全部の項目を読み直すことになる。決まった時点で書いておく
-- -----------------------------------------------------------------------------
alter table public.gw_procedures
  add column if not exists phase        text,
  -- 誰かに知らせたのはいつか。日付を変えたときに知らせ直すのに使う
  add column if not exists notified_at  timestamptz,
  add column if not exists notified_for date;

comment on column public.gw_procedures.phase is
  'planned=予定 / prep=準備 / day1=初日対応・lastday=退社日対応 / done=完了';
comment on column public.gw_procedures.notified_for is
  'どの日付で担当者に知らせたか。入社日を変えたら、もう一度知らせる';

-- -----------------------------------------------------------------------------
-- 4) タスクから、その人の入退社画面へ飛べるようにする
--
--    「あなたの担当が3件あります」と知らせても、そこから開けなければ
--    結局メニューを探すことになる
-- -----------------------------------------------------------------------------
alter table public.gw_tasks
  add column if not exists link text;

comment on column public.gw_tasks.link is
  'このタスクの行き先（例 admin-hr.html?id=…）。通知から直接開けるようにする';


-- -----------------------------------------------------------------------------
-- 5) 前の作りで入っている項目を、新しい手順に寄せる
--
--    新規メンバー登録（lib/onboard-kit.js）は、いままで
--    「PCの準備・初期設定」「Slack アカウント発行」などを入れていた。
--    新しい手順にも同じ作業があるので、そのままだと1つの入社に
--    似た項目が2行ずつ並ぶ。「どっちにチェックを付けたんだっけ」になる。
--
--    中身が同じものだけを寄せる。担当と段階も一緒に付け替える。
--    すでに新しい鍵が入っている手続きでは、寄せずに残す
--    （寄せると同じ鍵が2行になる）。残ったぶんは画面に出るので気づける。
-- -----------------------------------------------------------------------------
do $$
declare
  m record;
begin
  for m in
    select * from (values
      ('prep_pc',       'on_it_pc',      '会社PCの準備',                 'it',      'prep'),
      ('prep_slack',    'on_it_slack',   'Slack・グループウェアの発行',  'it',      'prep'),
      ('prep_timecard', 'on_it_perm',    '必要システムの権限付与',       'it',      'prep'),
      ('prep_intro',    'on_mgr_orient', 'オリエンテーション',           'manager', 'day1')
    ) as t(old_key, new_key, new_title, new_owner, new_phase)
  loop
    update public.gw_procedure_items i
       set item_key = m.new_key,
           title    = m.new_title,
           owner    = m.new_owner,
           phase    = m.new_phase,
           category = 'task'
     where i.item_key = m.old_key
       and not exists (
         select 1 from public.gw_procedure_items x
          where x.procedure_id = i.procedure_id
            and x.item_key = m.new_key);
  end loop;
end $$;

-- 段階が空のままの項目に、既定を入れておく。
-- 空だと「次にやること」の並び順が決まらない
update public.gw_procedure_items i
   set phase = case
         when p.kind = 'offboarding' then 'lastday'
         else 'prep' end
  from public.gw_procedures p
 where p.id = i.procedure_id
   and i.phase is null;


notify pgrst, 'reload schema';

-- 確認:
--   select p.phase, e.display_name, p.kind, p.target_on,
--          count(*) filter (where i.status in ('done','na')) as 済,
--          count(*) as 全部
--     from public.gw_procedures p
--     join public.gw_employees e on e.id = p.employee_id
--     left join public.gw_procedure_items i on i.procedure_id = p.id
--    group by p.id, p.phase, e.display_name, p.kind, p.target_on
--    order by p.target_on;
