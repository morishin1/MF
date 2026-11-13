// Staff-only transition from 30-minute Sales navigator to ENGER company portal.
// Never places plaintext passwords in URLs, persistent storage, or the DOM after 2 minutes.
(()=>{
 const params=new URLSearchParams(location.search);
 const companyId=params.get("companyId"),sessionId=params.get("sessionId");
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(companyId||"")||!uuid.test(sessionId||""))return;
 const by=id=>document.getElementById(id);
 const hint=by("meeting-company-login-hint"),issue=by("meeting-company-issue");
 const reset=by("meeting-company-reset"),password=by("meeting-company-password");
 const companyNo=by("meeting-company-login-id"),open=by("meeting-company-open"),copy=by("meeting-company-copy");
 if(!hint||!issue||!reset||!password||!companyNo||!open||!copy)return;
 let activeMember=null,memberCount=0,contactReady=false,canIssue=false,busy=false,autoAttempted=false;
 let oneTimeTimer=null,portalUrl=null,feedback="";
 const fail=message=>{feedback=String(message||"企業ログインを確認できません").slice(0,220);hint.textContent=feedback;};
 function eraseSecret(){
  if(oneTimeTimer)clearTimeout(oneTimeTimer);
  oneTimeTimer=null;password.textContent=activeMember?"設定済み（再表示不可）":"未発行";
 }
 function showSecret(temporary){
  if(typeof temporary!=="string"||temporary.length!==8)return;
  if(oneTimeTimer)clearTimeout(oneTimeTimer);
  password.textContent=temporary;
  oneTimeTimer=setTimeout(eraseSecret,120000);
 }
 function companyLoginUrl(base){
  try{
   const u=new URL(base);
   if(u.protocol!=="https:"||!["enger.jp","www.enger.jp"].includes(u.hostname)||
      u.pathname!=="/business/login"||u.username||u.password)return null;
   u.search="";
   u.searchParams.set("next","/business/meeting?companyId="+encodeURIComponent(companyId)+"&session="+encodeURIComponent(sessionId));
   return u.href;
  }catch{return null;}
 }
 function paint(){
  issue.hidden=Boolean(memberCount);
  issue.disabled=busy||!canIssue||memberCount>0;
  reset.hidden=!activeMember||!canIssue;
  reset.disabled=busy||!activeMember;
  copy.disabled=!portalUrl;
  open.hidden=!portalUrl;
  if(portalUrl)open.href=portalUrl;
  if(feedback){hint.textContent=feedback;return;}
  if(busy)hint.textContent="企業ID・初回パスワードの発行状態を確認しています…";
  else if(memberCount>0&&!activeMember)hint.textContent="招待中・停止中のアカウントがあります。既存の登録状態を確認してください。";
  else if(activeMember)hint.textContent="発行済みです。現在のパスワードは再表示できません。必要な場合だけ再発行してください。";
  else if(canIssue)hint.textContent=contactReady?
    "企業担当者へ8文字の初回パスワードを発行できます。":
    "担当者名・メール未登録でも、企業IDと8文字パスワードを発行できます。";
  else hint.textContent="発行権限または企業の登録状況を確認できません。";
 }
 async function reload(){
  const state=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
  canIssue=state?.canIssue===true;
  contactReady=state?.contactReady===true;
  const members=Array.isArray(state?.members)?state.members:[];
  memberCount=members.length;
  const active=members.filter(m=>m.status==="active");
  activeMember=active.length===1?active[0]:null;
  if(active.length>1)hint.textContent="複数の担当者がいます。企業IDではなく各担当者のメールでログインしてください。";
  companyNo.textContent=active.length>1?"担当者メール":String(state?.portal?.displayId||"—");
  const next=companyLoginUrl(state?.portal?.loginUrl);
  portalUrl=next;
  // Sales already knows the company member; do not ask the operator to type
  // the same recipient once again at STEP 6.
  if(active.length===1&&!active[0].idOnly){
   const recipient=by("meeting-recipient"),contact=by("meeting-contact");
   if(recipient&&!recipient.value&&active[0].email)recipient.value=String(active[0].email);
   if(contact&&!contact.value&&active[0].displayName)contact.value=String(active[0].displayName);
  }
  if(!oneTimeTimer)password.textContent=active.length?"設定済み（再表示不可）":"未発行";
  paint();
  if(active.length>1)hint.textContent="複数担当者が登録されています。企業IDではなく各担当者のメールでログインしてください。再発行は企業詳細のアカウント管理から行ってください。";
 }
 async function call(payload){
  if(busy)return;
  busy=true;feedback="";issue.disabled=true;reset.disabled=true;paint();
  try{
   const result=await API.api("/api/sales/company-portal",{method:"POST",body:{...payload,companyId,confirmed:true}});
   if(result?.temporaryPassword)showSecret(result.temporaryPassword);
   await reload();
   if(result?.temporaryPassword)feedback="企業IDと8文字の初回パスワードを発行しました。2分間のみ表示します。メールは送信していません。";
   else if(result?.state==="needs_review")feedback=result.hint||"企業アカウントの登録状態を確認してください。";
  }catch(error){fail(error?.hint||error?.message||"ログイン発行に失敗しました。");}
  finally{busy=false;paint();}
 }
 issue.addEventListener("click",()=>{
  if(!canIssue||memberCount>0)return;
  if(!confirm("この企業専用のIDと8文字の初回パスワードを発行します。発行した情報は企業担当者へ安全な方法で共有してください。続行しますか？"))return;
  void call({action:"ensure_meeting_account"});
 });
 reset.addEventListener("click",()=>{
  if(!activeMember||!canIssue)return;
  if(!confirm("既存の企業パスワードは無効になります。8文字の新しいパスワードを再発行しますか？"))return;
  void call({action:"generate_password",memberId:activeMember.id});
 });
 open.addEventListener("click",event=>{
  if(!portalUrl)return;
  // Script-opened window can close itself after a successful company offer.
  // No password is ever placed in this URL. The Sales screen observes the
  // server-side offer ledger and progresses independently (different devices work too).
  const child=window.open(portalUrl,"enger_business_"+sessionId,"width=1160,height=830");
  if(child){
   event.preventDefault();
   try{child.focus();}catch{/* cross-origin */}
   hint.textContent="企業画面で「提案する」を押すと、STEP 5へ自動で進みます。";
  }
  // If popups are blocked, keep the anchor's ordinary new-tab behavior.
 });
 copy.addEventListener("click",async()=>{
  if(!portalUrl)return;
  try{await navigator.clipboard.writeText(portalUrl);hint.textContent="企業専用ログインURLをコピーしました。";}
  catch{fail("URLをコピーできませんでした。リンクを開いて確認してください。");}
 });
 // Opening actual STEP 4 is the staff's explicit meeting action. Generate only
 // the first account; never rotate a current password or duplicate an invite.
 async function prepareAtStep4(){
  if(autoAttempted)return;
  autoAttempted=true;
  try{
   await reload();
   if(!canIssue||memberCount>0||busy)return;
   await call({action:"ensure_meeting_account"});
  }catch(error){fail(error?.hint||error?.message||"企業ログインの発行状態を確認できませんでした。");}
 }
 document.addEventListener("sales:meeting-step4-enter",event=>{
  if(event?.detail?.companyId===companyId&&event?.detail?.sessionId===sessionId)
   void prepareAtStep4();
 });
 window.addEventListener("pagehide",eraseSecret,{once:true});
 void reload().catch(err=>fail(err?.hint||err?.message||"企業ログインを取得できませんでした。"));
})();
