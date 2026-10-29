import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const html=fs.readFileSync(new URL('../nippo.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
for(const src of scripts) new vm.Script(src);
function section(start,end){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));}
function ctx(extra={}){const nodes=new Map();const c={console,setTimeout:()=>1,clearTimeout:()=>{},document:{querySelectorAll:()=>[]},el:id=>{if(!nodes.has(id))nodes.set(id,{value:'2026-10-23',textContent:'',innerHTML:'',dataset:{},classList:{toggle(){},remove(){}},getAttribute:()=>'/calendar.html',scrollIntoView(){}});return nodes.get(id)},...extra};vm.createContext(c);return c;}
test('inline scripts compile',()=>assert.ok(scripts.length));
test('Monday dates get Monday labels, through Sunday',()=>{const c=ctx({esc:x=>x,dayPlans:()=>[],showWeekDay(){},nextPlanTarget:'2026-10-26',weekHasLoadError:false});vm.runInContext(section('  const wd =','  const dayPlans=')+section('  function paintWeekPreview(){','  async function loadNextPlan(){'),c);c.paintWeekPreview();const output=c.el('np-week-days').innerHTML;assert.match(output,/<b>月<\/b><span>10\/26/);assert.match(output,/<b>日<\/b><span>11\/01/);});
test('saveDraft captures immediately under loaded date, not newly selected date',()=>{const saved={};const c=ctx({data:{me:{userId:'u1'}},formUserId:'u1',formDirty:true,formReady:true,formDate:'2026-10-23',readForm:()=>({date:'2026-10-26',wins:['keep']}),localStorage:{setItem:(k,v)=>saved[k]=JSON.parse(v)},draftKey:d=>'draft:'+d,draftTimer:1});vm.runInContext(section('  function saveDraft()','  function loadDraft'),c);assert.equal(c.saveDraft(),true);assert.equal(saved['draft:2026-10-23'].date,'2026-10-23');assert.deepEqual(saved['draft:2026-10-23'].wins,['keep']);});
test('during loading no blank form replaces saved draft',()=>{let count=0;const c=ctx({data:{me:{userId:'u1'}},formUserId:'u1',formDirty:true,formReady:false,formDate:'2026-10-23',localStorage:{setItem(){count++}},draftTimer:1});vm.runInContext(section('  function saveDraft()','  function loadDraft'),c);assert.equal(c.saveDraft(),false);assert.equal(count,0);});
test('storage failure is visible and does not clear form',()=>{const c=ctx({data:{me:{userId:'u1'}},formUserId:'u1',formDirty:true,formReady:true,formDate:'2026-10-23',readForm:()=>({}),localStorage:{setItem(){throw Error('quota')}},draftKey:x=>x,draftTimer:1});vm.runInContext(section('  function saveDraft()','  function loadDraft'),c);assert.equal(c.saveDraft(),false);assert.match(c.el('draft-tag').textContent,/保存できません/);});
test('load uses local draft before morning-only DB row',()=>assert.match(html,/fillForm\(restoredDraft \|\| data.today\)/));
test('schedule gate does not hide written report',()=>{let removed=false;const c=ctx({nextScheduleReady:true,scheduleGateState:'ready',scheduleGateReason:''});const el=c.el;c.el=id=>{const e=el(id);if(id==='write-card')e.classList={remove:()=>removed=true,toggle(){throw Error('must not hide')}};return e};vm.runInContext(section('  function setScheduleGateLocked','  function showSubmitBlockNotice'),c);c.setScheduleGateLocked(true,'missing');assert.ok(removed);});
function submitCtx(reviewResult,confirmResult){let submitted=0,saved=0;const c=ctx({nextScheduleGateSeq:0,checkNextScheduleGate:async()=>true,readForm:()=>({date:'2026-10-23',workItems:[],kpiActuals:[]}),data:{weekClosing:{},me:{userId:'u1'}},formDirty:true,formReady:true,formDate:'2026-10-23',formUserId:'u1',focusData:null,nextPlanSignature:()=> 'new',nextPlanReviewedSignature:null,runNextPlanReview:async()=>reviewResult,confirm:()=>confirmResult,KPActionFeedback:{show(){}},KPLayout:{busy:async(_b,_s,fn)=>fn()},API:{submitNippo:async()=>{submitted++;throw Error('server unavailable')}},saveDraft:()=>saved++});vm.runInContext(section('  async function submitReport','  // ---- 翌営業日予定'),c);return {c,counts:()=>({submitted,saved})};}
test('failed AI review with explicit confirmation reaches submit (no infinite stop)',async()=>{const {c,counts}=submitCtx(false,true);await c.submitReport({});assert.equal(counts().submitted,1);assert.equal(counts().saved,1);assert.match(c.el('f-msg').textContent,/入力内容はこの画面に残/);});
test('failed AI review cancellation keeps draft and does not submit',async()=>{const {c,counts}=submitCtx(false,false);await c.submitReport({});assert.equal(counts().submitted,0);});
test('successful review still asks user to inspect before second submit',async()=>{const {c,counts}=submitCtx(true,true);await c.submitReport({});assert.equal(counts().submitted,0);});
test('schedule gate failure never bypassed by AI fallback',async()=>{const {c,counts}=submitCtx(false,true);c.checkNextScheduleGate=async()=>false;c.showSubmitBlockNotice=()=>{};await c.submitReport({});assert.equal(counts().submitted,0);});
test('double clicks cannot send twice',async()=>{let resolve,count=0;const c=ctx({saveDraft(){},submitReport:async()=>{count++;await new Promise(r=>resolve=r)}});vm.runInContext(section('  let submitting =','  async function submitReport'),c);const p=c.submit({});await c.submit({});assert.equal(count,1);resolve();await p;});
test('success disables draft resave before removing stored draft',()=>assert.match(html,/formReady = false;\s*clearDraft\(body.date\)/));
test('error gives exact schedule conditions, retains editing',()=>{assert.match(html,/私用を除く本人の予定/);assert.match(html,/終了時刻が開始より後/);});
test('navigation during review never submits stale report',async()=>{const {c,counts}=submitCtx(false,true);c.runNextPlanReview=async()=>{c.el('f-date').value='2026-10-22';return false};await c.submitReport({});assert.equal(counts().submitted,0);});
test('editing during review asks for recheck rather than submitting old text',async()=>{const {c,counts}=submitCtx(false,true);c.runNextPlanReview=async()=>{c.readForm=()=>({date:'2026-10-23',workItems:[],kpiActuals:[],wins:['changed']});return false};await c.submitReport({});assert.equal(counts().submitted,0);assert.match(c.el('f-msg').textContent,/確認中に入力内容が変わりました/);});
test('draft recovery includes KPI values',()=>assert.match(html,/draft_kpi_actuals: d.kpiActuals/));

