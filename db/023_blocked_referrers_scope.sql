-- =============================================================================
-- 023: 口コミサイトブロックの台帳を、社内グループウェア側に寄せる
--
-- 何を変えるか
--   これまで台帳（blocked_referrers）と記録（blocked_access_logs）は
--   「ログインしていれば誰でも読み書きできる」設定だった。
--   この Supabase は LMS・タイムカード・事務ポータルと共有しているので、
--   その「誰でも」には日報を書きに来ただけの人も含まれる。
--
--   管理画面を mf.8grp.co.jp（このグループウェア）へ移すのに合わせて、
--   読めるのを「管理者・経営者」だけに絞る。
--   書き込みは API（service_role）だけが行うので、ポリシーは select しか置かない。
--
-- 何を変えないか
--   ・判定そのものは今までどおり 8grp.co.jp 側の Apache（.htaccess）が行う
--   ・記録の書き込みは blocked.php が service_role で行う（RLS を通らない）
--   ・表の形は 021 のまま。列は足さない
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- 021 を流していない環境でも動くように、表が無ければ作る
create table if not exists public.blocked_referrers (
  id           uuid primary key default gen_random_uuid(),
  domain       text not null unique,
  service_name text not null,
  enabled      boolean not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

create table if not exists public.blocked_access_logs (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  referer    text,
  domain     text,
  path       text,
  user_agent text
);


-- -----------------------------------------------------------------------------
-- 1) 誰が見てよいか
--    この Supabase には社内の別システムのアカウントも同居しているため、
--    「authenticated かどうか」では絞りきれない。
--    どこかのテナントで管理者・担当者、または経営者である人だけに限る。
--    （アクセス分析と同じ範囲。台帳は経営情報の一部という扱い）
-- -----------------------------------------------------------------------------
create or replace function public.gw_can_manage_blocks()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
     where m.user_id = auth.uid()
       and m.role in ('admin', 'staff')
  ) or exists (
    select 1
      from public.gw_role_grants g
      join public.gw_employees  e on e.id = g.employee_id
     where e.user_id = auth.uid()
       and g.role = 'owner'
  );
$$;

revoke all on function public.gw_can_manage_blocks() from public;
grant execute on function public.gw_can_manage_blocks() to authenticated;


-- -----------------------------------------------------------------------------
-- 2) ポリシーの張り替え
--    追加・ON/OFF・削除は /api/blocks が service_role で行う。
--    ブラウザから直接書ける口を残すと、台帳を壊された時に誰がやったか追えない。
-- -----------------------------------------------------------------------------
alter table public.blocked_referrers   enable row level security;
alter table public.blocked_access_logs enable row level security;

drop policy if exists blocked_referrers_rw     on public.blocked_referrers;
drop policy if exists blocked_referrers_select on public.blocked_referrers;
create policy blocked_referrers_select on public.blocked_referrers
  for select to authenticated
  using (public.gw_can_manage_blocks());

drop policy if exists blocked_access_logs_select on public.blocked_access_logs;
create policy blocked_access_logs_select on public.blocked_access_logs
  for select to authenticated
  using (public.gw_can_manage_blocks());


-- -----------------------------------------------------------------------------
-- 3) 記録が無限に積み上がらないようにする
--    ブロックの記録は「どこから何件来たか」が分かればよく、
--    半年前の1件を読み返すことはない。90日で捨てる。
-- -----------------------------------------------------------------------------
create or replace function public.blocked_access_logs_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.blocked_access_logs
   where created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- pg_cron が入っている環境でだけ毎日回す。無くてもエラーにしない
do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.unschedule('blocked_access_logs_prune')
      where exists (select 1 from cron.job where jobname = 'blocked_access_logs_prune');
    perform cron.schedule(
      'blocked_access_logs_prune', '20 18 * * *',   -- 毎日 03:20 JST
      $cron$select public.blocked_access_logs_prune();$cron$
    );
  end if;
exception when others then
  raise notice '古い記録の自動削除は設定できませんでした: %', sqlerrm;
end $$;


-- 確認:
--   select public.gw_can_manage_blocks();
--   select domain, service_name, enabled from public.blocked_referrers order by domain;
--   select count(*) from public.blocked_access_logs;
