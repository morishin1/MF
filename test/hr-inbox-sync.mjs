// Gmail Apps Script -> HR Inbox: HMAC 認証/時刻制限/テナント固定/重複/失敗再試行の検証。
import assert from "node:assert/strict";
import {mock} from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const at=p=>join(ROOT,p),read=p=>readFileSync(at(p),"utf8");
let writes=[],simulateFailure=false;
const tenant="12345678-1234-4234-8234-111111111111";
const secret="abc1234-abc1234-abc1234-abc1234-abc1234-abc1234-supersecret";
mock.module(at("lib/supabase.js"),{namedExports:{
 admin:()=>({from:name=>{
   assert.equal(name,"gw_hr_inbound_mail");
   return {insert:row=>({select:()=>({single:async()=>{
     if(simulateFailure)return {data:null,error:{code:"57014"}};
     if(writes.some(x=>x.tenant_id===row.tenant_id&&x.provider===row.provider&&x.provider_message_id===row.provider_message_id))
       return {data:null,error:{code:"23505"}};
     writes.push({...row});return {data:{id:"generated-uuid"},error:null};
   }})})};
 }})
}});
const {signature,verifySignature}=await import(at("lib/hr-inbox-sync-auth.js"));
const {default:handler}=await import(at("api/hr/inbox-ingest.js"));
const original={
 HR_INBOX_SYNC_ENABLED:process.env.HR_INBOX_SYNC_ENABLED,
 HR_INBOX_TENANT_ID:process.env.HR_INBOX_TENANT_ID,
 HR_INBOX_SYNC_SECRET:process.env.HR_INBOX_SYNC_SECRET
};
process.env.HR_INBOX_SYNC_ENABLED="1";
process.env.HR_INBOX_TENANT_ID=tenant;
process.env.HR_INBOX_SYNC_SECRET=secret;
const msg=()=>({id:"abcdef0123456789",recipient:"saiyou@8grp.co.jp",
 receivedAt:new Date().toISOString(),subject:"テストメール",sender:"notice@example.com",
 replyTo:"",text:"架空の応募候補です"});
const res=()=>({statusCode:0,body:null,headers:{},setHeader(k,v){this.headers[k]=v;},end(s){this.body=JSON.parse(s);}});
async function call(items,changes={}){
 const timestamp=String(Math.floor(Date.now()/1000));
 const body=JSON.stringify({messages:items});
 const req={method:"POST",body,headers:{
  "x-eight-timestamp":timestamp,
  "x-eight-signature":signature(secret,timestamp,body)
 }};
 if(changes.req)Object.assign(req,changes.req);
 if(changes.headers)Object.assign(req.headers,changes.headers);
 const r=res();await handler(req,r);return r;
}
const tests=[];
async function check(name,fn){
 try{writes=[];simulateFailure=false;await fn();console.log("  ok",name);tests.push(true);}
 catch(e){console.log("  NG",name,e.message);tests.push(false);}
}
await check("正常な1通がgmail新着として保存される",async()=>{
 const r=await call([msg()]);assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.equal(r.body.inserted,1);assert.equal(writes.length,1);
 assert.equal(writes[0].tenant_id,tenant);assert.equal(writes[0].provider,"gmail");
 assert.equal(writes[0].recipient,"saiyou@8grp.co.jp");
 assert.equal(writes[0].status,"new");
 assert.equal(writes[0].applicant_id,undefined);
});
await check("同じGmail IDの再送は上書きせず重複として扱う",async()=>{
 const one=await call([msg()]);const two=await call([msg()]);
 assert.equal(one.statusCode,200);assert.equal(two.statusCode,200);
 assert.equal(two.body.duplicates,1);assert.equal(writes.length,1);
});
await check("署名が違う/時計が古い/認証なしは拒否",async()=>{
 const b=JSON.stringify({messages:[msg()]}),now=Math.floor(Date.now()/1000);
 assert.equal(verifySignature({secret,timestamp:String(now),body:b,signatureHex:signature(secret,now,b)}),true);
 assert.equal(verifySignature({secret,timestamp:String(now-3600),body:b,signatureHex:signature(secret,now-3600,b)}),false);
 const r=await call([msg()],{headers:{"x-eight-signature":"0".repeat(64)}});
 assert.equal(r.statusCode,401);assert.equal(writes.length,0);
});
await check("他の宛先と不正メッセージは一括拒否",async()=>{
 let r=await call([{...msg(),recipient:"other@example.com"}]);
 assert.equal(r.statusCode,400);assert.equal(writes.length,0);
 r=await call([{...msg(),id:"x"}]);
 assert.equal(r.statusCode,400);
});
await check("同じバッチ内でID重複なら拒否",async()=>{
 const r=await call([msg(),msg()]);
 assert.equal(r.statusCode,400);assert.equal(r.body.error,"duplicate_in_batch");
});
await check("SQL側障害は503にし、次回再試行できる",async()=>{
 simulateFailure=true;
 const fail=await call([msg()]);assert.equal(fail.statusCode,503);
 assert.equal(fail.body.error,"retry_required");
 simulateFailure=false;
 const retry=await call([msg()]);assert.equal(retry.statusCode,200);
 assert.equal(retry.body.inserted,1);
});
await check("設定OFF/テナント未設定時は署名が正しくても閉じる",async()=>{
 process.env.HR_INBOX_SYNC_ENABLED="0";
 let r=await call([msg()]);assert.equal(r.statusCode,503);
 process.env.HR_INBOX_SYNC_ENABLED="1";
 process.env.HR_INBOX_TENANT_ID="";
 r=await call([msg()]);assert.equal(r.statusCode,503);
 process.env.HR_INBOX_TENANT_ID=tenant;
});
await check("個人情報を含まない処理ログ・Script初期DRY RUN・3本のJSTトリガー",async()=>{
 const script=read("scripts/google-apps-script/hr-inbox-sync.gs");
 assert.match(script,/HR_INBOX_DRY_RUN/);
 assert.match(script,/const enabled=props\.getProperty\("HR_INBOX_DRY_RUN"\)!=="0"/);
 assert.match(script,/\[9,13,17\]/);
 assert.match(script,/inTimezone\("Asia\/Tokyo"\)/);
 assert.match(script,/computeHmacSha256Signature/);
 assert.match(script,/getPlainBody/);
 assert.doesNotMatch(script,/GmailApp\.sendEmail|MailApp\.sendEmail/);
 const manifest=JSON.parse(read("scripts/google-apps-script/appsscript.json"));
 assert.equal(manifest.timeZone,"Asia/Tokyo");
 const api=read("api/hr/inbox.js");
 assert.match(api,/source_not_connected/,"手動UIからgmailを偽装させない");
});
for(const [k,v] of Object.entries(original))v===undefined?delete process.env[k]:process.env[k]=v;
console.log("HR Gmail取込："+tests.filter(Boolean).length+"/"+tests.length+" passed");
if(tests.some(x=>!x))process.exit(1);
