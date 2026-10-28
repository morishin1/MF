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
assert.equal(run('STATE.proposalOwner'),'me'); assert.equal(run('STATE.closingOwner'),'none');
run('ppRenderOwnerFilters()');
assert.equal(el('f-proposal-owner').value,'me'); assert.equal(el('f-closing-owner').value,'none');
run('ppPage=3;selected.add("one"); ppSet("proposalOwner", "")');
assert.equal(run('ppPage'),1); assert.equal(run('selected.size'),0);
assert.equal(run('STATE.closingOwner'),'none'); assert.ok(!pending[0].url.includes('proposalOwner='));
assert.ok(pending[0].url.includes('closingOwner=none')); assert.ok(calls.at(-1).includes('service=PC'));
run('STATE.owner="me";ppRenderOwnerFilters()'); assert.equal(el('pp-legacy-owner').hidden,false);
assert.match(el('pp-legacy-owner').textContent,/自分/);
run('ppResetOwners()');
assert.equal(run('STATE.owner+STATE.proposalOwner+STATE.closingOwner'),'');
assert.ok(!/[?&](owner|proposalOwner|closingOwner)=/.test(pending.at(-1).url));
assert.equal(run('STATE.service'),'PC'); assert.equal(run('STATE.q'),'needle'); assert.equal(run('STATE.sort'),'due');
assert.equal(el('pp-legacy-owner').hidden,true);
run('STATE.proposalOwner="bad\\\"<id>";ppRenderOwnerFilters()');
assert.match(el('f-proposal-owner').innerHTML,/選択中の担当/);
assert.ok(!el('f-proposal-owner').innerHTML.includes('<id>'));
assert.equal(el('f-proposal-owner').value,'bad"<id>');
run('render = function(){ globalThis.rendered = data.tag; }; STATE.proposalOwner="me"; ppSet("closingOwner","none");ppSet("closingOwner","")');
const stale = pending.at(-2), latest=pending.at(-1);
latest.resolve({tag:'latest'}); await new Promise(r=>setImmediate(r));
stale.resolve({tag:'stale'}); await new Promise(r=>setImmediate(r));
assert.equal(run('rendered'),'latest'); assert.equal(run('data.tag'),'latest');
for (const id of ['cards','sum','filters','filters-extra','kpi-sec']) el(id).innerHTML='stale';
run('ppSet("proposalOwner", "invalid")');pending.at(-1).reject({code:'invalid_filter',hint:'Invalid filter'});
await new Promise(r=>setImmediate(r));
assert.equal(run('data'),null);
for (const id of ['cards','sum','filters','filters-extra','kpi-sec']) assert.equal(el(id).innerHTML,'');
assert.match(el('pp-list-meta').textContent,/取得できません/);
assert.equal(el('pp-page-next').disabled,true);
run('ppResetOwners()');pending.at(-1).resolve({tag:'recovered'});await new Promise(r=>setImmediate(r));
assert.equal(run('rendered'),'recovered');
console.log('sales owner filter UI VM: URL, AND, reset, stale responses, failed-load recovery PASS (not a browser/layout test)');
