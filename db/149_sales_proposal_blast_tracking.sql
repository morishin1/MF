-- Sales提案のブラスト配信履歴（先行DB138必須）。
-- 配信・面談化は担当者の確認記録。実メールの一斉送信処理は含まない。
begin;
do $$
begin
 if to_regclass('public.gw_sales_proposals') is null or
    to_regclass('public.gw_sales_proposal_activities') is null then
    raise exception 'db/138_sales_proposals.sql を先に適用してください';
 end if;
end $$;
create table if not exists public.gw_sales_proposal_blasts (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete cascade,
 proposal_id uuid not null references public.gw_sales_proposals(id) on delete cascade,
 batch_id uuid not null,
 sent_at timestamptz not null,
 channel text not null default 'external_email' check (channel in ('external_email','external_service')),
 send_reference text not null check (char_length(btrim(send_reference)) between 4 and 200),
 sent_by uuid not null references auth.users(id),
 meeting_confirmed_at timestamptz,
 meeting_note text check (meeting_note is null or char_length(btrim(meeting_note)) between 10 and 1000),
 meeting_recorded_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 constraint gw_sales_blast_meeting_guard check
   ((meeting_confirmed_at is null and meeting_note is null and meeting_recorded_by is null)
    or (meeting_confirmed_at is not null and meeting_note is not null and meeting_recorded_by is not null
         and meeting_confirmed_at>=sent_at)),
 unique(tenant_id,proposal_id,batch_id)
);
create index if not exists gw_sales_proposal_blasts_by_proposal
 on public.gw_sales_proposal_blasts(tenant_id,proposal_id,sent_at desc);
alter table public.gw_sales_proposal_blasts enable row level security;
drop policy if exists gw_sales_blast_select on public.gw_sales_proposal_blasts;
create policy gw_sales_blast_select on public.gw_sales_proposal_blasts
 for select to authenticated using
 (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
drop policy if exists gw_sales_blast_insert on public.gw_sales_proposal_blasts;
create policy gw_sales_blast_insert on public.gw_sales_proposal_blasts
 for insert to authenticated with check
 (public.gw_is_sales(tenant_id) and sent_by=auth.uid() and exists(
   select 1 from public.gw_sales_proposals p where p.id=proposal_id and p.tenant_id=tenant_id
   and p.archived_at is null
   and (public.gw_sales_is_manager(tenant_id) or p.sales_owner_id=public.gw_employee_id(tenant_id))));
drop policy if exists gw_sales_blast_update on public.gw_sales_proposal_blasts;
create policy gw_sales_blast_update on public.gw_sales_proposal_blasts
 for update to authenticated using
 (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id)
   and exists(select 1 from public.gw_sales_proposals p where p.id=proposal_id and p.tenant_id=tenant_id
     and p.archived_at is null and
     (public.gw_sales_is_manager(tenant_id) or p.sales_owner_id=public.gw_employee_id(tenant_id))))
 with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
-- 送信という事実は追記後に書換え禁止。更新可能なのは面談確認3列の初回入力だけ。
create or replace function public.gw_sales_blast_immutable_guard() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
  or new.proposal_id is distinct from old.proposal_id or new.batch_id is distinct from old.batch_id
  or new.sent_at is distinct from old.sent_at or new.channel is distinct from old.channel
  or new.send_reference is distinct from old.send_reference or new.sent_by is distinct from old.sent_by
  or new.created_at is distinct from old.created_at
  or old.meeting_confirmed_at is not null or new.meeting_confirmed_at is null
 then raise exception 'blast_history_immutable'; end if;
 if not exists(
  select 1 from public.gw_sales_proposal_activities a
  where a.tenant_id=old.tenant_id and a.proposal_id=old.proposal_id
    and a.kind='meeting' and a.result in ('scheduled','done')
    and a.occurred_at >= old.sent_at
 ) then raise exception 'meeting_evidence_required'; end if;
 if new.meeting_recorded_by is distinct from auth.uid()
 then raise exception 'actor_mismatch'; end if;
 return new;
end $$;
drop trigger if exists gw_sales_blast_guard on public.gw_sales_proposal_blasts;
create trigger gw_sales_blast_guard before update on public.gw_sales_proposal_blasts
 for each row execute function public.gw_sales_blast_immutable_guard();
revoke all on public.gw_sales_proposal_blasts from anon,authenticated;
grant select,insert,update on public.gw_sales_proposal_blasts to authenticated;
grant all on public.gw_sales_proposal_blasts to service_role;
-- 削除は不可：配信履歴と面談の根拠を保持する。
notify pgrst,'reload schema';
commit;
