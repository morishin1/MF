// Compact Sales meeting board: linked receipts, matches, favorites, explicit portal sharing.
// The private shortlist is distinct from portal-visible items until a human publishes it.
export function renderCompanyMeetingHub(host,{companyId,brief,onTalent,onSearchTalent,onDraftMail}={}){
 if(!host||!companyId)return;
 host.replaceChildren();
 const source=brief?.source||{},suggestions=brief?.suggestions||{};
 let tab="recommended",companyName=brief?.company?.name||"企業",favorites=[],shareable=true;
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
 title.append(elem("h3","提案する案件・人材を選ぶ"),elem("p",
   "候補を検索 → 保存 → 公開情報を確認 → 商談用に準備"));
 const tabs=elem("div",undefined,"lp-meeting-tabs");
 for(const [key,label] of [["received","受領した情報"],["recommended","おすすめ候補"],["favorites","提案する候補"],["search","新規検索"]]){
   const b=button(label,()=>{tab=key;draw();});
   b.dataset.meetingTab=key;tabs.append(b);
 }
 heading.append(title,tabs);
 const body=elem("div",undefined,"lp-meeting-body");
 const status=elem("p","","lp-meeting-status");status.setAttribute("role","status");
 section.append(heading,body,status);host.append(section);
 const mapItem=(type,kind,extra="")=>x=>({
   kind,id:x.id,channel:x.channel||"不明",
   label:kind==="job"?(x.title||"案件"):(x.talentNo||"人材")+" "+(x.title||""),
   sub:(x.skills||[]).slice(0,4).join("・"),
   receivedAt:x.receivedAt||null,recordedAt:x.recordedAt||null,
   receivedLabel:x.receivedLabel||"登録",inactive:!!x.inactive,
   status:x.status||"",origin:type,
 });
 const receivedJobs=(source.receivedJobs||[]).map(mapItem("受領済み","job"));
 const receivedTalents=(source.receivedTalents||[]).map(mapItem("受領済み","talent"));
 const historyJobs=(source.proposalHistoryJobs||[]).map(mapItem("過去の提案","job"));
 const historyTalents=(source.proposalHistoryTalents||[]).map(mapItem("過去の提案","talent"));
 const confirmedJobs=(source.confirmedHistoricalJobs||[]).map(mapItem("確認済み過去履歴","job"));
 const confirmedTalents=(source.confirmedHistoricalTalents||[]).map(mapItem("確認済み過去履歴","talent"));
 const confirmedProposals=(source.confirmedHistoricalProposals||[]).map(x=>({
   label:x.title||"過去提案",stage:x.stage||"",at:x.createdAt||null,
 }));
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
     draw();
   }catch(e){error(e?.hint||"お気に入りの情報を取得できませんでした。");}
 }
 async function change(kind,id,action){
   const confirmed=["remove","publish","unpublish"].includes(action);
   if(confirmed&&!confirm(action==="publish"?
     "商談用に準備した情報を、"+companyName+"のログイン済み担当者に公開しますか？公開項目を確認してください。":
     action==="remove"?"このお気に入りを解除しますか？":"企業への公開を取り消しますか？"))return;
   error("保存しています…");
   try{
     await API.api("/api/sales/company-shortlist",{method:"POST",body:{
       companyId,itemType:kind,itemId:id,action,confirmed
     }});
     error(action==="publish"?"商談用の提案候補として公開しました。":
       action==="favorite"?"お気に入りに保存しました。":
       action==="unpublish"?"社外向けの共有を取り消しました。":"お気に入りを削除しました。");
     await loadState();draw();
     document.dispatchEvent(new CustomEvent("sales:proposal-prepared",{detail:{companyId}}));
   }catch(e){error(e?.hint||"変更できませんでした。");}
 }
 function row(item,opts={}){
   const div=elem("div",undefined,"lp-meeting-row");
   const content=elem("div",undefined,"lp-meeting-row-copy");
   content.append(elem("strong",item.label),elem("small",item.sub||"条件は未確認"));
   if(item.origin){
     const at=item.receivedAt||item.recordedAt;
     const shown=at?new Date(at).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",
       year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"日時未登録";
     content.append(elem("small",item.origin+" ／ "+(item.receivedAt?item.receivedLabel||"受信":"登録日時")+"："+shown,
       "lp-meeting-datetime"));
     content.append(elem("small",item.inactive?"過去・終了扱い":
       "現在の登録（募集・稼働継続は要確認）","lp-meeting-item-state"));
   }
   if(item.channel)content.append(elem("span","受信経路："+item.channel,"lp-receipt-channel"));
   div.append(content);
   const actions=elem("div",undefined,"lp-meeting-row-actions");
   const saved=savedStatus.get(item.kind+":"+item.id);
   if(saved)actions.append(elem("span",saved.status==="published"?"公開中":"お気に入り","lp-meeting-pill"));
   if(saved?.interests)actions.append(elem("span","企業から関心あり "+saved.interests+"件","lp-meeting-pill"));
   if(item.kind==="talent"&&onTalent)
      actions.append(button("詳細",()=>onTalent(item.id),"lp-meeting-secondary"));
   if(!saved && item.id && !item.inactive)actions.append(button("☆ お気に入り",()=>change(item.kind,item.id,"favorite")));
   if(saved && saved.status==="favorite"){
      if(saved.eligible&&shareable)actions.append(button("商談用に準備",()=>change(item.kind,item.id,"publish"),"lp-meeting-primary"));
      actions.append(button("解除",()=>change(item.kind,item.id,"remove"),"lp-meeting-secondary"));
   }
   if(saved && saved.status==="published")
      actions.append(button("公開取消",()=>change(item.kind,item.id,"unpublish"),"lp-meeting-secondary"));
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
     // Current/archived assets are grouped by company ID, never inferred by name.
     const unique=(items)=>{
       const seen=new Map();
       for(const item of items)if(item.id&&!seen.has(item.id))seen.set(item.id,item);
       return [...seen.values()].sort((a,b)=>String(b.receivedAt||b.recordedAt||"").localeCompare(String(a.receivedAt||a.recordedAt||"")));
     };
     const allJobs=unique([...receivedJobs,...historyJobs,...confirmedJobs]);
     const allTalents=unique([...receivedTalents,...historyTalents,...confirmedTalents]);
     const msg=(source.registeredRequests||0)||allJobs.length||allTalents.length?
       "この企業IDに紐づけられた現在・過去の情報です。実際の受信日時が不明なものは登録日時で表示します。":
       "現在、この企業IDに紐づく案件・人材はありません。下の「過去DBの照合」から既存データを確認できます。";
     body.append(elem("p",msg,"lp-meeting-note"));
     const grid=elem("div",undefined,"lp-meeting-dual-grid");
     for(const [kind,title,items] of [["job","案件",allJobs],["talent","人材",allTalents]]){
       const col=elem("section",undefined,"lp-meeting-dual-col");
       const h=elem("div",undefined,"lp-meeting-dual-title");
       h.append(elem("strong",title),elem("span",items.length+"件"));
       col.append(h);
       const scroll=elem("div",undefined,"lp-meeting-dual-scroll");
       if(!items.length)scroll.append(elem("p","この企業に紐づく"+title+"はありません。","lp-meeting-empty"));
       else{
         const current=items.filter(x=>!x.inactive);
         const past=items.filter(x=>x.inactive);
         if(current.length)scroll.append(elem("p","現在の登録・継続確認待ち "+current.length+"件","lp-meeting-subhead"));
         for(const item of current)scroll.append(row(item));
         if(past.length)scroll.append(elem("p","過去・終了 "+past.length+"件","lp-meeting-subhead"));
         for(const item of past)scroll.append(row(item));
       }
       col.append(scroll);grid.append(col);
     }
     body.append(grid);
     if(confirmedProposals.length)
       body.append(elem("p","企業IDに紐づけた過去提案："+confirmedProposals.length+"件。提案管理で経過をご確認ください。","lp-meeting-note"));
     body.append(button("新しい案件・人材を探す",()=>{tab="search";draw();},"lp-meeting-secondary"));
   }else if(tab==="recommended"){
     body.append(elem("p","照合元："+(suggestions.basis||"条件未登録")+
       " ／ この候補は参考一致です。所属・単価・募集継続を確認するまでは正式提案ではありません。",
       "lp-meeting-note"));
     category("おすすめ人材 "+recTalents.length+"名",recTalents,"一致する人材はありません。");
     category("おすすめ案件 "+recJobs.length+"件",recJobs,"一致する案件はありません。");
     if(suggestions.localAIProfileId){
       const a=document.createElement("a");
       a.href="https://dx.enger.jp/companies/"+encodeURIComponent(companyId)+"/local-ai";
       a.target="_blank";a.rel="noopener noreferrer";
       a.className="lp-meeting-dx-link";
       a.textContent="ENGER DXで正式マッチングの参考スコアを確認";
       body.append(a);
     }
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
       footer.append(elem("strong","商談用の公開候補："+published.length+"件"));
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