test('draft keys isolate accounts and require a verified user',()=>{const c=ctx({data:{me:{userId:'user-a'}}});vm.runInContext(section('  const draftKey =','  let draftTimer'),c);assert.notEqual(vm.runInContext('draftKey("2026-10-23","user-a")',c),vm.runInContext('draftKey("2026-10-23","user-b")',c));assert.equal(vm.runInContext('draftKey("2026-10-23",null)',c),null);});
test('legacy unowned draft is not restored or removed',()=>{let removed=false;const c=ctx({data:{me:{userId:'u1'}},localStorage:{getItem:k=>k==='kp_nippo_draft_2026-10-23'?'{"wins":["private legacy"]}':null,removeItem(){removed=true}}});vm.runInContext(section('  const draftKey =','  let draftTimer')+section('  function loadDraft','  const clearDraft'),c);assert.equal(c.loadDraft('2026-10-23'),null);assert.equal(removed,false);assert.match(c.el('draft-tag').textContent,/自動復元していません/);});
test('account switch cannot save old form to new identity',()=>{let writes=0;const c=ctx({data:{me:{userId:'user-b'}},formUserId:'user-a',formDirty:true,formReady:true,formDate:'2026-10-23',draftTimer:null,localStorage:{setItem(){writes++}}});vm.runInContext(section('  function saveDraft()','  function loadDraft'),c);assert.equal(c.saveDraft(),false);assert.equal(writes,0);});

