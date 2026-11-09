// Sales Detailed Analysis: recorded staff actions through the 30-minute meeting.
(() => {
 "use strict";
 const root=document.getElementById("sm-funnel");
 if(!root)return;
 const $=id=>document.getElementById(id);
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const count=v=>Number(v||0).toLocaleString("ja-JP");
 const fmt=at=>{const n=Date.parse(at||"");return Number.isFinite(n)?new Date(n).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"}):"—";};
 const valid=id=>/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(id||""));
 let data=null,metric="started",member="all",seq=0;
 const showError=message=>{
  $("sm-funnel-status").textContent=message;
 };
 function activeMembers(){
  return member==="all"?(data?.members||[]):(data?.members||[]).filter(x=>x.employeeId===member);
 }
 function sum(k){
  return activeMembers().reduce((n,m)=>n+Number(m.totals?.[k]||0),0);
 }
 function evidence(k,filterMember=member){
  const selected=filterMember==="all"?(data?.members||[]):(data?.members||[]).filter(x=>x.employeeId===filterMember);
  return selected.flatMap(m=>(m.evidence?.[k]||[]).map(x=>({...x,owner:m.name})))
   .sort((a,b)=>String(b.at).localeCompare(String(a.at)));
 }
 function paint(){
  if(!data)return;
  const person=$("sm-member"),allMembers=data.members||[];
  if(!person.dataset.loaded){
    person.replaceChildren(new Option("全担当者","all"));
    for(const m of allMembers)if(m.employeeId)
     person.add(new Option(m.name,m.employeeId));
    person.hidden=!data.manager;
    person.dataset.loaded="true";
  }
  if(!allMembers.some(x=>x.employeeId===member))member="all";
  person.value=member;
  const details=data.metrics||[];
  $("sm-metric-cards").innerHTML=details.map(x=>
    '<button type="button" class="sm-metric'+(metric===x.key?" selected":"")+'" data-metric="'+esc(x.key)+'">'+
    '<small>'+esc(x.label)+'</small><strong>'+count(sum(x.key))+'<em>'+esc(x.unit)+'</em></strong>'+
    '<span>'+esc(x.note)+'</span></button>').join("");
  const chosen=details.find(x=>x.key===metric)||details[0];
  $("sm-bars-title").textContent=chosen.label+"：担当者別";
  const rows=activeMembers().slice().sort((a,b)=>(b.totals[metric]||0)-(a.totals[metric]||0));
  const max=Math.max(1,...rows.map(m=>Number(m.totals[metric]||0)));
  $("sm-member-bars").innerHTML=rows.length?rows.map(m=>{
    const v=Number(m.totals[metric]||0),width=(v/max*100).toFixed(1);
    return '<button type="button" class="sm-bar" data-member="'+esc(m.employeeId||"all")+'" data-action="detail">'+
      '<span class="sm-bar-name">'+esc(m.name)+'</span>'+
      '<span class="sm-bar-track"><i style="width:'+width+'%"></i></span>'+
      '<strong>'+count(v)+'件</strong></button>';
  }).join(""):'<p class="sl-empty">対象期間に記録がありません。</p>';
  const selected=activeMembers(),byDate=new Map();
  for(const m of selected)for(const [day,all] of Object.entries(m.days||{}))
   byDate.set(day,(byDate.get(day)||0)+Number(all[metric]||0));
  const dates=[];
  const periodEnd=data.period.to;
  let day=new Date(periodEnd+"T00:00:00Z");
  for(let i=0;i<14&&day.toISOString().slice(0,10)>=data.period.from;i++){
   dates.unshift(day.toISOString().slice(0,10));
   day.setUTCDate(day.getUTCDate()-1);
  }
  const maxDaily=Math.max(1,...dates.map(d=>byDate.get(d)||0));
  $("sm-day-bars").innerHTML=dates.map(d=>{
   const v=byDate.get(d)||0;
   return '<div class="sm-day"><span>'+esc(d.slice(5).replace("-","/"))+'</span>'+
    '<div class="sm-day-track"><i style="height:'+Math.max(0,(v/maxDaily*100)).toFixed(1)+'%"></i></div>'+
    '<strong>'+count(v)+'</strong></div>';
  }).join("");
  const ai=$("sm-ai-summary");
  if(data.aiAnalysis){
   ai.hidden=false;
   ai.textContent="AI分析完了 "+count(data.aiAnalysis.completed)+"社（チーム全体）。"+data.aiAnalysis.attribution;
  }else ai.hidden=true;
  showError(data.note||"");
 }
 function showDetails(k,filterMember=member){
  const m=data.metrics.find(x=>x.key===k);
  $("sm-dialog-title").textContent=(m?.label||"実績")+"の根拠履歴";
  const hits=evidence(k,filterMember);
  $("sm-dialog-summary").textContent="対象 "+count(hits.length)+"件（最大100件の履歴を表示）。数値は操作履歴から集計しています。";
  $("sm-dialog-body").innerHTML=hits.length?hits.slice(0,100).map(row=>{
   const href=valid(row.companyId)?"/sales/company-segments.html?"+new URLSearchParams({companyId:row.companyId,meeting:"info"}):null;
   return "<tr><td>"+esc(fmt(row.at))+"</td><td>"+esc(row.owner)+
    "</td><td>"+(href?'<a href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">企業詳細を開く</a>':"企業ID未登録")+"</td></tr>";
  }).join(""):'<tr><td colspan="3">該当する記録はありません。</td></tr>';
  $("sm-detail-dialog").showModal();
 }
 async function load(){
  const version=++seq;
  $("sm-member").removeAttribute("data-loaded");
  $("sm-metric-cards").innerHTML='<p class="sl-empty">担当者別の商談記録を集計中…</p>';
  $("sm-member-bars").innerHTML="";
  $("sm-day-bars").innerHTML="";
  showError("");
  const url=new URL(location.href);
  const params=new URLSearchParams({period:url.searchParams.get("period")||"this_week"});
  if(params.get("period")==="custom"){
   params.set("from",url.searchParams.get("from")||"");
   params.set("to",url.searchParams.get("to")||"");
  }
  try{
   const next=await API.api("/api/sales/meeting-funnel-analysis?"+params);
   if(version!==seq)return;
   data=next;
   paint();
  }catch(e){
   if(version!==seq)return;
   data=null;
   $("sm-metric-cards").innerHTML='<p class="sl-empty">商談実績を表示できません。</p>';
   showError(e?.hint||e?.message||"集計に失敗しました。");
  }
 }
 root.addEventListener("click",e=>{
  const btn=e.target.closest("button");
  if(!btn)return;
  if(btn.dataset.metric){metric=btn.dataset.metric;paint();showDetails(metric);return;}
  if(btn.dataset.action==="detail"){showDetails(metric,btn.dataset.member||"all");}
 });
 $("sm-member").addEventListener("change",e=>{member=e.target.value;paint();});
 $("sm-detail-close").addEventListener("click",()=>$("sm-detail-dialog").close());
 window.SalesMeetingFunnel={load};
})();
