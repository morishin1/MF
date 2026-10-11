-- =============================================================================
-- 131: AI営業（MVP）— 分析・営業文・承認・利用量の台帳・予算の予約（設計：docs/ai-sales-agent-phase0.md）
--
-- ■ 足すもの（既存の表・列は変えない。gw_sales_approaches に列を1つ足すだけ）
--   gw_sales_ai_settings  … テナントごとの設定（有効／停止・上限・重点商材・配点・署名）
--   gw_sales_ai_analyses  … 企業ごとの AI 分析（履歴を残す）
--   gw_sales_ai_classifications … 商材の一次分類（1社1行・最新だけ）。候補を探すための安い分類。
--                           企業マスタの「提案サービス」（gw_sales_companies.service）は書き換えない
--   gw_sales_ai_drafts    … AI 営業文（版・承認）
--   gw_sales_ai_usage     … AI を呼ぶたびに1行（予約 → 確定 → 解放）。予算と異常の判定に使う台帳
--   gw_sales_approaches.ai_draft_id … AI 文面で送ったアタック（接触の数え方は変えない）
--
-- ■ 守り
--   ・RLS は「読むだけ」（gw_is_sales）。書き込みのポリシーは置かない → 書くのは API（service_role）だけ。
--     営業担当が PostgREST を直接呼んでも、承認の列・台帳・設定を書き換えられない
--   ・承認した人 ≠ 作った人・申請した人（CHECK。service_role でも破れない）
--   ・承認後に本文・件名を変えたら、承認済みのままにはできない（トリガー）
--   ・予算は予約方式：gw_sales_ai_reserve が設定行をロックしてから「確定済み＋予約中＋今回の見込み ≤ 上限」を確かめる。
--     並列で呼ばれても上限をすり抜けない。gw_sales_ai_settle が実費で確定し、上限到達・失敗の連続で自動停止する
--   ・予約・確定の関数は service_role だけが実行できる（anon・authenticated からは呼べない）
--
-- ■ 実行順
--   1. この db/131 を Supabase の SQL Editor で Run
--   2. db/check_131_sales_ai.sql で確認（❌ が無いこと）
--   戻すとき：db/rollback_131_sales_ai.sql（AI営業のデータは消える）
-- =============================================================================
begin;

do $$
begin
  if to_regclass('public.gw_sales_companies') is null or to_regclass('public.gw_sales_approaches') is null
     or to_regclass('public.gw_sales_templates') is null then
    raise exception 'db/131: 先に db/088（Sales）を適用してください。何も変更していません';
  end if;
  if to_regprocedure('public.gw_is_sales(uuid)') is null then
    raise exception 'db/131: public.gw_is_sales(uuid) がありません（db/088・db/094）。何も変更していません';
  end if;
end $$;

-- 1) 設定 -----------------------------------------------------------------------
create table if not exists public.gw_sales_ai_settings (
  tenant_id           uuid primary key references public.tenants(id) on delete cascade,
  enabled             boolean not null default false,
  paused_reason       text,
  paused_at           timestamptz,
  monthly_target_usd  numeric(10,2) not null default 50  check (monthly_target_usd >= 0),
  monthly_cap_usd     numeric(10,2) not null default 100 check (monthly_cap_usd >= 0 and monthly_cap_usd <= 1000),
  daily_cap_usd       numeric(10,2) not null default 10  check (daily_cap_usd >= 0),
  daily_company_limit int not null default 100 check (daily_company_limit between 0 and 2000),
  hourly_call_limit   int not null default 200 check (hourly_call_limit between 1 and 5000),
  focus_services      jsonb not null default '["8EC・8RENT","ENGER","無限道場（企業開拓）","無限道場（生徒募集）"]'::jsonb,
  score_profiles      jsonb not null default '{}'::jsonb,
  effective_threshold int not null default 60 check (effective_threshold between 0 and 100),
  signature           text check (signature is null or char_length(signature) <= 1000),
  banned_phrases      jsonb not null default '[]'::jsonb,
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);
comment on table public.gw_sales_ai_settings is
  'AI営業の設定（テナントに1行。db/131）。enabled=false で分析・文面・承認の API が止まる。上限はAIトークン代だけ（ドル）';

