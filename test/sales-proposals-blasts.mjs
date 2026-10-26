// 営業ブラスト：配信事実と面談化の別記録、権限、重複防止、画面列とナビ順の回帰テスト。
import assert from "node:assert/strict";
import {mock} from "node:test";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {createMemDb} from "./_memdb.mjs";
const ROOT=dirname(dirname(fileURLToPath(import.meta.url))),at=p=>join(ROOT,p);
const read=p=>readFileSync(at(p),"utf8");
const UUID1="12345678-1234-4234-8234-100000000001",
 UUID2="12345678-1234-4234-8234-100000000002",
 U="12345678-1234-4234-8234-200000000001",
 OWNER="12345678-1234-4234-8234-300000000001",
 OTHER="12345678-1234-4234-8234-300000000002",
 P1="12345678-1234-4234-8234-400000000001",
 P2="12345678-1234-4234-8234-400000000002",
 BATCH="12345678-1234-4234-8234-500000000001";
const mem=createMemDb({schema:{
 gw_sales_proposals:{},
 gw_sales_proposal_blasts:{
  unique:[["tenant_id","proposal_id","batch_id"]],
  defaults:()=>({meeting_confirmed_at:null,meeting_note:null,meeting_recorded_by:null})},
 gw_sales_proposal_activities:{},
}});
const sb=mem.admin();
await sb.from("gw_sales_proposals").insert([
 {id:P1,tenant_id:UUID1,sales_owner_id:OWNER,archived_at:null,status:"meeting_adjust"},
 {id:P2,tenant_id:UUID1,sales_owner_id:OTHER,archived_at:null,status:"meeting_adjust"},
]);
let tenant=UUID1,me=OWNER,roles=["sales"],granted=true;
const audit=[];
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async()=>({id:U})}});
mock.module(at("lib/gw.js"),{namedExports:{
 gwContext:async()=>({tenantId:tenant,roles,employee:{id:me}}),
 canSell:()=>granted
}});
mock.module(at("lib/supabase.js"),{namedExports:{userClient:()=>sb}});
mock.module(at("lib/gw-audit.js"),{namedExports:{gwLog:async e=>audit.push(e)}});
mock.module(at("lib/sales-proposals.js"),{namedExports:{
 isUuid:v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v||"")),
 canManageProposals:ctx=>ctx.roles.includes("manager")
}});
const {default:handler}=await import(at("api/sales/proposals/blasts.js"));
const send=async (body,method="POST",url="/api/sales/proposals/blasts")=>{
 const res={statusCode:0,body:null,setHeader(){},end(v){this.body=JSON.parse(v);}};
 await handler({method,url,body},res);return res;
};
const checked=[];
const test=async(label,fn)=>{try{await fn();checked.push(true);console.log("  ok",label);}
 catch(e){checked.push(false);console.log("  NG",label,e.message);}};
const ref={action:"record",ids:[P1],batchId:BATCH,
 reference:"架空ブラスト配信 #123",channel:"external_email",
 sentAt:new Date(Date.now()-2*60*60000).toISOString()};
await test("編集権のない他人の提案は一括記録できない",async()=>{
 const r=await send({...ref,ids:[P1,P2]});assert.equal(r.statusCode,403);
});
await test("配信していない記録は作らない",async()=>{
 const r=await send({...ref,reference:"",sentAt:new Date(Date.now()+86400000).toISOString()});
 assert.equal(r.statusCode,400);
});
await test("担当提案を外部送信済みとして記録する",async()=>{
 const r=await send(ref);assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.equal(r.body.count,1);
 const rows=(await sb.from("gw_sales_proposal_blasts").select("*")).data||[];
 assert.equal(rows.length,1);assert.equal(rows[0].meeting_confirmed_at,null);
 assert.equal(rows[0].send_reference,ref.reference);
});
await test("同じバッチを二重登録できない",async()=>{
 const r=await send(ref);assert.equal(r.statusCode,409);assert.equal(r.body.error,"already_recorded");
});
let blastId=(await sb.from("gw_sales_proposal_blasts").select("*")).data[0].id;
await test("ブラスト配信だけでは面談化しない",async()=>{
 const r=await send({action:"confirmMeeting",blastId,note:"配信後の商談化が確定したと確認した"});
 assert.equal(r.statusCode,409);assert.equal(r.body.error,"meeting_not_confirmed");
});
await sb.from("gw_sales_proposal_activities").insert({
 id:"12345678-1234-4234-8234-600000000001",tenant_id:UUID1,proposal_id:P1,
 kind:"meeting",result:"scheduled",occurred_at:new Date(Date.now()-30000).toISOString()
});
await test("面談予定の事実と担当者の根拠が揃って初めて面談化",async()=>{
 const r=await send({action:"confirmMeeting",blastId,note:"ブラスト返信を確認し面談日時を確定しました"});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.ok(r.body.blast.meeting_confirmed_at);
 assert.ok(audit.some(x=>x.action==="sales.blast_meeting_confirm"));
});
await test("面談化の重複を防ぐ",async()=>{
 const r=await send({action:"confirmMeeting",blastId,note:"同じ面談をもう一度記録する操作"});
 assert.equal(r.statusCode,409);
});
await test("他テナントは配信履歴も読めない",async()=>{
 tenant=UUID2;const r=await send({},"GET","/api/sales/proposals/blasts?proposalId="+P1);
 assert.equal(r.statusCode,404);tenant=UUID1;
});
await test("Sales権限のないユーザーは閲覧も不可",async()=>{
 granted=false;const r=await send({},"GET","/api/sales/proposals/blasts?proposalId="+P1);
 assert.equal(r.statusCode,403);granted=true;
});
await test("画面で提案がダッシュボードの隣・ブラスト列固定表示・記録UI",async()=>{
 const nav=read("js/sales-proposal-nav.js"),columns=read("js/sales-proposal-columns.js"),
 html=read("sales/proposals.html"),sql=read("db/149_sales_proposal_blast_tracking.sql");
 assert.match(nav,/dash\.after\(proposal\)/);
 assert.match(columns,/key:"blast", label:"ブラスト"/);
 assert.match(columns,/FIXED = \[[^\]]*"blast"/);
 assert.match(html,/ブラスト配信・記録/);
 assert.match(html,/ブラスト：すべて/);
 assert.match(html,/ppBlastConfirmSave/);
 assert.match(sql,/meeting_evidence_required/);
 assert.match(sql,/before update on public\.gw_sales_proposal_blasts/);
 assert.doesNotMatch(html,/GmailApp\.sendEmail|massSendEmail/);
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
   if(match[1].trim())new Script(match[1]);
});
console.log("Sales ブラスト：" +checked.filter(Boolean).length+"/"+checked.length+" passed");
if(checked.some(x=>!x))process.exit(1);
