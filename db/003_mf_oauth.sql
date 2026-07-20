-- 003_mf_oauth.sql
-- MF OAuth トークン保管を扱いやすくする。
-- 暗号化済みトークン（AES-256-GCM）を base64 文字列で保存するため bytea → text へ変更。
-- accounting_credentials は現状データ無しのため型変更は安全。

alter table public.accounting_credentials
  alter column encrypted_token type text using encode(encrypted_token, 'base64');

alter table public.accounting_credentials
  alter column refresh_token_encrypted type text using
    (case when refresh_token_encrypted is null then null else encode(refresh_token_encrypted, 'base64') end);