-- 2) 分析 -----------------------------------------------------------------------
create table if not exists public.gw_sales_ai_analyses (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  company_id         uuid not null references public.gw_sales_companies(id) on delete cascade,
  status             text not null check (status in ('ok','site_unreachable','robots_blocked','ai_failed','skipped')),
  tier               text not null default 'light' check (tier in ('light','standard','deep')),
  summary            text check (summary is null or char_length(summary) <= 2000),
  facts              jsonb not null default '[]'::jsonb,
  hypotheses         jsonb not null default '[]'::jsonb,
  uncertainties      jsonb not null default '[]'::jsonb,
  score              smallint check (score is null or score between 0 and 100),
  score_detail       jsonb not null default '{}'::jsonb,
  score_profile      jsonb not null default '{}'::jsonb,
  services           jsonb not null default '[]'::jsonb,
  form_url           text,
  form_purpose       text check (form_purpose is null or form_purpose in ('general','business','support_only','recruit_only','unknown')),
  send_check         text check (send_check is null or send_check in ('blocked','manual_review','ok_manual')),
  send_check_reasons jsonb not null default '[]'::jsonb,
  send_check_by      uuid references auth.users(id) on delete set null,
  send_check_at      timestamptz,
  effective          boolean not null default false,
  effective_reasons  jsonb not null default '[]'::jsonb,
  pages              jsonb not null default '[]'::jsonb,
  skip_reason        text,
  checked_by         uuid references auth.users(id) on delete set null,
  checked_at         timestamptz,
  check_result       text check (check_result is null or check_result in ('correct','wrong','unknown')),
  check_note         text check (check_note is null or char_length(check_note) <= 1000),
  model              text,
  prompt_version     text,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists idx_gw_sales_ai_analyses_company on public.gw_sales_ai_analyses(company_id, created_at desc);
create index if not exists idx_gw_sales_ai_analyses_tenant on public.gw_sales_ai_analyses(tenant_id, created_at desc);
comment on table public.gw_sales_ai_analyses is
  'AI営業の企業分析（履歴。最新は created_at が最大の行。db/131）。事実は出典URLつき、推測は hypotheses に分ける';

-- 2b) 商材の一次分類（候補探し）---------------------------------------------------------
-- 企業の登録情報＋トップページ1枚だけを見て、重点商材ごとの合いそうな度合い（0〜10）を付ける。
-- 本番の「提案サービス」欄は未設定が多く、電話番号などが入っている行もあるため、そこには頼らず・書き戻さない。
create table if not exists public.gw_sales_ai_classifications (
  company_id     uuid primary key references public.gw_sales_companies(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  best_service   text check (best_service is null or char_length(best_service) <= 100),
  fits           jsonb not null default '{}'::jsonb,       -- { "<商材>": 0〜10 }
  confidence     text check (confidence is null or confidence in ('high','mid','low')),
  reason         text check (reason is null or char_length(reason) <= 500),
  source         text not null check (source in ('site','meta')),   -- site = トップページも読んだ／meta = 登録情報だけ
  site_status    text check (site_status is null or site_status in ('ok','robots_blocked','site_unreachable','no_site')),
  service_field_invalid boolean not null default false,  -- 提案サービス欄に電話番号などが入っていた（直さない。印だけ）
  model          text,
  prompt_version text,
  classified_by  uuid,
  classified_at  timestamptz not null default now()
);
create index if not exists idx_gw_sales_ai_classifications_tenant on public.gw_sales_ai_classifications(tenant_id, best_service);
comment on table public.gw_sales_ai_classifications is
  'AI営業：商材の一次分類（1社1行・最新）。候補を探すためだけに使い、企業マスタは書き換えない（db/131）';

-- 3) 営業文 ---------------------------------------------------------------------
create table if not exists public.gw_sales_ai_drafts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  company_id         uuid not null references public.gw_sales_companies(id) on delete cascade,
  analysis_id        uuid references public.gw_sales_ai_analyses(id) on delete set null,
  template_id        uuid references public.gw_sales_templates(id) on delete set null,
  service            text check (service is null or char_length(service) <= 100),
  subject            text check (subject is null or char_length(subject) <= 300),
  body               text not null check (char_length(body) between 1 and 20000),
  rationale          text check (rationale is null or char_length(rationale) <= 2000),
  version            int not null default 1 check (version >= 1),
  status             text not null default 'draft'
                     check (status in ('draft','pending','approved','rejected','used','superseded')),
  -- 作った人・直した人・依頼した人・承認した人（auth.users の id）。承認の記録なので外部キーにしない
  -- （ユーザーを消しても空にならない。空になると自己承認の CHECK を満たせず、記録も消える）
  created_by         uuid,
  edited_by          uuid,
  edited_at          timestamptz,
  requested_by       uuid,
  requested_at       timestamptz,
  decided_by         uuid,
  decided_at         timestamptz,
  decision_note      text check (decision_note is null or char_length(decision_note) <= 1000),
  approved_body_hash text,
  approach_id        uuid references public.gw_sales_approaches(id) on delete set null,
  model              text,
  prompt_version     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- 承認した人は、作った人・申請した人と別の人（自己承認の禁止）
  constraint gw_sales_ai_drafts_no_self_approval check (
    status not in ('approved','used')
    or (decided_by is not null and decided_by is distinct from created_by and decided_by is distinct from requested_by)),
  -- 承認済みには、承認したときの本文のハッシュがある（送るときに照合する）
  constraint gw_sales_ai_drafts_approved_hash check (status not in ('approved','used') or approved_body_hash is not null)
);
create index if not exists idx_gw_sales_ai_drafts_company on public.gw_sales_ai_drafts(company_id, created_at desc);
create index if not exists idx_gw_sales_ai_drafts_tenant_status on public.gw_sales_ai_drafts(tenant_id, status, created_at desc);
-- 1社につき、承認待ち・承認済みは1つまで
create unique index if not exists uq_gw_sales_ai_drafts_active on public.gw_sales_ai_drafts(company_id)
  where status in ('pending','approved');
