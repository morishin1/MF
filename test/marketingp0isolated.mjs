// P0 integration on isolated main: source-backed content, six unmeasured KPI cards,
// site-status compact rows, business-scoped charts. No real DB, mail or external publish.
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const page=read("marketing/index.html");
const dashboard=read("js/marketing-handoff-dashboard.js");
const charts=read("js/marketing-overview-charts.js");
const sites=read("js/marketing-handoff-sites.js");
let checks=0;
const check=(yes,name)=>{assert.ok(yes,name);checks++;};
class Node{
 constructor(tag){this.tag=tag;this.children=[];this.className="";this.textContent="";this.style={};this.attrs={};this.value="";}
 append(...args){this.children.push(...args);}
 replaceChildren(...args){this.children=[...args];}
 setAttribute(k,v){this.attrs[k]=v;}
}
const ctx={window:{},document:{createElement:t=>new Node(t),createElementNS:(ns,t)=>new Node(t)},URL,Date};
vm.createContext(ctx);
for(const s of [charts,dashboard,sites])vm.runInContext(s,ctx);
const walk=n=>[n,...n.children.flatMap(c=>typeof c==="string"?[]:walk(c))];
const text=n=>[n.textContent,...n.children.map(c=>typeof c==="string"?c:text(c))].join(" ");
const roots=()=>({kpis:new Node("div"),tasks:new Node("div"),details:new Node("div")});
const none=roots();
ctx.window.MarketingHandoffDashboard.renderSplit(none,null);
check(walk(none.kpis).filter(x=>x.tag==="section"&&x.className==="mkh-kpi").length===6,"six KPI cards");
for(const label of ["発信数","Web PV","SNS流入","メールクリック","有効問い合わせ","商談・成約"])
 check(text(none.kpis).includes(label),"kpi "+label);
check(text(none.kpis).includes("—")&&!text(none.kpis).includes("123"),"no invented analytics");
check(text(none.tasks).includes("アクセス計測の接続状況"),"P0 tasks outside graphs");
const prod={
 sources:[{key:"plan",state:"ok"},{key:"site_news",state:"ok"}],
 items:[
  {origin:"site_news",biz:"site",medium:"column",state:{key:"published"},publishedOn:"2026-10-24",title:"PR公開原本"},
  {origin:"plan",biz:"mugen",medium:"sns",state:{key:"review"},title:"SNS準備",due:"2026-11-01",ownerId:"1",owner:"担当"},
  {origin:"plan",biz:"space",medium:"youtube",state:{key:"scheduled"},title:"動画"}
 ]};
const all=roots();
ctx.window.MarketingHandoffDashboard.renderSplit(all,prod);
check(text(all.details).includes("制作・公開の内訳"),"original source-backed charts preserved");
check(text(all.details).includes("進行中のPR・制作"),"PR production follow-ups preserved");
const onlyMugen=roots();
ctx.window.MarketingHandoffDashboard.renderSplit(onlyMugen,prod,{biz:"mugen"});
check(text(onlyMugen.details).includes("SNS準備"),"business scoped in-progress items");
check(!text(onlyMugen.details).includes("動画"),"business scope excludes another business");
const onlySpace=roots();
ctx.window.MarketingHandoffDashboard.renderSplit(onlySpace,prod,{biz:"space"});
check(text(onlySpace.details).includes("動画"),"space records available when selected");
const siteRoot=new Node("section");
ctx.window.MarketingHandoffSites.render(siteRoot,prod,null);
const compact=walk(siteRoot).filter(x=>x.className==="mkh-site-mini-row");
check(compact.length===5,"five compact site rows");
check(text(siteRoot).includes("2026/10/24")&&text(siteRoot).includes("反映未確認"),"published date not verified site delivery");
check(text(siteRoot).includes("対象保留")&&text(siteRoot).includes("未接続"),"unconnected and hold distinct");
check(walk(siteRoot).some(x=>x.tag==="details"&&x.className==="mkh-site-details"),"large table behind disclosure");
check(page.includes('id="marketing-dashboard-kpis"')&&page.indexOf('id="marketing-dashboard-kpis"')<page.indexOf('id="marketing-site-status"'),"KPI before site status");
check(page.indexOf('id="marketing-site-status"')<page.indexOf('id="marketing-home-charts"'),"site status before charts");
check(page.includes('id="mkh-p0-biz"')&&page.includes('id="mkh-p0-period"'),"P0 business and period selectors");
check(page.includes("window.addEventListener(\"popstate\""),"popstate URL restore");
check(page.includes("window.MarketingHandoffDashboard.renderSplit"),"UI renders split sections");
check(page.includes("marketing-pr-compact.css")&&page.includes("marketing-handoff-composer.js"),"PR editor remains intact");
check(page.includes("marketing-manual-share.js")&&page.includes('id="marketing-manual-share"'),"manual SNS sharing remains");
check(!/\bfetch\(|API\.api\(|localStorage|sessionStorage|service_role|sendMail/.test(dashboard+sites+charts),"P0 modules don't write or access API");
console.log("P0 isolated dashboard integration: "+checks+" synthetic checks passed");
