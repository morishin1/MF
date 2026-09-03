-- 006_storage_policies.sql
-- Storage バケット documents のアクセス制御。
--
-- ▼ なぜ必要か
-- schema.sql:308-333 のStorageポリシーは「参考」として丸ごとSQLコメントになっており、
-- schema.sql を実行しても storage.objects にポリシーは作られない。
-- 未適用の場合、storage.objects はポリシー不在＝全拒否となり、書類へのアクセスは
-- サーバ側 service_role が発行する短期署名URLだけに依存している状態になる。
-- （現状の app.html / admin.html は署名URL経由なので動くが、多層防御になっていない）
--
-- ▼ 元のコメント版からの修正点
-- 元案は split_part(name,'/',1)::uuid を無条件にキャストしていた。
-- この形だと、UUID以外のプレフィックス（例: 'groupware/...'）のオブジェクトが
-- 1つでも入った時点で invalid input syntax エラーになり、
-- 既存の書類一覧・署名URL発行まで巻き添えで落ちる。
-- PostgreSQL は AND の評価順を保証しないため、正規表現でガードするだけでは不十分。
-- そこで、失敗時に null を返す safe_uuid() を通してからキャストする。
--
-- 実行方法: Supabase の SQL Editor に全文を貼って実行。再実行しても安全。


-- =============================================================================
-- 1) バケット（非公開）
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;


-- =============================================================================
-- 2) 文字列を安全に uuid へ変換する（失敗したら null）
--    RLS の中で ::uuid を直接使うと、想定外のパスでクエリ全体が落ちるため。
-- =============================================================================
create or replace function public.safe_uuid(p text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p::uuid;
exception
  when others then
    return null;
end;
$$;


-- =============================================================================
-- 3) documents バケットのポリシー
--    パス規約: <tenant_id>/<client_id>/<YYYY-MM>/<doc_id>.<ext>
--      - 事務所スタッフ（admin/staff）… 自テナント配下すべて
--      - 顧問先ユーザー（client）      … 自分のクライアント配下のみ
--    safe_uuid が null を返した場合、is_tenant_staff(null) は false、
--    null in (...) は真にならないため、いずれも「拒否」に倒れる。
-- =============================================================================
drop policy if exists documents_owner_rw on storage.objects;
drop policy if exists documents_tenant_rw on storage.objects;

create policy documents_tenant_rw on storage.objects
  for all
  using (
    bucket_id = 'documents'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2)) in (select public.user_client_ids())
    )
  )
  with check (
    bucket_id = 'documents'
    and (
      public.is_tenant_staff(public.safe_uuid(split_part(name, '/', 1)))
      or public.safe_uuid(split_part(name, '/', 2)) in (select public.user_client_ids())
    )
  );


-- =============================================================================
-- 4) 確認用
--    実行後、以下で1行返ることを確認する。
--
--    select policyname, cmd
--      from pg_policies
--     where schemaname = 'storage' and tablename = 'objects';
-- =============================================================================