comment on table public.gw_sales_ai_drafts is
  'AI営業文（版・承認。db/131）。承認は経営者・営業責任者だけで、作った人・申請した人は承認できない（CHECK）';

create or replace function public.gw_sales_ai_drafts_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.tenant_id is distinct from old.tenant_id or new.company_id is distinct from old.company_id then
    raise exception 'gw_sales_ai_drafts: tenant_id・company_id は変えられません';
  end if;
  -- 承認済み（送信済み）のまま本文・件名を変えない。変えるなら承認をやり直す
  if old.status in ('approved','used') and new.status in ('approved','used')
     and (new.body is distinct from old.body or new.subject is distinct from old.subject) then
    raise exception 'gw_sales_ai_drafts: 承認済みの営業文は変えられません（変えるなら承認をやり直してください）';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists gw_sales_ai_drafts_guard_trg on public.gw_sales_ai_drafts;
create trigger gw_sales_ai_drafts_guard_trg before update on public.gw_sales_ai_drafts
  for each row execute function public.gw_sales_ai_drafts_guard();

-- 4) 利用量の台帳 -----------------------------------------------------------------
create table if not exists public.gw_sales_ai_usage (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  company_id    uuid references public.gw_sales_companies(id) on delete set null,
  employee_id   uuid references public.gw_employees(id) on delete set null,
  purpose       text not null check (purpose in ('analysis','draft','deep_analysis','classify')),
  model         text not null,
  status        text not null default 'reserved' check (status in ('reserved','committed','released')),
  reserved_usd  numeric(12,6) not null default 0 check (reserved_usd >= 0),
  cost_usd      numeric(12,6) not null default 0 check (cost_usd >= 0),
  input_tokens  int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  outcome       text check (outcome is null or outcome in ('ok','error','refusal','timeout','invalid_output','expired')),
  error_code    text,
  latency_ms    int,
  analysis_id   uuid references public.gw_sales_ai_analyses(id) on delete set null,
  draft_id      uuid references public.gw_sales_ai_drafts(id) on delete set null,
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);
create index if not exists idx_gw_sales_ai_usage_tenant on public.gw_sales_ai_usage(tenant_id, created_at desc);
create index if not exists idx_gw_sales_ai_usage_reserved on public.gw_sales_ai_usage(tenant_id, created_at) where status = 'reserved';
comment on table public.gw_sales_ai_usage is
  'AI営業の利用量の台帳（呼び出し1回＝1行。予約 reserved → 確定 committed／解放 released。db/131）';

