-- 157_onboarding_file_read_scope.sql
-- 入退社書類：社労士は共有許可された通常書類だけを閲覧。
-- マイナンバー関連書類はこのシステムでは収集・共有しない。
-- 既存データは削除・移動しない（別途棚卸し）。
--
-- 前提: db/008_onboarding.sql, db/012_hr_files.sql, db/039_consent_and_drive.sql
-- 事前確認: SELECT id, name, public FROM storage.buckets WHERE id = 'hr';
--             public は false でなければならない。
-- 適用後: この SQL で hr バケットは公開しない。既存 Drive 権限は変更しない。

begin;
alter table public.gw_procedure_files enable row level security;

drop policy if exists gw_procedure_files_select on public.gw_procedure_files;
create policy gw_procedure_files_select on public.gw_procedure_files
  for select to authenticated
  using (
    public.is_tenant_staff(tenant_id)
    or public.gw_is_hr(tenant_id)
    or public.gw_procedure_is_mine(procedure_id)
    or (
      public.gw_is_advisor(tenant_id)
      and exists (
        select 1
          from public.gw_procedure_items i
         where i.id = gw_procedure_files.item_id
           and i.procedure_id = gw_procedure_files.procedure_id
           and i.tenant_id = gw_procedure_files.tenant_id
           and i.share_with_advisor = true
           and coalesce(i.item_key, '') <> 'doc_mynumber'
           and coalesce(i.title, '') !~* '(マイナンバー|個人番号|通知カード|番号確認)'
      )
    )
  );
commit;
