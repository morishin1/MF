// Sales company meeting credentials, never stored in browser storage or URL.
// Existing passwords cannot be read: only an authorized manager explicitly
// issues/resets a temporary password, shown once, then cleared after 2 minutes.
const el=(tag,value,cls)=>{
 const node=document.createElement(tag);
 if(cls)node.className=cls;
 if(value!==undefined&&value!==null)node.textContent=String(value);
 return node;
};
const validatedEmail=s=>/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(s||"").trim());
export function createMeetingCredentialPanel(host,{companyId,onChange}={}){
 if(!host||!companyId)return null;
 let data=null,busy=false,visible=false,selectedMember=null,secret=null,expiry=null;
 const state=()=>({
   loaded:!!data,
   active:(data?.members||[]).filter(m=>m.status==="active"),
   canIssue:!!data?.canEnable,
   companyLoginId:data?.portal?.displayId||null
 });
 function forgetSecret(){
   if(expiry){clearTimeout(expiry);expiry=null;}
   secret=null;
 }
 function setSecret(value){
   forgetSecret();
   if(typeof value!=="string"||value.length<12)return;
   secret=value;
   expiry=setTimeout(()=>{secret=null;expiry=null;render();},120000);
 }
 function notify(){if(typeof onChange==="function")onChange({ready:state().active.length>0,loaded:!!data});}
 function render(){
  host.hidden=!visible;
  if(!visible)return;
  const card=el("div",null,"lc-credential-card");
  const head=el("div",null,"lc-credential-title");
  head.append(el("strong","企業ログイン情報"),el("small","商談で企業のご担当者が使用します。"));
  card.append(head);
  if(!data){
    card.append(el("p",busy?"企業アカウントを確認中…":"企業アカウントを取得できません。","lc-credential-note"));
    host.replaceChildren(card);return;
  }
  const st=state();
  const info=el("div",null,"lc-credential-fields");
  const field=(label,value)=>{
    const group=el("div",null,"lc-credential-field");
    group.append(el("small",label),el("strong",value||"未登録"));
    return group;
  };
  info.append(field("企業ID",st.companyLoginId||"未登録"));
  if(st.active.length===1)info.append(field("ログインID",st.active[0].email));
  else info.append(field("ログインID",st.active.length>1?"下の担当者メールを選択":"アカウント未発行"));
  card.append(info);
  if(st.active.length){
    const account=el("label",null,"lc-credential-label");
    account.append(el("span","企業担当者"));
    const select=el("select");
    for(const m of st.active){
      const option=el("option",m.displayName+"（"+m.email+"）");
      option.value=m.id;select.append(option);
    }
    if(!st.active.some(m=>m.id===selectedMember))selectedMember=st.active[0].id;
    select.value=selectedMember;
    select.onchange=()=>{selectedMember=select.value;forgetSecret();render();};
    account.append(select);card.append(account);
    card.append(el("p",st.active.length===1?
      "担当者が1名なら企業IDまたはメールアドレスでログインできます。":
      "担当者が複数のため、各担当者のメールアドレスでログインしてください。",
      "lc-credential-note"));
  }
  const password=el("div",null,"lc-credential-password");
  password.append(el("small","パスワード"));
  if(secret){
    const code=el("code",secret,"lc-credential-secret");
    password.append(code);
    const copy=el("button","パスワードをコピー","lc-credential-copy");copy.type="button";
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(secret||"");copy.textContent="コピーしました";}
      catch{copy.textContent="コピーできませんでした";}};
    password.append(copy);
    password.append(el("small","今回の一時パスワードのみ表示しています。2分後・画面移動時に非表示になります。"));
  }else{
    password.append(el("strong",st.active.length?"既存パスワードは再表示できません":"未発行"));
  }
  card.append(password);
  if(st.canIssue&&!busy){
    if(st.active.length){
      const reset=el("button","一時パスワードを再発行","lc-credential-secondary");reset.type="button";
      reset.onclick=async()=>{
        const member=st.active.find(m=>m.id===selectedMember);
        if(!member)return;
        if(!confirm(member.email+" の現在のパスワードを無効にして、新しい一時パスワードを発行しますか？"))return;
        busy=true;render();
        try{
          const result=await API.api("/api/sales/company-portal",{method:"POST",body:{
            companyId,action:"generate_password",memberId:member.id,confirmed:true
          }});
          setSecret(result?.temporaryPassword);
          await load();
        }catch(e){message=e?.hint||"パスワードを発行できませんでした。";}
        finally{busy=false;render();}
      };
      card.append(reset);
    }else{
      const form=el("form",null,"lc-credential-issue-form");
      const name=el("input");name.placeholder="企業担当者名";name.required=true;name.maxLength=100;name.setAttribute("aria-label","企業担当者名");
      const email=el("input");email.type="email";email.placeholder="担当者のメールアドレス";email.required=true;email.maxLength=254;email.setAttribute("aria-label","企業担当者メール");
      const issue=el("button","企業ログインIDと一時パスワードを発行","lc-primary");issue.type="submit";
      form.append(el("small","管理者が本人確認後に企業用アカウントを発行します。"),name,email,issue);
      form.onsubmit=async e=>{
        e.preventDefault();if(busy||!name.value.trim()||!validatedEmail(email.value))return;
        if(!confirm("この企業の担当者にログインアカウントを発行しますか？"))return;
        busy=true;render();
        try{
          const result=await API.api("/api/sales/company-portal",{method:"POST",body:{
            companyId,action:"issue_account",displayName:name.value.trim(),
            email:email.value.trim(),role:"admin",confirmed:true
          }});
          setSecret(result?.temporaryPassword);
          await load();
        }catch(e){message=e?.hint||"企業ログインアカウントを発行できませんでした。";}
        finally{busy=false;render();}
      };
      card.append(form);
    }
  }
  if(!st.canIssue&&!st.active.length)card.append(el("p","企業担当者のログイン発行は営業責任者・管理者へ依頼してください。","lc-credential-note"));
  const note=el("p",message||"パスワードはサーバーに平文保存しません。企業担当者へ安全な方法でお渡しください。","lc-credential-note");
  card.append(note);
  host.replaceChildren(card);
 }
 let message="";
 async function load(){
  try{
    const result=await API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}));
    if(!result||!Array.isArray(result.members))throw Error("アカウント情報がありません。");
    data=result;message="";render();notify();
  }catch(e){data=null;message=e?.hint||e?.message||"アカウント情報を読み込めませんでした。";render();notify();}
 }
 function setVisible(next){
   visible=Boolean(next);
   if(!visible)forgetSecret();
   render();
 }
 function dispose(){forgetSecret();visible=false;host.replaceChildren();}
 void load();
 return {setVisible,dispose,state};
}
