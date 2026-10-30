import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const nodes = new Map();
const el = id => {
  if (!nodes.has(id)) nodes.set(id, {value:"",hidden:false,disabled:false,innerHTML:"",textContent:"", listeners:{},
    addEventListener(kind, fn){ this.listeners[kind]=fn; }});
  return nodes.get(id);
};
const pending = [];
const context = {
  document:{getElementById:el,querySelectorAll:()=>[]},
  location:{href:"https://example.test/sales/?period=today"},
  history:{replaceState(){},pushState(){}},
  window:{addEventListener(){}},
  API:{api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))},
  URL,URLSearchParams,Date,Map,Set,Number,String,Math,Blob,setTimeout
};
vm.runInNewContext(readFileSync(new URL("../js/sales-dashboard-report.js",import.meta.url),"utf8"),context);
const metrics={matchingCount:1,unsubmittedMatchedCount:0,proposalSentCount:1,meetingEventCount:1,meetingCohortCount:1,conversionRate:100,closedCount:0,byOwner:[],lossReasons:[],blastCompanies:[],byCompany:[{companyName:"<script>bad</script>",sentCount:1,meetingCount:1,rate:100}]};
const data = day => ({period:{from:day,to:day},previousPeriod:{from:"2026-10-28",to:"2026-10-28"},metrics,previousMetrics:metrics,insights:{issues:[],improvements:[],actions:[]}});
const first=context.window.SalesDashboardReport.load();
const second=context.window.SalesDashboardReport.load();
pending[1].resolve(data("2026-10-30")); await second;
pending[0].resolve(data("2026-10-29")); await first;
assert.match(el("db-period-caption").textContent,/2026\/10\/30/);
assert.ok(el("db-business-content").innerHTML.includes("&lt;script&gt;bad&lt;/script&gt;"));
assert.ok(!el("db-business-content").innerHTML.includes("<script>bad</script>"));
assert.ok(el("db-business-content").innerHTML.includes("db-bar-fill"));
const third=context.window.SalesDashboardReport.load();
el("db-period-from").value="invalid";
el("db-period-to").value="invalid";
el("db-period-range").listeners.submit({preventDefault(){}});
pending[2].resolve(data("2026-10-29")); await third;
assert.equal(el("db-business-content").innerHTML,"");
assert.equal(el("db-business-csv").disabled,true);
console.log("PASS dashboard: out-of-order response, invalidation, graph and escaped company");
