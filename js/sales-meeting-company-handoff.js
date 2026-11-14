// Sales company portal guidance in STEP 1 and STEP 4.
// Initial issuance and password rotation both require an explicit user action.
(()=>{
 const params=new URLSearchParams(location.search);
 const companyId=params.get("companyId"),sessionId=params.get("sessionId");
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(companyId||"")||!uuid.test(sessionId||""))return;
 const by=id=>document.getElementById(id);
 const hint=by("meeting-company-login-hint"),companyNo=by("meeting-company-login-id");
 const open=by("meeting-company-open"),copy=by("meeting-company-copy");
 const issue=by("meeting-company-issue"),reset=by("meeting-company-reset"),secretPanel=by("meeting-company-one-time-password");
 const secretValue=by("meeting-company-one-time-value"),secretCopy=by("meeting-company-password-copy");
 if(!hint||!companyNo||!open||!copy||!issue||!reset||!secretPanel||!secretValue||!secretCopy)return;
 let portalUrl=null,portalState=null,activeStage=0,issueBusy=false,secretTimer=null;
 function clearSecret(){
  if(secretTimer)clearTimeout(secretTimer);
  secretTimer=null;secretValue.textContent="";secretPanel.hidden=true;
  syncIssue();
 }
 function syncIssue(){
  const members=Array.isArray(portalState?.members)?portalState.members:[];
  const active=members.filter(m=>m.status==="active"&&!m.disabledAt&&m.id);
  const canIssue=(activeStage===0||activeStage===3)&&!issueBusy&&portalState?.canIssue===true;
  // Never expose old passwords. Reset is explicit and supported only for
  // exactly one active company portal member.
  issue.disabled=!canIssue||members.length>0;
  issue.textContent=members.length?"発行済み（既存パスワードは表示できません）":"企業ID・初回仮パスワードを発行";
  reset.hidden=!(members.length===1&&active.length===1);
  reset.disabled=!canIssue||reset.hidden||!secretPanel.hidden;
 }
 function safeUrl(value){
  try{const u=new URL(value);if(u.protocol!=="https:"||!['enger.jp','www.enger.jp'].includes(u.hostname)||
    u.pathname!=="/business/login"||u.username||u.password)return null;
   u.search="";u.searchParams.set("next","/business/offers?companyId="+encodeURIComponent(companyId));return u.href;
  }catch{return null;}
 }
 async function reload(){
  const state=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
  portalState=state;
  const members=Array.isArray(state?.members)?state.members.filter(m=>m.status==="active"):[];
  companyNo.textContent=members.length>1?"担当者メール":String(state?.portal?.displayId||"—");
  portalUrl=safeUrl(state?.portal?.loginUrl);
  open.hidden=!portalUrl;copy.disabled=!portalUrl;if(portalUrl)open.href=portalUrl;
  if(members.length===1){
   const recipient=by("meeting-recipient"),contact=by("meeting-contact");
   if(recipient&&!recipient.value&&members[0].email)recipient.value=String(members[0].email);
   if(contact&&!contact.value&&members[0].displayName)contact.value=String(members[0].displayName);
  }
  hint.textContent=members.length>1?
   "複数の担当者がいます。企業IDではなく各担当者のメールアドレスでログインしてください。":"企業ログインIDを案内できます。既存のパスワードは表示できません。必要な場合のみ下の再発行を選んでください。";
  if(Array.isArray(state?.members)&&state.members.length&&state.members.some(m=>m.status!=="active"))
   hint.textContent="既存の招待・停止中アカウントがあります。重複発行せず、Sales管理者が状態を確認してください。";
  syncIssue();
 }
 open.addEventListener("click",event=>{
  if(!portalUrl)return;
  const child=window.open(portalUrl,"enger_business_"+sessionId,"width=1160,height=830");
  if(child){event.preventDefault();try{child.focus();}catch{}}
 });
 copy.addEventListener("click",async()=>{
  if(!portalUrl)return;
  try{await navigator.clipboard.writeText(portalUrl);hint.textContent="企業専用ログインURLをコピーしました。";}
  catch{hint.textContent="URLをコピーできませんでした。リンクを開いて確認してください。";}
 });
 issue.addEventListener("click",async()=>{
  if(![0,3].includes(activeStage)||issueBusy)return;
  if(!portalState)try{await reload();}catch(e){hint.textContent=e?.hint||e?.message||"企業ログイン情報を取得できませんでした。";return;}
  const members=Array.isArray(portalState?.members)?portalState.members:[];
  if(members.length){hint.textContent="既存アカウントを確認しました。パスワードの再表示・変更は行いません。";syncIssue();return;}
  if(portalState?.canIssue!==true){hint.textContent="Sales権限の確認が必要です。ログインし直してください。";return;}
  if(!confirm("企業IDと初回の仮パスワードを発行します。仮パスワードはこのSales画面に2分間だけ表示し、自動メール送信しません。発行後は再表示できません。実行しますか？"))return;
  issueBusy=true;syncIssue();clearSecret();
  try{
   const result=await API.api("/api/sales/company-portal",{method:"POST",body:{companyId,action:"ensure_meeting_account",confirmed:true}});
   if(result?.temporaryPassword){
    secretValue.textContent="初回仮パスワード："+result.temporaryPassword;
    secretPanel.hidden=false;
    secretTimer=setTimeout(clearSecret,120000);
   }
   await reload();
   hint.textContent=result?.temporaryPassword?
    "初回発行しました。表示中の仮パスワードを本人へ安全に共有してください。2分後に消去します。":"既存アカウントの状態を確認しました。パスワードの再表示・変更は行いません。";
  }catch(e){hint.textContent=e?.hint||e?.message||"初回ログインを発行できませんでした。Salesで状態を確認してください。";}
  finally{issueBusy=false;syncIssue();}
 });
 // Explicit password rotation: the old value is never fetched or shown.
 // The same scoped Sales API already implements a confirmation and 10-minute
 // rate limit. Only the newly generated password is visible for two minutes.
 reset.addEventListener("click",async()=>{
  if(![0,3].includes(activeStage)||issueBusy)return;
  if(!portalState)try{await reload();}catch(e){hint.textContent=e?.hint||e?.message||"企業ログイン情報を確認できませんでした。";return;}
  const members=Array.isArray(portalState?.members)?portalState.members:[];
  const active=members.filter(m=>m.status==="active"&&!m.disabledAt&&m.id);
  if(members.length!==1||active.length!==1||portalState?.canIssue!==true){
   hint.textContent="再発行できる企業アカウントを確認できません。企業管理画面で状態を確認してください。";
   syncIssue();return;
  }
  if(!confirm("この企業の現在のパスワードを無効にし、8文字の新しいパスワードを発行します。既存パスワードではログインできなくなります。新しいパスワードはこの画面に2分間だけ表示します。実行しますか？"))return;
  issueBusy=true;syncIssue();clearSecret();
  try{
   const result=await API.api("/api/sales/company-portal",{
    method:"POST",body:{companyId,action:"generate_password",memberId:active[0].id,confirmed:true}
   });
   if(result?.temporaryPassword){
    secretValue.textContent="再発行した仮パスワード："+result.temporaryPassword;
    secretPanel.hidden=false;
    secretCopy.textContent="新しいパスワードをコピー";
    secretTimer=setTimeout(clearSecret,120000);
   }
   await reload();
   hint.textContent=result?.temporaryPassword?
    "新しいパスワードを発行しました。旧パスワードは失効しています。表示中に企業担当者本人へ安全に共有してください。2分後に消えます。":
    "再発行結果を表示できませんでした。パスワードは再表示できないため、管理者へ確認してください。";
  }catch(e){hint.textContent=e?.hint||e?.message||"再発行できませんでした。権限・企業アカウントの状態を確認してください。";}
  finally{issueBusy=false;syncIssue();}
 });
 secretCopy.addEventListener("click",async()=>{
  const password=secretValue.textContent.replace(/^(初回仮パスワード|再発行した仮パスワード)：/,"");
  if(!password||secretPanel.hidden)return;
  try{await navigator.clipboard.writeText(password);secretCopy.textContent="コピーしました";}
  catch{secretCopy.textContent="コピーできませんでした";}
 });
 document.addEventListener("sales:meeting-step",event=>{
  const nextStage=Number(event.detail?.stage);
  // A newly-issued secret is never retained when navigating to a different step.
  if(nextStage!==activeStage)clearSecret();
  activeStage=nextStage;
  syncIssue();
 });
 window.addEventListener("pagehide",clearSecret,{once:true});
 void reload().catch(err=>{hint.textContent=err?.hint||err?.message||"企業ログイン情報を取得できませんでした。";});
})();

