// Read-only company portal handoff. Credentials are never issued or displayed here.
(()=>{
 const params=new URLSearchParams(location.search);
 const companyId=params.get("companyId"),sessionId=params.get("sessionId");
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(!uuid.test(companyId||"")||!uuid.test(sessionId||""))return;
 const by=id=>document.getElementById(id);
 const hint=by("meeting-company-login-hint"),companyNo=by("meeting-company-login-id");
 const open=by("meeting-company-open"),copy=by("meeting-company-copy");
 if(!hint||!companyNo||!open||!copy)return;
 let portalUrl=null;
 function safeUrl(value){
  try{const u=new URL(value);if(u.protocol!=="https:"||!['enger.jp','www.enger.jp'].includes(u.hostname)||
    u.pathname!=="/business/login"||u.username||u.password)return null;
   u.search="";u.searchParams.set("next","/business/offers?companyId="+encodeURIComponent(companyId));return u.href;
  }catch{return null;}
 }
 async function reload(){
  const state=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
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
   "複数の担当者がいます。企業IDではなく各担当者のメールアドレスでログインしてください。":"ログインIDと企業専用ページをご案内できます。パスワードは表示・再発行しません。";
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
 void reload().catch(err=>{hint.textContent=err?.hint||err?.message||"企業ログイン情報を取得できませんでした。";});
})();

