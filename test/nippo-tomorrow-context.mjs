import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {selectTomorrowTasks,selectTomorrowEvents,contextSummary} from "../lib/nippo-tomorrow-context.js";
const target="2026-11-10";
const tasks=[
 {id:"a",title:"A社へ提案",status:"todo",priority:"high",due_on:target,focus_date:target,done_condition:"送付"},
 {id:"b",title:"B社問い合わせ",status:"doing",priority:"normal",due_on:"2026-11-09",is_template:false},
 {id:"c",title:"完了済み",status:"done",due_on:target},
 {id:"d",title:"雛形",status:"todo",is_template:true,due_on:target},
 {id:"e",title:"未来の予定",status:"todo",due_on:"2026-11-30"},
];
const picked=selectTomorrowTasks(tasks,target);
assert.deepEqual(picked.map(x=>x.id),["a","b"]);
assert.equal(picked[0].doneWhen,"送付");
assert.equal(picked[0].focus,true);
const events=[
 {id:"1",title:"業務打合せ",category:"meeting",all_day:false,
  starts_at:"2026-11-10T09:00:00+09:00",ends_at:"2026-11-10T10:00:00+09:00"},
 {id:"2",title:"私用",category:"private",all_day:true},
 {id:"3",title:"無効",category:"work",all_day:false,
  starts_at:"2026-11-10T11:00:00+09:00",ends_at:"2026-11-10T10:00:00+09:00"},
];
const schedule=selectTomorrowEvents(events);
assert.equal(schedule.length,1);
assert.equal(schedule[0].title,"業務打合せ");
assert.equal(schedule[0].start,"09:00");
const view=contextSummary({targetDate:target,tasks:picked,events:schedule,weekGoal:null});
assert.equal(view.taskCount,2);assert.equal(view.eventCount,1);
assert.equal(view.hasCompanyGoal,false);
const src=readFileSync(new URL("../lib/nippo-tomorrow-context.js",import.meta.url),"utf8");
assert.match(src,/\.eq\("tenant_id",ctx.tenantId\)/);
assert.match(src,/\.eq\("assignee_id",ctx.employee.id\)/);
assert.match(src,/\.eq\("employee_id",ctx.employee.id\)/);
assert.match(src,/\.eq\("source","self"\)/);
assert.match(src,/\.neq\("category","private"\)/);
assert.match(src,/goalResult.data\?\.status==="active"/);
assert.doesNotMatch(src,/select\(".*body/);
console.log("tomorrow context: own tasks + work calendar only, no private plans or fabricated metrics");