// Render the design-handoff dashboard with real, access-controlled original records only.
// Uploaded React mock is intentionally not executed; its metric examples are fictional.
(function(){
"use strict";
const el=(tag,cls,text)=>{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=String(text);
  return node;
};
const SOURCES=new Set(["plan","site_news"]);
const validItems=(production)=>{
  if(!Array.isArray(production?.sources)||!Array.isArray(production?.items))return null;
  const allowed=new Set(production.sources.filter(s=>SOURCES.has(s.key)&&s.state==="ok").map(s=>s.key));
  if(!allowed.size)return null;
  return production.items.filter(x=>(x.origin==="plan"&&allowed.has("plan"))||(x.origin==="site_news"&&allowed.has("site_news")));
};
const mkCard=(title,subtitle)=>{
  const c=el("section","mkh-card");
  const head=el("div","mkh-cardhead");
  const left=el("div");
  left.append(el("h3","",title));
  if(subtitle)left.append(el("p","",subtitle));
  head.append(left);c.append(head);
  return c;
};
const warning=(text)=>{
  const p=el("div","mkh-empty");
  p.append(el("span","mkh-empty-icon","○"),el("p","",text));
  return p;
};
function kpi(label,value,sub,unit){
 const card=el("section","mkh-kpi");
 card.append(el("span","mkh-kpi-label",label));
 const big=el("div","mkh-kpi-main");
 big.append(el("strong","",value===null?"—":String(value)));
 if(value!==null&&unit)big.append(el("small","",unit));
 card.append(big,el("small","mkh-kpi-note",sub));
 return card;
}
const jstDay=iso=>{
 if(!iso)return null;
 const d=new Date(iso);
 if(!Number.isFinite(d.getTime()))return null;
 return new Date(d.getTime()+9*3600000).toISOString().slice(0,10);
};
function render(root,production,opts={}){
 if(!root)return;
 root.replaceChildren();
 const sourceItems=validItems(production);
 const items=sourceItems&&opts.biz?sourceItems.filter(x=>x.biz===opts.biz):sourceItems;
 const planOK=production?.sources?.some(s=>s.key==="plan"&&s.state==="ok");
 const newsOK=production?.sources?.some(s=>s.key==="site_news"&&s.state==="ok");
 const scope=items?(planOK&&newsOK?"取得範囲内の数値":"一部原本のみ取得"):"原本未取得";
 // These counters are source-backed; PV and inquiry attribution are NOT measured.
 const published=items?items.filter(x=>x.state?.key==="published").length:null;
 const kpis=el("div","mkh-kpis");
 kpis.append(
  kpi("発信数",null,"公開URL・配信履歴が未接続"),
  kpi("Web PV",null,"GA4の接続待ち"),
  kpi("SNS流入",null,"UTM・GA4未計測"),
  kpi("メールクリック",null,"ブラストメール未接続"),
  kpi("有効問い合わせ",null,"集計・重複除外未接続"),
  kpi("商談・成約",null,"Salesの施策帰属未接続")
 );
 root.append(kpis);
 const two=el("div","mkh-grid");
 const trend=mkCard("公開前後のアクセス推移","公開前7日・公開後7日の比較");
 const trendBody=el("div","mkh-cardbody");
 trendBody.append(warning("記事別PVと公開日時の照合が未接続です。GA4接続後に折れ線グラフを表示します。"));
 const compare=el("div","mkh-compare");
 for(const label of ["公開前7日 平均PV","公開後7日 平均PV","PR記事以外の伸び"]){
  const item=el("div");
  item.append(el("span","",label),el("strong","","—"));
  compare.append(item);
 }
 trendBody.append(compare);trend.append(trendBody);
 const rank=mkCard("記事別アクセスランキング","直近30日・サイト別");
 rank.append(warning("記事別PVは未計測です。実データ取得後に上位記事を表示します。"));
 two.append(trend,rank);
 // Reuse the actual original-state donut and media production-count bars.
 const productionWrap=el("section","mkh-production");
 const figure=el("div","mkh-chart-title");
 figure.append(el("h2","","制作・公開の内訳"),el("p","","現時点の原稿を確認し、次に公開するものを判断します。"));
 productionWrap.append(figure);
 const charts=el("div");window.MarketingOverviewCharts.render(charts,production);
 const chartGrid=charts.querySelector?.(".mt-chart-grid")||[...charts.children].find(x=>x.className==="mt-chart-grid");
 if(chartGrid)productionWrap.append(chartGrid);
 const note=[...charts.children].find(x=>x.className==="mt-caption");
 if(note)productionWrap.append(note);
 root.append(productionWrap);
 root.append(two);
 const bottom=el("div","mkh-grid");
 const active=mkCard("進行中のPR・制作","取得した制作予定から表示");
 const activeList=el("div","mkh-workitems");
 if(!planOK){
   activeList.append(warning("制作予定の原本が未取得です。"));
 }else{
   const rows=(items||[]).filter(x=>x.origin==="plan"&&x.state?.key!=="published")
      .sort((a,b)=>String(a.due||"9999").localeCompare(String(b.due||"9999"))).slice(0,5);
   if(!rows.length)activeList.append(el("p","mkh-muted","表示対象の進行中予定はありません。"));
   for(const item of rows){
     const row=el("button","mkh-work-row");
     row.type="button";
     const name=el("b","",item.title||"無題");
     const flow=el("div","mkh-progress");
     const states=["plan","drafting","review","scheduled","published"];
     const idx=states.indexOf(item.state?.key);
     states.forEach((_,i)=>flow.append(el("i",i<idx?"done":i===idx?"current":"")));
     flow.append(el("span","",item.state?.label||"状態未確認"));
     const meta=el("small","",["担当："+(item.owner||"未設定"),item.due?"期限："+item.due:"期限未設定"].join("　"));
     row.append(name,flow,meta);
     row.onclick=()=>document.querySelector('[data-marketing-step="pr"][role="tab"]')?.click();
     activeList.append(row);
   }
 }
 active.append(activeList);
 const tasks=mkCard("今週の改善タスク","原本の状態から判断できる事項のみ");
 const list=el("ul","mkh-tasks");
 const actions=[];
 const plans=planOK?(items||[]).filter(x=>x.origin==="plan"&&x.state?.key!=="published"):[];
 const overdue=plans.filter(x=>x.due&&x.due<jstDay(new Date().toISOString())).length;
 const unassigned=plans.filter(x=>!x.ownerId).length;
 if(overdue>0)actions.push([overdue+"件の期限超過を確認","制作予定"]);
 if(unassigned>0)actions.push([unassigned+"件の担当者を設定","制作予定"]);
 actions.push(["アクセス計測の接続状況を確認","GA4 / SNS / メール"]);
 actions.push(["PR公開後7日・30日の結果を確認","公開履歴"]);
 for(const [label,source] of actions){
  const li=el("li");
  li.append(el("span","mkh-checkbox"),el("span","",label),el("small","",source));
  list.append(li);
 }
 tasks.append(list);
 bottom.append(active,tasks);
 root.append(bottom);
 const summary=el("p","mkh-coverage",items?"原稿の状態・制作件数は取得済み原本の範囲に限定しています。公開設定済＝サイト反映完了ではありません。PV・効果は未接続のため未計測です。":"制作原本・計測データをまだ取得できません。権限や連携を確認してください。");
 root.append(summary);
}
// Keep the old render interface for legacy callers; redistribute only display nodes
// into P0 dashboard slots. This preserves original-data chart rendering and the PR workflow.
function renderSplit(roots,production,opts={}){
 const scratch=el("div");
 render(scratch,production,opts);
 const parts=[...scratch.children]; // 6 KPI cards, production charts, PV/rank placeholders, tasks+in-progress, source disclosure.
 if(parts.length!==5)throw Error("Marketing dashboard layout structure changed");
 roots.kpis.replaceChildren(parts[0]);
 roots.tasks.replaceChildren(parts[3].children[1]);
 roots.details.replaceChildren(parts[1],parts[2],parts[3].children[0],parts[4]);
}
window.MarketingHandoffDashboard={render,renderSplit,validItems};
})();
