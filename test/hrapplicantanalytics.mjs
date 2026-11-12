// HR応募分析：既存応募者のデータだけを集計。応募動機などの未記録を推測しない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const js=read("js/hr-applicant-analytics.js");
const window={};
runInNewContext(js,{window,Date,Map,Set,Math,Number,String});
const A=window.HRApplicantAnalytics;
const people=[
 {createdAt:"2026-10-23T00:15:00+09:00",source:"Wantedly",jobTitle:"AIまち運営",status:"todo",stage:"applied",interviewCount:0},
 {createdAt:"2026-10-01T14:00:00+09:00",source:"Wantedly",jobTitle:"エンジニア",status:"passed",stage:"casual_interview",interviewCount:1},
 {createdAt:"2026-09-24T00:01:00+09:00",source:"紹介",jobTitle:"AIまち運営",status:"declined",stage:"ceo_interview",interviewCount:1},
 {createdAt:"2026-09-23T23:59:00+09:00",source:"紹介",jobTitle:"営業",status:"accepted",stage:"offer",interviewCount:2},
 {createdAt:"2026-08-10T10:00:00+09:00",source:"SNS",jobTitle:"営業",status:"todo",stage:"applied",interviewCount:0}
];
const d30=A.summarize(people,30,"2026-10-23");
assert.equal(d30.total,3,"30日コホートの日付境界はJST");
assert.equal(d30.interviewRecords,2,"面談記録のある人を集計する");
assert.equal(d30.offerStage,0,"過去の内定者を現在の内定段階として誤認しない");
assert.equal(d30.statusCounts.passed,1);
assert.equal(d30.statusCounts.declined,1);
assert.equal(d30.sources.find(x=>x[0]==="Wantedly")[1],2);
assert.equal(d30.jobs.find(x=>x[0]==="AIまち運営")[1],2);
const view=A.render(d30);
assert.match(view.kpi,/対象期間の応募/);
assert.match(view.outcomes,/見送り・不採用/);
assert.doesNotMatch(JSON.stringify(view),/応募理由：.+確定/,"理由を創作しない");
assert.equal(A.escapeText("<img onerror=alert(1)>"),"&lt;img onerror=alert(1)&gt;");
const page=read("hr/index.html"),nav=read("js/hr-nav-analytics.js"),apps=read("hr/applicants.html");
for(const src of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
 if(src[1].trim())new Script(src[1]);
assert.match(page,/HRApplicantAnalytics\.summarize/);
assert.match(page,/応募動機・応募経路の詳しい理由：未収集/);
assert.match(nav,/applicant\.innerHTML/);
assert.match(nav,/oldDashboard\.innerHTML/);
assert.match(nav,/nav\.insertBefore\(applicant,oldDashboard\)/);
assert.match(page,/hr-nav-analytics\.js\?v=20261023hr1/);
assert.match(apps,/<h1 class="hr-title">採用ダッシュボード<\/h1>/);
// 選択期間と交差する月だけ。期間外月を0応募に見せない。
assert.equal(d30.range.from,"2026-09-24");
assert.equal(d30.range.to,"2026-10-23");
assert.equal(d30.trend.map(x=>x.name).join(","),"2026-09,2026-10");
assert.equal(d30.trend.reduce((sum,x)=>sum+x.count,0),d30.total);
assert.equal(d30.trend[0].from,"2026-09-24");
assert.equal(d30.trend[0].partial,true);
assert.equal(d30.trend[1].to,"2026-10-23");
assert.match(view.trend,/<polyline/);
assert.match(view.trend,/role="img" aria-labelledby="ha-trend-title ha-trend-desc"/);
assert.match(view.trend,/<caption>月別応募受付数の数値表<\/caption>/);
assert.match(view.trend,/<th scope="col">応募者数<\/th>/);
assert.match(view.trend,/<th scope="row">2026-09/);
assert.match(view.trend,/部分月/);
assert.match(view.trend,/2026-09-24 ～ 2026-09-30/);
assert.doesNotMatch(view.trend,/2026-08/);
const a=createdAt=>({createdAt,status:"todo",stage:"applied",interviewCount:0});
const boundary=A.summarize([
 a("2026-09-23T14:59:59Z"), // JST 9/23: 範囲外
 a("2026-09-23T15:00:00Z"), // JST 9/24: 含む
 a("2026-10-23T14:59:59Z"), // JST 10/23: 含む
 a("2026-10-23T15:00:00Z"), // JST 10/24: 未来・範囲外
],30,"2026-10-23");
assert.equal(boundary.total,2);
assert.equal(boundary.trend.map(x=>x.count).join(","),"1,1");
const crossYear=A.summarize([a("2026-12-31T15:00:00Z")],30,"2027-01-15");
assert.equal(crossYear.range.from,"2026-12-17");
assert.equal(crossYear.trend.map(x=>x.name).join(","),"2026-12,2027-01");
assert.equal(crossYear.trend.map(x=>x.count).join(","),"0,1");
const leap=A.summarize([a("2024-02-29T14:59:59Z")],30,"2024-03-01");
assert.equal(leap.range.from,"2024-02-01");
assert.equal(leap.trend[0].to,"2024-02-29");
assert.equal(leap.trend[0].partial,false);
const long=A.summarize([a("2026-04-29T00:00:00+09:00")],180,"2026-10-25");
assert.equal(long.range.from,"2026-04-29");
assert.equal(long.trend.length,7,"180日の端の部分月を固定6か月で切り捨てない");
assert.equal(long.trend[0].count,1);
for(const days of [30,90,180]){
 const data=A.summarize(people,days,"2026-10-23");
 assert.equal(data.trend.reduce((n,r)=>n+r.count,0),data.total);
 assert(data.trend.every(r=>r.from>=data.range.from&&r.to<=data.range.to&&r.from<=r.to));
 const html=A.render(data).trend;
 assert.equal([...html.matchAll(/<th scope="row">/g)].length,data.trend.length);
 assert.equal([...html.matchAll(/<td>(\d+)名<\/td>/g)].reduce((n,m)=>n+Number(m[1]),0),data.total,"数値表と集計合計が一致");
}
const empty=A.summarize([],30,"2026-10-23");
assert.equal(empty.trendComplete,true);
assert(empty.trend.every(r=>r.count===0));
assert.match(A.render(empty).trend,/この期間の応募記録は0名/);
assert.match(A.render(empty).trend,/<td>0名<\/td>/);
assert.doesNotMatch(A.render(empty).trend,/NaN|Infinity/);
const single=A.render(A.summarize([a("2026-10-23T00:00:00+09:00")],1,"2026-10-23")).trend;
assert.match(single,/<circle/);
assert.doesNotMatch(single,/<polyline/,"1点だけから推移を作らない");
const missing=A.summarize([a(null),a("invalid"),null,a("2026-10-01T00:00:00+09:00")],30,"2026-10-23");
assert.equal(missing.dateMissing,3);
assert.equal(missing.trendComplete,false);
const partial=A.render(missing);
assert.match(partial.trend,/登録日を確認できない応募が3名/);
assert.match(partial.trend,/<td>未確認<\/td>/);
assert.match(partial.trend,/<td>1名（確認分）<\/td>/);
assert.doesNotMatch(partial.trend,/<svg|<td>0名<\/td>/,"日付欠損で確認できない月は偽0の点にしない");
assert.match(partial.note,/各集計から除外/);
assert.match(partial.kpi,/対象期間の応募（確認分）/);
assert.doesNotMatch(partial.kpi,/<strong>0<\/strong>/);
assert.doesNotMatch(partial.stages,/<b>0人<\/b>/);
assert.doesNotMatch(partial.outcomes,/<b>0件<\/b>/);
const missingOnly=A.render(A.summarize([a(null)],30,"2026-10-23"));
assert.doesNotMatch(missingOnly.kpi,/<strong>0<\/strong>/,"推移以外のKPIも未確認を0名にしない");
assert.match(missingOnly.kpi,/<strong>—<\/strong>/);
assert.match(missingOnly.source,/応募0件という意味ではありません/);
assert.match(missingOnly.note,/「—」は未確認/);
const capped=A.summarize(Array.from({length:1000},()=>a("2026-10-01T00:00:00+09:00")),30,"2026-10-23");
assert.equal(capped.trendComplete,false);
assert.match(A.render(capped).trend,/取得上限（1000件）/);
assert.doesNotMatch(A.render(capped).trend,/<svg|<td>0名<\/td>/);
for(const bad of [null,undefined,{error:"forbidden"}])assert.throws(()=>A.summarize(bad,30,"2026-10-23"),/応募データを確認/);
for(const bad of ["bad","2026-02-30"])assert.throws(()=>A.summarize([],30,bad),/集計基準日/);
for(const bad of [0,-1,30.5,367])assert.throws(()=>A.summarize([],bad,"2026-10-23"),/集計期間/);
assert.doesNotMatch(js,/\bfetch\s*\(|XMLHttpRequest|API\./,"分析部品にAPIや外部通信を増設しない");

// 実HTMLの入口をVMで実行し、認可拒否・通信失敗・未準備で集計描画へ進まないことを確認。
const inline=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes("HRApplicantAnalytics.summarize"));
async function pageState({allow=true,error=null,response={applicants:[]}}={}){
 const elements=new Map();let apiCalls=0,summaries=0;
 const get=id=>{
  if(!elements.has(id))elements.set(id,{innerHTML:"",textContent:"",value:"30",hidden:id==="haResults",listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}});
  return elements.get(id);
 };
 runInNewContext(inline,{
  document:{getElementById:get},JST:{ymd:()=>"2026-10-23"},
  HRApplicantAnalytics:{...A,summarize(...args){summaries++;return A.summarize(...args);}},
  HRLayout:{init:async()=>allow?{}:null},
  API:{listHrApplicants:async()=>{apiCalls++;if(error)throw error;return response;}},
 });
 await new Promise(resolve=>setImmediate(resolve));
 return {get,apiCalls,summaries};
}
for(const error of [{status:403,message:"権限がありません"},{message:"接続できません"}]){
 const state=await pageState({error});
 assert.equal(state.summaries,0);
 assert.equal(state.get("haResults").hidden,true);
 assert.equal(state.get("haTrend").innerHTML,"");
 assert.match(state.get("haStatus").textContent,/読み込めませんでした/);
}
const notReady=await pageState({response:{notReady:true,message:"未準備",applicants:[]}});
assert.equal(notReady.summaries,0);
assert.equal(notReady.get("haResults").hidden,true);
const denied=await pageState({allow:false});
assert.equal(denied.apiCalls,0);
assert.equal(denied.summaries,0);
for(const response of [null,{}, {applicants:null},{applicants:{}}]){
 const invalid=await pageState({response});
 assert.equal(invalid.summaries,0);
 assert.equal(invalid.get("haResults").hidden,true);
 assert.match(invalid.get("haStatus").textContent,/形式を確認/);
 invalid.get("haPeriod").listeners.change();
 assert.equal(invalid.get("haResults").hidden,true,"期間変更で取得失敗を0件表示に変えない");
}
const success=await pageState();
assert.equal(success.get("haResults").hidden,false);
assert.match(success.get("haTrend").innerHTML,/この期間の応募記録は0名/);
console.log("HR応募分析：月別折線・数値表・JST/年跨ぎ/閏日/180日・欠損/上限/0件・権限/通信失敗 VM OK");