test('cannot submit A form under B while B loads',async()=>{const {c,counts}=submitCtx(false,true);c.formReady=false;c.el('f-date').value='2026-10-22';await c.submitReport({});assert.equal(counts().submitted,0);assert.match(c.el('f-msg').textContent,/読み込み中/);});
test('pending submission success does not clear later editing',async()=>{const {c}=submitCtx(false,true);let deleted=0,loaded=0;c.clearDraft=()=>deleted++;c.load=()=>loaded++;c.API.submitNippo=async()=>{c.readForm=()=>({date:'2026-10-23',workItems:[],kpiActuals:[],wins:['new edit']});return {ok:true}};await c.submitReport({});assert.equal(deleted,0);assert.equal(loaded,0);assert.match(c.el('f-msg').textContent,/下書きを保持/);});
test('pending submission success does not navigate back from a new day',async()=>{const {c}=submitCtx(false,true);let deleted=0,loaded=0;c.clearDraft=()=>deleted++;c.load=()=>loaded++;c.API.submitNippo=async()=>{c.el('f-date').value='2026-10-22';c.formDate='2026-10-22';return {ok:true}};await c.submitReport({});assert.equal(deleted,0);assert.equal(loaded,0);});
test('submit freezes pane during request and restores original interaction state',async()=>{let done;const c=ctx({saveDraft(){},submitReport:()=>new Promise(r=>done=r)});vm.runInContext(section('  let submitting =','  async function submitReport'),c);c.el('pane-mine').inert=false;const p=c.submit({});assert.equal(c.el('pane-mine').inert,true);done();await p;assert.equal(c.el('pane-mine').inert,false);});

test('viewing a saved report does not create a stale overriding draft',()=>{let writes=0;const c=ctx({data:{me:{userId:'u1'}},formUserId:'u1',formReady:true,formDirty:false,formDate:'2026-10-23',draftTimer:null,localStorage:{setItem(){writes++}}});vm.runInContext(section('  function saveDraft()','  function loadDraft'),c);assert.equal(c.saveDraft(),false);assert.equal(writes,0);});

test('loading freezes editing until the newest load finishes',async()=>{const pending=[];const c=ctx({loadGeneration:0,submitting:false,formReady:true,loadReport:()=>new Promise(r=>pending.push(r))});vm.runInContext(section('  async function load(date,','  async function loadReport'),c);const a=c.load('2026-10-22');const b=c.load('2026-10-23');assert.equal(c.el('pane-mine').inert,true);pending[0]();await a;assert.equal(c.el('pane-mine').inert,true);pending[1]();await b;assert.equal(c.el('pane-mine').inert,false);});

test('failed load keeps stale form locked and offers a selectable recovery copy',async()=>{const created=[];const c=ctx({loadGeneration:0,submitting:false,formReady:false,formDate:'2026-10-23',readForm:()=>({wins:['keep']}),document:{createElement:tag=>{const n={tag,append(){}};created.push(n);return n;}},loadReport:async()=>{}});c.el('notice').append=()=>{};vm.runInContext(section('  async function load(date,','  async function loadReport'),c);await c.load('2026-10-23');assert.equal(c.el('pane-mine').inert,false);assert.equal(c.el('write-card').inert,true);const copy=created.find(n=>n.tag==='textarea');assert.equal(copy.readOnly,true);assert.match(copy.value,/keep/);});

