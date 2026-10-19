// 社員全員の業務予定と、日報提出前のAI時間割レビューの最小回帰テスト。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = path => join(ROOT,path);
const src = file => readFileSync(at(file),"utf8");
let employee = {id:"emp1"};
let aiOn = false;
let aiCalls = 0;
mock.module(at("lib/http.js"), {namedExports:{
  json:(res,status,body) => {res.status=status;res.body=body;return body;},
  readJson: async req=>req.body,
  methodNotAllowed:(res)=>{res.status=405;return {error:"method"};}
}});
mock.module(at("lib/auth.js"), {namedExports:{requireUser:async()=>({id:"user1"})}});
mock.module(at("lib/gw.js"), {namedExports:{gwContext:async()=>({tenantId:"tenant1",employee})}});
mock.module(at("lib/supabase.js"), {namedExports:{
  admin:()=>({from:()=>{
    const q={select(){return q;},eq(){return q;},neq(){return q;},limit(){return Promise.resolve({data:[{title:"最優先の見積"}],error:null})}};
    return q;
  }})
}});
mock.module(at("lib/ai-json.js"), {namedExports:{
  aiConfigured:()=>aiOn,
  askJson:async()=>{aiCalls++;return {model:"mock",result:{verdict:"adjust",summary:"先に見積時間を確保してください",suggestions:["午前中に集中作業を置く"]}};}
}});
mock.module(at("lib/focus.js"), {namedExports:{nextFocusDate:(s)=>s==="2026-10-20"?"2026-10-21":"2026-10-22"}});
const {default:review,inspect} = await import("../api/schedule/review.js");

function req(entries, date="2026-10-21", reportDate="2026-10-20"){
  return {method:"POST",body:{entries,date,reportDate}};
}
const check=async(r)=>{
  const res={};
  await review(r,res);
  return res;
};
const entries=[
  {title:"見積",start:"09:00",end:"11:00"},
  {title:"提案",start:"10:30",end:"12:00"},
];
let result = await check(req(entries));
assert.equal(result.status,200);
assert.equal(result.body.ai,false);
assert.equal(result.body.metrics.overlaps,1);
assert.equal(result.body.verdict,"adjust");
assert(result.body.suggestions.some(s=>s.includes("重複")));
assert.equal(aiCalls,0);
assert.equal(inspect([{title:"集中作業",start:"09:00",end:"10:00"}]).totalMinutes,60);

aiOn=true;
result=await check(req([{title:"見積",start:"09:00",end:"10:00"}]));
assert.equal(result.status,200);
assert.equal(result.body.ai,true);
assert.equal(aiCalls,1);
assert(result.body.suggestions.includes("午前中に集中作業を置く"));

result=await check(req([{title:"不正な時間",start:"11:00",end:"10:00"}]));
assert.equal(result.status,400);
assert.equal(aiCalls,1);
result=await check(req(entries,"2026-10-23"));
assert.equal(result.status,400);
result=await check(req(Array.from({length:25},(_,i)=>({title:String(i),start:"09:00",end:"10:00"}))));
assert.equal(result.status,400);

employee=null;
result=await check(req(entries));
assert.equal(result.status,403);
employee={id:"emp1"};

const mine=src("api/schedule/index.js");
const team=src("api/schedule/team.js");
const view=src("team-schedule.html");
const nippo=src("nippo.html");
const sql=src("db/142_work_schedule_privacy.sql");
assert(mine.includes('.eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id)'),"自分の予定のみ本人用APIで読む");
assert(mine.includes('v.visibility = "shared"'),"業務予定は常に社内共有");
assert(!mine.includes('["work", "meeting", "visit", "private", "other"]'),"私用の新規追加を禁止");
assert(team.includes('.eq("source", "self")'),"本人が入力した業務予定のみ共有");
assert(team.includes('.neq("category", "private")'),"過去の私用予定を除外");
assert(!team.includes('.neq("employee_id", ctx.employee.id)'),"社員全員（本人を含む）を対象にする");
assert(!team.includes('.neq("visibility", "private")'),"旧非公開の業務予定も見える");
assert(view.includes('API.teamSchedule('),"社員一覧は同一APIから取得する");
assert(nippo.includes('await loadNextPlan()'),"日報で翌営業日の予定を読む");
assert(nippo.includes('signature !== nextPlanReviewedSignature'),"提出前チェックを要求");
assert(nippo.indexOf('await KPLayout.busy(btn, "予定を保存中…"') < nippo.indexOf('const res = await KPLayout.busy(btn, "送信中…"'),"予定保存後に日報提出");
assert(sql.includes('drop policy if exists gw_calendar_events_peer_select'),"共有はAPIだけ（本文のRLS漏れ防止）");

console.log("社員の仕事予定・翌日AIレビュー・RLS すべて通過");
