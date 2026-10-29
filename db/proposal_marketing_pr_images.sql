-- REVIEW ONLY: apply separately with explicit operator approval. No existing rows altered.
-- Server-only private originals. No public or authenticated direct access is granted.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('marketing-pr-images','marketing-pr-images',false,2097152,array['image/png']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='marketing-pr-images' and public=false and file_size_limit=2097152 and allowed_mime_types=array['image/png']) then raise exception 'private_image_bucket_configuration'; end if;
end $$;
-- Restrictive policy protects the new bucket even if another permissive policy is broad.
create policy marketing_pr_images_no_direct on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id <> 'marketing-pr-images') with check(bucket_id <> 'marketing-pr-images');
create table public.gw_marketing_pr_images (
 id uuid primary key, draft_id uuid not null references public.gw_marketing_pr_drafts(id) on delete restrict,
 tenant_id uuid not null references public.tenants(id), created_by uuid not null references auth.users(id),
 name text not null check(length(name) between 1 and 200),
 source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
 source_size integer not null check(source_size between 1 and 2097152),
 state text not null default 'pending' check(state in ('pending','ready','failed')),
 size_bytes integer check(size_bytes between 1 and 2097152), sha256 text check(sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(), ready_at timestamptz,
 check((state='ready') = (size_bytes is not null and sha256 is not null and ready_at is not null))
);
create index gw_mpr_images_owner on public.gw_marketing_pr_images(tenant_id,created_by,draft_id);
alter table public.gw_marketing_pr_images enable row level security;
revoke all on public.gw_marketing_pr_images from public,anon,authenticated;
grant select,insert,update on public.gw_marketing_pr_images to service_role;
-- Bounded retention, not a destructive garbage collector: unlinked originals stay private.
-- At quota, an operator must review retention rather than silently deleting originals.
create function public.gw_marketing_pr_image_reserve(p_tenant uuid,p_actor uuid,p_draft uuid,p_version integer,p_id uuid,p_name text,p_hash text,p_size integer)
returns public.gw_marketing_pr_images language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.gw_marketing_pr_drafts; i public.gw_marketing_pr_images;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_tenant::text,0));
 select * into d from public.gw_marketing_pr_drafts where id=p_draft and tenant_id=p_tenant and created_by=p_actor for update;
 if not found or p_version is null or d.status<>'draft' or d.version<>p_version then raise exception 'draft_conflict'; end if;
 select * into i from public.gw_marketing_pr_images where id=p_id;
 if found then
  if i.tenant_id<>p_tenant or i.created_by<>p_actor or i.draft_id<>p_draft or i.source_hash<>p_hash or i.source_size<>p_size or i.name<>p_name or i.state='failed' then raise exception 'image_conflict'; end if;
  return i;
 end if;
 if (select count(*) from public.gw_marketing_pr_images where tenant_id=p_tenant)>=2000
 or (select count(*) from public.gw_marketing_pr_images where tenant_id=p_tenant and created_by=p_actor)>=500
 or (select count(*) from public.gw_marketing_pr_images where draft_id=p_draft)>=100
 or (select count(*) from public.gw_marketing_pr_images where tenant_id=p_tenant and created_by=p_actor and created_at>now()-interval '1 hour')>=20 then raise exception 'image_quota'; end if;
 insert into public.gw_marketing_pr_images(id,draft_id,tenant_id,created_by,name,source_hash,source_size) values(p_id,p_draft,p_tenant,p_actor,p_name,p_hash,p_size) returning * into i;
 return i;
end $$;
create function public.gw_marketing_pr_image_finish(p_tenant uuid,p_actor uuid,p_draft uuid,p_version integer,p_id uuid,p_size integer,p_hash text)
returns public.gw_marketing_pr_images language plpgsql security invoker set search_path=public,pg_temp as $$
declare d public.gw_marketing_pr_drafts; i public.gw_marketing_pr_images;
begin
 select * into d from public.gw_marketing_pr_drafts where id=p_draft and tenant_id=p_tenant and created_by=p_actor for update;
 if not found or p_version is null or d.status<>'draft' or d.version<>p_version then raise exception 'draft_conflict'; end if;
 select * into i from public.gw_marketing_pr_images where id=p_id and draft_id=p_draft and tenant_id=p_tenant and created_by=p_actor for update;
 if not found or i.state='failed' then raise exception 'image_conflict'; end if;
 if i.state='ready' then
  if i.sha256<>p_hash or i.size_bytes<>p_size then raise exception 'image_conflict'; end if;
  return i;
 end if;
 update public.gw_marketing_pr_images set state='ready',size_bytes=p_size,sha256=p_hash,ready_at=now() where id=p_id returning * into i;
 return i;
end $$;
revoke all on function public.gw_marketing_pr_image_reserve(uuid,uuid,uuid,integer,uuid,text,text,integer),public.gw_marketing_pr_image_finish(uuid,uuid,uuid,integer,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.gw_marketing_pr_image_reserve(uuid,uuid,uuid,integer,uuid,text,text,integer),public.gw_marketing_pr_image_finish(uuid,uuid,uuid,integer,uuid,integer,text) to service_role;
commit;
