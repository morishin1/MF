-- =============================================================================
-- 052: 月次締め
--
-- ■ 何のための画面か
--   勤怠・休暇・経費は入口が別々にある。それでよい。
--   困るのは月初で、「この人の分は全部そろったか」を3画面で照合していた。
--   締めるときだけ、1か所に集める。
--
-- ■ 未承認が残っていたら締められない
--   締めたあとに経費の申請が出てくると、給与を計算し直すことになる。
--   締める側が「見落とし」を防ぐのではなく、
--   仕組みが「見落とせない」ようにする。
--
-- ■ 何を保存するか
--   集計そのものは保存しない。締めたときに数え直せばよく、
--   写しを持つと、元データを直したときに食い違う。
--   保存するのは「いつ・誰が締めたか」と、そのときの数字の控えだけ。
--   控え（snapshot）は、あとで「締めたときは何件だったか」を見るためのもので、
--   画面が読むのは常に元データのほう。
--
-- ■ 打刻の締め（gw_time_entries.locked_at）との関係
--   月次締めを実行すると、その月の打刻もまとめて締める。
--   打刻だけ締まっていて月は締まっていない、という状態を作らない。
-- =============================================================================

create table if not exists public.gw_month_closings (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,

  -- 'YYYY-MM'。日付型にしないのは、月そのものが単位だから
  month      text not null check (month ~ '^\d{4}-\d{2}$'),

  status     text not null default 'open'
             check (status in ('open', 'closed')),

  closed_by  uuid references auth.users(id) on delete set null,
  closed_at  timestamptz,
  reopened_by uuid references auth.users(id) on delete set null,
  reopened_at timestamptz,
  -- 締めを解いた理由。解くこと自体は必要だが、理由なく解けるべきではない
  reopen_reason text,

  -- 締めた時点の数字の控え。画面はここを読まない（元データを数え直す）。
  -- 「締めたときは何件だったか」を、あとから確かめるためだけに持つ
  snapshot   jsonb not null default '{}'::jsonb,

  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gw_month_closings_once unique (tenant_id, month)
);

create index if not exists idx_gw_month_closings_tenant
  on public.gw_month_closings(tenant_id, month desc);

comment on table public.gw_month_closings is
  '月次締め。勤怠・休暇・経費がそろったことを確認して、その月を閉じる';
comment on column public.gw_month_closings.snapshot is
  '締めた時点の控え。画面は元データを数え直すので、ここは読まない。'
  'あとから「締めたときは何件だったか」を確かめるためのもの';

-- ---- RLS --------------------------------------------------------------------
-- 読めるのは人事・経営者だけ。給与に関わる数字がまとまっている
alter table public.gw_month_closings enable row level security;

drop policy if exists gw_month_closings_read on public.gw_month_closings;
create policy gw_month_closings_read on public.gw_month_closings
  for select to authenticated
  using (public.gw_is_hr(tenant_id));

-- 書き込みは api/closing（service_role）だけ。
-- 締める・解くは必ずログを残す必要があり、直接の UPDATE を許すとそこが抜ける

notify pgrst, 'reload schema';

-- 確認:
--   select month, status, closed_at from public.gw_month_closings order by month desc;
