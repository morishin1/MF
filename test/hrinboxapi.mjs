// HR新着メール：取り込み/重複/テナント隔離/応募者リンクをモックDBで検証。
import assert from "node:assert/strict";
import {mock} from "node:test";
import {readFileSync} from "node:fs";
import {runInNewContext,Script} from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const root=dirname(dirname(fileURLToPath(import.meta.url))),at=p=>join(root,p);
const read=p=>readFileSync(at(p),"utf8");
const sql=read("db/147_hr_inbound_mail.sql"),page=read("hr/inbox.html"),code=read("api/hr/inbox.js");
assert.match(sql,/unique\(tenant_id,provider,provider_message_id\)/);
assert.match(sql,/enable row level security/);
assert.match(sql,/gw_is_recruiting\(tenant_id\)/);
assert.match(sql,/check \(\(status='linked'\)=\(applicant_id is not null\)\)/);
assert.doesNotMatch(page,/eval\s*\(/);
const script=page.match(/<script>\s*\(function\(\)\{[\s\S]*?<\/script>/)?.[0].replace(/<script>|<\/script>/g,"");
assert.ok(script);
new Script(script);

let role="recruiter",rows=[],apps=[{id:"12345678-1234-4234-8234-000000000001",tenant_id:"t1"}],calls=0;
const clone=x=>structuredClone(x);
function from(name){
 let filters=[],sort=null,values=null,doing="";
 const q={
  select(){return q;},eq(k,v){filters.push([k,v]);return q;},
  order(k,{ascending}){sort={k,ascending};return q;},
  limit(n){q.cap=n;return q;},
  is(k,v){filters.push([k,v]);return q;},
  insert(v){values=v;doing="insert";return q;},
  update(v){values=v;doing="update";return q;},
  async single(){return execute(true);},
  async maybeSingle(){return execute(true);},
  then(accept,reject){return execute(false).then(accept,reject);}
 };
 const dataOf=()=> (name==="gw_hr_inbound_mail"?rows:apps).filter(r=>filters.every(([k,v])=>r[k]===v)).map(clone);
 const execute=async one=>{
  calls++;
  if(doing==="insert"){
   if(rows.some(x=>x.tenant_id===values.tenant_id&&x.provider===values.provider&&x.provider_message_id===values.provider_message_id))
    return {data:null,error:{code:"23505"}};
   const record={id:"12345678-1234-4234-8234-000000000002",status:"new",applicant_id:null,...values};
   rows.push(record);return {data:clone(record),error:null};
  }
  if(doing==="update"){
   const hit=(name==="gw_hr_inbound_mail"?rows:apps).filter(r=>filters.every(([k,v])=>r[k]===v));
   if(hit.length)Object.assign(hit[0],values);
   return {data:hit[0]?clone(hit[0]):null,error:null};
  }
  const found=dataOf();
  if(sort)found.sort((a,b)=>sort.ascending?String(a[sort.k]).localeCompare(String(b[sort.k])):String(b[sort.k]).localeCompare(String(a[sort.k])));
  return {data:one?(found[0]||null):found.slice(0,q.cap||500),error:null};
 };
 return q;
}
mock.module(at("lib/supabase.js"),{namedExports:{admin:()=>({from})}});
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async()=>({id:"12345678-1234-4234-8234-000000000003"})}});
mock.module(at("lib/gw.js"),{namedExports:{gwContext:async()=>({tenantId:"t1",roles:[role]}),canRecruit:c=>c.roles.includes("recruiter")}});
mock.module(at("lib/gw-audit.js"),{namedExports:{gwLog:async()=>{}}});
const {default:handler}=await import(at("api/hr/inbox.js"));
const fakeRes=()=>({statusCode:0,body:null,setHeader(){},end(x){this.body=JSON.parse(x);}});
async function act(body,method="POST"){
 const res=fakeRes();
 await handler({method,url:"/api/hr/inbox",body},res);
 return res;
}
const entry={action:"import",provider:"gmail",providerMessageId:"abc123",recipient:"saiyou@8grp.co.jp",
 receivedAt:"2026-10-23T09:00:00+09:00",subject:"応募について",senderAddress:"recruitment@wantedly.example",
 candidateName:"架空の応募者",source:"Wantedly"};
let r=await act(entry);
assert.equal(r.statusCode,201,JSON.stringify(r.body));
assert.equal(rows.length,1);
r=await act(entry);
assert.equal(r.statusCode,200);
assert.equal(r.body.duplicate,true);
assert.equal(rows.length,1,"同じ受信IDは二重作成しない");
r=await act({}, "GET");assert.equal(r.body.newCount,1);
r=await act({...entry,providerMessageId:"bad-recipient",recipient:"external@example.com"});
assert.equal(r.statusCode,400);
r=await act({action:"link",id:rows[0].id,applicantId:"12345678-1234-4234-8234-000000000004"});
assert.equal(r.statusCode,404,"他テナント/未登録の応募者へリンクしない");
r=await act({action:"link",id:rows[0].id,applicantId:apps[0].id});
assert.equal(r.statusCode,200);
assert.equal(rows[0].status,"linked");
r=await act({action:"review",id:rows[0].id,status:"ignored",note:"誤登録"});
assert.equal(r.statusCode,409,"紐づけ済みは編集禁止");
role="sales";r=await act({},"GET");
assert.equal(r.statusCode,403,"採用権限以外は読み取り拒否");
console.log("HR新着受付：HTML/SQL・重複防止・権限・明示リンク 8ケース PASS");
