// Execute the real inline UI with a minimal DOM; no server or live data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../sales/proposals.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('const STATE'));
assert.ok(script);
assert.match(html,/aria-label="提案担当で絞り込み"/);
assert.match(html,/aria-label="クロージング担当で絞り込み"/);
assert.ok(!html.includes('id="f-owner"'));
const elements = new Map();
const el = id => { if (!elements.has(id)) elements.set(id, {innerHTML:'',textContent:'',value:'',hidden:false}); return elements.get(id); };
const calls = [];
const pending = [];
const context = vm.createContext({
  document:{getElementById:el,addEventListener:()=>{}}, window:{addEventListener:()=>{}},
  location:{pathname:'/sales/proposals.html',search:'?proposalOwner=me&closingOwner=none&service=PC&q=needle&sort=due'},
  history:{replaceState:(_,__,url)=>calls.push(url)},URLSearchParams,console,setTimeout,clearTimeout,
  SalesLayout:{esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),init:()=>new Promise(()=>{}),fmt:()=>'',statusPill:()=>''},
  SalesProposalColumns:{init:()=>{}},API:{api:url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}))},
});
vm.runInContext(script,context);
const run = code=>vm.runInContext(code,context);

run('renderRows=()=>{}; renderDetail=()=>{}; ppShowServerError=()=>{};');
run('data={proposals:[{id:"p",canEdit:true,hotAvailable:true,isHot:false,hotVersion:0}]};');
assert.match(run('ppHotMark(data.proposals[0])'),/aria-pressed="false"/);
assert.ok(!run('ppHotMark(data.proposals[0])').includes('>🔥'));
assert.match(run('ppHotMark({...data.proposals[0],isHot:true})'),/>🔥/);
assert.ok(!run('ppHotMark({...data.proposals[0],canEdit:false,isHot:true})').includes('<button'));
assert.match(run('ppHotMark({hotAvailable:false})'),/disabled/);
assert.match(run('ppHotMark(data.proposals[0])'),/event.stopPropagation/);
const first=run('ppToggleHot("p")');
assert.equal(pending.length,1);assert.equal(run('data.proposals[0].isHot'),false,'no optimistic success');
assert.match(run('ppHotMark(data.proposals[0])'),/aria-busy="true"/);
await run('ppToggleHot("p")');assert.equal(pending.length,1,'double click ignored');
pending[0].resolve({isHot:true,hotVersion:1});await new Promise(r=>setImmediate(r));
assert.equal(pending.length,2,'readback');
pending[1].resolve({proposals:[{id:'p',canEdit:true,hotAvailable:true,isHot:true,hotVersion:1}]});
run('render=()=>{};');await first;
assert.equal(run('data.proposals[0].isHot'),true);assert.equal(run('hotPending.size'),0);
const second=run('ppToggleHot("p")');pending[2].reject({code:'timeout'});await new Promise(r=>setImmediate(r));
assert.equal(pending.length,4,'timeout readback, no retry');
pending[3].resolve({proposals:[{id:'p',canEdit:true,hotAvailable:true,isHot:false,hotVersion:2}]});await second;
assert.equal(run('data.proposals[0].isHot'),false);
run('data.proposals[0].canEdit=false');await run('ppToggleHot("p")');assert.equal(pending.length,4);
console.log('hot UI VM: true/outline, readonly, pending, duplicate click, no optimistic success, timeout readback PASS');
