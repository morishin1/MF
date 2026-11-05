-- A read-only unified ledger. No name-based company matching or inferred sends.
create or replace view public.gw_sales_company_history with (security_invoker=true) as
with records as (
 select 'mail:'||m.id::text as id,m.tenant_id,m.company_id,null::uuid as sales_company_id,m.created_at as occurred_at,
 'email'::text as kind,'Salesメール'::text as source,m.actor_name,
 case m.status when 'accepted' then 'メール送信受付済み' when 'sending' then 'メール送信処理中・結果未確定' when 'unknown' then 'メール送信結果不明（再送注意）' else 'メール未送信' end as label,
 m.subject,'宛先：'||m.to_email||E'\n送信元：'||m.from_email||E'\n\n'||m.body_text as detail,null::text as next_action,null::text as next_date
 from public.gw_sales_company_mail m
 union all
 select 'work:'||a.id::text,a.tenant_id,a.company_id,null::uuid,a.created_at,
 case a.operation when 'profile' then 'edit' when 'plan' then 'plan' else case when a.payload->>'channel'='memo' and a.payload->>'result' like 'メール送信%' then 'email' when a.payload->>'channel'='memo' and a.payload->>'result' like 'フォーム送信%' then 'form' when a.payload->>'channel'='memo' and a.payload->>'result' like '電話対応%' then 'phone' else coalesce(a.payload->>'channel','memo') end end,'Sales作業',a.actor_name,
 case a.operation when 'profile' then '企業情報を更新' when 'plan' then '次回対応を更新' else coalesce(a.payload->>'result','対応を記録') end,
 a.payload->>'subject',case when a.operation='profile' then a.payload::text else concat_ws(E'\n\n',nullif(a.payload->>'body',''),nullif(a.payload->>'note','')) end,
 a.payload->'plan'->>'nextAction',a.payload->'plan'->>'nextDate'
 from public.gw_sales_company_activity a
 union all
 select 'enger:'||t.id::text,tenant.id,t.company_id,null::uuid,t.occurred_at,
 case t.kind when 'メール' then 'email' when '電話' then 'phone' when 'フォーム' then 'form' when 'email' then 'email' when 'mail' then 'email' when 'call' then 'phone' when 'phone' then 'phone' when 'form' then 'form' else 'memo' end,'ENGER接点',coalesce(e.display_name,t.created_by,'記録者未登録'),
 coalesce(t.summary,t.kind,'接点を記録'),null::text,t.detail,t.next_action,t.next_due::text
 from enger.company_touchpoints t
 join public.tenants tenant on tenant.id='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac'::uuid
 left join lateral (select display_name from public.gw_employees where tenant_id=tenant.id and user_id::text=t.created_by order by id limit 1) e on true
 union all
 select 'event:'||v.id::text,v.tenant_id,null::uuid,v.company_id,v.occurred_at,
 case coalesce(v.channel,v.event_key) when 'email' then 'email' when 'mail' then 'email' when 'phone' then 'phone' when 'call' then 'phone' when 'form' then 'form' else 'memo' end,'Sales営業記録',coalesce(e.display_name,'記録者未登録'),
 coalesce(v.label,v.event_key,'対応を記録'),null::text,v.detail,null::text,null::text
 from public.gw_sales_events v left join public.gw_employees e on e.tenant_id=v.tenant_id and e.id=v.employee_id
 union all
 select 'approach:'||a.id::text,a.tenant_id,null::uuid,a.company_id,coalesce(a.sent_at,a.failed_at),
 case coalesce(a.channel,'form') when 'email' then 'email' when 'phone' then 'phone' when 'form' then 'form' else 'memo' end,'Sales送信記録',coalesce(e.display_name,'記録者未登録'),
 case when a.sent_at is not null then '送信済み（登録された実績）' else '送信できなかった' end,a.subject,concat_ws(E'\n\n',a.send_from,a.body,a.send_failed_note),null::text,null::text
 from public.gw_sales_approaches a left join public.gw_employees e on e.tenant_id=a.tenant_id and e.id=a.employee_id where a.sent_at is not null or a.failed_at is not null
 union all
 select 'change:'||a.id::text||':'||c.id::text,a.tenant_id,c.id,null::uuid,a.ts,'edit','Sales区分変更',coalesce(e.display_name,'記録者未登録'),
 case a.action when 'sales.enger_directory_segment' then '営業区分を変更' when 'sales.enger_directory_broadcast' then '配信区分を変更' when 'sales.enger_directory_priority' then '優先度を変更' when 'sales.enger_directory_relationship' then '取引状態を変更' when 'sales.enger_directory_exclude' then '企業を一覧から除外' else '企業を一覧に復元' end,null::text,
 (a.detail-'ids')::text,null::text,null::text
 from public.gw_activity_log a
 cross join lateral jsonb_array_elements_text(case when jsonb_typeof(a.detail->'ids')='array' then a.detail->'ids' else '[]'::jsonb end) selected(id)
 join enger.companies c on c.id::text=selected.id
 left join lateral (select display_name from public.gw_employees where tenant_id=a.tenant_id and user_id=a.actor_id order by id limit 1) e on true
 where a.action in ('sales.enger_directory_segment','sales.enger_directory_broadcast','sales.enger_directory_priority','sales.enger_directory_relationship','sales.enger_directory_exclude','sales.enger_directory_restore')
)
select r.*,coalesce(c.name,s.name,'企業名未取得') as company_name,
 case when r.company_id is not null then c.id is not null and c.deleted_at is null else s.id is not null end as company_available,
 concat_ws(' ',c.name,s.name,r.company_id::text,r.sales_company_id::text,r.actor_name,r.label,r.subject) as search_text
from records r left join enger.companies c on c.id=r.company_id
left join public.gw_sales_companies s on s.tenant_id=r.tenant_id and s.id=r.sales_company_id;
revoke all on public.gw_sales_company_history from public,anon,authenticated;
grant select on public.gw_sales_company_history to service_role;
