-- db/134_office_payables_general.sql のやり直し（一般経費の請求・支払のための表・列・バケットを外す）。
--
-- ■ 注意：消えるもの（データも消える）
--   ・新しい5表の中身すべて（支払先マスタ・仕訳明細・MF CSV 出力バッチ・設定）
--   ・gw_vendor_invoices に足した列（一般請求書の vendor_id・請求日・支払期日・ファイル情報・仕訳状況・MF出力日時）
--   ・gw_office_payments に足した列（支払方法・口座・実支払額・手数料・取消理由・MF出力日時）
--   ・一般請求書（invoice_kind='general'）の行そのもの（先に消す。BP の請求書・明細・支払・月次完了は消さない）
--   ・バケット office-invoices の中のファイル（バケットの削除は SQL では空のときだけ。下の手順を参照）
--
-- 本番で流す前に、残したい行を控えること：
--   select * from public.gw_vendor_invoices where invoice_kind = 'general';
--   select * from public.gw_office_vendors;
--   select * from public.gw_office_invoice_journals;
--   select * from public.gw_office_mf_exports;
--
-- 戻したあとも、BP の請求書の照合・承認・支払予定・支払済み・取消（月次画面）は、これまでどおり動く。
begin;

-- 一般請求書の支払・仕訳を先に消す（支払は請求書に ON DELETE CASCADE）
delete from public.gw_vendor_invoices where invoice_kind = 'general';

drop table if exists public.gw_office_mf_export_items;
drop table if exists public.gw_office_mf_exports;
drop table if exists public.gw_office_invoice_journals;
drop table if exists public.gw_office_payables_settings;

alter table public.gw_office_payments
  drop constraint if exists gw_office_payments_method_chk,
  drop constraint if exists gw_office_payments_amounts_chk,
  drop constraint if exists gw_office_payments_text_len_chk;
alter table public.gw_office_payments
  drop column if exists method,
  drop column if exists source_account,
  drop column if exists source_sub_account,
  drop column if exists paid_amount,
  drop column if exists fee_amount,
  drop column if exists memo,
  drop column if exists cancel_reason,
  drop column if exists cancelled_at,
  drop column if exists cancelled_by,
  drop column if exists mf_payment_first_exported_at,
  drop column if exists mf_payment_last_exported_at;

drop index if exists public.uq_gw_vendor_invoices_vendor_no;
drop index if exists public.idx_gw_vendor_invoices_vendor;
drop index if exists public.idx_gw_vendor_invoices_sha;
alter table public.gw_vendor_invoices
  drop constraint if exists gw_vendor_invoices_kind_chk,
  drop constraint if exists gw_vendor_invoices_due_source_chk,
  drop constraint if exists gw_vendor_invoices_journal_status_chk,
  drop constraint if exists gw_vendor_invoices_closing_day_chk,
  drop constraint if exists gw_vendor_invoices_method_chk,
  drop constraint if exists gw_vendor_invoices_text_len_chk;
alter table public.gw_vendor_invoices
  drop column if exists vendor_id,
  drop column if exists invoice_kind,
  drop column if exists invoice_date,
  drop column if exists closing_day,
  drop column if exists payment_terms,
  drop column if exists payment_due_on,
  drop column if exists due_source,
  drop column if exists registration_no,
  drop column if exists description,
  drop column if exists payment_method,
  drop column if exists source_account,
  drop column if exists source_sub_account,
  drop column if exists file_path,
  drop column if exists file_name,
  drop column if exists file_mime,
  drop column if exists file_size,
  drop column if exists file_sha256,
  drop column if exists journal_status,
  drop column if exists journal_date,
  drop column if exists journal_confirmed_at,
  drop column if exists journal_confirmed_by,
  drop column if exists mf_purchase_first_exported_at,
  drop column if exists mf_purchase_last_exported_at;

drop table if exists public.gw_office_vendors;

commit;

notify pgrst, 'reload schema';

-- バケット office-invoices は、中のファイルを Supabase の Storage 画面（または API）で空にしてから削除する
-- （SQL で storage.objects を直接消すと、実ファイルが残る）。
--   空にしたあと: delete from storage.buckets where id = 'office-invoices';
