import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('../sales/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../js/sales-decision-board.js',import.meta.url),'utf8');
const api=readFileSync(new URL('../api/sales/decision-brief.js',import.meta.url),'utf8');
new Script(js);
assert.match(html,/id="db-decision-board"/);
assert.match(html,/id="db-legacy-queue"/);
assert.match(html,/SalesDecisionBoard\.ready\(\)/);
assert.match(html,/営業判断/);
assert.match(html,/従来のリード・アタック一覧（移行中・参考）/);
assert.doesNotMatch(html,/API\.warm\(KEY, fetchDashboard/,'Attack queue must not fetch on initial load');
assert.match(api,/requireUser/);
assert.match(api,/canSell/);
assert.match(api,/userClient/);
assert.match(api,/\.eq\('tenant_id',ctx\.tenantId\)/);
assert.match(api,/\.range\(0,MAX\)/);
assert.doesNotMatch(api,/\badmin\s*\(/,'No service-role admin use');
assert.doesNotMatch(api,/\b(insert|update|upsert|delete)\s*\(/,'GET API has no writes');

let requested=0,view=null;
const root={innerHTML:'',listeners:{},addEventListener(k,f){this.listeners[k]=f;}};
const w={API:{api:async p=>{requested++;assert.equal(p,'/api/sales/decision-brief');return {
  metrics:{openCases:8,proposalToVerify:3,contactToInspect:4,interviewToInspect:1},partial:false,
  note:'同期済み',updatedAt:'2026-11-03T02:00:00Z',
  priority:[{title:'<img onerror=alert(1)>',companyName:'テスト&企業',statusLabel:'条件確認',
    hasRegisteredOwner:false,sourceProposalId:'11111111-1111-4111-8111-111111111111'}]};
}},SalesDashboardTabs:{selectView:v=>{view=v;}}};
new Script(js).runInContext(createContext({document:{getElementById:id=>id==='db-decision-board'?root:null,addEventListener(){}},window:w,Number,String,Date,encodeURIComponent}));
assert.equal(requested,0,'No pre-auth request');
await w.SalesDecisionBoard.ready();
assert.equal(requested,1);
assert.match(root.innerHTML,/&lt;img/);
assert.doesNotMatch(root.innerHTML,/<img/);
assert.match(root.innerHTML,/需要：未確認/);
assert.match(root.innerHTML,/利益・企業実績/);
assert.match(root.innerHTML,/data-metric=\"openCases\"/);
assert.match(api,/resolvePeriod/);
assert.match(api,/metric/);
assert.match(root.innerHTML,/ENGERで確認/);
assert.match(root.innerHTML,/https:\/\/dx\.enger\.jp\/proposals\/1111/);
root.listeners.click({target:{closest:selector=>selector==='#db-judge-company'?{}:null}});
assert.equal(view,'company');
await w.SalesDecisionBoard.ready();
assert.equal(requested,1,'Do not requery on repeated ready');
console.log('PASS Sales judgment board: private lazy loading, safe encoding, decision-first UI');
