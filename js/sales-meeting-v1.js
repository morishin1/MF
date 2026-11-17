// Three visible sections; legacy six-step sessions keep their original navigator.
(()=>{
 const query=new URLSearchParams(location.search);
 if(query.get('flow')!=='v1')return;
 const companyId=query.get('companyId'),sessionId=query.get('sessionId');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(companyId||'')||!uuid.test(sessionId||''))return;
 const by=id=>document.getElementById(id),host=by('meeting-v1'),stages=[0,1,5];
 if(!host)return;
 const nav=by('meeting-stages'),back=by('meeting-back'),next=by('meeting-forward');
 const status=by('meeting-live-status'),mailStatus=by('meeting-mail-status');
 let current=null,busy=false,polling=false,loadedStage=null,offers=0,dirty=false,mailSent=false;
 let draftLoaded=false,draftDirty=false,draftSequence=0,mailConfigured=false,accountReady=false,historyBlocked=false;
 const setStatus=text=>{status.textContent=text;};
 const nodes=['meeting-eight-intro','meeting-company-handoff'];
 for(const id of nodes){by('meeting-v1-intro').append(by(id));by(id).hidden=false;}
 by('meeting-v1-confirm').append(by('meeting-offer-result'),by('meeting-closeout'));
 by('meeting-closeout').hidden=false;by('meeting-v1-mail-settings').hidden=false;
 by('meeting-step-description').hidden=true;by('meeting-proposals').hidden=true;
 host.hidden=false;nav.hidden=false;by('meeting-navigation').hidden=false;
 by('meeting-closeout').querySelector('h2').textContent='お礼と次回対応';
 by('meeting-outcome-label').parentElement.hidden=true;
 by('meeting-thank-you-copy').readOnly=false;
 by('meeting-thank-you-copy').required=true;
 by('meeting-thank-you-copy').maxLength=12000;
 by('meeting-thank-you-copy').parentElement.firstChild.textContent='お礼文（編集して送信・コピーできます）';
 by('meeting-company-offer-note').textContent='企業マイページから送信されたオファーを確認します。';
 by('meeting-offer-result').querySelector('p').textContent='商談結果と次回対応を確認してください。';
 by('meeting-send').textContent='確認したお礼文を送信して完了';
 const titles=['会社説明・企業ページ案内','目的・条件の確認','商談結果・お礼'];
 const fieldIds=['meeting-material-url','meeting-dispatch-permit','meeting-commercial-flow',
  'meeting-support-fee','meeting-v1-problem','meeting-v1-budget','meeting-v1-start'];
 const errorText=e=>e?.hint||e?.message||'保存できませんでした。入力内容を確認してください。';
 const defaultActions={offer:'面談候補日を確認する',reproposal:'条件に合う候補を追加で提案する',
  considering:'検討状況を確認する',declined:'見送りの結果を記録する'};
 const signal=()=>document.dispatchEvent(new CustomEvent('sales:meeting-step',{detail:{stage:current.stage,sessionId}}));
 function clearConfirmation(){by('meeting-mail-confirm').checked=false;updateSend();}
 function updateSend(){by('meeting-send').disabled=busy||mailSent||!current||current.stage!==5||
  current.status!=='active'||!by('meeting-mail-confirm').checked||!draftLoaded||!mailConfigured||!accountReady||historyBlocked;}
 function restore(){
  const details=current.stepDetails?.['0']||{};
  const fields={materialUrl:'meeting-material-url',dispatchPermit:'meeting-dispatch-permit',
   commercialFlow:'meeting-commercial-flow',supportFee:'meeting-support-fee',problem:'meeting-v1-problem',
   budget:'meeting-v1-budget',start:'meeting-v1-start'};
  for(const [key,id]of Object.entries(fields))by(id).value=details[key]||(['dispatchPermit','commercialFlow','supportFee'].includes(key)?'unknown':'');
  for(const input of document.querySelectorAll('[data-contact-method]'))input.checked=(details.contactMethods||[]).includes(input.dataset.contactMethod);
  for(const input of host.querySelectorAll('[data-v1-check]'))input.checked=current.stepChecks?.[input.dataset.stage]?.values?.[input.dataset.v1Check]===true;
  by('meeting-v1-note').value=current.staffNotes?.['0']||'';
  by('meeting-v1-purpose').value=current.staffNotes?.['1']||'';
  for(const step of [0,1])by('meeting-v1-skip-'+step).value=current.stepChecks?.[String(step)]?.skipReason||'';
  if(current.closeout?.outcome)by('meeting-step5-outcome').value=current.closeout.outcome;
  if(current.closeout?.nextAction)by('meeting-next-action').value=current.closeout.nextAction;
  if(current.closeout?.nextDue)by('meeting-next-due').value=current.closeout.nextDue;
 }
 function paint(){
  if(!current)return;
  const index=stages.indexOf(current.stage);
  nav.replaceChildren(...titles.map((title,i)=>{
   const button=document.createElement('button');button.type='button';
   button.textContent=(i+1)+' / 3 '+title+(i<2?' →':'');button.className='meeting-stage'+(i===index?' active':'');
   button.setAttribute('aria-current',i===index?'step':'false');button.disabled=true;return button;
  }));
  for(let i=0;i<3;i++)by('meeting-v1-pane-'+i).hidden=i!==index;
  by('meeting-offer-result').hidden=index!==2;
  if(loadedStage!==current.stage){if(!dirty)restore();loadedStage=current.stage;clearConfirmation();signal();}
  by('meeting-company-offer-count').textContent=offers?'企業からのオファー '+offers+'件を受信':'オファーはまだ届いていません';
  const offered=by('meeting-step5-outcome').querySelector('[value="offer"]');offered.disabled=offers===0;
  if(!offers&&by('meeting-step5-outcome').value==='offer'){by('meeting-step5-outcome').value='';clearConfirmation();}
  back.disabled=busy||current.status!=='active'||index===0;
  next.disabled=busy||current.status!=='active'||index===2;next.hidden=index===2;
  next.textContent=index===0?'目的・条件の確認へ →':'商談結果・お礼へ →';
  for(const button of host.querySelectorAll('[data-v1-save]'))button.disabled=busy||current.status!=='active';
  by('meeting-v1-save-state').textContent=dirty?'未保存の変更があります':'入力内容は保存済みです';
  updateSend();
 }
 async function refresh(){
  if(busy||polling)return;polling=true;
  try{
   const result=await API.api('/api/sales/meeting-session?'+new URLSearchParams({companyId,sessionId}));
   if(result.session?.stepDetails?.layout!=='compact_v1'){
    const old=new URL(location.href);old.searchParams.delete('flow');location.replace(old.href);return;
   }
   if(current&&dirty&&result.session.version!==current.version){
    setStatus('ほかの担当者が更新しています。入力内容は保持しています。保存前に最新の記録を確認してください。');return;
   }
   current=result.session;offers=Number(result.companyOfferCount)||0;
   if(!dirty&&loadedStage===current.stage)restore();paint();
   const elapsed=Math.max(0,Math.floor((Date.now()-new Date(current.startedAt||Date.now()).getTime())/1000));
   const left=Math.max(0,1800-elapsed);by('meeting-timer').textContent=String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0');
   if(current.stage===5&&!draftLoaded&&!draftDirty)await loadDraft();
  }catch(e){setStatus(errorText(e));}finally{polling=false;}
 }
 function checks(step){
  const values={};for(const input of host.querySelectorAll('[data-v1-check][data-stage="'+step+'"]'))values[input.dataset.v1Check]=input.checked;
  return {values,skipReason:by('meeting-v1-skip-'+step).value.trim()};
 }
 async function save(){
  if(!current||![0,1].includes(current.stage))return;
  const step=current.stage;
  const details={materialUrl:by('meeting-material-url').value.trim(),dispatchPermit:by('meeting-dispatch-permit').value,
   commercialFlow:by('meeting-commercial-flow').value,supportFee:by('meeting-support-fee').value,
   contactMethods:Array.from(document.querySelectorAll('[data-contact-method]:checked')).map(x=>x.dataset.contactMethod),
   problem:by('meeting-v1-problem').value.trim(),budget:by('meeting-v1-budget').value.trim(),start:by('meeting-v1-start').value.trim()};
  const result=await API.api('/api/sales/meeting-session',{method:'PATCH',body:{companyId,sessionId,
   action:'save_step',stage:step,version:current.version,checks:checks(step),
   note:by(step===0?'meeting-v1-note':'meeting-v1-purpose').value,...(step===0?{details}:{})}});
  current=result.session;dirty=false;paint();
 }
 async function move(delta){
  if(busy||!current||current.status!=='active')return;
  busy=true;paint();try{
   if(current.stage!==5)await save();
   const target=stages[stages.indexOf(current.stage)+delta];
   const result=await API.api('/api/sales/meeting-session',{method:'PATCH',body:{companyId,sessionId,
    action:'compact_stage',stage:target,version:current.version}});
   current=result.session;dirty=false;paint();setStatus('入力内容を保存して次の画面へ進みました。');
   if(current.stage===5&&!draftLoaded)await loadDraft();
  }catch(e){setStatus(errorText(e));}finally{busy=false;paint();}
 }
 async function loadDraft(force=false){
  const sequence=++draftSequence;
  try{
   const result=await API.api('/api/sales/meeting-closeout?'+new URLSearchParams({companyId,sessionId,email:by('meeting-recipient').value.trim()}));
   if(sequence!==draftSequence)return;
   mailConfigured=result.mailConfigured===true;accountReady=result.draft?.accountReady===true;
   by('meeting-v1-mail-from').textContent=result.mailFrom||'its@gw.8grp.co.jp';
   historyBlocked=Boolean(result.closeout);
   if(result.closeout){mailSent=result.closeout.status==='sent';mailStatus.textContent=mailSent?'案内メールは送信済みです。': '送信履歴があります。再送せず担当者に確認してください。';}
   else mailStatus.textContent=accountReady?(mailConfigured?'宛先と編集した本文を確認して送信してください。':'送信設定の確認が必要です。お礼文をコピーできます。'):'会社説明の画面で企業ログインを発行・確認してください。';
   if(result.draft&&(!draftDirty||force)){
    by('meeting-v1-subject').value=result.draft.subject;
    let text=result.draft.text.replace('ご提案した候補：0件','ご提案した候補：'+offers+'件');
    if(by('meeting-next-action').value.trim())text=text.replace('次回の対応をご案内します',by('meeting-next-action').value.trim());
    by('meeting-thank-you-copy').value=text;draftLoaded=true;draftDirty=false;
   }
   clearConfirmation();updateSend();
  }catch(e){mailStatus.textContent=errorText(e);draftLoaded=false;clearConfirmation();}
 }
 host.addEventListener('input',event=>{
  if(current?.stage!==5){dirty=true;by('meeting-v1-save-state').textContent='未保存の変更があります';}
  if(['meeting-v1-subject','meeting-thank-you-copy'].includes(event.target.id))draftDirty=true;
  if(event.target.id==='meeting-next-action'&&draftLoaded&&!draftDirty)
   by('meeting-thank-you-copy').value=by('meeting-thank-you-copy').value.replace(/^次回のご案内：.*$/m,'次回のご案内：'+event.target.value.trim());
  if(event.target.id!=='meeting-mail-confirm')clearConfirmation();
 });
 by('meeting-step5-outcome').addEventListener('change',()=>{
  by('meeting-outcome').value=by('meeting-step5-outcome').value;
  if(!by('meeting-next-action').value)by('meeting-next-action').value=defaultActions[by('meeting-step5-outcome').value]||'';
  clearConfirmation();
 });
 by('meeting-recipient').addEventListener('change',()=>{draftLoaded=false;void loadDraft();});
 by('meeting-v1-reset-draft').addEventListener('click',()=>{
  if(!draftDirty||confirm('編集したお礼文を定型文に戻しますか？'))void loadDraft(true);
 });
 for(const button of host.querySelectorAll('[data-v1-save]'))button.addEventListener('click',async()=>{
  if(busy)return;busy=true;try{await save();setStatus('確認事項と商談メモを保存しました。');}
  catch(e){setStatus(errorText(e));}finally{busy=false;paint();}
 });
 back.addEventListener('click',()=>void move(-1));next.addEventListener('click',()=>void move(1));
 by('meeting-mail-confirm').addEventListener('change',updateSend);
 by('meeting-copy-thank-you').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText('件名：'+by('meeting-v1-subject').value+'\n\n'+by('meeting-thank-you-copy').value);mailStatus.textContent='編集したお礼文をコピーしました。';}
  catch{mailStatus.textContent='コピーできませんでした。本文を選択してコピーしてください。';}
 });
 by('meeting-send').addEventListener('click',async()=>{
  if(by('meeting-send').disabled||busy||!by('meeting-closeout-form').reportValidity())return;
  const payload={companyId,sessionId,confirmed:true,email:by('meeting-recipient').value.trim(),
   contactName:by('meeting-contact').value.trim(),outcome:by('meeting-step5-outcome').value,
   nextAction:by('meeting-next-action').value.trim(),nextDue:by('meeting-next-due').value||null,
   offeredKeys:[],mailSubject:by('meeting-v1-subject').value,mailText:by('meeting-thank-you-copy').value};
  if(!payload.outcome){mailStatus.textContent='商談結果を選んでください。';return;}
  if(!confirm(payload.email+' に、画面で確認した件名とお礼文を送信しますか？'))return;
  busy=true;updateSend();mailStatus.textContent='送信結果を確認しています…';
  try{
   const result=await API.api('/api/sales/meeting-closeout',{method:'POST',body:payload});
   if(!result.mailSent&&!result.alreadySent)throw Error('送信完了を確認できませんでした。再送せず履歴を確認してください。');
   mailSent=true;current={...current,status:'closed'};paint();
   mailStatus.textContent='お礼文を送信し、商談結果と次回対応を保存しました。';setStatus('商談完了（送信済み）');
  }catch(e){mailStatus.textContent=errorText(e);clearConfirmation();}
  finally{busy=false;updateSend();}
 });
 window.addEventListener('beforeunload',event=>{if(dirty||draftDirty&&!mailSent){event.preventDefault();event.returnValue='';}});
 void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},5000);
 window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
})();
