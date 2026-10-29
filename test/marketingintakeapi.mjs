// Exact handler with mocked auth/DB only. No network, SQL application or real notifications.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createMemDb } from './_memdb.mjs';
import { normalizeIntakeInput } from '../lib/marketing-intake.js';
const root=dirname(dirname(fileURLToPath(import.meta.url))), at=p=>join(root,p);
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const T=id(1), U=id(2), E=id(3), OTHER=id(4), R=id(5), SRC=id(6);
const mem=createMemDb(); const base=mem.admin();
let ctx={tenantId:T,employee:{id:E,tenant_id:T,status:'active'},roles:['owner'],apps:[],marketing:true,hr:true};
let sourceAllowed=true, rpcError=null, rpcResult=null, rpcCalls=[];
const sb={...base,schema:schema=>({from:table=>base.from(`${schema}.${table}`)}),rpc:async(fn,args)=>{
 if(fn==='gw_marketing_intake_mutate'){rpcCalls.push(args);return rpcError?{error:rpcError}:{data:rpcResult||{ok:true,item:mem.rows.gw_marketing_intake[0],duplicate:false}};}
 if(['space_is_staff','zimu_is_admin','is_lms_staff'].includes(fn))return {data:sourceAllowed};
 return {data:[]};
}};
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:U})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,accessOf:c=>({marketing:c.marketing}),canRecruit:c=>c.hr}});
let adminTables=[],userTables=[];
const adminSb={...sb,from:(table)=>{adminTables.push(table);return sb.from(table);}};
const userSb={...sb,from:(table)=>{userTables.push(table);return sb.from(table);},schema:(schema)=>({from:(table)=>{userTables.push(schema+'.'+table);return sb.schema(schema).from(table);}})};
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>adminSb,userClient:()=>userSb}});
const {default:handler}=await import(at('api/marketing/intake.js'));
const phone={action:'create',requestId:id(10),channel:'phone',biz:'mugen',name:'架空受付',contact:'090-0000-0000',subject:'折返し相談',callbackWish:'午後',receivedAt:'2026-10-24T12:00:00Z',ownerEmployeeId:E,nextAction:'折り返す',dueAt:'2026-10-26T03:00:00Z'};
const row={id:R,tenant_id:T,channel:'phone',biz:'mugen',source_type:null,source_id:null,phone_name:phone.name,phone_contact:phone.contact,phone_subject:phone.subject,callback_wish:phone.callbackWish,received_at:phone.receivedAt,received_by:U,owner_employee_id:E,next_action:phone.nextAction,due_at:phone.dueAt,state:'open',result:'',version:1,created_by:U};
mem.rows.gw_employees=[{id:E,tenant_id:T,user_id:U,status:'active',display_name:'本人'},{id:OTHER,tenant_id:id(99),status:'active',display_name:'別会社'}];
mem.rows.gw_role_grants=[{employee_id:E,tenant_id:T,role:'owner'}];mem.rows.gw_app_grants=[];
mem.rows.gw_marketing_intake=[row];mem.rows.gw_marketing_intake_events=[];
mem.rows.gw_hr_inbound_mail=[{id:SRC,tenant_id:T,recipient:'saiyou@8grp.co.jp',subject:'採用窓口',body_text:'原本文',sender_address:'fake@example.invalid',received_at:phone.receivedAt}];
mem.rows.contact_submissions=[{id:SRC,source:'8grp_lp',message:'サイト本文',name:'架空',created_at:phone.receivedAt}];
mem.rows.rental_records=[{id:SRC,kind:'問い合わせ',name:'架空',form_content:'Space本文',created_at:phone.receivedAt}];
mem.rows.gw_hr_applicants=[{id:SRC,tenant_id:T,lead_category:'mugendojo',name:'架空',lead_profile:{challenge_text:'無限原文'},created_at:phone.receivedAt}];
async function call(method,body,url='/api/marketing/intake'){const res={setHeader(){},end(t){this.body=JSON.parse(t)}};await handler({method,body,url},res);return res;}
let n=0;async function check(label,fn){await fn();n++;console.log('ok',n,label)}
await check('phone normalizes required receipt/contact/next/due',()=>assert.equal(normalizeIntakeInput(phone,'create',E).name,phone.name));
await check('EC rejected',()=>assert.throws(()=>normalizeIntakeInput({...phone,biz:'ec'},'create',E)));
await check('actor spoof rejected',()=>assert.throws(()=>normalizeIntakeInput({...phone,receivedBy:OTHER},'create',E)));
await check('blank phone contact rejected',()=>assert.throws(()=>normalizeIntakeInput({...phone,contact:''},'create',E)));
await check('missing next/due rejected',()=>{assert.throws(()=>normalizeIntakeInput({...phone,nextAction:''},'create',E));assert.throws(()=>normalizeIntakeInput({...phone,dueAt:''},'create',E))});
const link={action:'create',requestId:id(11),channel:'email',biz:'site',sourceType:'site_contact',sourceId:SRC,ownerEmployeeId:E,nextAction:'原本を確認',dueAt:phone.dueAt};
await check('email may manually link existing company/Space originals',()=>{assert.equal(normalizeIntakeInput(link,'create',E).sourceType,'site_contact');assert.equal(normalizeIntakeInput({...link,biz:'space',sourceType:'space_inquiry'},'create',E).channel,'email')});
await check('linked original body copy rejected',()=>assert.throws(()=>normalizeIntakeInput({...link,subject:'copy'},'create',E)));
await check('cross business source rejected',()=>assert.throws(()=>normalizeIntakeInput({...link,biz:'mugen'},'create',E)));
await check('form cannot pretend HR mailbox',()=>assert.throws(()=>normalizeIntakeInput({...link,channel:'form',sourceType:'hr_mail'},'create',E)));
const update={id:R,version:1,requestId:id(12),ownerEmployeeId:E,nextAction:'完了記録を確認',dueAt:phone.dueAt,state:'done',result:'折返し案内済み'};
await check('done requires result independently from read',()=>assert.throws(()=>normalizeIntakeInput({...update,result:''},'update',E)));
await check('valid create passes actor from auth to only mutation RPC',async()=>{const r=await call('POST',phone);assert.equal(r.statusCode,200);assert.equal(rpcCalls.at(-1).p_actor,U);assert.equal(rpcCalls.at(-1).p_employee,E);assert.equal(mem.state.log.length,0)});
await check('GET list hides phone PII and performs no mutation',async()=>{rpcCalls=[];const r=await call('GET');assert.equal(r.statusCode,200);assert.equal(r.body.items.length,1);assert.ok(!JSON.stringify(r.body).includes(phone.contact));assert.equal(rpcCalls.length,0);assert.equal(mem.state.log.length,0)});
await check('GET detail has phone and explicit receivedBy',async()=>{const r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.body.item.contact,phone.contact);assert.equal(r.body.item.receivedBy,U)});
await check('Marketing denied before source or mutation',async()=>{ctx.marketing=false;rpcCalls=[];assert.equal((await call('POST',phone)).statusCode,403);assert.equal(rpcCalls.length,0);ctx.marketing=true});
await check('retired caller denied',async()=>{ctx.employee.status='left';assert.equal((await call('GET')).statusCode,403);ctx.employee.status='active'});
await check('non-HR cannot create Mugen phone',async()=>{ctx.hr=false;assert.equal((await call('POST',phone)).statusCode,403);ctx.hr=true});
await check('company phone needs source business permission',async()=>{sourceAllowed=false;rpcCalls=[];assert.equal((await call('POST',{...phone,biz:'site'})).statusCode,403);assert.equal(rpcCalls.length,0);sourceAllowed=true});
await check('cross tenant owner rejected',async()=>assert.equal((await call('POST',{...phone,ownerEmployeeId:OTHER})).statusCode,400));
await check('read detail tenant boundary',async()=>{const t=row.tenant_id;row.tenant_id=id(99);assert.equal((await call('GET',null,`/api/marketing/intake?id=${R}`)).statusCode,404);row.tenant_id=t});
await check('unrelated authorized member cannot edit',async()=>{const old=ctx.roles;ctx.roles=[];row.created_by=OTHER;row.owner_employee_id=OTHER;assert.equal((await call('PATCH',update)).statusCode,403);ctx.roles=old;row.created_by=U;row.owner_employee_id=E});
await check('stale version RPC outcome is 409, not success',async()=>{rpcResult={ok:false,error:'stale_record',status:409};assert.equal((await call('PATCH',update)).statusCode,409);rpcResult=null});
await check('duplicate replay marked without API inserts',async()=>{rpcResult={ok:true,item:row,duplicate:true};const r=await call('POST',phone);assert.equal(r.body.duplicate,true);assert.equal(mem.state.log.length,0);rpcResult=null});
await check('missing RPC returns not ready without DB detail',async()=>{rpcError={code:'PGRST202',message:'SECRET'};const r=await call('POST',phone);assert.equal(r.statusCode,503);assert.ok(!JSON.stringify(r.body).includes('SECRET'));rpcError=null});
await check('unexpected DB error sanitized',async()=>{rpcError={code:'XX',message:'SECRET'};const r=await call('POST',phone);assert.equal(r.statusCode,500);assert.ok(!JSON.stringify(r.body).includes('SECRET'));rpcError=null});
await check('company original body returned transiently, not RPC payload',async()=>{const old={...row};Object.assign(row,{channel:'email',biz:'site',source_type:'site_contact',source_id:SRC});const r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.body.original.body,'サイト本文');Object.assign(row,old)});
await check('Space original body returned under source permission',async()=>{const old={...row};Object.assign(row,{channel:'email',biz:'space',source_type:'space_inquiry',source_id:SRC});const r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.body.original.body,'Space本文');Object.assign(row,old)});
await check('HR email same tenant and recipient checked',async()=>{const old={...row};Object.assign(row,{channel:'email',biz:'mugen',source_type:'hr_mail',source_id:SRC});let r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.body.original.body,'原本文');mem.rows.gw_hr_inbound_mail[0].tenant_id=id(99);r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.statusCode,404);mem.rows.gw_hr_inbound_mail[0].tenant_id=T;Object.assign(row,old)});
await check('invalid calendar, local time and offset rejected',()=>{
 for(const dueAt of ['2026-02-30T12:00:00Z','2026-10-24T24:00:00Z','2026-10-24T12:60:00Z','2026-10-24T12:00:60Z','2026-10-24T12:00','2026-10-24T12:00:00+14:30']) assert.throws(()=>normalizeIntakeInput({...phone,dueAt},'create',E));
 assert.equal(normalizeIntakeInput({...phone,dueAt:'2028-02-29T12:00:00+09:00'},'create',E).dueAt,'2028-02-29T03:00:00.000Z');
});
await check('LMS course staff access does not require HR',async()=>{
 const old={...row};Object.assign(row,{channel:'form',biz:'mugen',source_type:'mugen_course',source_id:SRC});ctx.hr=false;
 mem.rows['lms.course_applications']=[{id:SRC,name:'架空受講',motivation:'学びたい',created_at:phone.receivedAt}];
 let r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.statusCode,200);assert.equal(r.body.original.body,'学びたい');
 r=await call('GET');assert.equal(r.body.items.length,1);ctx.hr=true;Object.assign(row,old);
});
await check('source outage never becomes successful empty list',async()=>{
 const old={...row};Object.assign(row,{channel:'form',biz:'site',source_type:'site_contact',source_id:SRC});mem.state.missing='contact_submissions';
 const r=await call('GET');assert.equal(r.statusCode,503);assert.ok(!r.body.items);mem.state.missing=null;Object.assign(row,old);
});
await check('missing intake table fails closed',async()=>{mem.state.missing='gw_marketing_intake';assert.equal((await call('GET')).statusCode,503);mem.state.missing=null;});
await check('receipt actor names are tenant scoped and event cap explicit',async()=>{
 mem.rows.gw_marketing_intake_events=Array.from({length:201},(_,i)=>({id:id(1000+i),tenant_id:T,intake_id:R,actor_id:U,kind:'updated',created_at:new Date(1792800000000+i*1000).toISOString(),detail:{}}));
 const r=await call('GET',null,`/api/marketing/intake?id=${R}`);assert.equal(r.body.item.receivedByName,'本人');assert.equal(r.body.events.length,200);assert.equal(r.body.eventsCapped,true);assert.equal(r.body.events[0].actorName,'本人');mem.rows.gw_marketing_intake_events=[];
});
await check('SQL static: service-only, atomic history, source unique, version guard',()=>{const sql=readFileSync(at('db/proposal_marketing_intake.sql'),'utf8');for(const re of [/revoke all.*from public,anon,authenticated/,/unique\(tenant_id,request_id\)/,/tenant_id,source_type,source_id/,/for update;/,/old_v.version<>p_expected_version/,/pg_advisory_xact_lock/,/insert into public.gw_marketing_intake_events/])assert.match(sql,re);assert.ok(!/insert into public\.gw_app_grants|update public\.(?:contact_submissions|space_bookings|gw_hr_applicants)|notify\(/i.test(sql))});
await check('revoked original access hides metadata and blocks mutation',async()=>{const old={...row};Object.assign(row,{channel:'form',biz:'site',source_type:'site_contact',source_id:SRC});sourceAllowed=false;rpcCalls=[];assert.equal((await call('GET',null,`/api/marketing/intake?id=${R}`)).statusCode,403);assert.equal((await call('PATCH',update)).statusCode,403);const list=await call('GET');assert.equal(list.statusCode,200);assert.equal(list.body.items.length,0);assert.equal(rpcCalls.length,0);sourceAllowed=true;Object.assign(row,old)});
await check('removed recipient grant rejects assignment without granting anything',async()=>{const roles=mem.rows.gw_role_grants;mem.rows.gw_role_grants=[];rpcCalls=[];assert.equal((await call('POST',phone)).statusCode,400);assert.equal(rpcCalls.length,0);assert.equal(mem.state.log.length,0);mem.rows.gw_role_grants=roles;});
await check('retired recipient rejected without widening access',async()=>{mem.rows.gw_employees[0].status='left';rpcCalls=[];assert.equal((await call('POST',phone)).statusCode,400);assert.equal(rpcCalls.length,0);mem.rows.gw_employees[0].status='active';});
await check('mismatched employee tenant blocked before DB writes',async()=>{ctx.employee.tenant_id=id(99);rpcCalls=[];assert.equal((await call('GET')).statusCode,403);assert.equal((await call('POST',phone)).statusCode,403);assert.equal(rpcCalls.length,0);ctx.employee.tenant_id=T;});
await check('non-HR-mail originals use user client not admin bypass',async()=>{const old={...row};for(const [source,biz,table] of [['site_contact','site','contact_submissions'],['space_inquiry','space','rental_records'],['hr_lead','mugen','gw_hr_applicants']]){Object.assign(row,{channel:'form',biz,source_type:source,source_id:SRC});adminTables=[];userTables=[];assert.equal((await call('GET',null,`/api/marketing/intake?id=${R}`)).statusCode,200);assert.ok(userTables.includes(table));assert.ok(!adminTables.includes(table));}Object.assign(row,old);});
await check('deleted original blocks detail and update and hides list record',async()=>{const old={...row},contacts=mem.rows.contact_submissions;Object.assign(row,{channel:'form',biz:'site',source_type:'site_contact',source_id:SRC});mem.rows.contact_submissions=[];rpcCalls=[];assert.equal((await call('GET',null,`/api/marketing/intake?id=${R}`)).statusCode,404);assert.equal((await call('PATCH',update)).statusCode,404);assert.equal((await call('GET')).body.items.length,0);assert.equal(rpcCalls.length,0);mem.rows.contact_submissions=contacts;Object.assign(row,old);});
await check('Space phone email required, validated and normalized',()=>{
 assert.throws(()=>normalizeIntakeInput({...phone,biz:'space'},'create',E));
 for(const email of ['bad','a@@example.com','.a@example.com','a..b@example.com','a@-bad.com','a@example..com','a@b.c',`${'a'.repeat(65)}@example.com`,'a@'+ 'b'.repeat(250)+'.com']) assert.throws(()=>normalizeIntakeInput({...phone,biz:'space',email},'create',E));
 assert.equal(normalizeIntakeInput({...phone,biz:'space',email:' Test+BOOK@Example.COM '},'create',E).email,'test+book@example.com');
 assert.equal(normalizeIntakeInput(phone,'create',E).email,null);
});
await check('linked source rejects email field even empty; no raw copy',()=>{for(const email of ['',null,'a@example.com']) assert.throws(()=>normalizeIntakeInput({...link,email},'create',E));});
await check('Space phone API requires email before mutation and passes only valid value',async()=>{
 rpcCalls=[];assert.equal((await call('POST',{...phone,biz:'space'})).statusCode,400);assert.equal(rpcCalls.length,0);
 assert.equal((await call('POST',{...phone,biz:'space',email:' Call@Example.com '})).statusCode,200);
 assert.equal(rpcCalls.at(-1).p_payload.email,'call@example.com');
});
await check('phone email detail only, never list metadata',async()=>{
 row.phone_email='private@example.com';
 assert.equal((await call('GET',null,`/api/marketing/intake?id=${R}`)).body.item.email,row.phone_email);
 const r=await call('GET');assert.ok(!Object.hasOwn(r.body.items[0],'email'));assert.ok(!JSON.stringify(r.body).includes(row.phone_email));delete row.phone_email;
});
await check('SQL email invariant and rollback data guard present; preflight indexes covered',()=>{
 const sql=readFileSync(at('db/proposal_marketing_intake.sql'),'utf8');
 assert.match(sql,/phone_email text/);assert.match(sql,/biz<>'space' or phone_email is not null/);assert.match(sql,/and phone_email is null/);assert.match(sql,/p_payload->>'email'/);
 const rollback=readFileSync(at('db/proposal_rollback_marketing_intake.sql'),'utf8');assert.match(rollback,/exists\(select 1 from public.gw_marketing_intake limit 1\)/);assert.match(rollback,/exists\(select 1 from public.gw_marketing_intake_events limit 1\)/);assert.ok(rollback.indexOf('raise exception')<rollback.indexOf('drop table'));
 assert.match(readFileSync(at('db/check_proposal_marketing_intake.sql'),'utf8'),/pg_indexes/);
});
await check('Space phone explicit pending preserves intake, never silently defaults',async()=>{
 const input=normalizeIntakeInput({...phone,biz:'space',emailPending:true},'create',E);assert.equal(input.email,null);assert.equal(input.emailPending,true);
 assert.equal((await call('POST',{...phone,biz:'space',emailPending:true})).statusCode,200);assert.equal(rpcCalls.at(-1).p_payload.emailPending,true);
 for(const b of [{emailPending:'true'},{emailPending:true,email:'a@example.com'},{biz:'site',emailPending:true}]) assert.throws(()=>normalizeIntakeInput({...phone,biz:'space',...b},'create',E));
});
await check('pending Space phone cannot complete until resolved; omitted PATCH preserves',async()=>{
 const old={...row};Object.assign(row,{biz:'space',email_pending:true,phone_email:null});
 rpcCalls=[];assert.equal((await call('PATCH',update)).statusCode,400);assert.equal(rpcCalls.length,0);
 assert.equal((await call('PATCH',{...update,state:'open',result:''})).statusCode,200);assert.ok(!Object.hasOwn(rpcCalls.at(-1).p_payload,'email'));assert.ok(!Object.hasOwn(rpcCalls.at(-1).p_payload,'emailPending'));
 assert.equal((await call('PATCH',{...update,email:' Valid@Example.com ',emailPending:false})).statusCode,200);assert.equal(rpcCalls.at(-1).p_payload.email,'valid@example.com');
 assert.equal((await call('PATCH',{...update,emailPending:false})).statusCode,400);
 Object.assign(row,old);delete row.email_pending;delete row.phone_email;
});
await check('linked source PATCH cannot alter email or pending',async()=>{
 const old={...row};Object.assign(row,{channel:'form',biz:'site',source_type:'site_contact',source_id:SRC});rpcCalls=[];
 assert.equal((await call('PATCH',{...update,email:'a@example.com'})).statusCode,400);assert.equal((await call('PATCH',{...update,emailPending:false})).statusCode,400);assert.equal(rpcCalls.length,0);Object.assign(row,old);
});
await check('SQL pending state guard, preserve semantics and address-free history',()=>{
 const sql=readFileSync(at('db/proposal_marketing_intake.sql'),'utf8');assert.match(sql,/email_pending boolean not null default false/);assert.match(sql,/not email_pending or .*state='open'/);assert.match(sql,/else old_v.phone_email end/);assert.match(sql,/coalesce\(\(p_payload->>'emailPending'\)::boolean,old_v.email_pending\)/);assert.match(sql,/'emailChanged',old_v.phone_email is distinct from v.phone_email/);assert.match(sql,/'contactPending',v.email_pending/);
});
console.log(`${n} intake checks passed (mock DB; SQL static only, not executed)`);
