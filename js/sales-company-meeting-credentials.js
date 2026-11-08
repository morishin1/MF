// 商談モーダルの企業ログインはIDとパスワードだけ。
// 企業基本情報に登録済みの担当者名・メールから、初回だけサーバで自動発行。
// 既存アカウントのパスワードは変更・取得しない。初回の平文は記憶領域に保存しない。
const make=(tag,value,cls)=>{
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(value!==undefined&&value!==null)node.textContent=String(value);
 return node;
};
const safeLoginUrl=value=>{
 try{
  const url=new URL(value);
  return url.protocol==="https:"&&url.pathname==="/business/login"&&
    (url.hostname==="enger.jp"||/^enger-[a-z0-9-]+\.vercel\.app$/.test(url.hostname)||
      /^enger-lp-git-[a-z0-9-]+\.vercel\.app$/.test(url.hostname))?url.href:null;
 }catch{return null;}
};
const copy=async (value,button)=>{
 try{await navigator.clipboard.writeText(value);button.textContent="コピーしました";}
 catch{button.textContent="コピーできませんでした";}
};
export function createMeetingCredentialPanel(host,{companyId,onChange}={}){
 if(!host||!companyId)return null;
 let data=null,visible=false,loading=null,issuing=false,attempted=false;
 let secret=null,secretTimeout=null,errorText="";
 const active=()=>Array.isArray(data?.members)?
   data.members.filter(m=>m.status==="active"):[];
 const demoAccount=()=>active().some(m=>String(m.email||"").startsWith("company-demo+"));
 const pending=()=>Array.isArray(data?.members)?
   data.members.filter(m=>["invited","expired","not_invited","disabled"].includes(m.status)):[];
 const state=()=>({
  loaded:!!data,
  active:active(),pending:pending(),
  canIssue:data?.canEnable===true,
  companyLoginId:data?.portal?.displayId||null,
  loginUrl:data?.portal?.loginUrl||null,
 });
 function forgetSecret(){
  if(secretTimeout)clearTimeout(secretTimeout);
  secretTimeout=null;secret=null;
 }
 function rememberSecret(password){
  forgetSecret();
  if(typeof password!=="string"||password.length<12)return;
  secret=password;
  secretTimeout=setTimeout(()=>{
   secret=null;secretTimeout=null;
   if(visible)render();
  },120000);
 }
 function notify(){
  if(typeof onChange==="function")onChange({ready:active().length>0,loaded:Boolean(data)});
 }
 const button=(label,callback,cls="lc-credential-copy")=>{
  const node=make("button",label,cls);
  node.type="button";node.addEventListener("click",callback);return node;
 };
 function line(label,value,canCopy=true){
  const root=make("div",null,"lc-credential-field");
  root.append(make("small",label));
  const row=make("div",null,"lc-credential-value-row");
  const shown=make("strong",value,"lc-credential-display");
  row.append(shown);
  if(canCopy&&value&&value!=="未発行"){
   const btn=button("コピー",()=>copy(value,btn));
   row.append(btn);
  }
  root.append(row);
  return root;
 }
 const note=(message,isError=false)=>{
  const n=make("p",message,"lc-credential-note");
  if(isError)n.dataset.status="error";
  return n;
 };
 function render(){
  host.hidden=!visible;
  if(!visible){host.replaceChildren();return;}
  const body=make("div",null,"lc-credential-card lc-credential-card-modal lc-credential-simple");
  const rows=make("div",null,"lc-credential-fields");
  const cId=data?.portal?.displayId||"確認中";
  rows.append(line("企業ID",cId,cId!=="確認中"));
  const status=active().length>0;
  const pwLabel=secret?"初回パスワード（2分間のみ表示）":"パスワード";
  if(secret)rows.append(line(pwLabel,secret,true));
  else rows.append(line(pwLabel,
    issuing?"初回発行中…":status?"設定済み（再表示不可）":
      pending().length?"登録状況の確認が必要":loading?"確認中":"未発行",false));
  body.append(rows);
  if(data?.portal?.loginUrl){
   const url=safeLoginUrl(data.portal.loginUrl);
   if(url){
    const controls=make("div",null,"lc-credential-login-actions");
    const anchor=make("a","企業ログインを開く","lc-credential-secondary");
    anchor.href=url;anchor.target="_blank";anchor.rel="noopener noreferrer";
    const btn=button("URLをコピー",()=>copy(url,btn));
    controls.append(anchor,btn);body.append(controls);
   }
  }
  if(demoAccount()){
    body.append(note("社内プレビュー専用のテストログインです。有効期間は発行から24時間。本番ENGERでは使用できません。実際の企業には共有しないでください。",true));
  }
  if(secret&&!demoAccount())body.append(note("このパスワードは初回だけ表示します。企業担当者本人へ安全な方法で共有してください。"));
  else if(status){
   body.append(note("既存のログイン情報をそのまま利用します。商談のたびにパスワードは再発行しません。"));
   if(active().length>1)body.append(note("担当者が複数いる企業は、企業IDではなく担当者本人のメールでログインしてください。"));
  }else if(pending().length){
   body.append(note("登録待ち・停止中の企業アカウントがあります。既存アカウントを確認してください。",true));
  }else if(issuing||loading){
   body.append(note("企業基本情報に保存済みの担当者情報を確認し、初回ログインを準備しています…"));
  }else if(errorText){
   body.append(note(errorText,true));
  }else if(data?.canEnable===false){
   body.append(note("初回発行は営業責任者・管理者の商談操作で行えます。",true));
  }else{
   body.append(note("企業基本情報の担当者名・メールをもとに初回パスワードを準備します。"));
  }
  if(errorText&&(status||pending().length))body.append(note(errorText,true));
  if(!status&&!pending().length&&!issuing&&!loading){
   const goInfo=button("企業基本情報を確認",()=>{
     host.closest("dialog")?.close();
     document.querySelector('[data-modal-tab="info"]')?.click();
   },"lc-credential-secondary");
   body.append(goInfo);
  }
  host.replaceChildren(body);
 }
 async function load(){
  if(loading)return loading;
  loading=(async()=>{
   try{
    const result=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
    if(!result||!Array.isArray(result.members))throw Error("企業アカウント情報を取得できませんでした");
    data=result;errorText="";notify();
   }catch(e){
    errorText=e?.hint||e?.message||"企業ログイン情報を取得できませんでした。";
   }
  })();
  if(visible)render();
  try{await loading}finally{loading=null;if(visible)render();}
 }
 async function autoPrepare(){
  if(!visible||issuing||attempted)return;
  attempted=true;
  await load();
  if(!visible)return;
  if(active().length||pending().length)return;
  if(!data){
   render();return;
  }
  if(!data.canEnable){
   errorText="初回発行は営業責任者・管理者が行います。";
   render();return;
  }
  issuing=true;errorText="";render();
  try{
   const result=await API.api("/api/sales/company-portal",{
    method:"POST",body:{companyId,action:"ensure_meeting_account",confirmed:true}
   });
   if(!visible)return;
   if(result?.temporaryPassword)rememberSecret(result.temporaryPassword);
   if(result?.previewOnly)errorText="社内プレビュー専用のテストアカウントを作成しました。本番ENGERでは使えません。";
   await load();
   if(!result?.temporaryPassword&&result?.state==="needs_review")
    errorText=result.hint||"既存アカウントの状態を確認してください。";
  }catch(e){
   if(visible)errorText=e?.hint||e?.message||"初回ログインの準備ができませんでした。";
  }finally{issuing=false;if(visible)render();}
 }
 function setVisible(next){
  visible=Boolean(next);
  if(!visible){
   attempted=false;forgetSecret();
  }
  render();
  if(visible)void autoPrepare();
 }
 function dispose(){
  visible=false;attempted=true;forgetSecret();host.replaceChildren();
 }
 // GETは状態確認のみ。新規発行は商談モーダルを明示的に開いた時のPOSTだけ。
 void load();
 return {state,setVisible,dispose,reload:load};
}
