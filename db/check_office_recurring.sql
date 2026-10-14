-- =============================================================================
-- Office 定例業務（db/125）の状態確認。読み取りだけ（何も書き換えない）。Supabase の SQL Editor で全体を貼って Run。
--
-- 結果の見かた（どれも、業務の文言・個人名は出さない。件数と ID だけ）
--   1) カテゴリ別のマスター数（有効／停止）
--   2) 担当者が未設定・退職のままの有効なマスター数（0 が望ましい）
--   3) 同じマスター・同じ日の予定が2件以上ある数（必ず 0。一意の索引で止まる）
--   4) 状態別の予定数と、期限超過（未完了で期限が今日より前）の数
--   5) 今日から先90日に予定が1件も無い有効なマスター（毎年の業務は 0件でも正常。毎月・毎週で出たら cron を確かめる）
-- =============================================================================

-- 1) カテゴリ別のマスター数
select category, count(*) filter (where is_active) as active, count(*) filter (where not is_active) as stopped
  from public.gw_office_recurring_tasks group by category order by category;

-- 2) 担当者が未設定・退職のままの有効なマスター数
select count(*) as assignee_missing
  from public.gw_office_recurring_tasks t
  left join public.gw_employees e on e.id = t.assignee_employee_id
 where t.is_active and (t.assignee_employee_id is null or e.id is null or e.status = 'left');

-- 3) 二重にできた予定（必ず 0）
select count(*) as duplicated
  from (select recurring_task_id, event_date from public.gw_office_calendar_events
         where recurring_task_id is not null group by 1, 2 having count(*) > 1) d;

-- 4) 状態別の予定数と、期限超過
select status, count(*) as events,
       count(*) filter (where status = 'pending' and coalesce(due_on, event_date) < (now() at time zone 'Asia/Tokyo')::date) as overdue
  from public.gw_office_calendar_events group by status order by status;

-- 5) 先90日に予定が無い有効なマスター（ID と繰り返しの種類だけ）
select t.id, t.recurrence_type
  from public.gw_office_recurring_tasks t
 where t.is_active
   and not exists (select 1 from public.gw_office_calendar_events e
                    where e.recurring_task_id = t.id
                      and e.event_date between (now() at time zone 'Asia/Tokyo')::date
                                           and (now() at time zone 'Asia/Tokyo')::date + 90)
 order by t.recurrence_type, t.id;
