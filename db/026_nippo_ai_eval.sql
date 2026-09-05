-- =============================================================================
-- 026: 日報のAI評価（AI日報評価API 実装要件 Phase 1・2）
--
-- 日報を出したあと、AIが内容を読んで
--   ・良かったところ
--   ・改善すると良いところ
--   ・明日のポイント
--   ・会社評価基準10項目の参考点（各0〜10点）と、その理由
-- を返す。結果はここに構造化して残す。
--
-- ■ 分けて持つ理由
--   日報本体（tc_nippo）に評価列を足さない。
--   ・AIが落ちても日報の保存は成功させたい（別の行なら独立して失敗できる）
--   ・評価をやり直したとき、前の評価も履歴として残したい
--   ・評価基準を変えたら prompt_version で世代を見分けたい
--
-- ■ 上書きしない
--   再評価すると新しい行が増える。最新は created_at の新しいものを見る。
--   点数が変わった経緯が消えると、あとから「なぜこの評価だったか」を
--   説明できなくなる。
--
-- ■ 評価材料不足を0点にしない
--   scores の各項目は {score, status, reason}。書いていないことは
--   status='not_enough_data' として score を null にする。
--   0点にすると「書けば点が増える」になり、日報が長くなるだけになる。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

create table if not exists public.gw_nippo_ai_evals (
  id          uuid primary key default gen_random_uuid(),
  nippo_id    uuid not null references public.tc_nippo(id) on delete cascade,
  -- tc_nippo.user_id と同じ（auth.users.id）。RLS の判定に使うので写しを持つ
  user_id     uuid not null,
  work_date   date not null,

  -- pending → processing → completed / failed
  status      text not null default 'pending'
              check (status in ('pending', 'processing', 'completed', 'failed')),

  -- どのモデル・どの評価基準で出したか。基準を変えたときに世代が分かる
  model          text,
  prompt_version text,

  -- 10項目 × 各0〜10点の合計。材料不足の項目は分母から外して按分する
  total_score integer,

  -- {"quantity":{"score":8,"status":"evaluated","reason":"…"}, …}
  scores             jsonb,
  good_points        jsonb,   -- 最大3件
  improvement_points jsonb,   -- 最大3件
  ai_comment         text,
  tomorrow_advice    text,

  -- 数字で出せるものはAIに渡さず、こちらで計算した値を残す
  -- （KGI達成率・成果件数・相談件数・提出時刻など）
  system_metrics jsonb,

  -- AIの生の応答。あとから「なぜこの点になったか」を追えるように残す
  raw_response jsonb,

  error_detail text,
  attempts     integer not null default 0,

  -- 管理者による修正。AI評価を最終評価にしない
  manager_scores  jsonb,     -- {"quantity":9, …} 直した項目だけ
  manager_comment text,
  manager_total   integer,
  decided_by      uuid references auth.users(id) on delete set null,
  decided_at      timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gw_nippo_ai_evals_nippo
  on public.gw_nippo_ai_evals(nippo_id, created_at desc);
create index if not exists idx_gw_nippo_ai_evals_user
  on public.gw_nippo_ai_evals(user_id, work_date desc);

comment on table public.gw_nippo_ai_evals is
  '日報のAI評価。再評価すると行が増える（上書きしない）。最新は created_at の新しいもの';
comment on column public.gw_nippo_ai_evals.total_score is
  '参考点。人事評価の確定値ではない。管理者が manager_scores で直せる';


-- -----------------------------------------------------------------------------
-- 誰が読めるか
--   本人と、社内の管理者・担当者・経営者だけ。
--   書き込みは service_role の API だけが行うので、insert/update のポリシーは置かない。
--   ブラウザから直接書ける口を残すと、自分の点数を書き換えられる。
-- -----------------------------------------------------------------------------
create or replace function public.gw_is_internal_staff()
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
       and g.role in ('owner', 'hr', 'manager')
  );
$$;

revoke all on function public.gw_is_internal_staff() from public;
grant execute on function public.gw_is_internal_staff() to authenticated;

alter table public.gw_nippo_ai_evals enable row level security;

drop policy if exists gw_nippo_ai_evals_select on public.gw_nippo_ai_evals;
create policy gw_nippo_ai_evals_select on public.gw_nippo_ai_evals
  for select to authenticated
  using (user_id = auth.uid() or public.gw_is_internal_staff());


-- -----------------------------------------------------------------------------
-- 生の応答は重い。90日で捨てる（点数と理由は残す）
-- -----------------------------------------------------------------------------
create or replace function public.gw_nippo_ai_evals_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.gw_nippo_ai_evals
     set raw_response = null
   where raw_response is not null
     and created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.unschedule('gw_nippo_ai_evals_prune')
      where exists (select 1 from cron.job where jobname = 'gw_nippo_ai_evals_prune');
    perform cron.schedule(
      'gw_nippo_ai_evals_prune', '40 18 * * *',   -- 毎日 03:40 JST
      $cron$select public.gw_nippo_ai_evals_prune();$cron$
    );
  end if;
exception when others then
  raise notice '生の応答の自動削除は設定できませんでした: %', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- 確認:
--   select work_date, status, total_score, ai_comment
--     from public.gw_nippo_ai_evals order by created_at desc limit 20;
