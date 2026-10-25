// PR draft API: synthetic DB and auth tests. No production calls or SQL execution.
import assert from "node:assert/strict";
import {mock} from "node:test";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {readFileSync} from "node:fs";
import {createMemDb} from "./_memdb.mjs";

const root=dirname(dirname(fileURLToPath(import.meta.url))),at=p=>join(root,p);
const T1="a0000000-0000-4000-8000-000000000001";
const T2="a0000000-0000-4000-8000-000000000002";
const U1="a0000000-0000-4000-8000-000000000011";
const U2="a0000000-0000-4000-8000-000000000012";
let who={id:U1,tenant:T1,marketing:true};
const mem=createMemDb({schema:{gw_marketing_pr_drafts:{
  defaults:()=>({version:1,status:"draft",created_at:new Date().toISOString(),updated_at:new Date().toISOString(),registered_at:null,registered_by:null}),
  required:["tenant_id","created_by","updated_by","status","payload","version"]
}}});
const sb=mem.admin();
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async(req)=>req.headers?.deny?null:{id:who.id}}});
mock.module(at("lib/gw.js"),{namedExports:{
  gwContext:async()=>({tenantId:who.tenant,roles:[],employee:{id:"a",status:"active"}}),
  accessOf:()=>({marketing:who.marketing})
}});
mock.module(at("lib/supabase.js"),{namedExports:{admin:()=>sb}});
const {default:handler}=await import(at("api/marketing/pr-drafts.js"));
const sample={draft:{
 kind:"event",title:"AI交流イベントを開催",summary:"実際にAIを体験できる交流会を開催します。",
 company:"株式会社エイト",contact_email:"press@example.com",
 features:[{title:"体験型",body:"参加者が実際に操作できます"}],url:"https://8grp.co.jp/lp/",
 images:[]
},body_override:"",media:{}};
const invoke=async(method,body,url="/api/marketing/pr-drafts")=>{
 const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},end(t){this.body=JSON.parse(t);}};
 await handler({method,body,url,headers:{}},res);
 return res;
};
let n=0;
async function check(label,fn){await fn();console.log("ok",++n,label);}
mem.state.missing="gw_marketing_pr_drafts";
await check("SQL unapplied: GET is 503, not empty 0",async()=>{
  const r=await invoke("GET");assert.equal(r.statusCode,503);assert.equal(r.body.error,"not_ready");
});
mem.state.missing=null;
await check("Marketing denied before DB access",async()=>{
  who.marketing=false;
  const before=mem.state.log.length;
  assert.equal((await invoke("POST",{action:"save",payload:sample})).statusCode,403);
  assert.equal(mem.state.log.length,before);
  who.marketing=true;
});
await check("unknown action and malformed payload rejected",async()=>{
  assert.equal((await invoke("POST",{action:"publish",payload:sample})).statusCode,400);
  assert.equal((await invoke("POST",{action:"save",payload:{draft:{kind:"bad"}}})).statusCode,400);
});
let id,version;
await check("new draft writes one tenant-scoped record",async()=>{
  const r=await invoke("POST",{action:"save",payload:{...sample,ignored_secret:"DO_NOT_COPY"}});
  assert.equal(r.statusCode,200);
  id=r.body.item.id;version=r.body.item.version;
  assert.equal(r.body.item.status,"draft");
  assert.equal(mem.rows.gw_marketing_pr_drafts.length,1);
  assert.equal(mem.rows.gw_marketing_pr_drafts[0].tenant_id,T1);
  assert.equal(mem.rows.gw_marketing_pr_drafts[0].created_by,U1);
  assert.ok(!JSON.stringify(r.body).includes("DO_NOT_COPY"));
});
await check("GET sees own item",async()=>{
  const list=await invoke("GET");
  assert.equal(list.statusCode,200);
  assert.equal(list.body.items.length,1);
  const one=await invoke("GET",null,"/api/marketing/pr-drafts?id="+id);
  assert.equal(one.body.item.id,id);
});
await check("same tenant other employee cannot read or edit",async()=>{
  who.id=U2;
  assert.equal((await invoke("GET")).body.items.length,0);
  assert.equal((await invoke("GET",null,"/api/marketing/pr-drafts?id="+id)).statusCode,404);
  assert.equal((await invoke("POST",{action:"save",id,version,payload:sample})).statusCode,409);
  who.id=U1;
});
await check("other tenant cannot retrieve or update",async()=>{
  who.tenant=T2;
  assert.equal((await invoke("GET")).body.items.length,0);
  assert.equal((await invoke("GET",null,"/api/marketing/pr-drafts?id="+id)).statusCode,404);
  assert.equal((await invoke("POST",{action:"save",id,version,payload:sample})).statusCode,409);
  who.tenant=T1;
});
await check("cannot register without explicit confirmation",async()=>{
  assert.equal((await invoke("POST",{action:"register",id,version,confirmed:false})).statusCode,400);
});
await check("draft updates with optimistic version",async()=>{
  const r=await invoke("POST",{action:"save",id,version,payload:sample});
  assert.equal(r.statusCode,200);
  assert.equal(r.body.item.version,version+1);
  assert.equal((await invoke("POST",{action:"save",id,version,payload:sample})).statusCode,409);
  version=r.body.item.version;
});
await check("invalid required field blocks internal registration",async()=>{
  const broken={...sample,draft:{...sample.draft,contact_email:"",contact_tel:""}};
  const saved=await invoke("POST",{action:"save",id,version,payload:broken});
  assert.equal(saved.statusCode,200);version=saved.body.item.version;
  const bad=await invoke("POST",{action:"register",id,version,confirmed:true});
  assert.equal(bad.statusCode,422);assert.equal(bad.body.error,"missing_required");
});
await check("saved and reviewed original registers once",async()=>{
  const saved=await invoke("POST",{action:"save",id,version,payload:sample});
  assert.equal(saved.statusCode,200);version=saved.body.item.version;
  const r=await invoke("POST",{action:"register",id,version,confirmed:true});
  assert.equal(r.statusCode,200);assert.equal(r.body.item.status,"registered");
  assert.ok(r.body.item.registeredAt);
  assert.ok(r.body.note.includes("PR TIMESへの投稿"));
});
await check("duplicate registration and registered update are blocked",async()=>{
  assert.equal((await invoke("POST",{action:"register",id,version,confirmed:true})).statusCode,409);
  assert.equal((await invoke("POST",{action:"save",id,version,payload:sample})).statusCode,409);
  assert.equal(mem.rows.gw_marketing_pr_drafts.length,1);
});
await check("no unauthorized outside publisher state machine",async()=>{
  const api=readFileSync(at("api/marketing/pr-drafts.js"),"utf8");
  const sql=readFileSync(at("db/proposal_marketing_pr_drafts.sql"),"utf8");
  assert.doesNotMatch(api,/fetch\(|sendMail|publish\(|webhook|\.rpc\(/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/revoke all on public\.gw_marketing_pr_drafts/);
  assert.match(sql,/status in \('draft','registered'\)/);
});
console.log("Marketing PR save/register API: "+n+" security and lifecycle checks passed.");
