import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
let checks=0;async function test(n,f){await f();checks++;console.log("PASS",n)}
const ownerSource=read("api/sales/proposals/owners.js");
const httpSource=read("lib/http.js").replace(/^import .+;\n/gm,"").replace(/^export /gm,"");
const http=new Function("redactSalary",httpSource+"\nreturn {json,readJson,methodNotAllowed,dbSetupHint}")((x)=>x);
const UID="10000000-0000-4000-8000-000000000001", PID="20000000-0000-4000-8000-000000000001", OLD="30000000-0000-4000-8000-000000000001", NEXT="40000000-0000-4000-8000-000000000001";
function fixture({rpcError=null,changed=true,method="POST",body={},user=true,sell=true,proposal={},lookupError=null,rpcImpl=null}={}){
 const calls={rpc:[],audit:[],notify:[],lookup:0};
 const sb={from(t){assert.equal(t,"gw_sales_proposals");calls.lookup++;return {select(){return this},eq(){return this},async maybeSingle(){return {data:{id:PID,tenant_id:"tenant",company_name:"Synthetic",archived_at:null,source_system:"manual",...proposal},error:lookupError}}}},async rpc(name,args){calls.rpc.push({name,args});if(rpcImpl)return rpcImpl(args);return {data:rpcError?null:changed,error:rpcError}}};
 const deps={...http,requireUser:async(req,res)=>{if(user)return{id:UID};http.json(res,401,{error:"unauthorized"});return null},
 gwContext:async()=>({tenantId:"tenant",employee:{id:UID}}),canSell:()=>sell,userClient:()=>sb,isUuid:x=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(x),
 gwLog:async x=>calls.audit.push(x),notify:async x=>calls.notify.push(x)};
 const src=ownerSource.replace(/^import .+;\n/gm,"").replace("export default async function handler","async function handler");
 const handler=new Function(...Object.keys(deps),src+"\nreturn handler")(...Object.values(deps));
 const req={method,body:{id:PID,role:"cs",ownerId:NEXT,expectedOwnerId:OLD,...body}};
 const res={statusCode:0,setHeader(){},end(s){this.body=JSON.parse(s)}};
 return {calls,req,res,run:()=>handler(req,res)};
}
for(const code of ["PT409","P0001","40001"])await test(code+" owner_changed maps HTTP409, one RPC, no side effects",async()=>{
 const f=fixture({rpcError:{code,message:"owner_changed"}});await f.run();
 assert.equal(f.res.statusCode,409);assert.equal(f.res.body.error,"owner_changed");assert.equal(f.calls.rpc.length,1);
 assert.deepEqual(f.calls.rpc[0],{name:"gw_sales_set_proposal_stage_owner",args:{p_proposal:PID,p_stage:"cs",p_owner:NEXT,p_expected_owner:OLD}});
 assert.equal(f.calls.audit.length+f.calls.notify.length,0);
});
await test("success remains 200 with one audit and one allowed notification",async()=>{const f=fixture();await f.run();assert.equal(f.res.statusCode,200);assert.equal(f.res.body.changed,true);assert.equal(f.calls.rpc.length,1);assert.equal(f.calls.audit.length,1);assert.equal(f.calls.notify.length,1)});
await test("unchanged database result does not audit or notify",async()=>{const f=fixture({changed:false});await f.run();assert.equal(f.res.body.changed,false);assert.equal(f.calls.audit.length+f.calls.notify.length,0)});
await test("same expected/requested value avoids RPC entirely",async()=>{const f=fixture({body:{ownerId:OLD}});await f.run();assert.equal(f.res.body.unchanged,true);assert.equal(f.calls.rpc.length,0)});
await test("unauthenticated and non-sales are denied before RPC",async()=>{for(const options of [{user:false},{sell:false}]){const f=fixture(options);await f.run();assert.ok([401,403].includes(f.res.statusCode));assert.equal(f.calls.rpc.length,0)}});
await test("method/invalid body/missing expected are rejected",async()=>{for(const options of [{method:"GET"},{body:{id:"bad"}},{body:{expectedOwnerId:undefined}},{body:{role:"unknown"}}]){const f=fixture(options);await f.run();assert.ok([400,405].includes(f.res.statusCode));assert.equal(f.calls.rpc.length,0)}});
await test("archived and ENGER fixed proposal owner denied before RPC",async()=>{for(const options of [{proposal:{archived_at:"2026-10-25"}},{proposal:{source_system:"enger"},body:{role:"proposal"}}]){const f=fixture(options);await f.run();assert.equal(f.res.statusCode,409);assert.equal(f.calls.rpc.length,0)}});
await test("database permission and member validation remain enforced",async()=>{for(const [error,status] of [[{code:"42501",message:"forbidden"},403],[{code:"23514",message:"invalid_member"},400],[{code:"23514",message:"current_owner_required"},409]]){const f=fixture({rpcError:error});await f.run();assert.equal(f.res.statusCode,status);assert.equal(f.calls.rpc.length,1);assert.equal(f.calls.audit.length+f.calls.notify.length,0)}});
await test("PT409 is not misclassified as missing schema",()=>assert.equal(http.dbSetupHint({code:"PT409",message:"owner_changed"},"db/145"),null));
await test("UI conflict issues one POST and one read-only reload; no POST retry",async()=>{
 const calls=[];const errors=[];const select={value:NEXT,dataset:{current:OLD},disabled:false};
 const deps={detail:{proposal:{id:PID}},API:{api:async(path,args)=>{calls.push({path,args});throw Object.assign(new Error("conflict"),{code:"owner_changed"})}},load:async()=>calls.push({path:"list",method:"GET"}),ppShowServerError:e=>errors.push(e),document:{querySelector(){return null}},openId:PID,renderDetail(){throw Error("unexpected render")},KPActionFeedback:{show(){throw Error("unexpected success")}}};
 const fn=new Function(...Object.keys(deps),(read("sales/proposals.html").split("  async function ppInlineOwner(")[1].split("  function ppChain(")[0].replace(/^/,"  async function ppInlineOwner("))+"\nreturn ppInlineOwner")(...Object.values(deps));
 await fn(select,PID,"cs");assert.equal(calls.length,2);assert.equal(calls[0].args.method,"POST");assert.equal(calls[1].method,"GET");assert.equal(errors.length,1);assert.equal(select.disabled,false);
 // Existing stale detail is documented; we do not silently broaden this emergency SQL patch.
 assert.equal(select.dataset.current,OLD);
});
await test("concurrent duplicate owner requests: one mutation; stale second gets409 without automatic retry",async()=>{
 let current=OLD,commits=0;
 // Models the existing SQL FOR UPDATE/OCC ordering, not a real database concurrency run.
 const rpcImpl=async args=>{if(current!==args.p_expected_owner)return{data:null,error:{code:"PT409",message:"owner_changed"}};current=args.p_owner;commits++;return{data:true,error:null}};
 const a=fixture({rpcImpl}),b=fixture({rpcImpl});await Promise.all([a.run(),b.run()]);
 assert.deepEqual([a.res.statusCode,b.res.statusCode].sort(),[200,409]);assert.equal(commits,1);
 assert.equal(a.calls.rpc.length+b.calls.rpc.length,2,"one RPC per distinct request, never an internal retry");
 assert.equal(a.calls.audit.length+b.calls.audit.length,1);assert.equal(a.calls.notify.length+b.calls.notify.length,1);
});
await test("UI disables owner control while pending; conflict reload is read-only",()=>{
 const html=read("sales/proposals.html");const fn=html.slice(html.indexOf("  async function ppInlineOwner("),html.indexOf("  function ppChain("));
 assert.ok(fn.indexOf("select.disabled = true")<fn.indexOf('API.api("/api/sales/proposals/owners"'));
 assert.match(fn,/finally \{ select.disabled = false/);
 assert.equal((fn.match(/API\.api\("\/api\/sales\/proposals\/owners"/g)||[]).length,1);
 const load=html.slice(html.indexOf("  async function load()"),html.indexOf("  function ppSet("));assert.ok(!/method:\s*["']POST/.test(load));
});
function stripComments(sql){
 // Preserve SQL string literals so '--' inside a string is not mistaken for a comment.
 return sql.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g,m=>m.startsWith("'")?m:" ");
}
function unsafeRaise(sql){
 const statements=stripComments(sql).match(/\braise\b[^;]*;/gi)||[];
 return statements.filter(s=>/\b(?:errcode\s*=\s*|sqlstate\s*)'(?:40001|40P01|serialization_failure|deadlock_detected)'/i.test(s)
  || /\braise\s+(?:exception\s+)?(?:serialization_failure|deadlock_detected)\b/i.test(s));
}
await test("Sales SQL has no custom RAISE of transient transaction codes40001/40P01",()=>{
 const files=readdirSync(new URL("../db/",import.meta.url)).filter(p=>/sales.*\.sql$/.test(p));
 assert.ok(files.length>=4);let violations=[];for(const f of files)for(const statement of unsafeRaise(read("db/"+f)))violations.push(f+": "+statement);
 assert.deepEqual(violations,[]);console.log("  scanned",files.length,"Sales SQL files");
});
await test("static checker catches business retries, permits real exception rethrow and comments",()=>{
 for(const s of ["raise exception 'owner_changed' using errcode='40001';","raise sqlstate '40P01' using message='business_conflict';","raise serialization_failure using message='stale';"])assert.equal(unsafeRaise(s).length,1);
 assert.equal(unsafeRaise("-- raise exception 'example' using errcode='40001';\nexception when serialization_failure then raise;").length,0);
 assert.equal(unsafeRaise("raise exception 'owner_changed' using errcode='PT409';").length,0);
});
await test("owner SQL keeps row lock, optimistic compare and auth guards before mutation",()=>{
 const sql=read("db/145_sales_proposal_inline_owners.sql");const start=sql.indexOf("create or replace function public.gw_sales_set_proposal_stage_owner(");
 const f=sql.slice(start,sql.indexOf("revoke all on function public.gw_sales_set_proposal_stage_owner",start));
 for(const x of ["for update","v_old is distinct from p_expected_owner","gw_is_sales(v.tenant_id)","gw_sales_employee_ok(p_owner, v.tenant_id)","raise exception 'owner_changed' using errcode='PT409';"])assert.ok(f.includes(x));
 assert.ok(f.indexOf("errcode='PT409'")<f.indexOf("update public.gw_sales_proposals"));assert.ok(!/\b(loop|while)\b/i.test(f));
});
console.log(checks+" safety checks passed. Mock/static only; genuine PostgreSQL transaction retries are not reconfigured.");
