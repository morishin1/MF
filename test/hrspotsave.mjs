// HRスポット人材：評価メモの単独保存、5項目評価、保存失敗時の明示をモックDBで実行。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const at=p=>join(root,p);
const T="t1", ID="12345678-1234-4234-8234-123456789012";
let stored,actorRole="recruiter",simulateLost=false,dbFailure=null;
let logs=[];
const seed=()=>{stored={id:ID,tenant_id:T,name:"テスト登録者",status:"answered",staff_scores:null,staff_note:null,applicant_id:null};simulateLost=false;dbFailure=null;actorRole="recruiter";logs=[];};
const copy=v=>v?{...v}:null;
const table=()=>{
  let conditions=[],patch=null;
  const q={
    select(){return q;},
    eq(k,v){conditions.push([k,v]);return q;},
    is(k,v){conditions.push([k,v]);return q;},
    update(values){patch=values;return q;},
    async maybeSingle(){
      if(dbFailure&&patch)return {data:null,error:dbFailure};
      const hit=stored && conditions.every(([key,value])=>stored[key]===value);
      if(!hit|| (patch&&simulateLost))return {data:null,error:null};
      if(patch)Object.assign(stored,patch);
      return {data:copy(stored),error:null};
    }
  };
  return q;
};
mock.module(at("lib/supabase.js"),{namedExports:{admin:()=>({from:()=>table()})}});
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async()=>({id:"87654321-1234-4234-8234-123456789012"})}});
mock.module(at("lib/gw.js"),{namedExports:{gwContext:async()=>({tenantId:T,roles:[actorRole]}),canRecruit:ctx=>ctx.roles.includes("recruiter")}});
mock.module(at("lib/gw-audit.js"),{namedExports:{gwLog:async e=>{logs.push(e);}}});
const {default:handler}=await import(at("api/hr/spot.js"));
function response(){return {statusCode:0,body:null,setHeader(){},end(s){this.body=JSON.parse(s);}};}
async function call(body){const res=response();await handler({method:"POST",body},res);return res;}
const checks=[];
async function test(title,fn){try{seed();await fn();checks.push(true);console.log("  ok",title);}catch(e){checks.push(false);console.log("  NG",title,e.message);}}
await test("採点なしでもメモを保存でき、回答済みの状態を保つ",async()=>{
 const r=await call({action:"note",id:ID,note:"SES営業経験があり、質問も具体的。"});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.equal(stored.staff_scores,null);
 assert.equal(stored.status,"answered");
 assert.equal(stored.staff_note,"SES営業経験があり、質問も具体的。");
 assert.equal(r.body.person.staff_note,stored.staff_note);
 assert.equal(logs.at(-1).action,"hr.spot_note");
});
await test("5項目とメモを保存し、実際の更新結果を返す",async()=>{
 const r=await call({action:"score",id:ID,scores:[5,4,5,4,5],note:"対応が丁寧"});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.deepEqual(stored.staff_scores,[5,4,5,4,5]);
 assert.equal(stored.status,"evaluated");
 assert.equal(stored.staff_note,"対応が丁寧");
 assert.ok(stored.scored_at);
 assert.equal(r.body.person.status,"evaluated");
 assert.equal(logs.at(-1).action,"hr.spot_score");
});
await test("採点が揃わなければメモも誤上書きしない",async()=>{
 const r=await call({action:"score",id:ID,scores:[5,4],note:"誤入力"});
 assert.equal(r.statusCode,400);
 assert.equal(stored.staff_note,null);
});
await test("終了済みでも後から評価メモを保存でき、終了タブを維持する",async()=>{
 stored.status="closed";
 const r=await call({action:"note",id:ID,note:"勤務終了後に所感を入力"});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.equal(stored.staff_note,"勤務終了後に所感を入力");
 assert.equal(stored.status,"closed");
});
await test("終了済みの5項目を事後評価しても終了ステータスを保つ",async()=>{
 stored.status="closed";
 const r=await call({action:"score",id:ID,scores:[4,5,3,4,5],note:"後日評価"});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 assert.deepEqual(stored.staff_scores,[4,5,3,4,5]);
 assert.equal(stored.status,"closed");
 assert.equal(r.body.person.status,"closed");
});
await test("HR選考へ引き継ぎ済みの評価は閲覧のみ",async()=>{
 stored.status="converted";stored.applicant_id="another-applicant";
 const r=await call({action:"note",id:ID,note:"更新禁止"});
 assert.equal(r.statusCode,409);
 assert.equal(r.body.error,"read_only");
 assert.equal(stored.staff_note,null);
});
await test("応募者紐づけがある場合は状態に関わらず評価不可",async()=>{
 stored.applicant_id="another-applicant";
 const r=await call({action:"score",id:ID,scores:[1,2,3,4,5],note:"更新禁止"});
 assert.equal(r.statusCode,409);
 assert.equal(stored.staff_note,null);
});
await test("更新0件を保存成功扱いにしない",async()=>{
 simulateLost=true;
 const r=await call({action:"note",id:ID,note:"一時的な競合"});
 assert.equal(r.statusCode,409);
 assert.equal(r.body.error,"stale_record");
});
await test("DB制約エラーは具体的案内を表示し、本文は漏らさない",async()=>{
 dbFailure={code:"23503",message:"secrets in the db"};
 const r=await call({action:"score",id:ID,scores:[5,5,5,5,5],note:"説明"});
 assert.equal(r.statusCode,500);
 assert.match(r.body.message,/アカウント情報/);
 assert.doesNotMatch(JSON.stringify(r.body),/secrets in the db/);
});
await test("権限がない社員は評価を保存できない",async()=>{
 actorRole="sales";
 const r=await call({action:"note",id:ID,note:"更新不可"});
 assert.equal(r.statusCode,403);
 assert.equal(stored.staff_note,null);
});
console.log("HRスポット保存API："+checks.filter(Boolean).length+"/"+checks.length+" tests");
if(checks.some(x=>!x))process.exit(1);
