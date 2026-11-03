import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const html=readFileSync(new URL("../sales/index.html",import.meta.url),"utf8");
const report=readFileSync(new URL("../js/sales-dashboard-report.js",import.meta.url),"utf8");
const tabsScript=readFileSync(new URL("../js/sales-dashboard-tabs.js",import.meta.url),"utf8");
for(const key of ["today","rankings","analysis","company"]){
  assert.match(html,new RegExp('id="db-tab-'+key+'"'));
  assert.match(html,new RegExp('id="db-panel-'+key+'"'));
  if(key!=="today") assert.match(html,new RegExp('id="db-panel-'+key+'"[\\s\\S]*?hidden'));
}
assert.match(html,/SalesDashboardTabs\.ready\(\)/);
assert.doesNotMatch(html,/load\(\); SalesDashboardReport\.load\(\)/,"first paint must not download the full analytical report");
assert.match(html,/db-focus-label/);
assert.match(html,/ENGERで案件進行を開く/);
assert.match(report,/\$\("db-rankings-content"\)\.innerHTML = rankingMarkup/,"rankings must render separately from analysis");
assert.match(report,/db-deep-dive/,"detailed analytics stay collapsed");
assert.match(html,/db-queue-guidance/);
const nodeMap=new Map();
function el(id){
  if(!nodeMap.has(id))nodeMap.set(id,{
    id,hidden:false,tabIndex:0,dataset:{},attributes:{},listeners:{},
    setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k]??null;},
    addEventListener(k,fn){this.listeners[k]=fn;},focus(){this.focused=true;},
    contains(){return true;},textContent:""
  });
  return nodeMap.get(id);
}
const win={listeners:{},addEventListener(k,fn){this.listeners[k]=fn;},SalesDashboardReport:{load(){win.loads++;}},loads:0};
const location={href:"https://example.test/sales"};
const ctx={document:{getElementById:el},window:win,location,URL,
  history:{pushState(_a,_b,url){location.href=String(url);}},String,Number};
for(const key of ["today","rankings","analysis","company"]) {el("db-tab-"+key);el("db-panel-"+key);}
for(const key of ["click","replied","follow","attack"]){el("sec-"+key);el("db-queue-"+key);}
el("sum");el("db-queue-guidance");el("db-focus-label");el("db-ranking-refresh");
vm.runInNewContext(tabsScript,ctx);
assert.equal(el("db-panel-today").hidden,false,"Today is the first visible tab");
assert.equal(el("db-panel-analysis").hidden,true);
assert.equal(win.loads,0,"initial tab performs no analytics call");
win.SalesDashboardTabs.ready();
assert.equal(win.loads,0,"ready must not eagerly fetch analytics");
win.SalesDashboardTabs.updateQueues({click:{total:0},replied:{total:2},follow:{total:1},attack:{total:3}});
assert.equal(el("sec-replied").hidden,false,"highest-priority nonempty queue is selected");
assert.equal(el("sec-click").hidden,true);
assert.match(el("db-focus-label").textContent,/返信あり/);
el("db-tab-rankings").listeners.click();
assert.equal(win.loads,1,"rankings loads analytics once");
assert.equal(el("db-panel-rankings").hidden,false);
el("db-tab-analysis").listeners.click();
assert.equal(win.loads,1,"switching between result tabs reuses report");
assert.equal(el("db-panel-analysis").hidden,false);
el("db-tab-company").listeners.click();
assert.equal(el("db-panel-company").hidden,false);
el("db-queue-follow").attributes["aria-pressed"]="false";
el("sum").listeners.click({target:{closest(){return {dataset:{queue:"follow"}};}}});
assert.equal(el("sec-follow").hidden,false,"manual lane selection takes effect");
win.SalesDashboardTabs.updateQueues({click:{total:4},replied:{total:8},follow:{total:1},attack:{total:0}});
assert.equal(el("sec-follow").hidden,false,"refresh does not override manual lane");
win.listeners.popstate?.();
assert.equal(el("db-panel-company").hidden,false,"URL back/forward preserves selected tab");
console.log("PASS Sales 4 tabs: Today-first, lazy fetch, lane focus, keyboard wiring and back/forward");
