// STEP1 company portal guidance. First login creation is explicit and one-time.
(()=>{
 const params=new URLSearchParams(location.search);
 const companyId=params.get("companyId"),sessionId=params.get("sessionId");
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(companyId||"")||!uuid.test(sessionId||""))return;
 const by=id=>document.getElementById(id);
 const hint=by("meeting-company-login-hint"),companyNo=by("meeting-company-login-id");
 const open=by("meeting-company-open"),copy=by("meeting-company-copy");
 const issue=by("meeting-company-issue"),secretPanel=by("meeting-company-one-time-password");
 const reset=by("meeting-company-password-reset");
 const secretValue=by("meeting-company-one-time-value"),secretCopy=by("meeting-company-password-copy");
 if(!hint||!companyNo||!open||!copy||!issue||!reset||!secretPanel||!secretValue||!secretCopy)return;
 let portalUrl=null,portalState=null,activeStage=0,issueBusy=false,secretTimer=null;
 function clearSecret(){
  if(secretTimer)clearTimeout(secretTimer);
  secretTimer=null;secretValue.textContent="";secretPanel.hidden=true;
  secretCopy.textContent="表示中のパスワードをコピー";
 }
 function showSecret(password){
  if(typeof password!=="string"||!password)return;
  secretValue.textContent="発行した仮パスワード："+password;
  secretPanel.hidden=false;
  secretTimer=setTimeout(clearSecret,120000);
 }
 function syncIssue(){
  const members=Array.isArray(portalState?.members)?portalState.members:[];
  issue.disabled=activeStage!==0||issueBusy||!portalState||portalState.canIssue!==true||members.length>0;
  issue.textContent=members.length?"発行済み":"企業ID・初回仮パスワードを発行";
  const active=members.filter(member=>member.status==="active");
  const handoffVisible=activeStage===0||activeStage===3;
  const demoEmail=/^company-demo\+[0-9a-f]{32}@gw\.8grp\.co\.jp$/i;
  const unsupportedDemo=active.length===1&&demoEmail.test(String(active[0].email||""))&&
   (portalState?.previewDemoAllowed!==true||members.length!==1);
  reset.hidden=!handoffVisible||active.length!==1||portalState?.canIssue!==true||unsupportedDemo;
  reset.disabled=issueBusy||!portalState||portalState.canIssue!==true;
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
   "複数の担当者がいます。企業IDではなく各担当者のメールアドレスでログインしてください。":"ログインIDと企業専用ページをご案内できます。既存パスワードは確認できません。必要な場合は新しいものを発行できます。";
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
  if(activeStage!==0||issueBusy)return;
  if(!portalState)try{await reload();}catch(e){hint.textContent=e?.hint||e?.message||"企業ログイン情報を取得できませんでした。";return;}
  const members=Array.isArray(portalState?.members)?portalState.members:[];
  if(members.length){hint.textContent="企業ログインは発行済みです。既存パスワードが分からない場合は、下のボタンから新しいものを発行できます。";syncIssue();return;}
  if(portalState?.canIssue!==true){hint.textContent="Sales権限の確認が必要です。ログインし直してください。";return;}
  if(!confirm("企業IDと初回の仮パスワードを発行します。仮パスワードはこのSales画面に2分間表示します。自動メール送信はしません。実行しますか？"))return;
  issueBusy=true;syncIssue();clearSecret();
  try{
   const result=await API.api("/api/sales/company-portal",{method:"POST",body:{companyId,action:"ensure_meeting_account",confirmed:true}});
   if(result?.temporaryPassword)showSecret(result.temporaryPassword);
   await reload();
   hint.textContent=result?.temporaryPassword?
    "初回発行しました。表示中の仮パスワードを本人へ安全に共有してください。2分後に消去します。":"既存アカウントの状態を確認しました。";
  }catch(e){hint.textContent=e?.hint||e?.message||"初回ログインを発行できませんでした。Salesで状態を確認してください。";}
  finally{issueBusy=false;syncIssue();}
 });
 reset.addEventListener("click",async()=>{
  if((activeStage!==0&&activeStage!==3)||issueBusy)return;
  const active=Array.isArray(portalState?.members)?portalState.members.filter(member=>member.status==="active"):[];
  if(active.length!==1||portalState?.canIssue!==true)return;
  const member=active[0];
  const isPreviewDemo=portalState.previewDemoAllowed===true&&
   /^company-demo\+[0-9a-f]{32}@gw\.8grp\.co\.jp$/i.test(String(member.email||""));
  const action=isPreviewDemo?"rotate_meeting_demo_password":"generate_password";
  const target=isPreviewDemo?"プレビュー専用のテストアカウント":String(member.email||"この企業アカウント");
  if(!confirm(target+"のパスワードを新しく発行します。現在のパスワードはすぐに使えなくなります。新しいパスワードはこの画面に2分間表示し、自動メール送信はしません。実行しますか？"))return;
  issueBusy=true;syncIssue();clearSecret();
  try{
   const body={companyId,action,confirmed:true};
   if(action==="generate_password")body.memberId=member.id;
   const result=await API.api("/api/sales/company-portal",{method:"POST",body});
   if(result?.temporaryPassword)showSecret(result.temporaryPassword);
   await reload();
   hint.textContent=result?.temporaryPassword?
    "新しいパスワードを発行しました。表示中のパスワードを本人へ安全に共有してください。2分後に消去します。":"パスワードを発行できませんでした。対象アカウントの状態を確認してください。";
  }catch(e){hint.textContent=e?.hint||e?.message||"パスワードを再発行できませんでした。";}
  finally{issueBusy=false;syncIssue();}
 });
 secretCopy.addEventListener("click",async()=>{
  const password=secretValue.textContent.replace(/^発行した仮パスワード：/,"");
  if(!password||secretPanel.hidden)return;
  try{await navigator.clipboard.writeText(password);secretCopy.textContent="コピーしました";}
  catch{secretCopy.textContent="コピーできませんでした";}
 });
 document.addEventListener("sales:meeting-step",event=>{
  activeStage=Number(event.detail?.stage);
  if(activeStage!==0&&activeStage!==3)clearSecret();
  syncIssue();
 });
 window.addEventListener("pagehide",clearSecret,{once:true});
 void reload().catch(err=>{hint.textContent=err?.hint||err?.message||"企業ログイン情報を取得できませんでした。";});
})();

