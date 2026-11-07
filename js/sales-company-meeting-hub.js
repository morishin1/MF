// Compact Sales meeting board: linked receipts, matches, favorites, explicit portal sharing.
// The private shortlist is distinct from portal-visible items until a human publishes it.
export function renderCompanyMeetingHub(host,{companyId,brief,onTalent,onSearchTalent,onDraftMail}={}){
 if(!host||!companyId)return;
 host.replaceChildren();
 const source=brief?.source||{},suggestions=brief?.suggestions||{};
 let tab="received",companyName=brief?.company?.name||"企業",favorites=[],shareable=true;
 const elem=(tag,content,cls)=>{
   const el=document.createElement(tag);if(content!==undefined)el.textContent=String(content);
   if(cls)el.className=cls;return el;
 };
 const button=(label,callback,cls)=>{
   const el=elem("button",label,cls||"lp-meeting-button");el.type="button";
   el.addEventListener("click",callback);return el;
 };
 const section=elem("section",undefined,"lp-meeting-hub");
 const heading=elem("div",undefined,"lp-meeting-head");
 const title=elem("div");
 title.append(elem("h3","商談管理"),elem("p",
   "受領済み案件・人材 → マッチング → お気に入り → 相手へ共有"));
 const tabs=elem("div",undefined,"lp-meeting-tabs");
 for(const [key,label] of [["received","受領した情報"],["recommended","おすすめ候補"],["favorites","お気に入り・共有"],["search","新規検索"]]){
   const b=button(label,()=>{tab=key;draw();});
   b.dataset.meetingTab=key;tabs.append(b);
 }
 heading.append(title,tabs);
 const body=elem("div",undefined,"lp-meeting-body");
 const status=elem("p","","lp-meeting-status");status.setAttribute("role","status");
 section.append(heading,body,status);host.append(section);
 const receivedJobs=(source.linkedJobs||[]).map(x=>({kind:"job",id:x.id,
   label:x.title||"案件",sub:[x.no?"No."+x.no:"",...(x.skills||[]).slice(0,4)].filter(Boolean).join(" ／ ")}));
 const receivedTalents=(source.linkedTalents||[]).map(x=>({kind:"talent",id:x.id,
   label:(x.talentNo||"人材")+" "+(x.title||""),sub:(x.skills||[]).slice(0,5).join(" ／ ")}));
 const recJobs=(suggestions.jobs||[]).map(x=>({kind:"job",id:x.id,
   label:x.title||"案件",sub:"一致スキル："+(x.matchedSkills||[]).join("・")}));
 const recTalents=(suggestions.talents||[]).map(x=>({kind:"talent",id:x.id,
   label:(x.talentNo||"人材")+" "+(x.title||""),sub:"一致スキル："+(x.matchedSkills||[]).join("・")}));
 const savedStatus=new Map();
 const error=(text)=>{status.textContent=text;};
 async function loadState(){
   try{
     const data=await API.api("/api/sales/company-shortlist?"+new URLSearchParams({companyId}));
     favorites=data.items||[];
     shareable=data.canShare!==false;
     savedStatus.clear();
     for(const entry of favorites)savedStatus.set(entry.itemType+":"+entry.itemId,entry);
     if(tab==="favorites")draw();
   }catch(e){error(e?.hint||"お気に入りの情報を取得できませんでした。");}
 }
 async function change(kind,id,action){
   const confirmed=["remove","publish","unpublish"].includes(action);
   if(confirmed&&!confirm(action==="publish"?
     "公開用に選んだ情報を、"+companyName+"のログイン済み担当者へ共有します。社外表示を確認しましたか？":
     action==="remove"?"このお気に入りを解除しますか？":"企業への公開を取り消しますか？"))return;
   error("保存しています…");
   try{
     await API.api("/api/sales/company-shortlist",{method:"POST",body:{
       companyId,itemType:kind,itemId:id,action,confirmed
     }});
     error(action==="publish"?"企業ポータルの共有リストに反映しました。":
       action==="favorite"?"お気に入りに保存しました。":
       action==="unpublish"?"社外向けの共有を取り消しました。":"お気に入りを削除しました。");
     await loadState();draw();
   }catch(e){error(e?.hint||"変更できませんでした。");}
 }
 function row(item,opts={}){
   const div=elem("div",undefined,"lp-meeting-row");
   const content=elem("div",undefined,"lp-meeting-row-copy");
   content.append(elem("strong",item.label),elem("small",item.sub||"条件は未確認"));
   div.append(content);
   const actions=elem("div",undefined,"lp-meeting-row-actions");
   const saved=savedStatus.get(item.kind+":"+item.id);
   if(saved)actions.append(elem("span",saved.status==="published"?"公開中":"お気に入り","lp-meeting-pill"));
   if(item.kind==="talent"&&onTalent)
      actions.append(button("詳細",()=>onTalent(item.id),"lp-meeting-secondary"));
   if(!saved && item.id)actions.append(button("☆ お気に入り",()=>change(item.kind,item.id,"favorite")));
   if(saved && saved.status==="favorite"){
      if(saved.eligible&&shareable)actions.append(button("企業へ共有",()=>change(item.kind,item.id,"publish"),"lp-meeting-primary"));
      actions.append(button("解除",()=>change(item.kind,item.id,"remove"),"lp-meeting-secondary"));
   }
   if(saved && saved.status==="published")
      actions.append(button("共有解除",()=>change(item.kind,item.id,"unpublish"),"lp-meeting-secondary"));
   div.append(actions);return div;
 }
 function list(items,empty){
   if(!items.length){body.append(elem("p",empty,"lp-meeting-empty"));return;}
   for(const it of items)body.append(row(it));
 }
 function category(title,items,empty){
   const h=elem("h4",title);body.append(h);list(items,empty);
 }
 function updateTabs(){
   tabs.querySelectorAll("[data-meeting-tab]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.meetingTab===tab)));
 }
 function draw(){
   updateTabs();body.replaceChildren();
   if(tab==="received"){
     const hasRecords=Boolean((source.registeredRequests||0)+(source.proposalCount||0)+receivedJobs.length+receivedTalents.length);
     body.append(elem("p",
       hasRecords?"この企業IDと照合できた受領・提案履歴です。確認済みの案件・人材だけを表示します。":
         "この企業IDで受領済みの案件・人材を確認できませんでした。新規企業は「新規検索」から始められます。",
         "lp-meeting-note"));
     category("受領済み案件 "+receivedJobs.length+"件",receivedJobs,"企業IDで照合できた案件はありません。");
     category("受領済み人材 "+receivedTalents.length+"名",receivedTalents,"企業IDで照合できた人材はありません。");
     body.append(button("候補を探す",()=>{tab="search";draw();},"lp-meeting-primary"));
   }else if(tab==="recommended"){
     body.append(elem("p","照合元："+(suggestions.basis||"条件未登録")+
       " ／ この候補は参考一致です。所属・単価・募集継続を確認するまでは正式提案ではありません。",
       "lp-meeting-note"));
     category("おすすめ人材 "+recTalents.length+"名",recTalents,"一致する人材はありません。");
     category("おすすめ案件 "+recJobs.length+"件",recJobs,"一致する案件はありません。");
   }else if(tab==="favorites"){
     body.append(elem("p","お気に入りは社内用です。「企業へ共有」を押した候補だけが相手の企業ポータルに表示されます。","lp-meeting-note"));
     if(!shareable)body.append(elem("p","この企業は連絡注意・非表示のため公開できません。企業情報を確認してください。","lp-meeting-warning"));
     const listItems=favorites.map(f=>({
       kind:f.itemType,id:f.itemId,
       label:f.itemType==="talent"?(f.item?.talentNo||"人材")+" "+(f.item?.title||""):
         (f.item?.jobNo||"案件")+" "+(f.item?.displayTitle||f.item?.title||""),
       sub:[(f.item?.skills||[]).slice(0,6).join("・"),f.eligible?"提示可能":"提示不可（クローズ等）"].filter(Boolean).join(" ／ "),
     }));
     list(listItems,"お気に入りはありません。おすすめ候補や検索結果から追加してください。");
     const published=favorites.filter(f=>f.status==="published"&&f.eligible);
     const footer=elem("div",undefined,"lp-meeting-share-actions");
     if(published.length){
       footer.append(elem("strong","企業向け共有中："+published.length+"件"));
       footer.append(button("共有ページをコピー",async()=>{
         const url="https://enger.jp/business/recommendations";
         try{await navigator.clipboard.writeText(url);error("ログイン後に閲覧する企業専用URLをコピーしました。");}
         catch{error("URLをコピーできません。https://enger.jp/business/recommendations");}
       },"lp-meeting-secondary"));
       footer.append(button("メール文面を作成",()=>{
         if(onDraftMail)onDraftMail({
           subject:"【ENGER】"+companyName+"様向けの案件・人材のご案内",
           text:companyName+" ご担当者様\n\n株式会社エイトのENGERです。\n貴社向けに案件・人材を"+
             published.length+"件選びました。\n以下の企業専用ページからご覧ください。\n"+
             "https://enger.jp/business/recommendations\n\n"+
             "※企業専用アカウントでのログインが必要です。公開情報以外の条件は営業担当へご確認ください。\n"
         });
       },"lp-meeting-primary"));
     }else footer.append(elem("p","お気に入りから「企業へ共有」を選ぶと、共有・メール案内が可能になります。","lp-meeting-note"));
     body.append(footer);
   }else if(tab==="search"){
     body.append(elem("p","新規企業もここから検索できます。案件・人材をお気に入りに保存し、確認後に共有してください。","lp-meeting-note"));
     const searchPanel=elem("div",undefined,"lp-meeting-search");
     const mode=elem("div",undefined,"lp-meeting-mode");
     mode.append(button("人材を検索",()=>onSearchTalent?.(),"lp-meeting-primary"));
     mode.append(button("案件を検索",()=>renderJobSearch(),"lp-meeting-secondary"));
     searchPanel.append(mode);
     const searchArea=elem("div",undefined,"lp-meeting-job-search");searchPanel.append(searchArea);body.append(searchPanel);
   }
 }
 async function renderJobSearch(){
   const area=body.querySelector(".lp-meeting-job-search");if(!area)return;
   area.replaceChildren();
   const form=elem("form",undefined,"lp-meeting-job-form");
   const input=elem("input");input.type="search";input.placeholder="職種・技術（例 Java AWS）";input.maxLength=100;
   const select=elem("select");
   for(const [key,label] of [["all","全案件"],["focus","注力案件"],["new","新着案件"]]){
     const opt=elem("option",label);opt.value=key;select.append(opt);
   }
   const submit=button("検索",()=>{},"lp-meeting-primary");submit.type="submit";
   form.append(input,select,submit);
   const hit=elem("div");area.append(form,hit);
   const run=async()=>{
     hit.replaceChildren(elem("p","ENGER案件を検索しています…","lp-meeting-note"));
     try{
       const r=await API.api("/api/sales/company-shortlist?"+new URLSearchParams({
         mode:"search",companyId,type:"job",q:input.value,tab:select.value
       }));
       hit.replaceChildren();
       if(r.truncated)hit.append(elem("p","直近600件の範囲からの検索結果です。","lp-meeting-note"));
       if(!(r.rows||[]).length){hit.append(elem("p","該当する案件がありません。","lp-meeting-empty"));return;}
       for(const j of r.rows)hit.append(row({kind:"job",id:j.id,
         label:(j.jobNo||"案件")+" "+(j.displayTitle||j.title),
         sub:(j.skills||[]).slice(0,7).join(" / ")}));
     }catch(e){hit.replaceChildren(elem("p",e?.hint||"案件を取得できませんでした。","lp-meeting-warning"));}
   };
   form.addEventListener("submit",e=>{e.preventDefault();void run()});
   await run();
 }
 void loadState();draw();
 return {refresh:loadState};
}
