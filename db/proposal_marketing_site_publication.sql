-- PROPOSAL ONLY. Review and obtain operator approval before applying to the correct DB.
-- Prerequisites: proposal_marketing_pr_drafts.sql and the existing 8grp-site
-- 8/zimu/news/articles.sql schema. Do NOT recreate news_articles or broaden its grants.
-- API must require Marketing + existing site manager (admin/owner), own registered PR,
-- and an explicitly configured matching tenant. news_articles is a global site table.
-- This transaction only requests publication through the existing daily news-sync.
-- It does not trigger deployment, send notifications, or claim that the site is live.
begin;
do $$ begin
 if to_regclass('public.gw_marketing_pr_drafts') is null
    or to_regclass('public.news_articles') is null then
  raise exception 'requires existing Marketing PR drafts and 8grp-site news_articles';
 end if;
end $$;

create table if not exists public.gw_marketing_site_publications (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references public.tenants(id) on delete restrict,
 draft_id uuid not null references public.gw_marketing_pr_drafts(id) on delete restrict,
 article_id uuid not null unique references public.news_articles(id) on delete restrict,
 draft_version integer not null check(draft_version >= 1),
 content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),
 title text not null check(char_length(btrim(title)) between 1 and 120),
 summary text not null check(char_length(btrim(summary)) between 1 and 600),
 body_html text not null check(char_length(btrim(body_html)) between 1 and 200000),
 slug text not null unique check(slug ~ '^press-mkt-[0-9a-f]{32}$'),
 requested_at timestamptz not null default now(),
 requested_by uuid not null references auth.users(id),
 checked_at timestamptz,
 verified_at timestamptz,
 last_check text not null default 'pending',
 unique(tenant_id,draft_id)
);
alter table public.gw_marketing_site_publications enable row level security;
revoke all on public.gw_marketing_site_publications from public,anon,authenticated;
revoke all on public.gw_marketing_site_publications from service_role;
grant select,insert on public.gw_marketing_site_publications to service_role;
grant update(checked_at,verified_at,last_check) on public.gw_marketing_site_publications to service_role;
comment on table public.gw_marketing_site_publications is
 'Immutable publication snapshot and later read-only public-content verification. Requested is not site-live. Only service_role through tenant/author-gated server API.';

-- Remove the earlier proposal signature so no stale-snapshot overload remains callable.
drop function if exists public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text);
create or replace function public.gw_marketing_publish_site(
 p_tenant uuid,p_actor uuid,p_draft uuid,p_version integer,p_hash text,
 p_title text,p_summary text,p_body text,p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 d public.gw_marketing_pr_drafts%rowtype;
 existing public.gw_marketing_site_publications%rowtype;
 saved public.gw_marketing_site_publications%rowtype;
 target_id uuid;
 target_slug text;
 next_article_id integer;
begin
 if p_tenant is null or p_actor is null or p_draft is null or p_version is null
    or p_version<1 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
    or p_title is null or char_length(btrim(p_title)) not between 1 and 120
    or p_summary is null or char_length(btrim(p_summary)) not between 1 and 600
    or p_body is null or char_length(btrim(p_body)) not between 1 and 200000 then
  raise exception 'invalid_publication' using errcode='23514';
 end if;
 -- Same draft serializes retries. The function is not callable by browser roles.
 select * into d from public.gw_marketing_pr_drafts
  where id=p_draft and tenant_id=p_tenant and created_by=p_actor for update;
 if not found then raise exception 'draft_forbidden' using errcode='42501'; end if;
 if d.status<>'registered' then raise exception 'registered_draft_required' using errcode='23514'; end if;
 if d.version<>p_version then raise exception 'draft_changed' using errcode='PT409'; end if;
 -- Rendering occurred before this lock. Detect even privileged source corrections
 -- that accidentally retain the same version; never publish the stale preview.
 if d.payload is distinct from p_payload then
  raise exception 'draft_payload_changed' using errcode='PT409';
 end if;
 select * into existing from public.gw_marketing_site_publications
  where tenant_id=p_tenant and draft_id=p_draft;
 if found then
  if existing.draft_version<>p_version or existing.content_hash<>p_hash
     or existing.title<>p_title or existing.summary<>p_summary or existing.body_html<>p_body then
   raise exception 'publication_changed' using errcode='PT409';
  end if;
  return to_jsonb(existing);
 end if;
 target_slug := 'press-mkt-'||replace(p_draft::text,'-','');
 -- Serializes new article number allocation with other writers. Existing writers
 -- retain their original behavior and unique constraints; no row is overwritten.
 lock table public.news_articles in share row exclusive mode;
 if exists(select 1 from public.news_articles where slug=target_slug) then
  raise exception 'publication_slug_conflict' using errcode='PT409';
 end if;
 select coalesce(max(article_id),0)+1 into next_article_id from public.news_articles;
 -- Published target rows are anonymously readable; never expose the actor UUID.
 -- The authenticated actor remains only in the private mapping requested_by field.
 insert into public.news_articles(article_id,slug,title,kind,summary,body_html,status,
   published_on,source,created_by,updated_by)
 values(next_article_id,target_slug,p_title,'プレスリリース',p_summary,p_body,'published',
   (now() at time zone 'Asia/Tokyo')::date,'portal','Marketing PR','Marketing PR')
 returning id into target_id;
 insert into public.gw_marketing_site_publications(tenant_id,draft_id,article_id,
   draft_version,content_hash,title,summary,body_html,slug,requested_by)
 values(p_tenant,p_draft,target_id,p_version,p_hash,p_title,p_summary,p_body,target_slug,p_actor)
 returning * into saved;
 return to_jsonb(saved);
end $$;
revoke all on function public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text,jsonb)
 to service_role;
commit;
