import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const ctx={window:{}};vm.runInNewContext(readFileSync(new URL('../js/marketing-dashboard-metrics.js',import.meta.url),'utf8'),ctx);
const build=x=>JSON.parse(JSON.stringify(ctx.window.MarketingDashboardMetrics.build(x)));
let n=0;const check=(s,fn)=>{fn();console.log('ok',++n,s);};
const sources=[{key:'hr_lead',biz:'mugen',state:'ok',capped:false,limit:300,scope:'HR原本範囲'},{key:'space_inquiry',biz:'space',state:'forbidden'},{key:'site_contact',biz:'site',state:'ok'}];
const items=[{key:'hr_lead:1',source:'hr_lead',biz:'mugen',status:{open:true}},{key:'hr_lead:2',source:'hr_lead',biz:'mugen',status:{open:false}},{key:'space_inquiry:3',source:'space_inquiry',biz:'space',status:{open:true}}];
const work={sources,items,fetchedAt:'2026-10-25T00:00:00Z'};
const production={today:'2026-10-25',sources:[{key:'plan',state:'ok'}],items:[
 {key:'plan:1',origin:'plan',biz:'mugen',title:'A',due:'2026-10-24',ownerId:null,state:{key:'drafting'}},
 {key:'plan:2',origin:'plan',biz:'space',title:'B',due:'2026-10-25',ownerId:'person',state:{key:'review'}},
 {key:'plan:3',origin:'plan',biz:'site',due:'2026-10-01',state:{key:'published'}},
 {key:'site_news:4',origin:'site_news',biz:'site',due:null,owner:null,state:{key:'drafting'}},
 {key:'plan:5',origin:'plan',biz:'ec',due:'2026-10-01',state:{key:'drafting'}}]};
check('unfetched sources are null not zero',()=>{const r=build();assert.equal(r.workCounts.length,4);assert.ok(r.workCounts.every(s=>s.value===null));assert.equal(r.production.overdue,null);});
check('source totals and open counts are different observed facts',()=>{const r=build({work});assert.equal(r.sourceBars[0].value,2);assert.equal(r.workCounts[0].value,1);assert.equal(r.sourceBars[0].scope,'HR原本範囲');});
check('forbidden source never counts stale items',()=>{const s=build({work}).workCounts.find(s=>s.key==='space_inquiry');assert.equal(s.value,null);assert.equal(s.ratio,null);});
check('ok empty is actual zero with unknown cap metadata preserved',()=>{const s=build({work}).workCounts.find(s=>s.key==='site_contact');assert.equal(s.value,0);assert.equal(s.capped,null);assert.equal(s.coverage,'unknown');});
check('all non-ok statuses remain unmeasured',()=>{for(const state of ['not_connected','failed','not_ready','on_hold']){const r=build({work:{items,sources:[{key:'hr_lead',state}]}});assert.equal(r.workCounts[0].value,null);}});
check('missing items do not masquerade as successful zero',()=>assert.equal(build({work:{sources}}).sourceBars[0].value,null));
check('missing status does not imply completed or open',()=>assert.equal(build({work:{sources,items:[{source:'hr_lead',biz:'mugen'}]}}).workCounts[0].value,null));
check('capped scope explicit without extrapolation',()=>{const r=build({work:{...work,sources:[{...sources[0],capped:true}]}});assert.equal(r.sourceBars[0].coverage,'capped');assert.equal(r.sourceBars[0].value,2);});
check('business filter preserves unavailable and excludes other rows',()=>{const r=build({work,production,biz:'space'});assert.equal(r.workCounts.length,1);assert.equal(r.workCounts[0].value,null);assert.equal(r.production.unassigned,0);});
check('EC and invalid filter never broaden to all',()=>{for(const biz of ['ec','bad']){const r=build({work,production,biz});assert.equal(r.workCounts.length,0);assert.equal(r.production.overdue,null);assert.equal(r.meta.validBiz,false);}});
check('issues exclude published, EC and news without owner field',()=>{const r=build({production});assert.equal(r.production.overdue,1);assert.equal(r.production.unassigned,1);assert.deepEqual(r.production.issues[0].reasons,['overdue','unassigned']);});
check('today not overdue, JST day boundary correct',()=>{assert.equal(build({production,now:'2026-10-24T14:59:00Z'}).production.overdue,0);assert.equal(build({production,now:'2026-10-24T15:00:00Z'}).production.overdue,1);});
check('strict due calendar excludes impossible date',()=>{const p={...production,items:[{...production.items[0],due:'2026-02-30'}]};assert.equal(build({production:p}).production.overdue,0);});
check('unavailable production suppresses stale issues',()=>{const r=build({production:{...production,sources:[{key:'plan',state:'not_ready'}]}});assert.equal(r.production.overdue,null);assert.equal(r.production.unassigned,null);assert.deepEqual(r.production.issues,[]);});
check('unknown today cannot invent overdue zero',()=>assert.equal(build({production:{...production,today:null}}).production.overdue,null));
check('no invented performance, goals or trend',()=>{const m=build({work,production}).meta;for(const key of ['goals','attribution','revenue','timeline'])assert.equal(m[key],null);assert.equal(m.measurementState,'not_connected');});
check('pure build leaves source objects untouched',()=>{const before=JSON.stringify({work,production});build({work,production});assert.equal(JSON.stringify({work,production}),before);});
console.log(`${n} dashboard metrics checks passed (synthetic fixtures only; no live results)`);
