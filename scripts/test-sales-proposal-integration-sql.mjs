import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
const db = new PGlite();
const migrations = (file) => readFileSync(new URL("../db/" + file, import.meta.url), "utf8");
await db.exec(`
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create schema enger;
create table auth.users (id uuid primary key);
create table public.tenants (id uuid primary key);
create table public.gw_sales_companies (id uuid primary key, tenant_id uuid);
create table public.gw_sales_events (id uuid primary key, channel text);
create table public.gw_employees (id uuid primary key, tenant_id uuid, status text);
create table enger.proposals (id uuid primary key, stage text, deleted_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, service_role, anon;
create function public.gw_employee_id(p_tenant uuid) returns uuid language sql stable security definer as $$
 select id from public.gw_employees where id=auth.uid() and tenant_id=p_tenant and status='active'
$$;
create function public.gw_is_sales(p_tenant uuid) returns boolean language sql stable as $$ select public.gw_employee_id(p_tenant) is not null $$;
create function public.gw_has_role(uuid,text) returns boolean language sql as $$ select false $$;
create function public.gw_has_app(uuid,text) returns boolean language sql as $$ select false $$;
create function public.is_tenant_staff(uuid) returns boolean language sql as $$ select false $$;
`);
for (const migration of ["138_sales_proposals.sql","140_sales_proposal_matching.sql","149_sales_proposal_source_state.sql"]) {
  try { await db.exec(migrations(migration)); } catch (error) { throw new Error(migration, { cause: error }); }
}
await db.exec(`
alter table public.gw_sales_proposals add column archived_at timestamptz;
grant select on public.gw_sales_proposals, public.gw_sales_proposal_activities, public.gw_sales_proposal_tasks to authenticated;
grant select,update,insert on public.gw_sales_proposals, public.gw_sales_proposal_activities, public.gw_sales_proposal_tasks to service_role;
`);
const apply = () => db.exec(migrations("185_sales_proposal_integration.sql"));
await apply();
await apply();
const tenant = "4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac";
const outside = "00000000-0000-0000-0000-000000000002";
const actor = "00000000-0000-0000-0000-000000000003";
const outsider = "00000000-0000-0000-0000-000000000004";
const p = "00000000-0000-0000-0000-000000000005";
const referral = "00000000-0000-0000-0000-000000000006";
const active = "00000000-0000-0000-0000-000000000007";
const activity = "00000000-0000-0000-0000-000000000008";
const task = "00000000-0000-0000-0000-000000000009";
const start = "2026-11-09T00:00:00.000Z";
await db.exec(`
insert into auth.users values ('${actor}'), ('${outsider}');
insert into public.tenants values ('${tenant}'), ('${outside}');
insert into public.gw_employees values ('${actor}', '${tenant}', 'active'), ('${outsider}', '${outside}', 'active');
insert into enger.proposals values ('${p}', '失注', null), ('${referral}', '提案中', null), ('${active}', '提案中', null);
insert into public.gw_sales_proposals (id,tenant_id,source_system,source_proposal_id,company_name,title,source_stage,status,sales_owner_id,sent_at,updated_at)
 values ('${p}','${tenant}','enger','${p}','資本金テスト','架空のSES','提案中','call_wait','${actor}','${start}','${start}'),
 ('${referral}','${tenant}','enger','${referral}','架空の会社','架空の紹介','提案中','call_wait','${actor}','${start}','${start}'),
 ('${active}','${tenant}','enger','${active}','架空の会社','架空のSES','提案中','call_wait','${actor}','${start}','${start}');
insert into public.gw_sales_proposal_activities (id,tenant_id,proposal_id,kind,result,evidence,occurred_at)
 values ('${activity}','${tenant}','${p}','sent','sent','system','${start}');
insert into public.gw_sales_proposal_tasks (id,tenant_id,proposal_id,kind,title,due_at,status,auto,source_event,assignee_id)
 values ('${task}','${tenant}','${p}','prepare','提案準備','${start}','open',true,'auto:prepare','${actor}');
`);
const repair = migrations("repair_sales_enger_proposal_metadata.sql");
const first = await db.exec(repair);
assert.equal(first[1].rows[0].corrected_source_stages, 1);
assert.equal(first[2].rows[0].completed_preparation_tasks, 1);
const second = await db.exec(repair);
assert.equal(second[1].rows[0].corrected_source_stages, 0);
assert.equal(second[2].rows[0].completed_preparation_tasks, 0);
assert.deepEqual((await db.query("select status,source_stage,sales_owner_id from public.gw_sales_proposals where id=$1", [p])).rows,
  [{ status: "call_wait", source_stage: "失注", sales_owner_id: actor }]);
