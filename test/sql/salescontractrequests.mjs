// Isolated PostgreSQL/PGlite integration. No network, production DB, or credentials.
// PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node test/sql/salescontractrequests.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
const modulePath=process.env.PGLITE_MODULE;
if(!modulePath) throw new Error('Set PGLITE_MODULE to a locally installed PGlite module; this test never installs dependencies.');
const {PGlite}=await import(pathToFileURL(modulePath).href);
const root=fileURLToPath(new URL('../..',import.meta.url));
const db=new PGlite();
let count=0;
const test=async(name,fn)=>{await fn();count++;console.log('PASS',name);};
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=uid(1), T2=uid(2), U=n=>uid(100+n), E=n=>uid(200+n), P=n=>uid(300+n);
const q=async(sql,args=[])=>db.query(sql,args);
const scalar=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
const as=async(user,fn)=>{await q("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec('set role authenticated');try{return await fn();}finally{await db.exec("reset role; select set_config('request.jwt.claim.sub','',false)");}};
const read=(user,mode='sales',proposal=null,tenant=T)=>as(user,()=>scalar('select public.gw_sales_contract_requests_read($1,$2,$3)',[tenant,mode,proposal]));
const act=(user,action,payload={},version=null,proposal=P(1),mode='sales',tenant=T)=>as(user,()=>scalar('select public.gw_sales_contract_request_action($1,$2,$3,$4,$5,$6)',[tenant,proposal,mode,action,version,JSON.stringify(payload)]));
const rejects=async(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,`${e.message} unexpected SQLSTATE`);return true;});
const create={contractType:'needs_confirmation',requestedDueOn:'2026-11-02',plannedStartOn:'2026-11-10',note:'テストのみの架空依頼'};
const update=(more={})=>({reason:'書類作成を確認',...more});
const files=['test/sql/000_supabase_stub.sql','db/schema.sql','db/005_groupware_core.sql','db/041_admin_is_hr.sql','db/075_partner_bp.sql','db/076_site_contracts.sql','db/081_hr_recruiting.sql','db/088_sales.sql','db/094_recruit_sales_roles.sql','db/099_access_hr_office.sql','db/099_owner_only.sql','db/119_app_grants.sql','db/120_left_gate.sql','db/130_sales_access_align.sql','db/096_sales_channels.sql','db/138_sales_proposals.sql','db/140_sales_proposal_matching.sql','db/141_sales_cs_closing_handoff.sql','db/142_sales_team_proposals_bulk.sql','db/046_esign.sql','db/056_doc_orders.sql'];
const migration=readFileSync(root+'/db/proposal_sales_office_contract_requests.sql','utf8');
try{
 await db.exec('create role anon nologin;');
 for(const f of files) await db.exec(readFileSync(root+'/'+f,'utf8').replace(/^create extension[^;]+;/gm,''));
 await db.exec('grant all on all tables in schema public to authenticated,service_role; grant execute on all functions in schema public to authenticated,service_role;');
 await db.exec(migration);
 await test('migration twice is valid on real prerequisite schemas',()=>db.exec(migration));
 await q('insert into tenants(id,name) values($1,$2),($3,$4)',[T,'架空テスト社A',T2,'架空テスト社B']);
 for(let n=1;n<=9;n++){
  await q('insert into auth.users(id) values($1)',[U(n)]);
  await q('insert into gw_employees(id,user_id,tenant_id,display_name) values($1,$2,$3,$4)',[E(n),U(n),n===6?T2:T,`テスト担当${n}`]);
 }
 for(const [n,role] of [[3,'finance'],[4,'owner'],[5,'manager'],[6,'owner'],[8,'finance'],[9,'hr']]) await q('insert into gw_role_grants(tenant_id,employee_id,role) values($1,$2,$3)',[n===6?T2:T,E(n),role]);
 for(const [n,app] of [[1,'sales'],[2,'sales'],[3,'office'],[7,'office'],[8,'office'],[9,'office']]) await q('insert into gw_app_grants(tenant_id,employee_id,app_key) values($1,$2,$3)',[T,E(n),app]);
 for(let n=1;n<=7;n++) await q(`insert into gw_sales_proposals(id,tenant_id,source_system,source_proposal_id,source_stage,company_name,title,talent_initials,sales_owner_id,sent_at,status,closed_at,close_reason)
 values($1,$2,$3,$4,$5,'架空顧客','架空の合格後管理','T.T.',$6,now(),$7,$8,$9)`,[P(n),n===4?T2:T,n===6?'manual':'enger',n===6?null:'source-'+n,n===2||n===3?'稼働':'合格',n===4?E(6):E(1),n===5?'lost':'meeting_done',n===5?new Date().toISOString():null,n===5?'client_declined':null]);
 await q("insert into gw_sales_proposal_activities(tenant_id,proposal_id,kind,source_event,detail) values($1,$2,'sync','event-accepted-003',$3)",[T,P(3),JSON.stringify({from:'面談',to:'合格'})]);
 await q("insert into gw_sales_proposal_tasks(tenant_id,proposal_id,kind,title,due_at,assignee_id) values($1,$2,'manual','既存フォロー',now(),$3)",[T,P(1),E(1)]);
 await q("insert into gw_doc_orders(id,tenant_id,employee_id,doc_kind,title) values($1,$2,$3,'employment','架空の契約書')",[uid(501),T,E(1)]);
 await q("insert into gw_doc_orders(id,tenant_id,employee_id,doc_kind,title) values($1,$2,$3,'employment','別テナントの書類')",[uid(502),T2,E(6)]);
 await q("insert into gw_site_contracts(id,tenant_id,employee_id,engagement_kind,site_company,period_from) values($1,$2,$3,'pp','架空現場','2026-11-01')",[uid(503),T,E(1)]);
 await test('list includes explicit pass and historical transition, not inferred稼働/manual',async()=>{
  const r=await read(U(1));assert.ok(r.rows.some(x=>x.proposalId===P(1)));assert.ok(r.rows.some(x=>x.proposalId===P(3)));
  assert.ok(!r.rows.some(x=>x.proposalId===P(2)));assert.ok(!r.rows.some(x=>x.proposalId===P(6)));assert.ok(!r.rows.some(x=>x.proposalId===P(4)));
  assert.equal(r.rows.find(x=>x.proposalId===P(5)).canRequest,false);
 });
 await test('Office grants require both app and job role',async()=>{
  for(const u of [U(1),U(5),U(7),U(9)]) await rejects(()=>read(u,'office'),'42501');
  assert.deepEqual((await read(U(3),'office')).rows,[]);
 });
 await test('other owner cannot create, tenant crossing denied',async()=>{
  await rejects(()=>act(U(2),'create',create),'42501');await rejects(()=>act(U(6),'create',create),'42501');
  await rejects(()=>act(U(1),'create',create,null,P(4)),'42501');
 });
 await test('unknown pass, manual and lost cannot request',async()=>{for(const n of [2,5,6])await rejects(()=>act(U(1),'create',create,null,P(n)),'23514');});
 let first;
 await test('request created with one atomic audit',async()=>{first=await act(U(1),'create',create);assert.equal(first.version,1);assert.equal(await scalar('select count(*)::int from gw_sales_contract_request_events'),1);});
 await test('duplicate create never overwrites or repeats audit',async()=>{
  const r=await act(U(1),'create',{...create,note:'DO NOT OVERWRITE'});assert.equal(r.id,first.id);assert.equal(r.replayed,true);
  assert.equal(await scalar('select note from gw_sales_contract_requests where id=$1',[first.id]),create.note);
  assert.equal(await scalar('select count(*)::int from gw_sales_contract_request_events'),1);
 });
 await test('raw requests/events cannot bypass masked RPC',async()=>{
  for(const table of ['gw_sales_contract_requests','gw_sales_contract_request_events']) for(const op of [`select * from ${table}`,`delete from ${table}`,`update ${table} set tenant_id='${T2}'`]) await rejects(()=>as(U(1),()=>q(op)),'42501');
 });
 await test('unauth and cross-tenant read rejected',async()=>{await rejects(()=>read(null),'42501');await rejects(()=>read(U(6),'sales',null,T),'42501');});
 await test('Sales cannot drive Office state',async()=>{await rejects(()=>act(U(1),'update',update({status:'in_progress'}),1,P(1),'office'),'42501');await rejects(()=>act(U(1),'update',update(),1),'23514');});
 await test('stale expectedVersion conflict leaves audit untouched',async()=>{await rejects(()=>act(U(3),'update',update({status:'in_progress'}),9,P(1),'office'),'PT409');assert.equal(await scalar('select count(*)::int from gw_sales_contract_request_events'),1);});
 await test('workflow cannot skip directly to completed',async()=>{await rejects(()=>act(U(3),'update',update({status:'completed',contractType:'client_ses',assigneeId:E(3),artifactReference:'内部文書棚のテストPDF'}),1,P(1),'office'),'23514');});
 await test('Office cannot assign Sales-only member',async()=>{await rejects(()=>act(U(3),'update',update({assigneeId:E(1)}),1,P(1),'office'),'23514');});
 await test('past-due leaving staff cannot be assigned or access queue',async()=>{
  await q("update gw_employees set status='leaving',left_on='2000-01-01' where id=$1",[E(8)]);
  assert.ok(!(await read(U(3),'office')).members.some(m=>m.id===E(8)));
  await rejects(()=>act(U(3),'update',update({assigneeId:E(8)}),1,P(1),'office'),'23514');
  await rejects(()=>read(U(8),'office'),'42501');
  await q("update gw_employees set status='active',left_on=null where id=$1",[E(8)]);
 });
 await test('non-HR cannot attach HR doc order',async()=>{await rejects(()=>act(U(3),'update',update({employeeId:E(1),docOrderId:uid(501),contractType:'employment'}),1,P(1),'office'),'42501');});
 await test('doc link tenant and contract type checked',async()=>{
  await rejects(()=>act(U(4),'update',update({employeeId:E(1),docOrderId:uid(502),contractType:'employment'}),1,P(1),'office'),'23514');
  await rejects(()=>act(U(4),'update',update({employeeId:E(1),docOrderId:uid(501),contractType:'client_ses'}),1,P(1),'office'),'23514');
 });
 await test('Office owner links existing document and starts work',async()=>{
  const r=await act(U(4),'update',update({status:'in_progress',contractType:'employment',assigneeId:E(3),employeeId:E(1),docOrderId:uid(501),siteContractId:uid(503)}),1,P(1),'office');assert.equal(r.version,2);
 });
 await test('Sales projection masks all HR/internal IDs',async()=>{
  const r=(await read(U(1),'sales',P(1))).rows[0].request;assert.equal(r.employeeId,null);assert.equal(r.docOrderId,null);assert.equal(r.siteContractId,null);
 });
 await test('non-HR Office has protected doc flag without ID',async()=>{
  const x=await read(U(3),'office',P(1));assert.equal(x.canLinkHrDocs,false);assert.equal(x.rows[0].request.hasDocOrder,true);assert.equal(x.rows[0].request.docOrderId,null);
 });
 await test('non-HR cannot clear protected HR association',async()=>{
  await rejects(()=>act(U(3),'update',update({docOrderId:null}),2,P(1),'office'),'42501');
  await rejects(()=>act(U(3),'update',update({employeeId:E(2)}),2,P(1),'office'),'23514');
  assert.equal(await scalar('select doc_order_id from gw_sales_contract_requests where id=$1',[first.id]),uid(501));
 });
 await test('non-HR can advance without changing protected links',async()=>{
  assert.equal((await act(U(3),'update',update({status:'review'}),2,P(1),'office')).version,3);
 });
 await test('draft complete requires artifact reference; unknown type cannot complete',async()=>{
  await rejects(()=>act(U(3),'update',update({status:'completed'}),3,P(1),'office'),'23514');
  await rejects(()=>act(U(4),'update',update({status:'completed',contractType:'needs_confirmation',docOrderId:null,artifactReference:'内部保管の文書名ABC.pdf'}),3,P(1),'office'),'23514');
 });
 await test('completion is recorded without any signing, contract or proposal update',async()=>{
  await act(U(3),'update',update({status:'completed',artifactReference:'内部保管の文書名ABC.pdf'}),3,P(1),'office');
  assert.equal(await scalar('select status from gw_doc_orders where id=$1',[uid(501)]),'requested');
  assert.equal(await scalar('select status from gw_sales_proposals where id=$1',[P(1)]),'meeting_done');
  assert.equal(await scalar('select count(*)::int from gw_sales_proposal_tasks where proposal_id=$1 and status=\'open\'',[P(1)]),1);
  assert.equal(await scalar('select count(*)::int from gw_sign_requests'),0);
 });
 await test('completed cannot edit or cancel; explicit reopen retains links',async()=>{
  await rejects(()=>act(U(3),'update',update(),4,P(1),'office'),'23514');await rejects(()=>act(U(1),'cancel',{reason:'取消確認理由'},4),'23514');
  const r=await act(U(3),'reopen',{reason:'内容変更のため再開'},4,P(1),'office');assert.equal(r.version,5);
  const x=(await read(U(4),'office',P(1))).rows[0].request;assert.equal(x.status,'requested');assert.equal(x.docOrderId,uid(501));assert.equal(x.assigneeId,null);assert.equal(x.artifactReference,null);
 });
 await test('forged sync and ENGER source changes rejected',async()=>{
  await rejects(()=>as(U(1),()=>q("update gw_sales_proposals set source_stage='合格' where id=$1",[P(2)])),'42501');
  await rejects(()=>as(U(1),()=>q("insert into gw_sales_proposal_activities(tenant_id,proposal_id,kind,source_event,detail) values($1,$2,'sync','forged-sync-event', '{\"to\":\"合格\"}')",[T,P(2)])),'42501');
  await rejects(()=>as(U(1),()=>q("insert into gw_sales_proposals(tenant_id,source_system,source_proposal_id,source_stage,company_name,title,sales_owner_id,sent_at,status) values($1,'enger','forged','合格','架空','架空',$2,now(),'call_wait')",[T,E(1)])),'42501');
 });
 await test('existing legitimate manual proposal/activity inserts still work',async()=>{
  await as(U(1),()=>q("insert into gw_sales_proposal_activities(tenant_id,proposal_id,kind,employee_id,created_by,note) values($1,$2,'memo',$3,$4,'通常のメモ')",[T,P(1),E(1),U(1)]));
  await as(U(1),()=>q("insert into gw_sales_proposals(tenant_id,source_system,company_name,title,sales_owner_id,sent_at,status) values($1,'manual','架空','通常の手入力',$2,now(),'call_wait')",[T,E(1)]));
 });
 await test('service role source intake still allowed',async()=>{
  await db.exec('set role service_role');try{await q("update gw_sales_proposals set source_stage='面談合格' where id=$1",[P(2)]);}finally{await db.exec('reset role');}
  assert.ok((await read(U(1))).rows.find(r=>r.proposalId===P(2))?.accepted);
 });
 await test('inactive proposal cannot start or complete Office work',async()=>{
  await q('update gw_sales_proposals set archived_at=now() where id=$1',[P(1)]);
  const row=(await read(U(1),'sales',P(1))).rows[0];assert.equal(row.canRequest,false);assert.equal(row.canCancelRequest,true);
  await rejects(()=>act(U(3),'update',update({status:'in_progress',assigneeId:E(3)}),5,P(1),'office'),'23514');
  await q('update gw_sales_proposals set archived_at=null where id=$1',[P(1)]);
 });
 await test('cancel succeeds after assignee leaves; audit still preserved',async()=>{
  await act(U(3),'update',update({status:'in_progress',assigneeId:E(8)}),5,P(1),'office');
  await q("update gw_employees set status='left' where id=$1",[E(8)]);
  await act(U(1),'cancel',{reason:'担当退職による取消'},6);assert.equal((await read(U(1),'sales',P(1))).rows[0].request.status,'cancelled');
 });
 await test('resubmission requires explicit reason/version and keeps same request',async()=>{
  await rejects(()=>act(U(1),'resubmit',create,7),'23514');
  const r=await act(U(1),'resubmit',{...create,contractType:'employment',reason:'条件再確認を依頼'},7);assert.equal(r.id,first.id);assert.equal(r.version,8);
  assert.equal(await scalar('select count(*)::int from gw_sales_contract_requests'),1);
  assert.equal(await scalar('select count(*)::int from gw_sales_contract_request_events'),8);
 });
 await test('all events immutable and every version retained',async()=>{
  const r=await read(U(1),'sales',P(1));assert.equal(r.rows[0].request.history.length,8);
  assert.deepEqual(r.rows[0].request.history.map(x=>x.version),[8,7,6,5,4,3,2,1]);
  await rejects(()=>as(U(3),()=>q("update gw_sales_contract_request_events set reason='上書き'")),'42501');
 });
 console.log(`${count}/${count} real PostgreSQL migration/RPC/RLS tests passed (isolated PGlite; no production access)`);
}finally{await db.close();}
