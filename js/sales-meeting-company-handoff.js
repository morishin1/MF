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
 let activeMember=null,contactReady=false,canIssue=false,busy=false;
 let oneTimeTimer=null,portalUrl=null;
 const fail=message=>{hint.textContent=String(message||"企業ログインを確認できません").slice(0,220);};
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
  issue.hidden=Boolean(activeMember);
  issue.disabled=busy||!canIssue||!contactReady;
  reset.hidden=!activeMember||!canIssue;
  reset.disabled=busy||!activeMember;
  copy.disabled=!portalUrl;
  open.hidden=!portalUrl;
  if(portalUrl)open.href=portalUrl;
  if(!contactReady&&!activeMember)fail("正式な企業ログイン発行には、企業基本情報に実際の担当者名・メールが必要です。社内商談はそのまま継続できます。");
  else if(activeMember)fail("この企業のログインは発行済みです。パスワードは表示できません。必要な場合だけ再発行してください。");
  else if(canIssue)fail("確認済みの企業担当者に対して、8文字の初回パスワードを発行できます。");
  else fail("発行権限または企業の登録状況を確認できません。");
 }
 async function reload(){
  const state=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
  canIssue=state?.canIssue===true;
  contactReady=state?.contactReady===true;
  const members=Array.isArray(state?.members)?state.members:[];
  const active=members.filter(m=>m.status==="active");
  activeMember=active.length===1?active[0]:null;
  if(active.length>1)hint.textContent="複数の担当者がいます。企業IDではなく各担当者のメールでログインしてください。";
  companyNo.textContent=active.length>1?"担当者メール":String(state?.portal?.displayId||"—");
  const next=companyLoginUrl(state?.portal?.loginUrl);
  portalUrl=next;
  if(!oneTimeTimer)password.textContent=active.length?"設定済み（再表示不可）":"未発行";
  paint();
  if(active.length>1)hint.textContent="複数担当者が登録されています。企業IDではなく各担当者のメールでログインしてください。再発行は企業詳細のアカウント管理から行ってください。";
 }
 async function call(payload){
  if(busy)return;
  busy=true;issue.disabled=true;reset.disabled=true;
  try{
   const result=await API.api("/api/sales/company-portal",{method:"POST",body:{...payload,companyId,confirmed:true}});
   if(result?.temporaryPassword)showSecret(result.temporaryPassword);
   await reload();
   if(result?.temporaryPassword)hint.textContent="8文字パスワードを発行しました。2分間だけ表示します。コピー・共有した後は再表示できません。";
  }catch(error){fail(error?.hint||error?.message||"ログイン発行に失敗しました。");}
  finally{busy=false;paint();}
 }
 issue.addEventListener("click",()=>{
  if(!contactReady||!canIssue)return;
  if(!confirm("企業基本情報で確認された担当者に、初回の企業ID・8文字パスワードを発行しますか？"))return;
  void call({action:"ensure_meeting_account"});
 });
 reset.addEventListener("click",()=>{
  if(!activeMember||!canIssue)return;
  if(!confirm("既存の企業パスワードは無効になります。8文字の新しいパスワードを再発行しますか？"))return;
  void call({action:"generate_password",memberId:activeMember.id});
 });
 copy.addEventListener("click",async()=>{
  if(!portalUrl)return;
  try{await navigator.clipboard.writeText(portalUrl);hint.textContent="企業専用ログインURLをコピーしました。";}
  catch{fail("URLをコピーできませんでした。リンクを開いて確認してください。");}
 });
 // Open company-side search as a script-created window, allowing it to
 // close itself after a successful offer. No credential is placed in its URL.
 let companyWindow=null;
 open.addEventListener("click",event=>{
  if(!portalUrl)return;
  event.preventDefault();
  companyWindow=window.open(portalUrl,"enger-company-offer",
    "width=1220,height=850,scrollbars=yes,resizable=yes");
  if(companyWindow){companyWindow.focus();}
  else fail("新しい画面がブロックされています。URLをコピーして開いてください。");
 });
 window.addEventListener("message",event=>{
  if(event.origin!=="https://enger.jp"||!companyWindow||event.source!==companyWindow)return;
  const msg=event.data||{};
  if(msg.type!=="enger.company-offer-submitted"||
     msg.companyId!==companyId||msg.sessionId!==sessionId||
     !Number.isInteger(msg.received)||msg.received<1)return;
  // This is a hint only; the Sales navigator verifies the saved offer
  // using a staff-authenticated, tenant-scoped API before advancing.
  window.dispatchEvent(new CustomEvent("enger:company-offer-received",{
   detail:{companyId,sessionId}
  }));
 });
 window.addEventListener("pagehide",eraseSecret,{once:true});
 void reload().catch(err=>fail(err?.hint||err?.message||"企業ログインを取得できませんでした。"));
})();
