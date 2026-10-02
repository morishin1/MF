-- =============================================================================
-- 118: 採用HRの応募者を「無限道場リード」にも使う（mugendojo.jp → /api/hr/leads）
--
-- ■ 新しいCRMは作らない
--   無限道場LP（mugendojo.jp・別アプリ・別 Supabase プロジェクト）から来たリードは、
--   採用候補者と同じ gw_hr_applicants に入れる。面談（gw_hr_interviews）・
--   タイムライン（gw_hr_timeline）・TimeRex 連携・通知もそのまま使う。
--   採用か無限道場かは lead_category で分ける。
--
-- ■ 足すもの（加算のみ。既存の列・制約・RLS は変えない）
--   lead_category      recruitment（既定。既存の行はすべてこれ）/ mugendojo / internship / other
--   utm_source / utm_medium / utm_campaign
--                      媒体別に数える軸なので、普通の列にする（最初に来たときの値）
--   attribution jsonb  流入の詳細。first / last（source_url・landing_page・referrer・
--                      utm_*・at）と、受け付けた送信ID（submission_ids。再送の判定）
--   lead_profile jsonb LPで本人が入れた内容（都道府県・現在の状況・AI経験・IT経験・
--                      興味・挑戦したいこと・適性診断）
--   last_contacted_at  最終接触日時（フォーム送信・TimeRex 予約で更新）
--   lead_next_action   面談後の次のアクション（体験案内・説明・参加検討…。下の check）
--
-- ■ 重複は無限道場の中だけで防ぐ
--   unique (tenant_id, lower(email)) where lead_category = 'mugendojo'。
--   採用の応募者には同じメールが既にあり得るので、採用側には一意を課さない。
--   採用応募者と同じメールの人が無限道場から来ても、勝手に統合しない（別の行になる）。
--
-- ■ 無限道場の stage（カジュアル面談までは既存の stage / status をそのまま使う）
--   applied → casual_interview → md_trial（体験案内）→ md_considering（参加検討）
--   → md_applied（申込）→ md_joined（参加）
--
-- ■ 通知先（無限道場の運営担当）は設定で持つ
--   gw_hr_lead_watchers（tenant・lead_category・社員）。コードに個人IDを書かない。
--   誰も設定されていなければ、採用HRの担当（経営者・人事・採用担当）へ知らせる
--   （リードを黙って取りこぼさない）。
--
-- ■ 書き込みは service_role の API（/api/hr/leads）だけ
--   anon・authenticated に公開用のポリシーは足さない（db/081 の RLS のまま）。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等。何度流しても同じ）
-- 前提: 081_hr_recruiting.sql
-- 未実行でも既存の採用HRは動く（/api/hr/leads だけが 503 not_ready を返す）
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 列
-- -----------------------------------------------------------------------------
alter table public.gw_hr_applicants
  add column if not exists lead_category text not null default 'recruitment',
  add column if not exists utm_source text,
  add column if not exists utm_medium text,
  add column if not exists utm_campaign text,
  add column if not exists attribution jsonb,
  add column if not exists lead_profile jsonb,
  add column if not exists last_contacted_at timestamptz,
  add column if not exists lead_next_action text;

alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_lead_category_check;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_lead_category_check
  check (lead_category in ('recruitment', 'mugendojo', 'internship', 'other'));

alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_lead_next_action_check;
alter table public.gw_hr_applicants add constraint gw_hr_applicants_lead_next_action_check
  check (lead_next_action is null or lead_next_action in (
    'trial',            -- 体験案内
    'explain',          -- 説明
    'considering',      -- 参加検討
    'apply',            -- 申込
    'join',             -- 参加
    'enger_referral',   -- ENGER紹介
    'other_service',    -- 別サービス紹介
    'hold',             -- 保留
    'not_target'        -- 対象外
  ));

comment on column public.gw_hr_applicants.lead_category is
  'recruitment=採用（既定）/ mugendojo=無限道場リード / internship=インターン / other=その他。'
  '同じ表・同じ面談・同じTimeRex連携を使い、表示名と遷移だけを分ける（db/118）';