assert.deepEqual((await db.query("select status,done_activity_id from public.gw_sales_proposal_tasks where id=$1", [task])).rows,
  [{ status: "done", done_activity_id: activity }]);
const rpc = "select public.gw_record_sales_proposal_progress($1,$2,$3,$4,$5,$6,$7,$8,$9)";
const fresh = async id => (await db.query("select updated_at from public.gw_sales_proposals where id=$1",[id])).rows[0].updated_at;
const terms = (kind,revenue,stage="conditions") => ({
  stage, revenueKind: kind, revenue, startOn: "2026-11-13", contractConfirmed: stage==="won",
});
const payload = (id, salesProgress) => ({
  id, kind: salesProgress.stage === "won" ? "result" : "memo",
  result: salesProgress.stage === "won" ? "won" : null, occurred_at: "2026-11-14T01:00:00Z",
  employee_id: actor, note: "架空の検証", detail: { salesProgress }, source_event: "progress:"+id,
});
const invalid = [{ kind: "manual", title: "期限不明", assignee_id: actor, auto: false }];
const id1 = "00000000-0000-0000-0000-000000000011";
const data1 = [tenant,p,await fresh(p),actor,payload(id1,terms("monthly",600000)),{status:"considering"},[],[],invalid];
await db.exec(`set role authenticated; set request.jwt.claim.sub = '${actor}'`);
await assert.rejects(db.query(rpc,data1),{code:"42501"});
await db.exec("set role service_role");
await assert.rejects(db.query(rpc,data1),{code:"23502"});
assert.equal((await db.query("select count(*) as n from public.gw_sales_proposal_activities where id=$1",[id1])).rows[0].n,0);
assert.equal((await db.query("select status from public.gw_sales_proposals where id=$1",[p])).rows[0].status,"call_wait");
data1[8] = [{...invalid[0],due_at:"2026-11-20T04:00:00Z",source_event:"progress:"+id1}];
await db.query(rpc,data1);
await assert.rejects(db.query(rpc,data1),{code:"40001"});
const id2 = "00000000-0000-0000-0000-000000000012";
await db.query(rpc,[tenant,referral,await fresh(referral),actor,payload(id2,terms("one_time",1200000,"won")),{status:"won",closed_at:"2026-11-14T01:00:00Z"},[],[],[]]);
const id3 = "00000000-0000-0000-0000-000000000013";
await db.query(rpc,[tenant,active,await fresh(active),actor,payload(id3,terms("monthly",800000,"won")),{status:"won",closed_at:"2026-11-14T01:00:00Z"},[],[],[]]);
await db.exec(`set role authenticated; set request.jwt.claim.sub = '${actor}'`);
const totals = async () => (await db.query("select * from public.gw_sales_enger_revenue($1,'2026-11-01','2026-11-30')", [tenant])).rows[0];
assert.deepEqual(await totals(),{monthly_forecast:"600000",monthly_confirmed:"800000",referral_forecast:"0",referral_confirmed:"1200000",excluded_count:0});
await db.exec(`set request.jwt.claim.sub = '${outsider}'`);
assert.deepEqual(await totals(),{monthly_forecast:"0",monthly_confirmed:"0",referral_forecast:"0",referral_confirmed:"0",excluded_count:0});
console.log("Postgres: migration and repair are idempotent, write ACL, rollback on task failure, compare-and-set, revenue buckets and tenant RLS passed.");
await db.close();
