-- 002_document_classification.sql
-- 書類の「種別判定＋月次管理」対応。
-- 既存データを壊さない“追加”マイグレーション（本番Supabaseでそのまま実行可）。

-- 1) doc_type の種別を拡張（会計証憑＋非会計書類も受け入れる）
alter table public.documents drop constraint if exists documents_doc_type_check;
alter table public.documents
  add constraint documents_doc_type_check
  check (doc_type in (
    'invoice',     -- 請求書
    'receipt',     -- 領収書・レシート
    'bank',        -- 通帳・銀行明細
    'card',        -- クレジットカード明細
    'salary',      -- 給与明細
    'contract',    -- 契約書
    'quote',       -- 見積書・発注書
    'tax',         -- 納付書・税金関係
    'certificate', -- 証明書類（登記簿・各種証明）
    'namecard',    -- 名刺
    'other',       -- その他
    'unknown'      -- 未判定
  ));

-- 2) 月次管理・要約用カラムを追加
alter table public.documents add column if not exists doc_date      date;    -- 書類に記載の日付（AI抽出）
alter table public.documents add column if not exists period        text;    -- 管理上の対象月 'YYYY-MM'
alter table public.documents add column if not exists ai_summary    text;    -- AIの一言要約
alter table public.documents add column if not exists is_accounting boolean default false; -- 仕訳対象の会計証憑か

-- 3) status に 'classified'（分類済み）/ 'filed'（非会計・整理完了）を追加
alter table public.documents drop constraint if exists documents_status_check;
alter table public.documents
  add constraint documents_status_check
  check (status in (
    'uploaded',    -- アップロード直後
    'recognizing', -- AI処理中
    'classified',  -- 分類のみ完了
    'ready',       -- 会計証憑＝仕訳ドラフト生成済み（承認待ち）
    'asking',      -- 追加確認中
    'filed',       -- 非会計＝月次整理完了
    'approved',    -- 承認済み
    'sent',        -- MF登録済み
    'error'        -- エラー
  ));

-- 4) 月次×種別で素早く引くためのインデックス
create index if not exists idx_documents_period on public.documents(tenant_id, client_id, period);
create index if not exists idx_documents_type   on public.documents(tenant_id, client_id, doc_type);
