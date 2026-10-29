// Executes actual browser controller in a synthetic DOM; no real DB, Slack or mail.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../js/slack-history.js',import.meta.url),'utf8');
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++;};
function fixture(department='hr',data={history:[],ready:true},authorized=true,owner=false){
 const nodes=Object.fromEntries(['slack-history-state','slack-history-list','slack-history-refresh','slack-history-record'].map(id=>[id,{textContent:'',innerHTML:'',hidden:true,disabled:true,events:{},replaceChildren(){this.innerHTML='';},addEventListener(name,fn){this.events[name]=fn;}}]));
 const calls=[],gates=[];let result=data;
 const context={document:{body:{dataset:{slackDepartment:department}},getElementById:id=>nodes[id]},URL,Date,Intl,console,
  API:{api:async url=>{calls.push(url);if(result instanceof Error||result?.status)throw result;return typeof result==='function'?result():result;}},
  HRLayout:{init:async options=>{gates.push(['hr',options]);return authorized?{me:{gw:{roles:owner?['owner']:['recruiter']}}}:null;}},SalesLayout:{init:async options=>{gates.push(['sales',options]);return authorized?{me:{gw:{roles:owner?['owner']:['recruiter']}}}:null;}},OfficeLayout:{init:async options=>{gates.push(['office',options]);return authorized?{me:{gw:{roles:owner?['owner']:['recruiter']}}}:null;}}};
 const done=vm.runInNewContext(source,context);
 return {nodes,calls,gates,done,set(value){result=value;},refresh:()=>nodes['slack-history-refresh'].events.click()};
}
const row={id:'x',department:'hr',summary:'確認事項 <script>alert(1)</script>',sent_at:'2026-10-29T03:00:00Z',slack_permalink:'https://8grp.slack.com/archives/C0CCSBTDB1S/p1793242800000000',coverage_status:'partial',coverage_note:'一部未取得 <b>x</b>',period_start:'2026-10-28T23:00:00Z',period_end:'2026-10-29T03:00:00Z'};
let f=fixture('hr',{history:[row],ready:true});await f.done;
check(f.calls.length===1&&f.calls[0]==='/api/slack-history?department=hr','only history GET');
check(f.gates[0][1].verify===true,'HR verifies current identity');
check(f.nodes['slack-history-list'].innerHTML.includes('&lt;script&gt;'),'summary escaped');
check(f.nodes['slack-history-list'].innerHTML.includes('取得不足'),'partial visible');
check(f.nodes['slack-history-list'].innerHTML.includes('&lt;b&gt;'),'coverage escaped');
check(f.nodes['slack-history-list'].innerHTML.includes(row.slack_permalink),'exact permalink');
check(f.nodes['slack-history-list'].innerHTML.includes('JST'),'explicit timezone');
check(!f.nodes['slack-history-refresh'].disabled,'refresh enabled');
f.set({status:503});await f.refresh();check(f.nodes['slack-history-state'].textContent.includes('準備中'),'schema not ready');check(f.nodes['slack-history-list'].innerHTML==='','old rows removed on error');
f.set({status:403});await f.refresh();check(f.nodes['slack-history-state'].textContent.includes('権限'),'denied not zero');
f.set({history:[],ready:true});await f.refresh();check(f.nodes['slack-history-state'].textContent.includes('確認が完了したことを意味'),'empty distinct from checked mailbox');
for(const link of ['javascript:alert(1)','https://evil.example/archives/C0CCSBTDB1S/p1793242800000000','https://8grp.slack.com/archives/C0CCLMUQZ7G/p1793242800000000','https://8grp.slack.com/archives/C0CCSBTDB1S/p1793242800000000?token=x']){f.set({history:[{...row,slack_permalink:link}],ready:true});await f.refresh();check(!f.nodes['slack-history-list'].innerHTML.includes('<a href='),'unsafe or other channel link blocked');}
for(const r of [{...row,department:'office'},{...row,status:'failed'},{...row,sent_at:null}]){f.set({history:[r],ready:true});await f.refresh();check(f.nodes['slack-history-list'].innerHTML==='','cross department/unsent fail closed');}
let release;f.set(()=>new Promise(resolve=>{release=resolve;}));const pending=f.refresh();await Promise.resolve();const n=f.calls.length;await f.refresh();check(f.calls.length===n,'double refresh coalesced');release({history:[],ready:true});await pending;
for(const dept of ['hr','office','sales']){const a=fixture(dept,{history:[],ready:true});await a.done;check(a.gates[0][0]===dept,'correct layout gate');check(a.calls[0].endsWith('='+dept),'fixed department request');}
f=fixture('hr',{},false);await f.done;check(f.calls.length===0,'no history when unauthorized');
f=fixture('keiei',{});await f.done;check(f.calls.length===0&&f.gates.length===0,'private DM department unsupported');
for(const [path,dept] of [['hr/inbox.html','hr'],['office/slack-history.html','office'],['sales/slack-history.html','sales']]){const html=readFileSync(new URL('../'+path,import.meta.url),'utf8');check(html.includes('data-slack-department="'+dept+'"'),'fixed page department');check(!/inbox-sync-now|HrInboxCount|loadApplicants|action:"import"/.test(html),'no email intake UI');}
const applicant=readFileSync(new URL('../hr/applicants.html',import.meta.url),'utf8');check(!/hr-inbox-count.js|HrInboxCount/.test(applicant),'old dashboard mail count removed');
for(const path of ['hr/applicants.html','office/index.html','sales/index.html']){const html=readFileSync(new URL('../'+path,import.meta.url),'utf8');check(html.includes('slack-mark.svg')&&html.includes('Slack通知履歴'),'icon entry present');}
f=fixture('hr',{history:[],ready:true},true,true);await f.done;check(!f.nodes['slack-history-record'].hidden&&f.nodes['slack-history-record'].href==='/slack-history-record.html?department=hr','owner normal-form link');
f=fixture('hr',{history:[],ready:true},true,false);await f.done;check(f.nodes['slack-history-record'].hidden,'non-owner no record link');
console.log(`Slack history UI synthetic ${checks}/${checks} PASS (not a real-browser test)`);
