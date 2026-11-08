// EIGHT SALES company portal intake review: safe text DOM, tenant-scoped APIs.
(()=>{
 const $=id=>document.getElementById(id);
 const status=$("status"),rows=$("rows"),filter=$("filter"),count=$("count");
 let busy=false;
 const node=(tag,value,cls)=>{
  const el=document.createElement(tag);if(cls)el.className=cls;
  if(value!==undefined&&value!==null)el.textContent=String(value);return el;
 };
 function note(message){status.textContent=message||"";}
 async function refresh(){
  if(busy)return;
  busy=true;rows.replaceChildren();note("企業からの登録を確認しています…");
  try{
   const data=await API.api("/api/sales/company-submissions?"+new URLSearchParams({status:filter.value}));
   if(!Array.isArray(data.items))throw Error("提出データを確認できませんでした。");
   count.textContent=data.items.length+"件表示";
   if(!data.items.length)rows.append(node("p","対象の提出情報はありません。"));
   for(const item of data.items){
    const card=node("article",null,"item");
    const header=node("div",null,"row"),name=node("div");
    name.append(node("h2",item.title),
      node("small",item.companyName+" ／ "+(item.itemType==="job"?"案件":"所属人材")+
       " ／ "+new Date(item.createdAt).toLocaleDateString('ja-JP')));
    const badge=node("small",item.status);header.append(name,badge);card.append(header);
    card.append(node("p",item.description||"概要は未登録です。"));
    const skills=node("div",null,"tags");
    for(const x of Array.isArray(item.skills)?item.skills:[])
      skills.append(node("span",String(x).slice(0,70),"tag"));
    card.append(skills);
    if(item.budget)card.append(node("p","予算・希望条件："+item.budget));
    if(item.workStyle)card.append(node("p","稼働条件："+item.workStyle));
    const actions=node("div",null,"actions");
    const companyLink=node("a","企業情報を確認");
    companyLink.href="/sales/company-segments.html?"+
     new URLSearchParams({companyId:item.companyId,meeting:"info"});actions.append(companyLink);
    if(item.attachmentName){
     const attachment=node("button","スキルシートを確認");
     attachment.type="button";
     attachment.onclick=async()=>{
      attachment.disabled=true;
      try{
       const r=await API.api("/api/sales/company-submission-file?"+
        new URLSearchParams({id:item.id}));
       if(!r.url||!r.url.startsWith("https://"))throw Error("添付ファイルのURLを確認できませんでした。");
       window.open(r.url,"_blank","noopener,noreferrer");
      }catch(e){note(e.hint||e.message||"ファイルを確認できません。");}
      finally{attachment.disabled=false;}
     };
     actions.append(attachment);
    }
    if(data.canReview&&item.status==="pending_review"){
     const actionsList=[["approve","内容を確認済み"],["needs_changes","修正を依頼"],["reject","見送り"]];
     for(const [action,label] of actionsList){
      const button=node("button",label,action==="approve"?"primary":"");
      button.type="button";
      button.onclick=async()=>{
       let reason="";
       if(action!=="approve"){
        const value=window.prompt(label+"の理由を入力してください。");
        if(value===null)return;
        reason=value.trim();
        if(reason.length<3){note("理由は3文字以上で入力してください。");return;}
       }
       if(!window.confirm(item.companyName+" の「"+item.title+"」を "+label+" にしますか？"))return;
       button.disabled=true;note("確認結果を保存しています…");
       try{
        const saved=await API.api("/api/sales/company-submissions",{
         method:"PATCH",body:{submissionId:item.id,action,reviewNote:reason,confirmed:true}});
        note(saved.hint||"確認結果を保存しました。ENGER DXで最終確認を行ってください。");
        await refresh();
       }catch(e){note(e.hint||e.message||"確認結果を保存できませんでした。");}
       finally{button.disabled=false;}
      };
      actions.append(button);
     }
    }
    card.append(actions);rows.append(card);
   }
   note(data.canReview?"確認・承認は他社公開を意味しません。マッチングはENGER DXで最終確認してください。":"閲覧のみ。承認・見送りは責任者が操作します。");
  }catch(e){note(e.hint||e.message||"登録情報を取得できません。ログイン状態を確認してください。");}
  finally{busy=false;}
 }
 filter.onchange=()=>void refresh();
 $("refresh").onclick=()=>void refresh();
 void refresh();
})();