// Optional, collapsed verification of historical ENGER data for this company.
// Historical records are not displayed as confirmed receipts until Sales staff verify.
export function renderCompanyHistoricalPanel(host,companyId,{onLinked}={}) {
 if(!host||!companyId)return;
 let opened=false,loaded=false,loading=false,items=[],partial=false;
 const create=(tag,text,cls="")=>{
   const el=document.createElement(tag);if(text!==undefined)el.textContent=String(text);
   if(cls)el.className=cls;return el;
 };
 const shell=create("details",undefined,"lp-history-verify");
 const header=create("summary","過去DBの案件・人材・提案を照合する");
 const body=create("div",undefined,"lp-history-verify-content");
 const message=create("p","","lp-meeting-note");
 shell.append(header,body);host.replaceChildren(shell);
 const typeLabels={job:"案件",talent:"人材",proposal:"提案履歴"};
 const reasonLabels={sender_domain:"メールドメイン一致",company_name:"会社名一致",historical_proposal:"過去提案の社名一致"};
 function draw(){
   body.replaceChildren();
   if(message.textContent)body.append(message);
   if(!loaded)return;
   body.append(create("p","候補は会社名・送信元の一致から抽出。担当者が確認するまでは企業IDに紐づけません。","lp-meeting-note"));
   if(partial)body.append(create("p","照合候補が多いため、一部の結果だけを表示しています。","lp-meeting-warning"));
   for(const [type,label] of Object.entries(typeLabels)){
     const matches=items.filter(x=>x.type===type);
     body.append(create("h4",label+" "+matches.length+"件"));
     if(!matches.length){body.append(create("p","該当する履歴なし","lp-meeting-empty"));continue;}
     const group=create("div",undefined,"lp-history-verify-list");
     for(const item of matches){
       const row=create("div",undefined,"lp-history-verify-row");
       const content=create("div",undefined,"lp-meeting-row-copy");
       content.append(create("strong",(item.no?item.no+" ／ ":"")+item.label),
         create("small",(reasonLabels[item.sourceKind]||"確認待ち")+" ／ "+(item.status||"状態未確認")));
       const actions=create("div",undefined,"lp-meeting-row-actions");
       if(item.linked){
         actions.append(create("span","紐づけ済み","lp-meeting-pill"));
         const remove=create("button","解除","lp-meeting-secondary");
         remove.type="button";remove.onclick=()=>void link(item,"unlink");actions.append(remove);
       }else{
         const approve=create("button","確認して紐づける","lp-meeting-primary");
         approve.type="button";approve.onclick=()=>void link(item,"confirm");actions.append(approve);
       }
       row.append(content,actions);group.append(row);
     }
     body.append(group);
   }
 }
 async function load() {
   if(loading||!host.isConnected)return;
   loading=true;message.textContent="過去のENGER DBを照合中…";draw();
   try{
     const response=await API.api("/api/sales/company-historical-assets?"+new URLSearchParams({companyId}));
     if(!host.isConnected)return;
     items=response.items||[];partial=Boolean(response.partial);loaded=true;message.textContent="";
     const count=response.counts||{};
     header.textContent="過去DBの照合候補：案件"+(count.jobs||0)+"件・人材"+(count.talents||0)+
       "名・提案"+(count.proposals||0)+"件";
   }catch(e){message.textContent=e?.hint||"過去情報を照合できませんでした。";loaded=false;}
   finally{loading=false;if(host.isConnected)draw();}
 }
 async function link(item,action) {
   if(loading)return;
   if(!confirm(action==="confirm"
     ?"このデータを選択企業に紐づけますか？会社名・メール等の情報を確認してください。"
     :"企業との紐づけを解除しますか？"))return;
   loading=true;message.textContent="登録内容を更新中…";draw();
   try {
     const result=await API.api("/api/sales/company-historical-assets",{method:"POST",body:{
       companyId,type:item.type,itemId:item.id,action,confirmed:true,
     }});
     if(!result?.ok)throw Error("結果を確認できませんでした。");
     const found=items.find(x=>x.id===item.id&&x.type===item.type);
     if(found)found.linked=action==="confirm";
     message.textContent=action==="confirm"?"企業IDに紐づけました。商談管理を開き直すと反映されます。":"紐づけを解除しました。";
     onLinked?.();
   }catch(e){message.textContent=e?.hint||"保存できませんでした。";}
   finally{loading=false;if(host.isConnected)draw();}
 }
 shell.addEventListener("toggle",()=>{opened=shell.open;if(opened&&!loaded)void load();});
 return {refresh:()=>void load()};
}
