// ENGER企業担当者のログイン情報をSales商談準備モーダル内に表示する。
// パスワードは発行・明示再発行の応答でのみ受け取り、2分後とモーダル終了時に破棄。
const el=(tag,value,cls)=>{
 const n=document.createElement(tag);
 if(cls)n.className=cls;
 if(value!==undefined&&value!==null)n.textContent=String(value);
 return n;
};
const emailPattern=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const validLoginUrl=value=>{
 try{
  const u=new URL(value);
  return u.protocol==="https:"&&u.pathname==="/business/login"&&
    (u.hostname==="enger.jp"||/^enger-[a-z0-9-]+\.vercel\.app$/.test(u.hostname)||
     /^enger-lp-git-[a-z0-9-]+\.vercel\.app$/.test(u.hostname)) ? u.href : null;
 }catch{return null;}
};
const copyValue=async(value,button)=>{
 try{await navigator.clipboard.writeText(value);button.textContent="コピーしました";}
 catch{button.textContent="コピーできませんでした";}
};
export function createMeetingCredentialPanel(host,{companyId,onChange}={}){
 if(!host||!companyId)return null;
 let data=null,loading=true,visible=false,busy=false,selectedMember=null;
 let secret=null,secretEmail=null,expiry=null,inviteLink=null,errorMessage="";
 const currentMembers=()=>data?.members||[];
 const active=()=>currentMembers().filter(m=>m.status==="active");
 const pending=()=>currentMembers().filter(m=>["invited","expired","not_invited"].includes(m.status));
 const state=()=>({
  loaded:!!data,active:active(),pending:pending(),
  canIssue:data?.canEnable===true,
  companyLoginId:data?.portal?.displayId||null,
  loginUrl:data?.portal?.loginUrl||null
 });
 function forgetSecret(){
  if(expiry){clearTimeout(expiry);expiry=null;}
  secret=null;secretEmail=null;inviteLink=null;
 }
 function storeSecret(password,email){
  forgetSecret();
  if(typeof password!=="string"||password.length<12)return;
  secret=password;
  secretEmail=email||null;
  expiry=setTimeout(()=>{secret=null;secretEmail=null;expiry=null;if(visible)render();},120000);
 }
 function notify(){
  if(typeof onChange==="function")onChange({
   ready:active().length>0,loaded:!!data
  });
 }
 const button=(label,click,cls="lc-credential-secondary")=>{
  const b=el("button",label,cls);
  b.type="button";b.onclick=click;return b;
 };
 const field=(label,value,allowCopy=true)=>{
  const root=el("div",null,"lc-credential-field");
  root.append(el("small",label));
  const row=el("div",null,"lc-credential-value-row");
  row.append(el("strong",value||"未発行"));
  if(allowCopy&&value&&value!=="未発行")
   row.append(button("コピー",()=>copyValue(value,row.lastElementChild),"lc-credential-copy"));
  root.append(row);
  return root;
 };
 const message=(value,kind="")=>{
  const p=el("p",value,"lc-credential-note");
  if(kind)p.dataset.status=kind;
  return p;
 };
 function render(){
  host.hidden=!visible;
  if(!visible){host.replaceChildren();return;}
  const card=el("section",null,"lc-credential-card lc-credential-card-modal");
  card.append(el("h3","企業ログインID・パスワード"));
  card.append(message("企業担当者はENGERにログインします。営業担当の社内IDは使えません。"));
  if(!data){
   card.append(message(loading?"企業アカウントを確認しています…":errorMessage||"アカウント情報を取得できませんでした。","error"));
   if(!loading)card.append(button("再取得",load));
   host.replaceChildren(card);return;
  }
  const st=state(),users=active(),queued=pending();
  const link=validLoginUrl(st.loginUrl);
  const grid=el("div",null,"lc-credential-fields");
  grid.append(field("企業ID（担当者1名の場合）",st.companyLoginId||"未登録"));
  const chosen=users.find(m=>m.id===selectedMember)||users[0]||null;
  if(chosen)selectedMember=chosen.id;
  grid.append(field("ログインID（担当者メール）",chosen?.email||secretEmail||"未発行"));
  card.append(grid);
  if(link){
   const line=el("div",null,"lc-credential-login-actions");
   const a=el("a","企業ログイン画面を開く","lc-credential-secondary");
   a.href=link;a.target="_blank";a.rel="noopener noreferrer";
   line.append(a,button("ログインURLをコピー",()=>copyValue(link,line.lastElementChild)));
   card.append(line);
  }else card.append(message("企業ログインURLが未設定です。管理者に設定を確認してください。","error"));

  if(users.length>1){
   const group=el("label",null,"lc-credential-label");
   group.append(el("span","対象の企業担当者"));
   const select=el("select");
   for(const m of users){const item=el("option",m.displayName+"（"+m.email+"）");item.value=m.id;select.append(item);}
   select.value=selectedMember||users[0].id;
   select.onchange=()=>{selectedMember=select.value;forgetSecret();render();};
   group.append(select);card.append(group);
  }
  if(secret){
   const pw=el("div",null,"lc-credential-password lc-credential-password-new");
   pw.append(el("small","一時パスワード（今回だけ表示・2分で消去）"));
   const row=el("div",null,"lc-credential-password-value");
   row.append(el("code",secret,"lc-credential-secret"));
   row.append(button("コピー",()=>copyValue(secret,row.lastElementChild),"lc-credential-copy"));
   pw.append(row);
   pw.append(message("ログインIDと一時パスワードを本人へ安全な方法で共有してください。再発行すると以前のパスワードは使えません。"));
   card.append(pw);
  }else if(users.length){
   card.append(message("パスワード：設定済み（安全のため再表示不可）。本人が忘れた場合だけ再発行してください。"));
  }else if(queued.length){
   card.append(message("初回登録待ちの担当者がいます。招待リンクを送って本人に設定してもらってください。"));
  }else{
   card.append(message("まだ企業担当者のログインID・パスワードが発行されていません。","error"));
  }
  if(inviteLink){
   const box=el("div",null,"lc-credential-password-new");
   box.append(message("初回登録用URL（今回のみ表示）"));
   box.append(button("招待URLをコピー",()=>copyValue(inviteLink,box.lastElementChild)));
   card.append(box);
  }
  if(users.length&&st.canIssue&&!busy){
   const recovery=el("details",null,"lc-credential-recovery");
   recovery.append(el("summary","パスワードを忘れたときだけ再発行"));
   recovery.append(message("通常の商談・ログイン・モーダル表示ではIDやパスワードを再発行しません。再発行すると現在のパスワードが使えなくなります。"));
   recovery.append(button("一時パスワードを再発行",async()=>{
    const member=users.find(x=>x.id===selectedMember);
    if(!member)return;
    if(!confirm(member.email+" の現在のパスワードが無効になります。再発行しますか？"))return;
    busy=true;errorMessage="";render();
    try{
     const result=await API.api("/api/sales/company-portal",{
      method:"POST",body:{companyId,action:"generate_password",memberId:member.id,confirmed:true}
     });
     storeSecret(result?.temporaryPassword,member.email);
     await load();
    }catch(e){errorMessage=e?.hint||e?.message||"再発行できませんでした。";}
    finally{busy=false;render();}
   }));
   card.append(recovery);
  }
  if(queued.length&&!users.length){
   for(const member of queued.slice(0,5)){
    const row=el("div",null,"lc-credential-pending");
    row.append(message((member.displayName||"担当者")+"（"+member.email+"）: "+(member.statusLabel||"初回登録待ち")));
    if(st.canIssue&&!busy){
     row.append(button("招待URLを再発行",async()=>{
      if(!confirm(member.email+" へ招待URLを発行しますか？"))return;
      busy=true;render();
      try{
       const result=await API.api("/api/sales/company-portal",{
        method:"POST",body:{companyId,action:"reinvite",memberId:member.id,sendMail:false}
       });
       inviteLink=result?.inviteUrl||null;
       await load();
      }catch(e){errorMessage=e?.hint||e?.message||"招待できませんでした。";}
      finally{busy=false;render();}
     }));
    }
    card.append(row);
   }
  }
  if(!users.length&&!queued.length&&st.canIssue&&!busy){
   const form=el("form",null,"lc-credential-issue-form");
   const desc=message("初回だけ企業担当者の氏名・メールを入力すると、ログインIDと一時パスワードが発行されます。");
   const name=el("input");name.required=true;name.maxLength=100;name.placeholder="企業担当者名";name.autocomplete="name";
   const mail=el("input");mail.required=true;mail.maxLength=254;mail.type="email";mail.placeholder="担当者のメールアドレス";mail.autocomplete="email";
   const issue=el("button","企業ログインID・一時パスワードを発行","lc-primary");issue.type="submit";
   form.append(desc,name,mail,issue);
   form.addEventListener("submit",async ev=>{
    ev.preventDefault();
    const email=mail.value.trim().toLowerCase();
    const displayName=name.value.trim();
    if(busy||!displayName||!emailPattern.test(email))return;
    if(!confirm("この企業の担当者 "+email+" にログインアカウントを発行しますか？"))return;
    busy=true;errorMessage="";render();
    try{
     const result=await API.api("/api/sales/company-portal",{
      method:"POST",body:{companyId,action:"issue_account",displayName,email,role:"admin",confirmed:true}
     });
     storeSecret(result?.temporaryPassword,email);
     await load();
    }catch(e){errorMessage=e?.hint||e?.message||"ログイン発行に失敗しました。";}
    finally{busy=false;render();}
   });
   card.append(form);
  }
  if(!st.canIssue&&!users.length){
   card.append(message("アカウント発行・再発行は営業責任者・管理者のみ操作できます。","error"));
  }
  if(errorMessage)card.append(message(errorMessage,"error"));
  const foot=el("p","企業担当者は同じログインIDを継続使用できます。既存のパスワードはSalesから取得できません。","lc-credential-note");
  card.append(foot);
  host.replaceChildren(card);
 }
 async function load(){
  loading=true;
  if(visible)render();
  try{
   const result=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
   if(!result||!Array.isArray(result.members))throw Error("企業アカウント情報を取得できませんでした");
   data=result;errorMessage="";notify();
  }catch(e){
   errorMessage=e?.hint||e?.message||"企業アカウント情報を取得できませんでした。";
   if(!data)notify();
  }finally{loading=false;if(visible)render();}
 }
 function setVisible(next){
  visible=Boolean(next);
  if(!visible)forgetSecret();
  render();
 }
 function dispose(){
  forgetSecret();visible=false;host.replaceChildren();
 }
 void load();
 return {state,setVisible,dispose,reload:load};
}
