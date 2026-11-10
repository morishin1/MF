// ENGER Sales 30-minute navigator: 6 steps with scoped persistence.
// Coaching text and checked questions are staff-only. Corporate users read
// only the public proposals and current stage from their own authenticated page.
const STEPS=[
 {name:"アイスブレーク",min:2,title:"ご挨拶・今日の進め方",goal:"安心して話せる雰囲気をつくり30分の流れを共有",
  talk:"本日はお時間をいただきありがとうございます。まず御社の近況を少し伺い、今日は30分で課題を整理します。後半は御社専用ページで候補をご覧いただき、次のアクションまで決めましょう。",
  questions:["最近の事業や開発案件の状況はいかがでしょうか？","今日、特に確認しておきたいことは何ですか？"],
  checks:[["intro","挨拶・近況確認をした"],["agenda","30分の進め方を共有した"]]},
 {name:"会社概要",min:4,title:"エイト・ENGERのご紹介",goal:"エイトの支援内容とENGERの仕組みを簡潔に伝える",
  talk:"エイトはAI・DX開発、IT人材・案件のマッチング、実践型教育を行っています。ENGERは企業の案件と所属要員をつなぎます。御社の条件に合う候補を専用ページで探し、気になるものをその場でオファーできます。",
  questions:["人材のご提案と案件のご紹介、どちらに関心がありますか？","本日の進め方でよろしいでしょうか？"],
  checks:[["purpose","エイト・ENGERの概要を説明した"],["decision","商談で確認したい目的に合意した"]]},
 {name:"課題・目的確認",min:7,title:"必要な人材・案件と条件を確認",goal:"必要スキル・単価・稼働時期と優先事項を明確にする",
  talk:"今優先している案件・要員を教えてください。職種、必須スキル、稼働時期、勤務形態、予算を確認します。この条件をもとに専用ページで探します。",
  questions:["最優先の案件または要員は何ですか？","必須スキル・人数・予算・開始時期は？","優先順位の高い条件は？"],
  checks:[["problem","必要な人材・案件と条件を把握した"],["budget","予算・単価を確認した"],["start","開始時期を確認した"]]},
 {name:"企業ページで候補検索",min:10,title:"企業専用ページへ切り替えて候補提案",goal:"企業IDとログイン方法を確認し企業自身に検索・候補閲覧してもらう",
  talk:"ここからは御社専用ページをご案内します。画面に表示されるURLと企業IDでログインいただき、公開承認済みの人材・案件から職種やスキルで検索できます。パスワードが未発行の場合は、御社担当者のメールを確認したうえで発行します。",
  questions:["企業専用ページにログインできましたか？","検索結果は御社の希望条件に近いですか？"],
  checks:[["candidate","企業専用ページで候補を表示・案内した"],["conditions","希望条件との一致・相違を確認した"]]},
 {name:"オファー確認",min:4,title:"候補の選択・オファー確認",goal:"企業側で候補を選び、マッチング希望と次の対応を決める",
  talk:"ご関心のある候補があれば御社の画面で選んでください。案件と要員の紐づけ・条件を確認し、オファーを送信するとエイトへ届きます。合う候補がなければ追加条件を伺って再提案します。",
  questions:["候補の中で面談・相談したい案件や要員はありますか？","不足スキルや追加条件はありますか？"],
  checks:[["interest","面談・オファー希望を確認した"],["nextstep","次の候補提案または面談調整を決めた"]]},
 {name:"クロージング",min:3,title:"次回アクション・お礼",goal:"商談結果と連絡方法を記録し次の対応を確定する",
  talk:"本日はありがとうございました。候補は御社専用ページから引き続きご覧いただけます。今後は普段のメールで案件・人材情報を送っていただければ、エイトが確認して次の候補をご案内します。次回の対応日を確認させてください。",
  questions:["次回はいつ何を確認しましょうか？","ご案内先のメールアドレスはどちらですか？"],
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
   btn.textContent=(i<s.stage?"✓ ":"")+(i+1)+". "+step.name+" "+step.min+"分";
   btn.className="meeting-stage"+(i===viewed?" active":i<s.stage?" completed":"");
   btn.dataset.step=String(i);
   btn.setAttribute("aria-current",i===s.stage?"step":"false");
   btn.disabled=busy||s.status!=="active";
   btn.addEventListener("click",()=>{
     if(busy)return;
     previewStage=i===s.stage?null:i;lastRenderedStage=-1;paint(current);
   });
   stages.append(btn);
   if(i<STEPS.length-1){
     const arrow=label("span","→");arrow.className="meeting-stage-arrow";
     arrow.setAttribute("aria-hidden","true");stages.append(arrow);
   }
  });
  const step=STEPS[viewed],offset=viewed===0?0:entry[viewed-1];
  by("meeting-step-title").textContent="STEP "+(viewed+1)+" / "+STEPS.length+" ・ "+step.title;
  by("meeting-step-copy").textContent=step.talk;
  by("meeting-step-goal").textContent=step.goal;
  by("meeting-step-questions").replaceChildren(...step.questions.map(q=>label("li",q)));
  stepClock.textContent=offset+"〜"+(offset+step.min)+"分（目安 "+step.min+"分）";
  if(lastRenderedStage!==viewed){renderCheckFields(viewed);lastRenderedStage=viewed;}
  const summary=by("meeting-company-summary");
  if(summary)summary.hidden=viewed!==1;
  const intro=by("meeting-eight-intro");
  if(intro)intro.hidden=viewed!==1;
  // Candidate cards live exclusively on the authenticated business page.
  proposals.hidden=true;
  const handoff=by("meeting-business-handoff");
  if(handoff)handoff.hidden=viewed!==3&&viewed!==4;
  if(handoff&&!handoff.hidden)void loadCompanyHandoff();
  closing.hidden=viewed!==5;
  by("meeting-step-guide").hidden=viewed===5;
  back.disabled=busy||s.status!=="active"||s.stage===0;
  next.disabled=busy||s.status!=="active"||s.stage===5;
  by("meeting-step-save").disabled=busy||s.status!=="active"||viewed!==s.stage;
  const preview=viewed!==s.stage;
  status.textContent=s.status==="closed"?"商談完了（保存済み）":
    preview?"別のステップをプレビューしています。操作は現在のステップに戻って行います。":
    "現在：STEP "+(s.stage+1)+" / "+STEPS.length+"。内容を確認したらチェックを保存して進んでください。";
  by("meeting-step-preview").hidden=!preview;
  next.textContent=s.stage===3?"オファー確認へ":s.stage===4?"クロージングへ":s.stage===5?"案内送信で完了":"次のステップへ";
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
