begin;
set local statement_timeout='180s';
-- Authorized one-time contact reconciliation. Contacts remain in tenant-scoped Sales.
-- ENGER source rows, stop flags, existing links and edited contact fields are not overwritten.
-- No mail/phone/form action is executed. Run inside a transaction; audit is atomic.
do $reconcile$
declare
 p record; n integer:=0; created_n integer:=0; linked_n integer:=0;
 batch constant text:='sales-contact-reconcile-20261105-v1';
 tenant constant uuid:='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac';
begin
 perform pg_advisory_xact_lock(hashtext(batch));
 if exists(select 1 from public.gw_activity_log where tenant_id=tenant and action='sales.company_contact_reconcile' and detail->>'batch'=batch) then return; end if;
 for p in with s as materialized (
 select s.*,regexp_replace(lower(normalize(s.name,NFKC)),'[[:space:]]','','g') as nn,
 regexp_replace(lower(substring(coalesce(nullif(s.site_url,''),s.domain) from '^(?:https?://)?([^/:?#]+)')),'^www[.]','') as host,
 regexp_replace(normalize(coalesce(s.address,''),NFKC),'[[:space:]]','','g') as addr,
 regexp_replace(coalesce(s.phone,''),'[^0-9]','','g') as tel
 from public.gw_sales_companies s where s.tenant_id='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac' and s.hidden_at is null
), e as materialized (
 select c.*,regexp_replace(lower(normalize(c.name,NFKC)),'[[:space:]]','','g') as nn,
 regexp_replace(lower(substring(c.website from '^(?:https?://)?([^/:?#]+)')),'^www[.]','') as host,
 regexp_replace(normalize(coalesce(c.address,''),NFKC),'[[:space:]]','','g') as addr,
 regexp_replace(coalesce(c.phone,''),'[^0-9]','','g') as tel
 from enger.companies c join enger.dx2_sales_company_directory_for_tenant d on d.id=c.id and d.tenant_id='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac' and d.directory_hidden_at is null where c.deleted_at is null
), pairs as materialized (
 select s.id as sid,e.id as eid,s.name as sname,e.name as ename,
 s.host=e.host and s.host like '%.%' as same_site,
 length(s.addr)>=10 and s.addr=e.addr as same_address,
 length(s.tel)>=10 and s.tel=e.tel as same_phone,
 nullif(lower(trim(e.contact_email)),'')=any(select lower(trim(x)) from unnest(s.emails) x) as same_email
 from s join e on regexp_replace(s.nn,'株式会社|有限会社|合同会社|[()]','','g')=regexp_replace(e.nn,'株式会社|有限会社|合同会社|[()]','','g')
), strong as materialized (select *,count(*) over(partition by sid) as sc,count(*) over(partition by eid) as ec from pairs where same_site or same_address or same_phone or same_email)
, legacy as (
 select l.* from enger.dx2_legacy_company_sources l
 where l.matched_company_id is not null and not l.hard_suppressed
 and l.match_method in ('created_from_legacy_staging','exact_name_and_website')
 and (l.email_unverified ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or regexp_replace(coalesce(l.phone_unverified,''),'[^0-9]','','g') ~ '^0[0-9]{9,10}$')
 and l.matched_company_id in (select matched_company_id from enger.dx2_legacy_company_sources where matched_company_id is not null group by matched_company_id having count(*)=1)
), eligible as (
 select e.*, l.external_key,l.email_unverified,l.phone_unverified,l.source_filename,l.source_references,
 strong.sid as matched_sales_id
 from e
 join enger.dx2_sales_company_directory_for_tenant d on d.id=e.id and d.tenant_id='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'
 left join legacy l on l.matched_company_id=e.id
 left join strong on strong.eid=e.id and strong.sc=1 and strong.ec=1
 where not d.needs_contact_review
 and (strong.sid is not null or l.external_key is not null)
 and not exists(select 1 from public.gw_sales_company_links x where x.tenant_id=d.tenant_id and x.source_company_id=e.id::text)
 and not exists(select 1 from public.gw_sales_company_activity a where a.tenant_id=d.tenant_id and a.company_id=e.id and a.operation='profile' and (a.payload?'phone' or a.payload?'contactEmail'))
 and (
   strong.sid is not null and not exists(select 1 from public.gw_sales_company_links x where x.tenant_id=d.tenant_id and x.company_id=strong.sid)
   or strong.sid is null and not exists(select 1 from s where regexp_replace(s.nn,'株式会社|有限会社|合同会社|[()]','','g')=regexp_replace(e.nn,'株式会社|有限会社|合同会社|[()]','','g') or s.host=e.host and s.host like '%.%')
 )
), plan as (
 select e.id as eid,coalesce(e.matched_sales_id,gen_random_uuid()) as sid,e.matched_sales_id is null as create_sales,e.name,
 coalesce(nullif(trim(s.phone),''),nullif(trim(e.phone),''),case when regexp_replace(coalesce(e.phone_unverified,''),'[^0-9]','','g') ~ '^0[0-9]{9,10}$' then trim(e.phone_unverified) end) as phone,
 case when cardinality(s.emails)>0 then s.emails else array(select v from (select distinct on (lower(trim(v))) trim(v) as v,ord from unnest(array[e.contact_email,e.email_unverified]) with ordinality u(v,ord) where v ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' order by lower(trim(v)),ord) dedup order by ord) end as emails,
 coalesce(nullif(s.site_url,''),e.website) as site_url,
 coalesce(nullif(s.form_url,''),e.contact_form_url) as form_url,
 e.address,e.industry,e.prefecture,e.external_key,e.source_filename,e.source_references,
 case when e.matched_sales_id is not null then jsonb_build_object('phone',s.phone,'emails',s.emails,'updated_at',s.updated_at) else null end as before_sales,
 s.ng_reason,e.contact_email as primary_enger_email
 from eligible e left join s on s.id=e.matched_sales_id where s.ng_reason is null
)
 select * from plan loop
  if exists(select 1 from public.gw_sales_company_links where tenant_id=tenant and source_company_id=p.eid::text) then raise exception 'Concurrent source link; rerun reconciliation'; end if;
  if p.create_sales then
   -- Explicit source ID link is authoritative. Do not merge different legal entities by host.
   insert into public.gw_sales_companies(id,tenant_id,name,phone,emails,site_url,form_url,address,industry,region,status,next_action,note)
   values(p.sid,tenant,p.name,p.phone,p.emails,p.site_url,p.form_url,p.address,p.industry,p.prefecture,'untouched','旧資料の連絡先と履歴を確認して対応',
    '企業IDに紐づく旧営業台帳から連絡先を反映。現在の在籍・到達性は未確認。出典と紐づけ日時は営業履歴を参照。');
   created_n:=created_n+1;
  else
   perform 1 from public.gw_sales_companies where id=p.sid and tenant_id=tenant and hidden_at is null and ng_reason is null
    and jsonb_build_object('phone',phone,'emails',emails,'updated_at',updated_at)=p.before_sales for update;
   if not found then raise exception 'Sales contact changed; rerun reconciliation'; end if;
   update public.gw_sales_companies set phone=p.phone,emails=p.emails,updated_at=now() where id=p.sid and tenant_id=tenant;
   linked_n:=linked_n+1;
  end if;
  insert into public.gw_sales_company_links(tenant_id,source_system,source_company_id,company_id,method)
   values(tenant,'enger',p.eid::text,p.sid,case when p.create_sales then 'created' else 'domain' end);
  insert into public.gw_sales_company_activity(tenant_id,company_id,request_key,actor_name,operation,payload)
   values(tenant,p.eid,gen_random_uuid(),'AI（企業情報の照合）','activity',
    jsonb_build_object('channel','memo','result','連絡先を紐づけ',
     'note',concat_ws(E'\n','Sales企業ID：'||p.sid,
      case when p.external_key is not null then '企業IDに紐づく旧営業台帳の電話・メールを反映。現在の在籍・到達性は未確認。' else '企業名と公式サイトの一致を確認し、既存Sales企業へ紐づけ。' end,
      '出典：'||p.source_filename,'元資料の参照：'||p.source_references),
     'sourceKey',p.external_key,'batch',batch));
  insert into public.gw_activity_log(tenant_id,action,target,detail)
   values(tenant,'sales.company_contact_reconcile',p.eid::text,
    jsonb_build_object('batch',batch,'engerId',p.eid,'salesId',p.sid,'createdSales',p.create_sales,'beforeSales',p.before_sales,
      'afterSales',jsonb_build_object('phone',p.phone,'emails',p.emails),'sourceKey',p.external_key,'contactVerified',false));
  n:=n+1;
 end loop;
 if n<>2625 or created_n<>2602 or linked_n<>23 then raise exception 'Plan changed: total %, created %, linked %',n,created_n,linked_n; end if;
 if exists(select 1 from public.gw_sales_company_links l left join public.gw_sales_companies s on s.id=l.company_id and s.tenant_id=l.tenant_id where l.tenant_id=tenant and s.id is null) then raise exception 'Broken tenant link'; end if;
end;
$reconcile$;
commit;

