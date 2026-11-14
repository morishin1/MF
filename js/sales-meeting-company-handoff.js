// ENGER Sales meeting: scoped enterprise login handoff.
// A password is only displayed on initial issue or explicit, audited rotation.
// Never obtain a stored password, and never put a password in an URL or email.
(()=>{
 const params=new URLSearchParams(location.search);
 const companyId=params.get("companyId"),sessionId=params.get("sessionId");
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(companyId||"")||!uuid.test(sessionId||""))return;
 const by=id=>document.getElementById(id);
 const hint=by("meeting-company-login-hint"),companyNo=by("meeting-company-login-id");
 const open=by("meeting-company-open"),copy=by("meeting-company-copy");
 const issue=by("meeting-company-issue"),secretPanel=by("meeting-company-one-time-password");
 const secretValue=by("meeting-company-one-time-value"),secretCopy=by("meeting-company-password-copy");
 const memberPicker=by("meeting-company-member-picker"),memberSelect=by("meeting-company-member");
 const forgot=by("meeting-company-forgot");
 if(!hint||!companyNo||!open||!copy||!issue||!secretPanel||!secretValue||!secretCopy||
   !memberPicker||!memberSelect||!forgot)return;

 let portalUrl=null,portalState=null,activeStage=0,issueBusy=false,secretTimer=null;
 function clearSecret(){
  if(secretTimer)clearTimeout(secretTimer);
  secretTimer=null;secretValue.textContent="";secretPanel.hidden=true;
  secretCopy.textContent="仮パスワードをコピー";
 }
 const activeMembers=()=>Array.isArray(portalState?.members)?
   portalState.members.filter(m=>m.status==="active"):[];
 function selectedMember(){
  const members=activeMembers();
  return members.find(m=>m.id===memberSelect.value)||members[0]||null;
 }
 function syncIssue(){
  const members=Array.isArray(portalState?.members)?portalState.members:[];
  const active=activeMembers();
  const allowedStage=activeStage===0||activeStage===3;
  const permitted=portalState?.canIssue===true;
  issue.textContent=members.length===0?"企業ID・初回仮パスワードを発行":
    active.length?"パスワードを再発行":"ログイン状態を確認してください";
  issue.disabled=!allowedStage||issueBusy||!permitted||(members.length>0&&!active.length);
  memberPicker.hidden=active.length<=1;
  // No alternate account or own-company lookup may be used as a reset target.
  const m=selectedMember();
  const hasVerifiedEmail=Boolean(m&&!m.idOnly&&typeof m.email==="string"&&m.email.includes("@"));
  forgot.hidden=!hasVerifiedEmail;
  if(hasVerifiedEmail){
    const u=new URL("/business/forgot","https://enger.jp");
    u.searchParams.set("email",m.email);
    forgot.href=u.href;
  }
 }
 function safeUrl(value){
  try{const u=new URL(value);if(u.protocol!=="https:"||!["enger.jp","www.enger.jp"].includes(u.hostname)||
    u.pathname!=="/business/login"||u.username||u.password)return null;
   u.search="";u.searchParams.set("next","/business/offers?companyId="+encodeURIComponent(companyId));return u.href;
  }catch{return null;}
 }
 async function reload(){
  const state=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
  portalState=state;
  const members=activeMembers();
  const previousSelection=memberSelect.value;
  memberSelect.replaceChildren();
  for(const m of members){
    const option=document.createElement("option");option.value=m.id;
    option.textContent=m.idOnly?"企業ID専用（"+String(state?.portal?.displayId||"—")+"）":
      (m.displayName||"企業担当者")+"／"+m.email;
    memberSelect.append(option);
  }
  if(members.some(m=>m.id===previousSelection))memberSelect.value=previousSelection;
  companyNo.textContent=members.length>1?"担当者ごとのメール":String(state?.portal?.displayId||"—");
  portalUrl=safeUrl(state?.portal?.loginUrl);
  open.hidden=!portalUrl;copy.disabled=!portalUrl;if(portalUrl)open.href=portalUrl;
  if(members.length===1){
   const recipient=by("meeting-recipient"),contact=by("meeting-contact");
   // Never place the system-owned company-ID login alias in a customer email field.
   if(recipient&&!recipient.value&&!members[0].idOnly&&members[0].email)recipient.value=String(members[0].email);
   if(contact&&!contact.value&&members[0].displayName&&!members[0].idOnly)
     contact.value=String(members[0].displayName);
  }
  hint.textContent=members.length>1?
    "担当者ごとにメールアドレスでログインします。パスワードが不明な場合は担当者を選んで再発行できます。":
    members.length===1?
      "発行済みのパスワードは確認できません。必要な場合のみ、本人の了承を得て新しい仮パスワードを再発行できます。":
      "未発行です。初回ログインを発行すると、仮パスワードが2分間だけ表示されます。";
  if(Array.isArray(state?.members)&&state.members.length&&state.members.some(m=>m.status!=="active"))
    hint.textContent="招待待ち・停止中のアカウントがあります。再発行前にSales企業詳細で利用状態を確認してください。";
  syncIssue();
 }
 memberSelect.addEventListener("change",syncIssue);
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
  if(portalState?.canIssue!==true){hint.textContent="Salesの操作権限を確認できません。ログインし直してください。";return;}
  const members=Array.isArray(portalState.members)?portalState.members:[];
  const reset=members.length>0;
  const target=selectedMember();
  if(reset&&!target){hint.textContent="有効なアカウントがありません。Sales企業詳細で状態を確認してください。";return;}
  if(reset&&!uuid.test(target.id)){hint.textContent="再発行先を確認できません。";return;}
  if(!confirm(reset?
    "既存のパスワードを無効にし、新しい8文字の仮パスワードを発行します。企業担当者の了承を確認しましたか？\n\n発行後は2分間だけ表示され、自動メール送信はしません。":
    "企業IDと初回の仮パスワードを発行します。仮パスワードはこのSales画面に2分間だけ表示し、自動メール送信しません。実行しますか？"))return;
  issueBusy=true;syncIssue();clearSecret();
  try{
    const body=reset?{companyId,action:"generate_password",memberId:target.id,confirmed:true}:
      {companyId,action:"ensure_meeting_account",confirmed:true};
    const result=await API.api("/api/sales/company-portal",{method:"POST",body});
    if(result?.oneTime&&typeof result.temporaryPassword==="string"){
      secretValue.textContent=(reset?"再発行した":"初回")+"仮パスワード："+result.temporaryPassword;
      secretPanel.hidden=false;secretTimer=setTimeout(clearSecret,120000);
    }
    await reload();
    hint.textContent=result?.temporaryPassword?
      "仮パスワードを発行しました。表示中のパスワードを本人に安全に共有してください。2分後に消去します。":
      result?.hint||"アカウントの状態を確認しました。";
  }catch(e){hint.textContent=e?.hint||e?.message||"パスワードを発行できませんでした。Sales企業詳細で確認してください。";}
  finally{issueBusy=false;syncIssue();}
 });
 secretCopy.addEventListener("click",async()=>{
  const password=secretValue.textContent.replace(/^(?:初回|再発行した)仮パスワード：/,"");
  if(!password||secretPanel.hidden)return;
  try{await navigator.clipboard.writeText(password);secretCopy.textContent="コピーしました";}
  catch{secretCopy.textContent="コピーできませんでした";}
 });
 document.addEventListener("sales:meeting-step",event=>{
  const stage=Number(event.detail?.stage);
  if(!Number.isInteger(stage))return;
  if(activeStage!==stage&&stage!==0&&stage!==3)clearSecret();
  activeStage=stage;syncIssue();
 });
 window.addEventListener("pagehide",clearSecret,{once:true});
 void reload().catch(err=>{hint.textContent=err?.hint||err?.message||"企業ログイン情報を取得できませんでした。";});
})();
