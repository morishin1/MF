// ENGER Sales 30-minute navigator: 6 steps with scoped persistence.
// Coaching text and checked questions are staff-only. Corporate users read
// only the public proposals and current stage from their own authenticated page.
const STEPS=[
 {name:"会社概要",min:4,title:"会社概要",goal:"エイトとENGERの価値を4分以内で共有する",
  talk:"株式会社エイトはAI・DX開発とIT人材のマッチングを行っています。ENGERでは開発課題に合う人材・案件をご紹介します。本日は30分で御社の状況を伺い、候補を一緒に確認できればと思います。",
  questions:["弊社の支援範囲はイメージいただけましたか？"],
  checks:[["intro","エイトとENGERの概要を説明した"],["agenda","30分の進め方を共有した"]]},
 {name:"目的確認",min:2,title:"今回の商談目的",goal:"何を決める30分なのか合意する",
  talk:"今日は何が決まれば良かったと思えるお時間になりますか？ 今回は人材の採用、案件の受発注、情報交換のどれが最も近いでしょうか。",
  questions:["今回の最優先テーマは何ですか？","意思決定に関わる方はどなたですか？"],
  checks:[["purpose","商談目的を確認した"],["decision","決裁・相談の流れを確認した"]]},
 {name:"課題確認",min:7,title:"現状の課題と希望条件",goal:"求める条件・予算・開始時期を具体化する",
  talk:"現在の開発や人材の課題について、優先順位の高いものを教えてください。開始時期・必要スキル・ご予算も確認させてください。",
  questions:["今もっとも困っていることは何ですか？","求めるスキル・人数・役割は？","月額予算と開始時期の目安は？"],
  checks:[["problem","必要な人材・案件と条件を把握した"],["budget","予算・単価を確認した"],["start","開始時期を確認した"]]},
 {name:"候補提案",min:10,title:"人材・案件をご紹介",goal:"条件の合う候補を見せて反応を確認する",
  talk:"公開可能な候補から、御社の課題に近い人材・案件をご紹介します。スキルシートや稼働条件はご関心があるものを中心に確認しましょう。",
  questions:["最も関心がある候補はどれですか？","スキルや条件に不足はありませんか？"],
  checks:[["candidate","候補・公開スキル情報を説明した"],["conditions","希望条件との一致・相違を確認した"]]},
 {name:"オファー",min:4,title:"面談・オファーの意思確認",goal:"候補の面談希望または再提案条件を決める",
  talk:"ご関心のある候補にチェックを入れましょう。面談の希望があれば次の確認に進めます。該当がなければ、次に提案すべき条件を教えてください。",
  questions:["面談してみたい候補はありますか？","希望日程や追加条件はありますか？"],
  checks:[["interest","面談・オファー希望を確認した"],["nextstep","次の候補提案または面談調整を決めた"]]},
 {name:"クロージング",min:3,title:"企業専用ページと次回対応",goal:"宛先確認・案内メール送信・Salesへの次回アクション記録",
  talk:"本日はありがとうございました。ご提案内容は企業専用ページから確認でき、御社の案件や所属人材も登録できます。最後にご案内先と次回対応を確認させてください。",
  questions:["ご案内先のメールアドレスを教えていただけますか？","次回はいつ、何を確認しましょうか？"],
  checks:[]}
];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qs=new URLSearchParams(location.search);
const companyId=qs.get("companyId"),sessionId=qs.get("sessionId");
if(UUID.test(companyId||"")&&UUID.test(sessionId||"")){
 const by=id=>document.getElementById(id);
 const stages=by("meeting-stages"),panel=by("meeting-step-description"),proposals=by("meeting-proposals");
 const back=by("meeting-back"),next=by("meeting-forward"),status=by("meeting-live-status");
 const checksHost=by("meeting-step-checks"),notes=by("meeting-step-note"),skip=by("meeting-step-skip");
 const closing=by("meeting-closeout"),timer=by("meeting-timer"),stepClock=by("meeting-step-time");
 stages.hidden=false;panel.hidden=false;by("meeting-navigation").hidden=false;
 const route="/api/sales/meeting-session";
 let current=null,busy=false,previewStage=null,startedAt=null,mailSent=false;
 let lastRenderedStage=-1;
 const totalMin=STEPS.reduce((a,s)=>a+s.min,0);
 const entry=STEPS.reduce((a,s)=>{a.push((a.at(-1)||0)+s.min);return a;},[]);
 const clean=s=>String(s||"").trim();
 const label=(tag,t)=>{const x=document.createElement(tag);x.textContent=t;return x;};
 function renderCheckFields(stage){
  checksHost.replaceChildren();
  const cfg=STEPS[stage];
  const saved=current?.stepChecks?.[String(stage)]?.values||{};
  for(const [key,text] of cfg.checks){
   const item=document.createElement("label"),input=document.createElement("input");
   input.type="checkbox";input.dataset.checkKey=key;input.checked=saved[key]===true;
   item.append(input,label("span",text));checksHost.append(item);
  }
  notes.value=current?.staffNotes?.[String(stage)]||"";
  skip.value=current?.stepChecks?.[String(stage)]?.skipReason||"";
  by("meeting-step-skip-label").hidden=stage===5;
  checksHost.hidden=stage===5;
 }
 function paint(s){
  if(!s)return;
  current=s;
  if(!startedAt)startedAt=Date.parse(s.startedAt)||Date.now();
  const viewed=previewStage===null?s.stage:previewStage;
  stages.replaceChildren();
  STEPS.forEach((step,i)=>{
   const btn=document.createElement("button");btn.type="button";
   btn.textContent=(i<s.stage?"✓ ":"")+(i+1)+"/6 "+step.name+" "+step.min+"分";
   btn.className="meeting-stage"+(i===viewed?" active":i<s.stage?" completed":"");
   btn.dataset.step=String(i);
   btn.setAttribute("aria-current",i===s.stage?"step":"false");
   btn.disabled=busy||s.status!=="active";
   btn.addEventListener("click",()=>{
     if(busy)return;
     previewStage=i===s.stage?null:i;lastRenderedStage=-1;paint(current);
   });
   stages.append(btn);
  });
  const step=STEPS[viewed],offset=viewed===0?0:entry[viewed-1];
  by("meeting-step-title").textContent="STEP "+(viewed+1)+" / 6 ・ "+step.title;
  by("meeting-step-copy").textContent=step.talk;
  by("meeting-step-goal").textContent=step.goal;
  by("meeting-step-questions").replaceChildren(...step.questions.map(q=>label("li",q)));
  stepClock.textContent=offset+"〜"+(offset+step.min)+"分（目安 "+step.min+"分）";
  if(lastRenderedStage!==viewed){renderCheckFields(viewed);lastRenderedStage=viewed;}
  const summary=by("meeting-company-summary");
  if(summary)summary.hidden=viewed!==0;
  const intro=by("meeting-eight-intro");
  if(intro)intro.hidden=viewed!==0;
  // Only show candidate cards during presentation, offers or closing.
  proposals.hidden=viewed!==3&&viewed!==4&&viewed!==5;
  closing.hidden=viewed!==5;
  by("meeting-step-guide").hidden=viewed===5;
  back.disabled=busy||s.status!=="active"||s.stage===0;
  next.disabled=busy||s.status!=="active"||s.stage===5;
  by("meeting-step-save").disabled=busy||s.status!=="active"||viewed!==s.stage;
  const preview=viewed!==s.stage;
  status.textContent=s.status==="closed"?"商談完了（保存済み）":
    preview?"別のステップをプレビューしています。操作は現在のステップに戻って行います。":
    "現在：STEP "+(s.stage+1)+" / 6。内容を確認したらチェックを保存して進んでください。";
  by("meeting-step-preview").hidden=!preview;
  next.textContent=s.stage===4?"クロージングへ":s.stage===5?"メール送信で完了":"次のステップへ";
  tick();
 }
 function tick(){
  if(!current||!timer)return;
  const elapsed=Math.max(0,Math.floor((Date.now()-startedAt)/1000));
  const remaining=Math.max(0,totalMin*60-elapsed),m=Math.floor(remaining/60),sec=remaining%60;
  timer.textContent=String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0");
  timer.dataset.over=elapsed>totalMin*60?"true":"false";
  const prev=current.stage===0?0:entry[current.stage-1];
  if(elapsed>(prev+STEPS[current.stage].min)*60)
   timer.title="このステップの時間目安を超えています。";
  else timer.title="残り時間です（30分の目安）。";
 }
 async function refresh(){
  try{
   const r=await API.api(route+"?"+new URLSearchParams({companyId,sessionId}));
   if(!busy&&r.session)paint(r.session);
  }catch(e){status.textContent=e?.hint||e?.message||"商談状態を確認できません。";}
 }
 function checksInput(){
  const values={};
  for(const input of checksHost.querySelectorAll("[data-check-key]"))
   values[input.dataset.checkKey]=input.checked;
  return {values,skipReason:clean(skip.value)};
 }
 async function saveStep(){
  if(!current||previewStage!==null)return false;
  const saved=await API.api(route,{method:"PATCH",body:{
   companyId,sessionId,action:"save_step",stage:current.stage,
   checks:checksInput(),note:notes.value,version:current.version
  }});
  current=saved.session;return true;
 }
 async function changeStage(delta){
  if(!current||busy||current.status!=="active"||previewStage!==null)return;
  const to=current.stage+delta;if(to<0||to>5)return;
  busy=true;paint(current);
  try{
   if(delta>0)await saveStep();
   else if(delta<0)await saveStep();
   const r=await API.api(route,{method:"PATCH",body:{
    companyId,sessionId,stage:to,version:current.version
   }});
   previewStage=null;lastRenderedStage=-1;current=r.session;paint(current);
  }catch(e){
   status.textContent=e?.hint||e?.message||"進行を更新できませんでした。";
   await refresh();
  }finally{busy=false;paint(current);}
 }
 back.addEventListener("click",()=>void changeStage(-1));
 next.addEventListener("click",()=>void changeStage(1));
 by("meeting-step-save").addEventListener("click",async()=>{
  if(busy||previewStage!==null)return;
  busy=true;
  try{
   await saveStep();
   status.textContent="チェックとメモを保存しました。";
  }catch(e){status.textContent=e?.hint||e?.message||"保存できませんでした。";}
  finally{busy=false;paint(current);}
 });
 by("meeting-send").addEventListener("click",async()=>{
  if(busy||mailSent||!current||current.stage!==5)return;
  const form=by("meeting-closeout-form");
  if(!form.reportValidity())return;
  const selected=Array.from(document.querySelectorAll("[data-offer-key]:checked")).map(x=>x.dataset.offerKey);
  const payload={
   companyId,sessionId,confirmed:true,
   email:by("meeting-recipient").value.trim(),
   contactName:by("meeting-contact").value.trim(),
   outcome:by("meeting-outcome").value,
   nextAction:by("meeting-next-action").value.trim(),
   nextDue:by("meeting-next-due").value||null,offeredKeys:selected
  };
  if(!confirm(payload.email+" に企業専用ページ・ログイン情報・今回の提案を送信しますか？"))return;
  busy=true;by("meeting-send").disabled=true;
  const mailNote=by("meeting-mail-status");
  mailNote.textContent="企業アカウント・公開候補を確認して案内メールを送信しています…";
  try{
   const response=await API.api("/api/sales/meeting-closeout",{method:"POST",body:payload});
   if(!response?.mailSent)throw Error("送信完了を確認できませんでした。");
   mailSent=true;
   mailNote.textContent="案内メールを送信し、商談結果と次回対応をSalesへ保存しました。";
   const creds=by("meeting-one-time-credentials");
   creds.replaceChildren(label("strong","企業ログインID："+response.loginId),
     label("span","企業専用ページ："+response.loginUrl));
   if(response.oneTimePassword){
    const once=label("span","初回パスワード："+response.oneTimePassword);creds.append(once);
    window.setTimeout(()=>once.remove(),120000);
   }
   creds.hidden=false;
   await refresh();
  }catch(e){mailNote.textContent=e?.hint||e?.message||"送信できませんでした。Salesで再確認してください。";}
  finally{busy=false;by("meeting-send").disabled=mailSent;}
 });
 refresh();
 const polling=setInterval(()=>{tick();if(!document.hidden&&!busy)void refresh();},3000);
 const clock=setInterval(tick,1000);
 window.addEventListener("pagehide",()=>{clearInterval(polling);clearInterval(clock);},{once:true});
}
