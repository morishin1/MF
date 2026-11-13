// Shared JST calendar selector: same URL period for all Sales analytical tabs.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const html=readFileSync(new URL("../sales/index.html",import.meta.url),"utf8");
const script=readFileSync(new URL("../js/sales-dashboard-report.js",import.meta.url),"utf8");
const top=html.indexOf('id="db-global-period-summary"');
const firstTab=html.indexOf('id="db-panel-today"');
assert.ok(top>0&&top<firstTab,"Global period control is above the four tab panels");
for(const id of ["db-periods","db-period-range","db-period-from","db-period-to","db-global-period-error"])
 assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id+" must be unique");
const elements=new Map();
const el=id=>{
 if(!elements.has(id))elements.set(id,{
   value:"",min:"",hidden:true,disabled:false,innerHTML:"",textContent:"",dataset:{},
   listeners:{},setAttribute(){},addEventListener(kind,fn){this.listeners[kind]=fn;}
 });
 return elements.get(id);
};
let href="https://example.test/sales/";
const location={get href(){return href;},set href(next){href=String(next);}};
const history={pushState(_state,_label,url){location.href=url;},replaceState(_state,_label,url){location.href=url;}};
const listeners={};
let reports=0,companies=0,lastOpt;
const win={
 SalesDashboardTabs:{periodChanged(o){reports++;lastOpt=o;}},
 SalesCompanyReference:{periodChanged(){companies++;}},
 addEventListener(k,f){listeners[k]=f;}
};
const mock={
 window:win,document:{getElementById:el,querySelectorAll:()=>[]},location,history,
 API:{api(){throw Error("Period selection outside analysis must not fetch an API");}},
 Number,String,Math,Date,Map,Set,URL,URLSearchParams
};
new vm.Script(script).runInNewContext(mock);
const p=win.SalesDashboardReport;
assert.equal(p.getPeriod().key,"this_week","Default selection is current JST week");
assert.match(el("db-global-period-summary").textContent,/今週/);
assert.match(location.href,/period=this_week/);
const choose=key=>el("db-periods").listeners.click({target:{closest(){return {dataset:{period:key}};}}});
choose("today");
assert.equal(p.getPeriod().key,"today");
assert.match(el("db-global-period-summary").textContent,/今日/);
assert.match(location.href,/period=today/);
assert.equal(reports,1);
assert.equal(companies,1);
choose("this_week");
assert.equal(p.getPeriod().key,"this_week");
assert.match(el("db-global-period-summary").textContent,/今週/);
assert.equal(reports,2);
choose("custom");
assert.equal(p.getPeriod().key,"this_week","Opening calendar does not commit a different date");
assert.equal(el("db-period-range").hidden,false);
assert.equal(reports,2,"No extra data query until calendar submission");
el("db-period-from").value="2026-09-10";
el("db-period-to").value="2026-09-01";
el("db-period-range").listeners.submit({preventDefault(){}});
assert.equal(p.getPeriod().key,"this_week","Invalid interval does not replace selected interval");
assert.match(el("db-global-period-error").textContent,/開始日/);
assert.equal(reports,2,"Invalid range must not refresh data");
el("db-period-to").value="2026-09-18";
el("db-period-range").listeners.submit({preventDefault(){}});
assert.deepEqual(JSON.parse(JSON.stringify(p.getPeriod())),{key:"custom",from:"2026-09-10",to:"2026-09-18"});
assert.equal(reports,3);
assert.equal(companies,3);
assert.match(location.href,/period=custom/);
assert.match(location.href,/from=2026-09-10/);
assert.match(location.href,/to=2026-09-18/);
assert.match(el("db-global-period-summary").textContent,/2026\/09\/10〜2026\/09\/18/);
assert.equal(el("db-global-period-error").hidden,true);
location.href="https://example.test/sales/?tab=company&period=last_week";
listeners.popstate();
assert.equal(p.getPeriod().key,"last_week");
assert.equal(lastOpt.loadVisible,true,"Back navigation refreshes the selected period through the lazy tab router");
assert.equal(reports,4);
assert.equal(companies,4);
console.log("PASS Sales shared calendar: presets, validation, custom dates, URL/back and cross-tab invalidation");
