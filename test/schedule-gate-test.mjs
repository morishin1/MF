// 翌営業日の予定が無ければ日報を書けない。祝日・本人の予定・APIのエラーを検証する。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNextWorkSchedule } from "../lib/schedule-gate.js";
import { nextFocusDate } from "../lib/focus.js";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=p=>readFileSync(join(root,p),"utf8");
const ctx={tenantId:"tenant-1",employee:{id:"employee-1"}};
const props=[];
let result={data:[],error:null};
const query={
  select(a){props.push(["select",a]);return this;},
  eq(a,b){props.push(["eq",a,b]);return this;},
  neq(a,b){props.push(["neq",a,b]);return this;},
  gte(a,b){props.push(["gte",a,b]);return this;},
  lt(a,b){props.push(["lt",a,b]);return this;},
  order(a){props.push(["order",a]);return this;},
  limit(a){props.push(["limit",a]);return Promise.resolve(result);}
};
const db={from(x){props.push(["from",x]);return query;}};
let gate=await checkNextWorkSchedule(db,ctx,"2026-10-20");
assert.deepEqual([gate.ready,gate.count,gate.targetDate],[false,0,"2026-10-21"],"未登録ならロック");
assert(props.some(x=>x[0]==="eq"&&x[1]==="tenant_id"&&x[2]===ctx.tenantId),"会社単位");
assert(props.some(x=>x[0]==="eq"&&x[1]==="employee_id"&&x[2]===ctx.employee.id),"本人だけ");
assert(props.some(x=>x[0]==="eq"&&x[1]==="source"&&x[2]==="self"),"手入力の予定だけ");
assert(props.some(x=>x[0]==="neq"&&x[1]==="category"&&x[2]==="private"),"過去の私用は対象外");
const at={title:"提案の準備",starts_at:"2026-10-21T09:00:00+09:00",ends_at:"2026-10-21T10:00:00+09:00",all_day:false};
result={data:[at],error:null};
gate=await checkNextWorkSchedule(db,ctx,"2026-10-20");
assert(gate.ready&&gate.count===1,"翌営業日に1件あれば日報を解放");
result={data:[{...at,title:"",all_day:false},{...at,ends_at:at.starts_at,all_day:false}],error:null};
gate=await checkNextWorkSchedule(db,ctx,"2026-10-20");
assert.equal(gate.ready,false,"空件名や0分の予定では日報を解放しない");
result={data:null,error:{message:"database timeout"}};
gate=await checkNextWorkSchedule(db,ctx,"2026-10-20");
assert(!gate.ready&&gate.error==="schedule_query_failed","DB障害時は未登録と混同せず安全側で止める");
assert.equal(nextFocusDate("2026-10-23"),"2026-10-26","金曜日は月曜日の予定（祝日を除く）で判定");
const api=read("api/nippo/index.js");
const checker=read("api/schedule/day-gate.js");
const ui=read("nippo.html");
assert(api.includes("await checkNextWorkSchedule(sb, ctx, date)"),"日報POSTはサーバで判定");
const gatePos=api.indexOf("const scheduleGate = await checkNextWorkSchedule(");
const subsequentWrite=api.indexOf("const row = {",gatePos);
assert(gatePos>=0 && subsequentWrite>gatePos && api.indexOf(".from(\"tc_nippo\")",subsequentWrite)>subsequentWrite,
  "日報の保存より前に予定登録を検証する");
assert(api.includes('error:"next_schedule_required"'),"未登録でAPI 400");
assert(checker.includes("checkNextWorkSchedule(admin(),ctx,date)"),"UI用GETも本人予定をDBで判定");
assert(ui.includes('id="np-schedule-gate"'),"未登録時に案内カード");
assert(ui.includes('id="write-card"') && ui.includes('class="card hidden" id="write-card"'),"初期状態で日報フォームを隠す");
assert(ui.includes('setScheduleGateLocked(true,'),"UIで日報入力をロック");
assert(ui.includes('await checkNextScheduleGate(gateSeq)'),"読込後の予定状況を確認");
assert(ui.includes('const allowed=await checkNextScheduleGate('),"送信直前にも確認");
assert(ui.includes('onclick="refreshScheduleGate(this)"'),"予定登録後に再確認可能");
assert(read("calendar.html").includes('URLSearchParams(location.search).get("date")'),"対象日付きカレンダーへ遷移");
console.log("翌営業日予定必須・社員ごとの制御・DBエラー・日報API前段ゲート すべて通過");
