// The four-stage employee workflow for /nippo.html (presentation only).
// All existing APIs, schedule gate, report save, and weekly closing rules remain unchanged.
(function(){
 "use strict";
 const steps=[
  {n:1,key:"outcomes",title:"今日の成果",sub:"実績・完了条件"},
  {n:2,key:"review",title:"振り返り",sub:"成長・困りごと"},
  {n:3,key:"tomorrow",title:"明日のゴール",sub:"タスクと予定からAI提案"},
  {n:4,key:"report",title:"日報を提出",sub:"本人が確認して完了"},
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
      .np-flow-date{display:flex;gap:6px;align-items:center;font-size:11px;color:#65738a;flex-wrap:wrap}
      .np-flow-date input{font:inherit;padding:5px 7px;border:1px solid #cad3df;border-radius:7px;max-width:160px}
      .np-flow-next{display:flex;justify-content:flex-end;align-items:center;margin:10px 0 0;gap:10px;flex-wrap:wrap}
      .np-flow-next button{font:inherit;font-size:13px;font-weight:700;padding:10px 17px;border:0;border-radius:9px;background:#235c9b;color:white;cursor:pointer}
      .np-flow-next button:hover{background:#164b82}
      .np-flow-next button:focus-visible{outline:3px solid #8fb5df;outline-offset:3px}
      .np-flow-next button[aria-disabled="true"]{background:#e3e8ef;color:#62748a}
      .np-flow-progress-msg{font-size:12px;color:#9d5920;line-height:1.6;margin:6px 0}
      .np-flow-step.locked{opacity:.68;background:#f4f5f6;border-style:dashed}
      .np-flow-step.optional{border-color:#edcf94;background:#fff9ee}
      .np-flow-note{padding:10px 13px;border:1px solid #ead4a2;border-radius:9px;background:#fffaf0;font-size:12px;line-height:1.6;color:#775321;margin:10px 0}
      .np-flow-track{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:12px 0 10px}
      .np-flow-step{font:inherit;border:1px solid #d7dfe8;background:#f9fafb;border-radius:9px;padding:10px;
        display:flex;align-items:center;text-align:left;gap:9px;min-width:0;cursor:pointer;color:#354965}
      .np-flow-step:hover{background:#f1f6fd;border-color:#8da7c9}
      .np-flow-step:focus-visible{outline:2px solid #2e69b8;outline-offset:2px}
      .np-flow-step.current{border-color:#2e68a7;background:#eaf3ff;box-shadow:inset 0 -2px #2e68a7}
      .np-flow-step.done{background:#f2faf5;border-color:#a3cdb0}
      .np-flow-step.done .np-flow-num{background:#367e58;color:#fff;border-color:#367e58}
      .np-flow-step.blocked{border-color:#e6c898;background:#fff9f0}
      .np-flow-step.locked{background:#f4f5f6;color:#7b8695;border-style:dashed}
      .np-flow-step.locked .np-flow-num{background:#f4f5f6;color:#8a94a0}
      .np-goal-form{padding:13px 15px;border:1px solid #dbe4ef;border-radius:10px;background:#fff;margin:0 0 10px}
      .np-goal-form h3{font-size:15px;margin:0 0 5px}
      .np-goal-form label{display:block;font-size:12px;font-weight:700;color:#3e526d;margin:10px 0 3px}
      .np-goal-form input{box-sizing:border-box;width:100%;max-width:100%;padding:10px;border:1px solid #c7d2df;
        border-radius:7px;font:inherit;font-size:13px}
      .np-goal-form .btn{margin-top:9px}
      .np-goal-banner{border:1px solid #ecd19f;background:#fff9ee;border-radius:8px;padding:9px 11px;
        font-size:12px;line-height:1.65;color:#735422;margin:8px 0}
      .np-goal-banner.ok{border-color:#a5d0b9;background:#eff8f1;color:#2b6948}
      .np-goal-actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
      .np-goal-draft{background:#f6faff;border:1px solid #d5e2f2;padding:11px;border-radius:8px;
        font-size:12.5px;line-height:1.75;margin:10px 0}
      .np-goal-draft p{margin:4px 0}
      .np-goal-note{font-size:11.5px;color:#65758b;line-height:1.6;margin-top:5px}
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
  root.innerHTML='<div class="np-flow-top"><div><strong>日報から次の勤務日へ</strong><p>今日を振り返り、明日のゴールを決めて仕事を終えます。</p></div>'+
    '<div class="np-flow-date"><label for="np-flow-date">日報の日付</label>'+
    '<input type="date" id="np-flow-date" aria-label="日報の日付" onchange="selectGateReportDate(this.value)">'+
    '<span id="np-flow-summary" class="np-flow-summary" role="status">読み込み中</span></div></div>'+
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
  // Keep input nodes and their handlers intact: relocate the existing field sections.
  // The report's readForm()/fillForm() both use element IDs and continue to work.
  const moveField=(id,stage)=>{
    const element=$(id);
    const block=element?.classList?.contains("np-sec")?element:element?.closest?.(".np-sec");
    if(block)stages[stage].appendChild(block);
  };
  for(const id of ["todo-sec","f-kpi-sec","f-work","f-met-sec"])moveField(id,0);
  for(const id of ["f-wins","f-consult","f-improve"])moveField(id,1);
  const todaySummary=node("div","np-flow-empty","np-flow-today-summary");
  stages[0].insertBefore(todaySummary,stages[0].firstChild);
  const goalForm=node("div","np-goal-form","np-flow-goal-form");
  stages[2].appendChild(goalForm);
  const goalMessage=node("div","np-flow-empty","np-flow-goal-status");
  stages[2].appendChild(goalMessage);
  const oldMorning=node("details","np-flow-fold","np-flow-old-morning");
  const oldTitle=node("summary","");
  oldTitle.textContent="朝の詳細入力・予定案を確認する（任意）";
  oldMorning.appendChild(oldTitle);
  if($("am-card"))oldMorning.appendChild($("am-card"));
  stages[0].appendChild(oldMorning);
  const progressMessage=node("div","np-flow-empty","np-flow-midday-status");
  stages[1].insertBefore(progressMessage,stages[1].firstChild);
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
  for(const [index,label] of [[0,"次へ：振り返り"],[1,"次へ：明日のゴール"],[2,"次へ：提出前の確認"]]){
    const area=node("div","np-flow-next");
    const btn=node("button","");
    btn.type="button";btn.textContent=label;
    btn.dataset.npFlowNext=String(index+2);
    area.appendChild(btn);
    stages[index].appendChild(area);
  }
  root.addEventListener("click",ev=>{
    const btn=ev.target.closest("[data-np-flow-step]");
    if(btn)choose(Number(btn.dataset.npFlowStep),true);
    const next=ev.target.closest("[data-np-flow-next]");
    if(next)choose(Number(next.dataset.npFlowNext),true);
  });
  root.parentElement?.addEventListener("input",ev=>{
    if(ev.target.closest?.(".np-flow-stage"))refresh();
  });
  root.parentElement?.addEventListener("change",ev=>{
    if(ev.target.closest?.(".np-flow-stage"))refresh();
  });
  render();
 }
 function readiness(){
   try {return window.NippoFlowReadiness?.()||{outcome:false,reflection:false};}
   catch{return {outcome:false,reflection:false};}
 }
 function choose(n,user=false){
  if(!steps.some(s=>s.n===n))return;
  begin();
  const status=readiness();
  const lockedOutcome=n>1&&!snap.submitted&&!status.outcome;
  const lockedReflection=n>2&&!snap.submitted&&!status.reflection;
  if(lockedOutcome||lockedReflection){
    selected=lockedOutcome?1:2;manual=true;
    render();
    const note=$("np-flow-message");
    if(note){
      note.textContent=lockedOutcome?
        "まず①今日の日報を書いてください。仕事の結果を「できた／できなかった」で確認してから次へ進めます。":
        "②振り返りに、今日の学び・改善点やできたことを1つ入力してください。";
      note.classList.add("warn");
    }
    $("np-flow-stage-"+selected)?.scrollIntoView?.({behavior:"smooth",block:"start"});
    return;
  }
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
  return v.submitted?4:1;
 }
 function sync(v={}){
  begin();
  if(v.date&&lastDate!==v.date){
    lastDate=v.date;manual=false;selected=1;
    weekPlan?.removeAttribute("open");
    extras?.removeAttribute("open");
  }
  snap={...snap,...v};loaded=Boolean(snap.date);
  const datePicker=$("np-flow-date");
  if(datePicker&&snap.date){datePicker.value=snap.date;datePicker.max=new Date(Date.now()+9*3600000).toISOString().slice(0,10);}
  if(!manual)selected=chooseDefault(snap);
  // The user can review their accomplishments before confirming tomorrow's goal.
  const todayBox=$("np-flow-today-summary");
  if(todayBox){
    todayBox.innerHTML=snap.todayGoal?
      "<b>前日に確定した今日のゴール</b><div>"+info(snap.todayGoal.goalText||"")+
      "</div><div>完了条件："+info(snap.todayGoal.doneWhen||"")+"</div>"+
      (snap.todayGoal.timing==="late"?"<small>後から確定した記録</small>":""):
      "<b>今日のゴールの記録</b><div>前日に確定した記録はありません。今日実施した仕事と成果を確認してください。</div>";
  }
  const tomorrowBox=$("np-flow-goal-status");
  if(tomorrowBox){
    tomorrowBox.hidden=Boolean(snap.goalConfirmed);
    tomorrowBox.textContent=snap.goalConfirmed?"":
      "明日のゴールは未設定です。AI提案・手入力で確定することをおすすめしますが、未設定でも提出できます。";
  }
  const middayInfo=$("np-flow-midday-status");
  if(middayInfo){
    middayInfo.hidden=!!snap.middayAvailable;
    middayInfo.textContent=snap.submitted?
      "本日の日報は提出済みです。改善点と、次の勤務日に活かすことを確認できます。":
      "できるようになったこと、困ったこと、改善したことを振り返ります。入力は必要な箇所だけで構いません。";
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
 function states(r){
  return [
    {state:r.outcome?"done":"todo",message:r.outcome?"入力済":"まず日報を書く"},
    {state:r.reflection?"done":"todo",message:r.reflection?"入力済":"振り返りを書く"},
    {state:snap.goalConfirmed?"done":"optional",
      message:snap.goalConfirmed?"本人が確定済":"未設定でも提出可"},
    {state:snap.submitted?"done":snap.goalConfirmed?"current":"optional",
      message:snap.submitted?"提出済":snap.goalConfirmed?"最終確認へ":"未設定の警告あり"},
  ];
 }
 const instructions={
  1:"今日のタスクやKPIの実績を確認し、できたこと・できなかった理由を記入します。",
  2:"できるようになったこと、困りごと、次に変えることを振り返ります。",
  3:"AIがタスク・予定・週目標から明日のゴールを提案します。本人の確定を推奨しますが、未設定でも日報は提出できます。",
  4:"今日の日報と振り返りを確認し、［日報を提出］を押します。明日のゴール未設定なら提出前に確認します。",
 };
 function render(){
  if(!root)return;
  const ready=readiness();
  const current=states(ready);
  stages.forEach((s,i)=>{s.hidden=i+1!==selected;s.classList.toggle("is-current",i+1===selected)});
  for(const [index,canProceed] of [[0,ready.outcome],[1,ready.outcome&&ready.reflection],[2,ready.outcome&&ready.reflection]]){
    const btn=stages[index]?.querySelector?.("[data-np-flow-next]");
    if(btn)btn.setAttribute("aria-disabled",(!canProceed&&!snap.submitted)?"true":"false");
  }
   const summary=$("np-flow-summary");
  if(summary)summary.textContent=snap.submitted?"日報提出済":"ステップ "+selected+" / 4";
  const track=$("np-flow-track");
  if(track)track.innerHTML=steps.map((s,i)=>{
    const c=current[i],active=s.n===selected;
    const cls=c.state==="done"?" done":c.state==="blocked"?" blocked":c.state==="optional"?" optional":"";
    const navLocked=!snap.submitted&&(s.n>1&&!ready.outcome||s.n>2&&!ready.reflection);
    return '<button type="button" class="np-flow-step'+cls+
      (navLocked?" locked":"")+(active?" current":"")+
      '" data-np-flow-step="'+s.n+'" aria-current="'+(active?"step":"false")+
      '" aria-disabled="'+(navLocked?'true':'false')+'">'+
      '<span class="np-flow-num">'+(c.state==="done"?"✓":s.n)+'</span>'+
      '<span class="np-flow-label"><b>'+info(s.title)+'</b><small>'+info(c.message)+'</small></span></button>';
  }).join("");
  const msg=$("np-flow-message");
  if(msg){
    let alert="";
    if(selected===4&&snap.closing&&!snap.closingFilled)
      alert="今週の最終勤務日です。まず「週次振り返り」を保存してから日報を提出してください。";
    else if(selected===4&&!snap.goalConfirmed&&!snap.submitted)
      alert="明日のゴールは未設定です。提出はできますが、明日の行動を明確にするため設定をおすすめします。";
    else if(selected===4&&!snap.scheduleReady&&!snap.submitted)
      alert="翌営業日の仕事予定が未登録または未確認です。上の予定登録案内を確認してください。入力した内容は保持されます。";
    else if(selected===1&&snap.submitted)
      alert="この日の日報は提出済みです。記録を確認できます。";
    msg.textContent=alert||instructions[selected];
    msg.classList.toggle("warn",Boolean(alert));
  }
 }
 function step(){return selected}
 function refresh(){render()}
 function maySubmit(){
    const r=readiness();
    if(snap.submitted)return true;
    return !!(r.outcome&&r.reflection);
 }
 function showWeekPlan(){choose(3,true);if(weekPlan)weekPlan.open=true;weekPlan?.scrollIntoView?.({behavior:"smooth",block:"start"});}
 function showWeekly(){choose(4,true);if(weekly)weekly.open=true;weekly?.scrollIntoView?.({behavior:"smooth",block:"start"});}
 window.NippoFlow={init:begin,sync,choose,step,refresh,maySubmit,showWeekPlan,showWeekly};
})();
