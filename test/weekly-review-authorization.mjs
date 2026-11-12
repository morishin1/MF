// Real administrator weekly handler, mock auth and synthetic in-memory rows only.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createMemDb} from './_memdb.mjs';
const at=p=>new URL('../'+p,import.meta.url).pathname;
const mem=createMemDb({schema:{tc_weekly_review:{unique:[['user_id','week_start']]}}});
let signedIn=true, ctx, accessed=[];
const client=()=>{const sb=mem.admin();return {...sb,from:table=>{accessed.push(table);return sb.from(table)}}};
mock.module(at('lib/supabase.js'),{namedExports:{admin:client}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>{if(signedIn)return {id:'reviewer'};res.statusCode=401;res.end('{}');return null}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>ctx,canManageHr:c=>c.isAdmin||c.isHr}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async()=>{}}});
const {default:handler}=await import(at('api/nippo/weekly.js'));
mem.rows.gw_employees=[{user_id:'member-a',tenant_id:'tenant-a',display_name:'架空A'},{user_id:'member-b',tenant_id:'tenant-b',display_name:'架空B'}];
mem.rows.tc_weekly_review=[{user_id:'member-a',week_start:'2026-11-02',q1:'self reflection',eval_comment:'draft',submitted_at:null},{user_id:'member-b',week_start:'2026-11-02',q1:'foreign reflection'}];
async function call(method,userId='member-a',action='save'){
 accessed=[];
 const res={setHeader(){},end(v){this.body=JSON.parse(v)}};
 await handler({method,headers:{},url:`/api/nippo/weekly?weekStart=2026-11-02&userId=${userId}`,body:{userId,weekStart:'2026-11-02',action,scores:{},comment:'reviewer comment',q1:'forged reflection'}},res);
 return res;
}
ctx={tenantId:'tenant-a',isAdmin:false,isHr:false,roles:[]};
signedIn=false;assert.equal((await call('GET')).statusCode,401);assert.deepEqual(accessed,[]);signedIn=true;
for(const method of ['GET','POST']){
 assert.equal((await call(method)).statusCode,403);assert.deepEqual(accessed,[]);
}
let checks=0;
for(const role of ['admin','owner','hr']){
 ctx={tenantId:'tenant-a',isAdmin:role==='admin',isHr:role==='hr',roles:role==='owner'?['owner']:[]};
 for(const method of ['GET','POST']){
  const r=await call(method,'member-b');assert.equal(r.statusCode,404);assert.deepEqual(accessed,['gw_employees']);checks++;
  assert.equal((await call(method,'unknown')).statusCode,404);assert.deepEqual(accessed,['gw_employees']);checks++;
  mem.state.missing='gw_employees';assert.equal((await call(method)).statusCode,503);assert.deepEqual(accessed,['gw_employees']);mem.state.missing=null;checks++;
  assert.equal((await call(method)).statusCode,200);checks++;
 }
}
const own=mem.rows.tc_weekly_review.find(r=>r.user_id==='member-a');
assert.equal(own.q1,'self reflection');assert.equal(own.submitted_at,null,'admin save is a draft, not publication');
assert.equal((await call('POST','member-a','submit')).statusCode,200);assert.ok(own.submitted_at);
assert.equal(mem.rows.tc_weekly_review.find(r=>r.user_id==='member-b').q1,'foreign reflection');
ctx.tenantId=null;assert.equal((await call('GET')).statusCode,403);assert.deepEqual(accessed,[]);
console.log(`weekly authorization: ${checks} role/tenant/error checks plus unauthenticated/member denial and save/publication semantics passed`);
