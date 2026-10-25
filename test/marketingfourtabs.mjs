// Focused DOM-less smoke tests. No live analytics, DB, browser session, posting, or network.
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";

const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const page=read("marketing/index.html");
const chartCode=read("js/marketing-overview-charts.js");
let count=0; const check=(test,message)=>{assert.ok(test,message);count++;};
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.textContent="";this.attrs={};this.style={};this.className="";}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=[...nodes];}
  setAttribute(k,v){this.attrs[k]=v;}
}
const ctx={window:{},document:{
  createElement:tag=>new Node(tag),
  createElementNS:(namespace,tag)=>new Node(tag)
}};
vm.createContext(ctx);
vm.runInContext(chartCode,ctx);
const ui=ctx.window.MarketingOverviewCharts;
const view=(e)=>[e.textContent,...e.children.map(x=>typeof x==="string"?x:view(x))].join(" ");

const noData=ui.getModel(null);
check(!noData.ready&&noData.total===0,"not connected is distinct from confirmed zero");
let div=new Node("section");
ui.render(div,null);
check(view(div).includes("原本未取得")&&!view(div).includes("取得できた対象原稿は0件"),"unknown never shown as zero");
const prod={sources:[{key:"plan",state:"ok"},{key:"site_news",state:"ok"}],items:[
  {origin:"site_news",medium:"column",state:{key:"published"}},
  {origin:"plan",medium:"sns",state:{key:"review"}},
  {origin:"plan",medium:"youtube",state:{key:"scheduled"}},
  {origin:"plan",medium:"column",state:{key:"drafting"}},
  {origin:"plan",medium:"unknown",state:{key:"unknown"}}
]};
const model=ui.getModel(prod);
check(model.ready&&model.total===4&&model.media.column===2&&model.counts.review===1,"known status composition and media only");
ui.render(div,prod);
check(view(div).includes("制作状況の内訳")&&view(div).includes("媒体別の制作件数"),"pie and bar chart headings");
check(view(div).includes("公開設定済")&&view(div).includes("実サイト反映は別確認"),"published original is not delivery verification");
check(div.children.some(e=>e.className==="mt-chart-grid"),"chart container renders");
const partial=ui.getModel({sources:[{key:"plan",state:"ok"},{key:"site_news",state:"forbidden"}],items:[
 {origin:"site_news",medium:"column",state:{key:"published"}},
 {origin:"plan",medium:"sns",state:{key:"review"}}
]});
check(partial.partial&&partial.total===1&&partial.counts.published===0,"unauthorized source excluded and partial marked");
ui.render(div,{sources:[{key:"plan",state:"ok"},{key:"site_news",state:"forbidden"}],items:[{origin:"plan",medium:"sns",state:{key:"review"}}]});
check(view(div).includes("一部ソースは未取得"),"partial aggregation caveat visible");
check(["dashboard","pr","distribution","analytics"].every(k=>page.includes('id="mkt-tab-'+k+'"')&&page.includes('id="mkt-panel-'+k+'"')),"four primary tab/panel pairs");
check(page.includes('let primaryStep = STEPS.includes(selectedFromUrl) ? selectedFromUrl : q0.has("tab") ? "pr" : "dashboard"'),"dashboard default plus older deep-link handling");
check(page.includes('window.MarketingOverviewCharts.render(el("marketing-home-charts"), S.prod)'),"overview receives original production response");
check(page.indexOf('id="marketing-home-charts"')<page.indexOf('id="marketing-omnichannel"'),"first view prioritizes source-backed status, not fake GA4");
check(page.indexOf('id="marketing-outcomes"')<page.indexOf('class="mk-tabs"'),"existing analysis drilldown still precedes legacy list");
check(page.includes('window.MarketingOmniDashboard.render')&&page.includes('marketing-distribution-tools'),"existing UTM generation moves to distribution screen");
check(page.includes('role="tablist"')&&page.includes('aria-selected="true"'),"tab accessibility semantics");
check(!/\bfetch\(|API\.|method:|localStorage|service_role/.test(chartCode),"chart module never fetches, stores, or sends data");
console.log("Marketing four primary tabs and measured-only doughnut/bar charts: "+count+" checks passed");
