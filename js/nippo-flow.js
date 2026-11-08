// The four-stage employee workflow for /nippo.html (presentation only).
// All existing APIs, schedule gate, report save, and weekly closing rules remain unchanged.
(function(){
 "use strict";
 const steps=[
  {n:1,key:"morning",title:"今日のゴール",sub:"目的・完了条件"},
  {n:2,key:"midday",title:"進捗確認",sub:"30秒で確認"},
  {n:3,key:"tomorrow",title:"明日の準備",sub:"重要タスク・予定"},
  {n:4,key:"report",title:"日報を提出",sub:"成果・改善・振り返り"},
 ];
 let root=null,stages=[],selected=1,lastDate=null,manual=false,loaded=false,extras=null,weekly=null,weekPlan=null;
 let snap={};
 const $=id=>document.getElementById(id);
 function node(tag,cls,id){
  const x=document.createElement(tag);
  if(cls)x.className=cls;
  if(id)x.id=id;
  return x;
 }
 function info(text){return (typeof text==="string"?text:"").replace(/[&<>"']/g,x=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[x]));}
 function begin(){
  if(root||!$("pane-mine"))return;
  const pane=$("pane-mine");
  if(!$("np-flow-style")){
    const style=node("style",null,"np-flow-style");
    style.textContent=`
      .np-flow{border:1px solid #dbe4ef;border-radius:12px;background:#fff;padding:15px 17px;margin:0 0 12px;scroll-margin-top:15px}
      .np-flow-top{display:flex;gap:10px;justify-content:space-between;align-items:start;flex-wrap:wrap}
      .np-flow-top strong{font-size:15px;color:#1b2440}.np-flow-top p{font-size:11px;color:#65738a;margin:3px 0 0;line-height:1.55}
      .np-flow-summary{font-size:11px;font-weight:700;border-radius:999px;padding:4px 9px;background:#ecf2f9;color:#2b5a8d}
      .np-flow-track{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:12px 0 10px}
      .np-flow-step{font:inherit;border:1px solid #d7dfe8;background:#f9fafb;border-radius:9px;padding:10px;
        display:flex;align-items:center;text-align:left;gap:9px;min-width:0;cursor:pointer;color:#354965}
      .np-flow-step:hover{background:#f1f6fd;border-color:#8da7c9}
      .np-flow-step:focus-visible{outline:2px solid #2e69b8;outline-offset:2px}
      .np-flow-step.current{border-color:#2e68a7;background:#eaf3ff;box-shadow:inset 0 -2px #2e68a7}
      .np-flow-step.done{background:#f2faf5;border-color:#a3cdb0}
      .np-flow-step.done .np-flow-num{background:#367e58;color:#fff;border-color:#367e58}
      .np-flow-step.blocked{border-color:#e6c898;background:#fff9f0}
      .np-flow-num{height:26px;width:26px;flex:0 0 26px;border:1px solid #c2cedb;border-radius:50%;
        display:grid;place-items:center;font-weight:800;font-size:12px;background:white;color:#345d90}
      .np-flow-step.current .np-flow-num{border-color:#356fae}
      .np-flow-label{display:flex;flex-direction:column;gap:3px;min-width:0}
      .np-flow-label b{font-size:12px;line-height:1.3}
      .np-flow-label small{font-size:10px;line-height:1.35;color:#6b7a8d}
      .np-flow-message{font-size:12px;line-height:1.6;margin:0;border-radius:7px;color:#3c5875}
      .np-flow-message.warn{padding:8px 10px;background:#fff5e4;color:#8d510a}
      .np-flow-stage{margin:0 0 11px;scroll-margin-top:15px}
      .np-flow-stage[hidden],.np-flow-fold[hidden]{display:none!important}
      .np-flow-stage>.card,.np-flow-stage>details.card{margin-top:0;margin-bottom:11px}
      .np-flow-fold{border:1px solid #dfe5ed;background:#fff;border-radius:10px;margin:0 0 11px;padding:0}
      .np-flow-fold>summary{padding:12px 15px;cursor:pointer;font-size:12.5px;font-weight:700;color:#3a5575}
      .np-flow-fold[open]>summary{border-bottom:1px solid #e6ebf2;margin-bottom:10px}
      .np-flow-fold>.card{margin:8px 10px 10px}
      .np-flow-extra{margin-top:3px}
      .np-flow-empty{padding:13px 16px;border:1px dashed #cfdae6;border-radius:9px;background:#f9fbfd;
        font-size:12.5px;line-height:1.8;color:#455a72}
      .np-submit-entry{position:relative!important;top:auto!important}
      @media(max-width:850px){.np-flow-track{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:460px){.np-flow{padding:12px}.np-flow-step{padding:9px 7px;gap:7px}
        .np-flow-num{height:23px;width:23px;flex-basis:23px}.np-flow-label b{font-size:11px}}
    `;
    document.head.appendChild(style);
  }
  root=node("section","np-flow","np-flow");
  root.setAttribute("aria-label","日報ゴールコーチの進捗");
  root.innerHTML='<div class="np-flow-top"><div><strong>今日の進捗</strong><p>今やることを1つずつ。上のステップから戻って編集できます。</p></div>'+
    '<span id="np-flow-summary" class="np-flow-summary" role="status">読み込み中</span></div>'+
    '<div id="np-flow-track" class="np-flow-track" role="group" aria-label="日報の4ステップ"></div>'+
    '<p id="np-flow-message" class="np-flow-message" role="status" aria-live="polite"></p>';
  const entry=$("np-submit-entry");
  entry?.after(root);
  // Move cards into sections without cloning them. Existing DOM ids and handlers keep working.
  const ids=[
   ["thanks-card","am-card"],
   ["push-card","mid-card"],
   ["focus-card"],
   ["write-card","flags-card","ai-card"],
  ];
  stages=steps.map((step,i)=>{
    const section=node("section","np-flow-stage","np-flow-stage-"+step.n);
    section.setAttribute("aria-label",step.title);
    section.dataset.flowStage=String(step.n);
    root.after(section);
    ids[i].map($).filter(Boolean).forEach(el=>section.appendChild(el));
    return section;
  });
  // Visually reorder sections after inserting each with after(): DOM order becomes 1→2→3→4.
  stages.reduce((prev,section)=>{prev.after(section);return section},root);
  weekPlan=node("details","np-flow-fold","np-flow-weekplan");
  const weekTitle=node("summary","");
  weekTitle.textContent="今週の予定を見る・変更する（必要なときだけ）";
  weekPlan.appendChild(weekTitle);
  weekPlan.appendChild($("next-plan-card"));
  stages[2].appendChild(weekPlan);
  weekly=node("details","np-flow-fold np-flow-weekly","np-flow-weekly");
  const weekSummary=node("summary","");
  weekSummary.id="np-flow-weekly-label";
  weekSummary.textContent="週の振り返り（週の締め日に記入）";
  weekly.appendChild(weekSummary);
  weekly.appendChild($("wk-card"));
  stages[3].insertBefore(weekly,stages[3].firstChild);
  const gate=$("np-schedule-gate");
  if(gate)stages[3].insertBefore(gate,weekly); // blocking instructions stay with report submission
  const goalMessage=node("div","np-flow-empty","np-flow-goal-status");
  stages[0].appendChild(goalMessage);
  const progressMessage=node("div","np-flow-empty","np-flow-midday-status");
  stages[1].appendChild(progressMessage);
  // All long-form historical/secondary content is initially collapsed.
  extras=node("details","np-flow-fold np-flow-extra","np-flow-extra");
  const summary=node("summary","");
  summary.textContent="その他の情報（今月の振り返り・提出状況・過去の日報）";
  extras.appendChild(summary);
  ["month-card","growth-card"].map($).filter(Boolean).forEach(el=>extras.appendChild(el));
  for(const id of ["team","past"]){
    const element=$(id)?.closest(".card");if(element)extras.appendChild(element);
  }
  stages[3].after(extras);
  root.addEventListener("click",ev=>{
    const btn=ev.target.closest("[data-np-flow-step]");
    if(btn)choose(Number(btn.dataset.npFlowStep),true);
  });
  render();
 }
 function choose(n,user=false){
  if(!steps.some(s=>s.n===n))return;
  begin();
  selected=n;
  if(user)manual=true;
  render();
  // This is a flow change, not a submission. Nothing is persisted here.
  if(user){
    const id=n===4&&snap.closing&&!snap.closingFilled?"np-flow-weekly":"np-flow";
    $(id)?.scrollIntoView?.({behavior:"smooth",block:"start"});
  }
 }
 function chooseDefault(v){
  if(v.submitted)return 4;
  if(v.closing&&!v.closingFilled)return 4; // required weekly review
  if(!v.morningStarted)return 1;
  if(v.middayAvailable)return 2;
  if(v.focusCount||v.scheduleReady)return 3;
  return 2;
 }
 function sync(v={}){
  begin();
  if(v.date&&lastDate!==v.date){
    lastDate=v.date;manual=false;selected=1;
    weekPlan?.removeAttribute("open");
    extras?.removeAttribute("open");
  }
  snap={...snap,...v};loaded=Boolean(snap.date);
  if(!manual)selected=chooseDefault(snap);
  const todayGoal=$("np-flow-goal-status");
  if(todayGoal){
    const card=$("am-card");
    const absent=card?.classList.contains("hidden");
    todayGoal.hidden=!absent;
    if(absent)todayGoal.textContent=snap.morningStarted?
      "今日のゴールは登録済みです。"+(snap.goalLine?" 完了条件："+snap.goalLine:" 日報で実際の成果を確認できます。"):
      "この日付の朝のゴール入力はありません。今日の記録は日付を戻して確認してください。";
  }
  const middayInfo=$("np-flow-midday-status");
  if(middayInfo){
    middayInfo.hidden=!!snap.middayAvailable;
    middayInfo.textContent=snap.submitted?
      "日報は提出済みです。午後の途中確認は任意なので、未実施を未達とは扱いません。":
      snap.morningStarted?
        "途中確認は11〜16時の間に表示します。今は目標を確認し、必要なら次の「明日の準備」に進んでください。":
        "まず①のゴールを設定してください。途中確認は任意で、日報の提出条件ではありません。";
  }
  if(weekly){
    const show=!!(snap.closing||snap.closingFilled);
    weekly.hidden=!show;
    if(snap.closing&&!snap.closingFilled)weekly.open=true;
    const text=snap.closing&&!snap.closingFilled?
      "今日の提出前に必要：週次振り返りを記入・保存する":
      snap.closingFilled?"週次振り返りは保存済み（必要なら開いて確認）":"週の振り返り";
    if($("np-flow-weekly-label"))$("np-flow-weekly-label").textContent=text;
  }
  render();
 }
 function states(){
  return [
    {state:snap.morningStarted?"done":"todo",message:snap.morningStarted?"設定済":"今日の目標を確認"},
    {state:snap.submitted?"done":snap.middayAvailable?"current":"optional",message:snap.submitted?"日報で確認済":"任意・30秒確認"},
    {state:snap.focusConfirmed?"done":snap.focusCount?"current":"todo",
      message:snap.focusConfirmed?"確定済":snap.focusCount?"候補 "+snap.focusCount+"件":"タスクを選ぶ"},
    {state:snap.submitted?"done":snap.scheduleReady?"current":"blocked",
      message:snap.submitted?"提出済":snap.scheduleReady?"入力・提出へ":"翌日の予定を確認"},
  ];
 }
 const instructions={
  1:"今日のゴールと完了条件を確認し、AI提案が必要なら「AIにゴールを聞く」を押してください。",
  2:"14時ごろに、朝の目標・残りの仕事・午後の最優先を30秒で確認します。入力は任意です。",
  3:"明日の重要タスク（最大3件）を選び、必要に応じて下の「今週の予定」を開きます。",
  4:"今日の成果・改善・明日の最優先を日報に記入し、画面内の［日報を提出］を押します。",
 };
 function render(){
  if(!root)return;
  const current=states();
  stages.forEach((s,i)=>{s.hidden=i+1!==selected;s.classList.toggle("is-current",i+1===selected)});
   const summary=$("np-flow-summary");
  if(summary)summary.textContent=snap.submitted?"日報提出済":"ステップ "+selected+" / 4";
  const track=$("np-flow-track");
  if(track)track.innerHTML=steps.map((s,i)=>{
    const c=current[i],active=s.n===selected;
    const cls=c.state==="done"?" done":c.state==="blocked"?" blocked":c.state==="optional"?" optional":"";
    return '<button type="button" class="np-flow-step'+cls+(active?" current":"")+
      '" data-np-flow-step="'+s.n+'" aria-current="'+(active?"step":"false")+'">'+
      '<span class="np-flow-num">'+(c.state==="done"?"✓":s.n)+'</span>'+
      '<span class="np-flow-label"><b>'+info(s.title)+'</b><small>'+info(c.message)+'</small></span></button>';
  }).join("");
  const msg=$("np-flow-message");
  if(msg){
    let alert="";
    if(selected===4&&snap.closing&&!snap.closingFilled)
      alert="今週の最終勤務日です。まず「週次振り返り」を保存してから日報を提出してください。";
    else if(selected===4&&!snap.scheduleReady&&!snap.submitted)
      alert="翌営業日の仕事予定が未登録または未確認です。上の予定登録案内を確認してください。入力した内容は保持されます。";
    else if(selected===1&&snap.submitted)
      alert="この日の提出は完了しています。記録を確認できます。";
    msg.textContent=alert||instructions[selected];
    msg.classList.toggle("warn",Boolean(alert));
  }
 }
 function step(){return selected}
 function refresh(){render()}
 function showWeekPlan(){choose(3,true);if(weekPlan)weekPlan.open=true;weekPlan?.scrollIntoView?.({behavior:"smooth",block:"start"});}
 function showWeekly(){choose(4,true);if(weekly)weekly.open=true;weekly?.scrollIntoView?.({behavior:"smooth",block:"start"});}
 window.NippoFlow={init:begin,sync,choose,step,refresh,showWeekPlan,showWeekly};
})();
