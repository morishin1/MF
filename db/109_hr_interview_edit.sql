-- =============================================================================
-- 109: 面談（gw_hr_interviews）の編集・面談メモ
--
-- ■ 何のため
--   面談を設定したあとでも、日時・面談担当・面談方法・面談URLを直せるようにし、
--   「その面談に紐づくメモ」を面談ごとに保存・編集できるようにする。
--
--   method          … 面談方法（online=オンライン / onsite=対面 / phone=電話）。
--                     未設定はnull（既存の面談はすべてnullのまま。推測で埋めない）
--   memo            … その面談のメモ（応募者全体のメモ gw_hr_applicants.note とは別）。
--                     評価の「気になる点」（notes）とも別。評価の前後どちらでも書ける
--   memo_updated_at … メモを最後に保存した日時
--   memo_updated_by … メモを最後に保存した人（auth.users）
--
-- ■ TimeRex同期済みの面談（timerex_event_id が入っている行）
--   日時・面談URLはTimeRex側が正（lib/hr-timerex.js がWebhookのたびに上書きする）。
--   アプリからはTimeRexへ何も送らないので、この2つはAPI層（api/hr/interviews/index.js）で
--   編集を断る。面談担当・面談方法・メモはアプリ側だけの情報なので編集できる
--   （Webhookはこれらの列を触らない）。DB側では列を分けるだけで、制約は置かない。
--
-- ■ RLS
--   列を足すだけ。gw_hr_interviews には 081 の gw_hr_interviews_staff
--   （gw_is_recruiting(tenant_id)）がそのまま効く。新しい表は作らない。
--   念のため RLS が有効であることだけを、ここでも確かめる（べき等）。
--
-- ■ 既存データへの影響
--   列の追加のみ（すべてnull許容・既定値なし）。既存行の値は変わらない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 081_hr_recruiting.sql, 083_hr_interview_meeting_url.sql,
--       089_hr_timerex_sync.sql, 090_hr_interview_cancel.sql
-- =============================================================================

alter table public.gw_hr_interviews
  add column if not exists method          text,
  add column if not exists memo            text,
  add column if not exists memo_updated_at timestamptz,
  add column if not exists memo_updated_by uuid references auth.users(id) on delete set null;

alter table public.gw_hr_interviews drop constraint if exists gw_hr_interviews_method_check;
alter table public.gw_hr_interviews add constraint gw_hr_interviews_method_check
  check (method is null or method in ('online', 'onsite', 'phone'));

-- メモは長文になりうるが、上限は持たせる（API側は4000字で切る）
alter table public.gw_hr_interviews drop constraint if exists gw_hr_interviews_memo_len_check;
alter table public.gw_hr_interviews add constraint gw_hr_interviews_memo_len_check
  check (memo is null or char_length(memo) <= 4000);

comment on column public.gw_hr_interviews.method is
  '面談方法。online=オンライン / onsite=対面 / phone=電話。未設定はnull';
comment on column public.gw_hr_interviews.memo is
  'この面談に紐づくメモ。応募者全体のメモ（gw_hr_applicants.note）・評価の所感（notes）とは別';
comment on column public.gw_hr_interviews.memo_updated_at is 'メモを最後に保存した日時';
comment on column public.gw_hr_interviews.memo_updated_by is 'メモを最後に保存した人';

-- RLS（081 と同じ。べき等）
alter table public.gw_hr_interviews enable row level security;

notify pgrst, 'reload schema';

-- 確認:
--   select id, kind, scheduled_at, method, left(memo, 40) as memo, memo_updated_at,
--          timerex_event_id is not null as timerex
--     from public.gw_hr_interviews order by created_at desc limit 20;

-- -----------------------------------------------------------------------------
-- ロールバック（必要なときだけ、手で実行する。メモの内容は消える）
-- -----------------------------------------------------------------------------
-- alter table public.gw_hr_interviews drop constraint if exists gw_hr_interviews_memo_len_check;
-- alter table public.gw_hr_interviews drop constraint if exists gw_hr_interviews_method_check;
-- alter table public.gw_hr_interviews
--   drop column if exists memo_updated_by,
--   drop column if exists memo_updated_at,
--   drop column if exists memo,
--   drop column if exists method;
-- notify pgrst, 'reload schema';
