-- =============================================================================
-- 096: /sales 営業チャネル・送信結果・返信後の連絡管理
--
--   1) 企業の「非表示」   … リンク切れ・閉業・営業対象外などを、消さずに一覧・アタック対象から外す
--   2) 送信チャネル        … フォーム以外（メール・LINE・Instagram・X・Facebook・LinkedIn …）で送った記録
--   3) 送信できなかった    … 理由つきで、送れなかったことも営業結果として残す
--   4) 返信後の連絡管理    … 返信元チャネル・いまの連絡手段・連絡先
--
-- ■ 既存の表を使う（新しい表は作らない）
--   企業         → gw_sales_companies に列を足す
--   アタック     → gw_sales_approaches に列を足す（channel の制約を広げる）
--   営業の出来事 → gw_sales_events に channel を足す（返信元・切替先のチャネル）
--
-- 何度流しても同じ結果になる（add column if not exists / 制約は張り直し）。
-- 088_sales.sql の後に流す。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 企業：非表示・いまの連絡手段・連絡先
-- -----------------------------------------------------------------------------
alter table public.gw_sales_companies
  add column if not exists hidden_at               timestamptz,
  add column if not exists hidden_by               uuid references auth.users(id) on delete set null,
  add column if not exists hidden_reason           text,
  add column if not exists hidden_note             text,
  -- いまやり取りしているチャネル（営業ステータスとは別。変えてもステータスは動かさない）
  add column if not exists current_contact_channel text,
  add column if not exists current_contact_value   text,     -- そのチャネルの連絡先（例：tanaka@example.jp）
  -- 連絡先（メール・LINE名・Instagram・X・Facebook・LinkedIn・電話・その他）
  add column if not exists contacts                jsonb not null default '{}'::jsonb,
  add column if not exists last_contact_at         timestamptz;

alter table public.gw_sales_companies drop constraint if exists gw_sales_companies_hidden_reason_check;
alter table public.gw_sales_companies add constraint gw_sales_companies_hidden_reason_check
  check (hidden_reason is null or hidden_reason in (
    'link_broken',   -- リンク切れ
    'no_info',       -- 会社情報なし
    'closed',        -- 閉業
    'not_target',    -- 営業対象外
    'duplicate',     -- 重複
    'other'          -- その他
  ));

alter table public.gw_sales_companies drop constraint if exists gw_sales_companies_current_contact_channel_check;
alter table public.gw_sales_companies add constraint gw_sales_companies_current_contact_channel_check
  check (current_contact_channel is null or current_contact_channel in (
    'email', 'line', 'instagram', 'x', 'facebook', 'linkedin', 'phone', 'other'
  ));

-- 通常の一覧は「表示中」（hidden_at is null）だけを引く
create index if not exists idx_gw_sales_companies_hidden
  on public.gw_sales_companies(tenant_id, hidden_at);

-- -----------------------------------------------------------------------------
-- 2) アタック：送信チャネル・送信元・送信できなかった理由
-- -----------------------------------------------------------------------------
--    送信完了   … sent_at が立つ（088 と同じ）
--    送れなかった … failed_at が立つ。sent_at は立てない
--                  （直近30日の警告・アタック数に数えない。別チャネルで送り直せる）
alter table public.gw_sales_approaches
  add column if not exists send_from          text,          -- 送信元（@eight_xxx・sales@8grp.co.jp など）
  add column if not exists failed_at          timestamptz,
  add column if not exists send_failed_reason text,
  add column if not exists send_failed_note   text;

alter table public.gw_sales_approaches drop constraint if exists gw_sales_approaches_channel_check;
alter table public.gw_sales_approaches add constraint gw_sales_approaches_channel_check
  check (channel in (
    'form',        -- お問い合わせフォーム
    'email', 'line', 'instagram', 'x', 'facebook', 'linkedin',
    'sns_other',   -- その他SNS
    'other'
  ));

alter table public.gw_sales_approaches drop constraint if exists gw_sales_approaches_send_failed_reason_check;
alter table public.gw_sales_approaches add constraint gw_sales_approaches_send_failed_reason_check
  check (send_failed_reason is null or send_failed_reason in (
    'no_form',         -- 問い合わせフォームがない
    'no_email',        -- メールアドレスがない
    'form_error',      -- フォームエラー
    'ng_notice',       -- 営業禁止の記載あり
    'link_broken',     -- URLリンク切れ
    'login_required',  -- ログイン・会員登録が必要
    'captcha',         -- CAPTCHA等で送信できない
    'sns_only',        -- SNSしか連絡手段がない
    'other'
  ));

-- 送信完了と送れなかったは、どちらか一方だけ
alter table public.gw_sales_approaches drop constraint if exists gw_sales_approaches_sent_or_failed_check;
alter table public.gw_sales_approaches add constraint gw_sales_approaches_sent_or_failed_check
  check (sent_at is null or failed_at is null);

-- -----------------------------------------------------------------------------
-- 3) 営業の出来事：チャネル（返信元・切替先・やり取りしたチャネル）
-- -----------------------------------------------------------------------------
alter table public.gw_sales_events
  add column if not exists channel text;

alter table public.gw_sales_events drop constraint if exists gw_sales_events_channel_check;
alter table public.gw_sales_events add constraint gw_sales_events_channel_check
  check (channel is null or channel in (
    'form', 'email', 'line', 'instagram', 'x', 'facebook', 'linkedin', 'sns_other', 'phone', 'other'
  ));

-- -----------------------------------------------------------------------------
-- 確認用（流したあとに見る）
-- -----------------------------------------------------------------------------
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'gw_sales_companies'
--    and column_name in ('hidden_at', 'hidden_reason', 'current_contact_channel', 'contacts', 'last_contact_at');
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'gw_sales_approaches'
--    and column_name in ('send_from', 'failed_at', 'send_failed_reason');
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.gw_sales_approaches'::regclass and conname = 'gw_sales_approaches_channel_check';
