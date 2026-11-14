// Role/tenant/read-version guards around the actual new handlers, with an in-memory database.
import assert from 'node:assert/strict';import {mock} from 'node:test';import {fileURLToPath} from 'node:url';
import {createMemDb} from './_memdb.mjs';
const at=p=>fileURLToPath(new URL('../'+p,import.meta.url));
const db=createMemDb(),tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
let allowed=true,rpcCalls=[];const sb=db.admin();sb.rpc=async(name,args)=>{rpcCalls.push({name,args});return {data:{ok:true},error:null};};
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:'reviewer'})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:tenant}),canRecruit:()=>allowed}});
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>sb}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async()=>{}}});
mock.module(at('lib/hr-intake.js'),{namedExports:{ANALYSES:'gw_hr_mail_analysis',processIntake:async()=>({ok:true})}});
const {default:state}=await import(at('api/hr/applicant-state.js'));
const {default:intake}=await import(at('api/hr/intake.js'));
const {default:review}=await import(at('api/hr/document-review.js'));
async function call(fn,method='GET',body={}){const r={headers:{},statusCode:0,setHeader(k,v){this.headers[k]=v;},end(raw){this.body=JSON.parse(raw);}};await fn({method,body,url:'/api/hr/test'},r);return r;}
for(const fn of[state,intake,review]){allowed=false;assert.equal((await call(fn)).statusCode,403);}allowed=true;
db.rows.gw_hr_applicants=[{id,tenant_id:tenant,stage:'applied',status:'todo',updated_at:'2026-11-14T01:00:00Z'}];
assert.equal((await call(state,'POST',{id,action:'read',expectedUpdatedAt:'2026-11-13T01:00:00Z'})).statusCode,409);
assert.equal((await call(state,'POST',{id,action:'read',expectedUpdatedAt:'2026-11-14T01:00:00Z'})).statusCode,200);
assert.equal(db.rows.gw_hr_applicant_reads[0].user_id,'reviewer');assert.equal(db.rows.gw_hr_applicant_reads[0].tenant_id,tenant);
db.rows.gw_hr_applicants[0].tenant_id=other;assert.equal((await call(state,'POST',{id,action:'read',expectedUpdatedAt:'2026-11-14T01:00:00Z'})).statusCode,404);
db.rows.gw_hr_inbound_mail=[{id,tenant_id:other,status:'new'}];assert.equal((await call(intake,'POST',{id,action:'classify'})).statusCode,404);
db.rows.gw_hr_inbound_mail[0].tenant_id=tenant;
assert.equal((await call(intake,'POST',{id,action:'register',classification:'application',reason:'原文を確認',fields:{name:'架空',email:'noreply',jobTitle:'営業'}})).statusCode,400);
assert.equal((await call(intake,'POST',{id,action:'correct',classification:'application',reason:'',fields:{}})).statusCode,400);
db.rows.gw_hr_documents=[{id,tenant_id:other}];assert.equal((await call(review,'POST',{id,state:'confirmed'})).statusCode,404);
assert.equal(rpcCalls.length,0,'denied/malformed requests never run the registration RPC');
console.log('PASS: new API role restrictions, tenant separation, stale read rejection, per-reviewer seen state, manual registration validation and document review isolation');
