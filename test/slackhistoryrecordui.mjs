// Normal form controller, synthetic DOM and mocked authenticated API only.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {normalizeReceipt} from '../lib/slack-history.js';
const src=readFileSync(new URL('../js/slack-history-record.js',import.meta.url),'utf8');
let n=0;function check(c,m){assert.ok(c,m);n++;}
const fields=['state','form','fields','verify','history','destination','link','ts','sent','summary','date','slot','revision','start','end','coverage','note','sources','confirm-sent','confirm-safe'];
function fixture({dept='hr',owner=true,access=true,response={ok:true}}={}){
 const nodes=Object.fromEntries(fields.map(k=>['receipt-'+k,{value:'',checked:false,hidden:true,disabled:false,textContent:'',events:{},addEventListener(k,fn){this.events[k]=fn;}}]));
 const calls=[],posts=[],window={addEventListener(){}};let result=response;
 const me={gw:{roles:owner?['owner']:['recruiter']},access:{recruit:access}};
 const api={me:async()=>{calls.push('me');return me;},api:async(path,options)=>{calls.push(path);if(options){posts.push(options);const r=typeof result==='function'?await result():result;if(r instanceof Error||r?.status)throw r;return r;}return {ready:true,history:[]};}};
 const context={document:{getElementById:id=>nodes[id]},location:{search:'?department='+dept},URLSearchParams,Date,Number,window,API:api,KPLayout:{hasAccess:()=>access,init:async()=>({me})}};
 const done=vm.runInNewContext(src,context);
 const fill=()=>{for(const [k,v]of Object.entries({link:'https://8grp.slack.com/archives/C0CCSBTDB1S/p1793242800000000',summary:'確認済みの非機密要約',date:'2026-10-29',slot:'12',revision:'1',start:'2026-10-29T08:00:00+09:00',end:'2026-10-29T11:00:00+09:00',coverage:'complete',sources:'fake-message-1\nfake-message-2'}))nodes['receipt-'+k].value=v;nodes['receipt-confirm-sent'].checked=nodes['receipt-confirm-safe'].checked=true;};
 return{nodes,calls,posts,done,api,fill,set:v=>{result=v;},submit:()=>nodes['receipt-form'].events.submit({preventDefault(){}}),verify:()=>nodes['receipt-verify'].events.click()};
}
for(const options of [{owner:false},{access:false},{dept:'keiei'}]){const f=fixture(options);await f.done;check(f.nodes['receipt-form'].hidden,'unauthorized/private form stays hidden');check(f.posts.length===0,'no unauthorized write');}
let f=fixture();await f.done;check(f.calls[0]==='me','fresh official API identity');check(!f.nodes['receipt-form'].hidden,'authorized owner normal form');check(f.nodes['receipt-history'].href==='/hr/inbox.html','scoped history link');f.fill();
f.nodes['receipt-confirm-safe'].checked=false;await f.submit();check(f.posts.length===0,'nonconfidential confirmation required');f.fill();f.nodes['receipt-confirm-sent'].checked=false;await f.submit();check(f.posts.length===0,'sent confirmation required');
f.fill();f.nodes['receipt-link'].value='https://8grp.slack.com/archives/D0000000000/p1793242800000000';await f.submit();check(f.posts.length===0,'DM rejected');
f.fill();f.nodes['receipt-start'].value='2026-10-29T08:00';await f.submit();check(f.posts.length===0,'local timezone ambiguity rejected');
f.fill();let release;f.set(()=>new Promise(r=>{release=r;}));const pending=f.submit();await Promise.resolve();check(f.nodes['receipt-fields'].disabled,'pending form locked');await f.submit();check(f.posts.length===1,'duplicate click no duplicate POST');
const b=f.posts[0].body;check(!normalizeReceipt(b).error,'actual backend normalizer accepts form payload');check(b.source==='hr-mailbox'&&b.department==='hr','fixed source and department');check(b.slackTs==='1793242800.000000','timestamp extracted from exact permalink');check(f.posts[0].method==='POST','normal authenticated API POST');release({ok:true});await pending;check(f.nodes['receipt-fields'].disabled,'success stays locked');check(f.nodes['receipt-state'].textContent.includes('記録しました'),'success visible');await f.submit();check(f.posts.length===1,'success never automatically re-registers');
f=fixture({response:new Error('network')});await f.done;f.fill();await f.submit();check(f.nodes['receipt-state'].textContent.includes('不明'),'unknown explicit');check(f.nodes['receipt-fields'].disabled&&!f.nodes['receipt-verify'].hidden,'unknown locked with verify control');await f.submit();check(f.posts.length===1,'unknown blocks second POST');await f.verify();check(f.posts.length===1&&f.calls.at(-1)==='/api/slack-history?department=hr','unknown verifies via GET only');check(f.nodes['receipt-state'].textContent.includes('確認できません'),'absent row not asserted failed');
const body=f.posts[0].body;f.api.api=async()=>({ready:true,history:[{department:'hr',slack_permalink:body.slackPermalink,summary:body.summary,target_date:body.targetDate,slot:body.slot,revision:body.revision}]});await f.verify();check(f.nodes['receipt-state'].textContent.includes('全入力の一致は未確認'),'matching receipt readback accurately qualified');
for(const status of [403,409,503]){f=fixture({response:{status}});await f.done;f.fill();await f.submit();check(f.nodes['receipt-fields'].disabled,'blocked result remains locked');await f.submit();check(f.posts.length===1,'blocked result no automatic retries');}
f=fixture({response:{status:400}});await f.done;f.fill();await f.submit();check(!f.nodes['receipt-fields'].disabled,'known validation rejection permits correction');f.set({ok:true,duplicate:true});await f.submit();check(f.nodes['receipt-state'].textContent.includes('二重登録していません'),'idempotent receipt shown accurately');
const html=readFileSync(new URL('../slack-history-record.html',import.meta.url),'utf8');check(html.includes('自動照会するものではなく'),'does not imply Slack verification');check(!/localStorage|sessionStorage|access_token|fetch\(/.test(src),'no token extraction, persistence or arbitrary fetch');
console.log(`Slack history owner form ${n}/${n} PASS (synthetic DOM; no real writes)`);
