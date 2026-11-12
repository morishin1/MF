// Synthetic identities and in-memory writes only. Never calls live auth or DB.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createMemDb } from './_memdb.mjs';
import { validReviewDate, reviewClosing, ownReview } from '../lib/weekly-review.js';
const at = p => new URL('../' + p, import.meta.url).pathname;
const mem = createMemDb({schema:{tc_weekly_review:{unique:[['user_id','week_start']]}}});
let user = {id:'member-a'}, ctx = {tenantId:'tenant-a', employee:{id:'employee-a',display_name:'架空メンバー',status:'active'}};
mock.module(at('lib/supabase.js'), {namedExports:{admin:()=>mem.admin(),userClient:()=>mem.admin()}});
mock.module(at('lib/auth.js'), {namedExports:{requireUser:async(_req,res)=>{if(user)return user;res.statusCode=401;res.end('{}');return null;}}});
mock.module(at('lib/gw.js'), {namedExports:{gwContext:async()=>ctx}});
mock.module(at('lib/actions.js'), {namedExports:{closeItems:async()=>0,shapeItem:v=>v}});
mock.module(at('lib/nippo-eval.js'), {namedExports:{isConfigured:()=>false}});
mock.module(at('api/nippo/evaluate.js'), {namedExports:{shape:v=>v}});
const {default:handler}=await import(at('api/nippo/index.js'));
async function call(method,body,url='/api/nippo') {
 const res={setHeader(){},end(v){this.body=JSON.parse(v)}};
 await handler({method,body,url,headers:{}},res); return res;
}
const get = date => call('GET',null,`/api/nippo?view=weekly&date=${date}&userId=member-b`);
const save = payload => call('POST',{kind:'weekly',weekStart:'2026-11-02',...payload});
assert.equal(validReviewDate('2026-02-30'),false);
assert.equal(validReviewDate('2026-11-02'),true);
for(const prefs of [null,{data:null},{data:{workdays:null}},{data:{workdays:[9]}},{error:{message:'fail'},data:{workdays:[5]}}]) {
 assert.equal(reviewClosing('2026-11-06',prefs,null).on,null);
 assert.equal(reviewClosing('2026-11-06',prefs,null).isToday,false);
}
assert.equal(reviewClosing('2026-11-06',{data:{workdays:[]}},null).scheduleStatus,'no_workdays');
assert.equal(reviewClosing('2026-11-05',{data:{workdays:[2,3,4]}},null).isToday,true);
assert.equal(reviewClosing('2026-11-08',{data:{workdays:[6,7]}},null).isToday,true);
assert.equal(reviewClosing('2026-11-02',{data:{workdays:[1,5]}},null).on,'2026-11-06');
mem.rows.tc_weekly_review=[{id:'other',user_id:'member-b',week_start:'2026-11-02',q1:'private'}];
mem.rows.gw_reminder_prefs=[{employee_id:'employee-a',workdays:[2,3,4]}];
let r=await get('2026-11-03'); assert.equal(r.statusCode,200);assert.equal(r.body.weekly,null);assert.equal(r.body.weekStart,'2026-11-02');assert.equal(r.body.weekClosing.on,'2026-11-05');
r=await save({user_id:'member-b',q1:'  input  ',eval_total:100,submitted_at:'2026-11-01'});
assert.equal(r.statusCode,200);assert.equal(r.body.weekly.user_id,'member-a');assert.equal(r.body.weekly.q1,'input');assert.equal(r.body.weekly.submitted_at,undefined);assert.equal(r.body.weekly.eval_total,undefined);
const own=mem.rows.tc_weekly_review.find(x=>x.user_id==='member-a');Object.assign(own,{eval_total:80,eval_scores:{a:80},ai_summary:'draft',submitted_at:null});
r=await get('2026-11-06');assert.equal(r.body.weekly.q1,'input');assert.equal(r.body.weekly.eval_total,undefined);assert.equal(r.body.weekly.ai_summary,undefined);
r=await save({q1:'updated',q2:'second'});assert.equal(r.body.weekly.q1,'updated');assert.equal(mem.rows.tc_weekly_review.length,2);assert.equal(own.eval_total,80);
assert.equal(mem.rows.tc_weekly_review[0].q1,'private');
own.submitted_at='2026-11-06T08:00:00Z';
r=await get('2026-11-06');assert.equal(r.body.weekly.eval_total,80);assert.equal(r.body.weekly.ai_summary,undefined);
for(const weekStart of [undefined,'bad','2026-02-30','2026-11-03','2099-01-05']) assert.equal((await save({weekStart})).statusCode,400);
assert.equal((await get('2099-01-05')).statusCode,400);
mem.state.missing='tc_weekly_review';assert.equal((await get('2026-11-03')).statusCode,503);assert.equal((await save({q1:'retain'})).statusCode,500);mem.state.missing=null;
mem.state.missing='gw_reminder_prefs';r=await get('2026-11-06');assert.equal(r.statusCode,200);assert.equal(r.body.weekClosing.scheduleStatus,'unavailable');assert.equal(r.body.weekClosing.isToday,false);mem.state.missing=null;
user=null;assert.equal((await get('2026-11-03')).statusCode,401);assert.equal((await save({q1:'no'})).statusCode,401);user={id:'member-a'};
ctx.employee=null;assert.equal((await save({q1:'no'})).statusCode,403);
console.log('weekly review: own read/write, validation, publication, unknown schedules and failure tests passed');
