import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);const at=p=>new URL(p,root).pathname;
const events=[];let broken=false,manager=true;
const q=()=>{const x={select(){return x},eq(){return x},limit(){return x},maybeSingle:async()=>({data:{id:'e1',user_id:'u1',status:'active'},error:null}),then(ok){return Promise.resolve({data:[],error:null}).then(ok)},upsert:async()=>{events.push('grant');return {error:null}},delete(){const y={eq(){return y},then(ok){events.push('remove');return Promise.resolve({error:null}).then(ok)}};return y}};return x};
const client={from:q};
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:'admin'})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:'t1'}),canManageHr:()=>manager}});
mock.module(at('lib/mfa.js'),{namedExports:{requireMfa:async()=>true}});
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>client,userClient:()=>client}});
mock.module(at('lib/gw-audit.js'),{namedExports:{gwLog:async()=>{}}});
mock.module(at('lib/role-change.js'),{namedExports:{changeRole:async()=>{},afterChange:async()=>({}),grantRuleError:()=>null}});
mock.module(at('lib/enger-agent-role.js'),{namedExports:{revokeAgentAccess:async()=>{events.push('enger-stop');if(broken)throw Error('offline')}}});
const {default:handler}=await import('../api/employees/apps.js');
async function call(grant){events.length=0;let body;const res={statusCode:0,setHeader(){},end(s){body=JSON.parse(s)}};await handler({method:'POST',headers:{},body:{employeeId:'e1',app:'sales',grant}},res);return {status:res.statusCode,body};}
test('Sales ON creates the common grant without creating or converting accounts',async()=>{const r=await call(true);assert.equal(r.status,200);assert.deepEqual(events,['grant']);});
test('Sales OFF closes legacy ENGER access before removing the common grant',async()=>{const r=await call(false);assert.equal(r.status,200);assert.deepEqual(events,['enger-stop','remove']);});
test('A failed ENGER revocation is visible and never pretends the operation completed',async()=>{broken=true;try{const r=await call(false);assert.equal(r.status,503);assert.deepEqual(events,['enger-stop']);}finally{broken=false;}});
test('Non-managers cannot enable either application',async()=>{manager=false;try{const r=await call(true);assert.equal(r.status,403);assert.deepEqual(events,[]);}finally{manager=true;}});
