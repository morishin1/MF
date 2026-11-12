// Executes the actual inline form code without a browser; no live services.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const html=readFileSync(new URL('../nippo.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  let weeklyData = null;'),html.indexOf('  // --- 今日の提出状況'));
const nodes=new Map();
const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',classList:{remove(){}}});return nodes.get(id)};
let saved=null,failSave=false,failRead=false,discard=true,resolveSave,delayed=false;
const snapshots={'2026-11-02':{weekStart:'2026-11-02',weekly:null,weekClosing:{on:'2026-11-05'},criteria:[]},'2026-10-26':{weekStart:'2026-10-26',weekly:null,weekClosing:{scheduleStatus:'unknown'},criteria:[]}};
const ctx={el,Date,URL,console,confirm:()=>discard,window:{addEventListener(){}},esc:v=>v,catChips:()=>'',jstToday:()=> '2026-11-04',data:{weekStart:'2026-11-02',weekClosing:{filled:false}},KPLayout:{busy:async(_btn,_msg,f)=>f()},API:{
 api:async url=>{const date=new URL(url,'http://local').searchParams.get('date');if(failRead)throw {hint:'read failed'};return structuredClone(snapshots[date]);},
 saveWeeklyReview:async payload=>{if(failSave)throw {hint:'save failed'};if(delayed)await new Promise(r=>resolveSave=r);saved={week_start:payload.weekStart,updated_at:'2026-11-04T03:00:00Z',...Object.fromEntries(['q1','q2','q3','q4'].map(k=>[k,payload[k].trim()||null]))};snapshots[payload.weekStart].weekly=saved;return saved;}
}};
runInNewContext(code+'\nglobalThis.form = {changeWeeklyDate,saveWeekly,markWeeklyDirty,weeklyDirty};',ctx);
const f=ctx.form;
el('w-date').value='2026-11-02';await f.changeWeeklyDate();assert.equal(el('wk-tag').textContent,'未保存');assert.equal(el('w-fields').disabled,false);
el('w-q1').value='  keep  ';f.markWeeklyDirty();assert.equal(el('wk-tag').textContent,'未保存の変更あり');
await f.saveWeekly({});assert.equal(el('w-q1').value,'keep');assert.match(el('wk-tag').textContent,/1\/4/);assert.equal(ctx.data.weekClosing.filled,true);assert.equal(f.weeklyDirty(),false);
el('w-date').value='2026-10-26';await f.changeWeeklyDate();assert.equal(el('w-q1').value,'');assert.match(el('wk-note').textContent,/不明/);
el('w-q1').value='draft';discard=false;el('w-date').value='2026-11-02';await f.changeWeeklyDate();assert.equal(el('w-date').value,'2026-10-26');assert.equal(el('w-q1').value,'draft');discard=true;
failSave=true;await f.saveWeekly({});assert.equal(el('w-q1').value,'draft');assert.equal(el('w-msg').textContent,'save failed');assert.equal(f.weeklyDirty(),true);failSave=false;
failRead=true;el('w-date').value='2026-11-02';await f.changeWeeklyDate();assert.equal(el('w-q1').value,'draft');assert.equal(el('w-date').value,'2026-10-26');failRead=false;
delayed=true;const pending=f.saveWeekly({});assert.equal(el('w-date').disabled,true);assert.equal(el('w-fields').disabled,true);await f.saveWeekly({});resolveSave();await pending;assert.equal(saved.week_start,'2026-10-26');assert.equal(el('w-date').disabled,false);delayed=false;
el('w-date').value='2026-11-02';await f.changeWeeklyDate();assert.equal(el('w-q1').value,'keep');el('w-q1').value='';await f.saveWeekly({});assert.match(el('wk-tag').textContent,/0\/4/);assert.equal(ctx.data.weekClosing.filled,false);
console.log('weekly form: actual inline code passed save/reload/week choice/dirty guard/failure preservation/locking/empty state');