comment on column public.gw_hr_applicants.attribution is
  '流入の詳細（db/118）。{first:{source_url,landing_page,referrer,utm_*,at}, last:{…}, submission_ids:[…]}';
comment on column public.gw_hr_applicants.lead_profile is
  'LPで本人が入れた内容（db/118）。prefecture, occupation, ai_experience, it_experience, '
  'interests[], challenge_text, diagnosis_type, diagnosis_label';
comment on column public.gw_hr_applicants.last_contacted_at is
  '最終接触日時（db/118）。フォーム送信・TimeRex予約で更新';
comment on column public.gw_hr_applicants.lead_next_action is
  '無限道場リードの面談後の次のアクション（db/118）。lib/hr-leads.js の LEAD_NEXT_ACTIONS が正';

-- -----------------------------------------------------------------------------
-- 2) stage に無限道場の段階を足す（いまの制約の値 ∪ 表にある値 ∪ 081 の一覧 ∪ md_*。狭めない）
-- -----------------------------------------------------------------------------
do $$
declare
  cur  text;
  vals text[];
begin
  select pg_get_constraintdef(oid) into cur
    from pg_constraint
   where conrelid = 'public.gw_hr_applicants'::regclass and conname = 'gw_hr_applicants_stage_check';

  select array_agg(distinct v order by v) into vals from (
    select m[1] as v from regexp_matches(coalesce(cur, ''), '''([^'']+)''', 'g') as m
     where m[1] !~ '[{},]'
    union select stage from public.gw_hr_applicants where stage is not null
    union select unnest(array['applied', 'casual_interview', 'ceo_recommend', 'ceo_interview', 'offer',
                              'joining_scheduled', 'md_trial', 'md_considering', 'md_applied', 'md_joined'])
  ) s;

  alter table public.gw_hr_applicants drop constraint if exists gw_hr_applicants_stage_check;
  execute format(
    'alter table public.gw_hr_applicants add constraint gw_hr_applicants_stage_check check (stage in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(vals) as v));
end $$;

-- -----------------------------------------------------------------------------
-- 3) 重複防止（無限道場の中だけ）と、一覧の絞り込み用の索引
-- -----------------------------------------------------------------------------
create unique index if not exists uq_gw_hr_applicants_mugendojo_email
  on public.gw_hr_applicants(tenant_id, lower(email))
  where lead_category = 'mugendojo';

create index if not exists idx_gw_hr_applicants_category
  on public.gw_hr_applicants(tenant_id, lead_category, created_at desc);

-- -----------------------------------------------------------------------------
-- 4) 通知先（無限道場の運営担当など）。lead_category ごとに、社員を何人でも
-- -----------------------------------------------------------------------------
create table if not exists public.gw_hr_lead_watchers (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  lead_category text not null check (lead_category in ('recruitment', 'mugendojo', 'internship', 'other')),
  employee_id   uuid not null references public.gw_employees(id) on delete cascade,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, lead_category, employee_id)
);

comment on table public.gw_hr_lead_watchers is
  '新しいリードの通知先（db/118）。無限道場の運営担当などを社員単位で設定する。'
  '誰もいなければ採用HRの担当（経営者・人事・採用担当）へ知らせる（lib/hr-leads.js）';

alter table public.gw_hr_lead_watchers enable row level security;
drop policy if exists gw_hr_lead_watchers_staff on public.gw_hr_lead_watchers;
create policy gw_hr_lead_watchers_staff on public.gw_hr_lead_watchers
  for all using (public.gw_is_recruiting(tenant_id)) with check (public.gw_is_recruiting(tenant_id));

notify pgrst, 'reload schema';

-- 確認:
--   select lead_category, count(*) from public.gw_hr_applicants group by 1;
--   select name, email, stage, status, utm_source, utm_medium, last_contacted_at
--     from public.gw_hr_applicants where lead_category = 'mugendojo' order by created_at desc;
--   select w.lead_category, e.display_name from public.gw_hr_lead_watchers w
--     join public.gw_employees e on e.id = w.employee_id;