function recoveryCtx(extra={}) {
  const saved={}; let reloads=[];
  const c=ctx({formReady:true,formDate:'2026-10-23',formUserId:'u1',submitting:false,
    data:{me:{userId:'u1'}},formReportVersion:'stale',readForm:()=>({date:'2026-10-23',reportVersion:'stale',wins:['keep me']}),
    draftKey:date=>'draft:u1:'+date,confirm:()=>true,
    localStorage:{getItem:k=>saved[k]||null,setItem:(k,v)=>saved[k]=v},
    load:async(...args)=>reloads.push(args), API:{nippo:async()=>({me:{userId:'u1'},today:{updated_at:'new',wins:['saved']}})},...extra});
  vm.runInContext(section('  function showDraftConflict()', '  // --- 提出'),c);
  return {c,saved,reloads};
}
test('comparison is read only and never refreshes stale CAS token',async()=>{
  const {c}=recoveryCtx();c.showDraftConflict();await c.compareDraft({});
  assert.equal(c.formReportVersion,'stale');assert.match(c.el('draft-current-copy').value,/keep me/);
  assert.match(c.el('draft-latest-copy').value,/saved/);
});
test('failed comparison retains current input and offers retry',async()=>{
  const {c}=recoveryCtx({API:{nippo:async()=>{throw Error('offline')}}});await c.compareDraft({});
  assert.match(c.el('draft-comparison').textContent,/入力は保持/);assert.equal(c.formReportVersion,'stale');
});
test('comparison from an old day cannot render over a newer form',async()=>{
  const {c}=recoveryCtx();c.API.nippo=async()=>{c.formDate='2026-10-22';return {me:{userId:'u1'}}};
  await c.compareDraft({});assert.equal(c.el('draft-comparison').innerHTML,'');
});
test('comparison never exposes another signed-in user response',async()=>{
  const {c}=recoveryCtx({API:{nippo:async()=>({me:{userId:'u2'},today:{wins:['other user']}})}});
  await c.compareDraft({});assert.equal(c.el('draft-comparison').innerHTML,'');
});
test('explicit restart archives input and asks for a fresh saved report, never submits',async()=>{
  const {c,saved,reloads}=recoveryCtx();await c.restartFromSaved();
  const backup=JSON.parse(saved['draft:u1:2026-10-23_recovery']);assert.equal(backup[0].input.wins[0],'keep me');
  assert.deepEqual(reloads,[['2026-10-23',true]]);assert.equal(c.formReportVersion,'stale');
  c.showDraftRecovery('2026-10-23');assert.equal(c.el('draft-recovery').hidden,false);
  assert.match(c.el('draft-recovery-copy').value,/keep me/);
});
test('cancelled restart changes neither draft nor report',async()=>{
  const {c,saved,reloads}=recoveryCtx({confirm:()=>false});await c.restartFromSaved();
  assert.deepEqual(saved,{});assert.equal(reloads.length,0);
});
test('storage failure blocks restart before current input can be lost',async()=>{
  const {c,reloads}=recoveryCtx({localStorage:{getItem:()=>null,setItem(){throw Error('quota')}}});
  await c.restartFromSaved();assert.equal(reloads.length,0);assert.match(c.el('f-msg').textContent,/再開を止め/);
});
test('repeated restart preserves previous recovery copies too',async()=>{
  const {c,saved}=recoveryCtx();await c.restartFromSaved();await c.restartFromSaved();
  assert.equal(JSON.parse(saved['draft:u1:2026-10-23_recovery']).length,2);
});
test('account switch cannot archive old user input into new account',async()=>{
  const {c,saved,reloads}=recoveryCtx({data:{me:{userId:'u2'}}});await c.restartFromSaved();
  assert.deepEqual(saved,{});assert.equal(reloads.length,0);
});
test('morning-only report is not labelled as submitted',()=>{
  assert.match(html,/date-tag"\)\.textContent = data.today\?\.submitted_at/);
});