-- 5) 既存のアタック記録に、AI 文面で送ったかを足す ---------------------------------------
alter table public.gw_sales_approaches
  add column if not exists ai_draft_id uuid references public.gw_sales_ai_drafts(id) on delete set null;
create index if not exists idx_gw_sales_approaches_ai_draft on public.gw_sales_approaches(ai_draft_id) where ai_draft_id is not null;

-- 6) 予算の予約・確定 --------------------------------------------------------------
-- 予約：設定行をロック（for update）してから合計を見るので、並列で呼ばれても上限を超えない。
-- 返り値：reservation_id（予約できたとき）と reason（断ったとき。paused / monthly_cap / daily_cap / daily_company_limit / burst）
create or replace function public.gw_sales_ai_reserve(
  p_tenant uuid, p_estimate numeric, p_purpose text, p_model text, p_company uuid, p_employee uuid)
returns table(reservation_id uuid, reason text)
language plpgsql set search_path = public as $$
declare
  s public.gw_sales_ai_settings%rowtype;
  m_start timestamptz := (date_trunc('month', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo';
  d_start timestamptz := (date_trunc('day', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo';
  spent_m numeric; spent_d numeric; n_today int; n_hour int; rid uuid;
begin
  if p_estimate is null or p_estimate < 0 then raise exception 'gw_sales_ai_reserve: 見込み額が正しくありません'; end if;
  insert into public.gw_sales_ai_settings(tenant_id) values (p_tenant) on conflict (tenant_id) do nothing;
  select * into s from public.gw_sales_ai_settings where tenant_id = p_tenant for update;
  if not s.enabled then
    return query select null::uuid, case when s.paused_reason is not null then 'paused:' || s.paused_reason else 'disabled' end;
    return;
  end if;
  -- 応答が無いまま10分たった予約は解放する（落ちた関数の予約で、いつまでも枠を取らない）
  update public.gw_sales_ai_usage set status = 'released', outcome = coalesce(outcome, 'expired'), settled_at = now()
   where tenant_id = p_tenant and status = 'reserved' and created_at < now() - interval '10 minutes';

  select coalesce(sum(case when status = 'committed' then cost_usd else reserved_usd end), 0) into spent_m
    from public.gw_sales_ai_usage where tenant_id = p_tenant and status in ('reserved','committed') and created_at >= m_start;
  select coalesce(sum(case when status = 'committed' then cost_usd else reserved_usd end), 0) into spent_d
    from public.gw_sales_ai_usage where tenant_id = p_tenant and status in ('reserved','committed') and created_at >= d_start;
  if spent_m + p_estimate > s.monthly_cap_usd then return query select null::uuid, 'monthly_cap'; return; end if;
  if spent_d + p_estimate > s.daily_cap_usd then return query select null::uuid, 'daily_cap'; return; end if;
  if p_purpose = 'analysis' then
    select count(*) into n_today from public.gw_sales_ai_usage
     where tenant_id = p_tenant and purpose = 'analysis' and status in ('reserved','committed') and created_at >= d_start;
    if n_today >= s.daily_company_limit then return query select null::uuid, 'daily_company_limit'; return; end if;
  end if;
  -- 暴走の検知：1時間の呼び出しが上限を超えたら、止める（人が解除するまで）
  select count(*) into n_hour from public.gw_sales_ai_usage where tenant_id = p_tenant and created_at >= now() - interval '1 hour';
  if n_hour >= s.hourly_call_limit then
    update public.gw_sales_ai_settings set enabled = false, paused_reason = 'burst', paused_at = now() where tenant_id = p_tenant;
    return query select null::uuid, 'burst';
    return;
  end if;

  insert into public.gw_sales_ai_usage(tenant_id, company_id, employee_id, purpose, model, status, reserved_usd)
  values (p_tenant, p_company, p_employee, p_purpose, p_model, 'reserved', p_estimate)
  returning id into rid;
  return query select rid, null::text;
end $$;

-- 確定：実際のトークン・費用で確定し、上限到達・失敗の連続なら自動停止する。返り値は停止の理由（止めなければ null）
create or replace function public.gw_sales_ai_settle(
  p_id uuid, p_input int, p_output int, p_cost numeric, p_outcome text, p_error text, p_latency int)
returns text
language plpgsql set search_path = public as $$
declare
  t uuid; s public.gw_sales_ai_settings%rowtype;
  m_start timestamptz := (date_trunc('month', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo';
  spent_m numeric; fails int; why text := null;
begin
  update public.gw_sales_ai_usage
     set status = 'committed', input_tokens = greatest(coalesce(p_input, 0), 0), output_tokens = greatest(coalesce(p_output, 0), 0),
         cost_usd = greatest(coalesce(p_cost, 0), 0), outcome = p_outcome, error_code = left(p_error, 200),
         latency_ms = p_latency, settled_at = now()
   where id = p_id and status in ('reserved','released')
  returning tenant_id into t;
  if t is null then return null; end if;

  select * into s from public.gw_sales_ai_settings where tenant_id = t for update;
  select coalesce(sum(case when status = 'committed' then cost_usd else reserved_usd end), 0) into spent_m
    from public.gw_sales_ai_usage where tenant_id = t and status in ('reserved','committed') and created_at >= m_start;
  if spent_m >= s.monthly_cap_usd then why := 'monthly_cap';
  else
    select count(*) filter (where outcome is distinct from 'ok') into fails
      from (select outcome from public.gw_sales_ai_usage
             where tenant_id = t and status = 'committed' order by settled_at desc nulls last limit 20) x;
    if fails >= 5 then why := 'errors'; end if;
  end if;
  if why is not null and s.enabled then
    update public.gw_sales_ai_settings set enabled = false, paused_reason = why, paused_at = now() where tenant_id = t;
  end if;
  return why;
end $$;

-- 予約・確定は API（service_role）だけ。anon・authenticated から RPC で呼ばせない
revoke all on function public.gw_sales_ai_reserve(uuid, numeric, text, text, uuid, uuid) from public;
revoke all on function public.gw_sales_ai_settle(uuid, int, int, numeric, text, text, int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.gw_sales_ai_reserve(uuid, numeric, text, text, uuid, uuid) from anon';
    execute 'revoke all on function public.gw_sales_ai_settle(uuid, int, int, numeric, text, text, int) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.gw_sales_ai_reserve(uuid, numeric, text, text, uuid, uuid) from authenticated';
    execute 'revoke all on function public.gw_sales_ai_settle(uuid, int, int, numeric, text, text, int) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.gw_sales_ai_reserve(uuid, numeric, text, text, uuid, uuid) to service_role';
    execute 'grant execute on function public.gw_sales_ai_settle(uuid, int, int, numeric, text, text, int) to service_role';
  end if;
end $$;

-- 7) RLS：読むだけ（書くのは API の service_role だけ）-----------------------------------
alter table public.gw_sales_ai_settings enable row level security;
alter table public.gw_sales_ai_analyses enable row level security;
alter table public.gw_sales_ai_drafts   enable row level security;
alter table public.gw_sales_ai_usage    enable row level security;
alter table public.gw_sales_ai_classifications enable row level security;

drop policy if exists gw_sales_ai_settings_select on public.gw_sales_ai_settings;
create policy gw_sales_ai_settings_select on public.gw_sales_ai_settings for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_ai_analyses_select on public.gw_sales_ai_analyses;
create policy gw_sales_ai_analyses_select on public.gw_sales_ai_analyses for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_ai_drafts_select on public.gw_sales_ai_drafts;
create policy gw_sales_ai_drafts_select on public.gw_sales_ai_drafts for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_ai_usage_select on public.gw_sales_ai_usage;
create policy gw_sales_ai_usage_select on public.gw_sales_ai_usage for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_ai_classifications_select on public.gw_sales_ai_classifications;
create policy gw_sales_ai_classifications_select on public.gw_sales_ai_classifications for select using (public.gw_is_sales(tenant_id));

commit;
