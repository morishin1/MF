// Compact AI-assisted matching/proposal workspace. Staff-authenticated endpoints only.
// Never displays partner company, person name/contact, internal prices or raw CVs.
// A source-backed AI skill match is a lead for review, not a confirmed job order.
const mk=(tag, text, className)=>{
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined&&text!==null)node.textContent=String(text);
  return node;
};
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const max=(v,n=140)=>String(v??"").trim().slice(0,n);
const asList=(v,n=6)=>Array.isArray(v)?v.slice(0,n):[];
function candidate(kind,r,from){
  if(!r||!UUID.test(String(r.id||"")))return null;
  return {
    kind,id:r.id,
    name:max(kind==="talent"?(r.talentNo||r.displayName||"人材")+" "+(r.title||""):
      (r.jobNo||r.no||"案件")+" "+(r.displayTitle||r.title||""),130),
    skills:asList(r.matchedSkills?.length?r.matchedSkills:r.skills,5).map(x=>max(x,38)),
    detail:max(kind==="talent"?[r.availability,r.remoteLabel,r.prefecture].filter(Boolean).join("・"):
      [r.remote,r.location].filter(Boolean).join("・"),110),
    matched:asList(r.matchedSkills,5).length,
    source:from,
    inactive:r.inactive===true
  };
}
export function renderCompactProposal(host,{companyId,brief,onTalent,onPublished,getLoginUrl,loadError=null,onRetry}={}){
  if(!host||!UUID.test(companyId||""))return;
  host.replaceChildren();
  let mode="recommended",type="all",busy=false,canShare=false,loadedState=false,expanded=false;
  let results={job:[],talent:[]};
  const existing=new Map();
  const summary=brief?.suggestions||{};
  const rec={
    job:asList(summary.jobs,8).map(x=>candidate("job",x,"ai")).filter(Boolean),
    talent:asList(summary.talents,8).map(x=>candidate("talent",x,"ai")).filter(Boolean),
  };
  // AI条件がまだない企業でも、人材・案件の一覧そのものはデフォルト表示する。
  // 新着候補はAI推薦とは違うため、必ず「登録候補（未照合）」と表示する。
  const starter={job:[],talent:[]};
  let starterLoading=false,starterError=null;
  // Existing DX matching: the backend labels its evidence as confirmed or unverified.
  const verified=summary.verified===true;
  const wrap=mk("div",null,"lp-compact-wrap");
  const top=mk("section",null,"lp-compact-top");
  const head=mk("div",null,"lp-compact-heading");
  const title=mk("strong","候補一覧・AIおすすめ");
  const hint=mk("small","営業準備用の参考候補です。商談と企業向けの候補提示はENGERで進めます。");
  head.append(title,hint);top.append(head);
  const form=mk("form",null,"lp-compact-search");
  form.setAttribute("role","search");
  const query=mk("input");query.type="search";query.maxLength=100;
  query.placeholder="案件・人材の職種、スキル、番号を検索";
  query.setAttribute("aria-label","案件・人材の検索");
  const kind=mk("select");kind.setAttribute("aria-label","検索対象");
  for(const [value,label]of [["all","案件と人材"],["talent","人材"],["job","案件"]]){
    const option=mk("option",label);option.value=value;kind.append(option);
  }
  const search=mk("button","検索","lc-primary");search.type="submit";
  const showAI=mk("button","AIおすすめ","lp-compact-secondary");showAI.type="button";
  showAI.addEventListener("click",()=>{mode="recommended";expanded=false;type="all";kind.value="all";query.value="";draw();});
  form.append(query,kind,search,showAI);top.append(form);
  const basis=mk("p",null,"lp-compact-basis");
  basis.textContent=(verified?"企業IDに紐づく確認済みニーズを優先":rec.job.length+rec.talent.length?"AI分析・公開情報からの仮説（需要は未確認）":"AI照合がないためENGER登録候補を表示（需要は未確認）")+
    " ／ 照合条件："+(loadError?"取得できていません":max(summary.basis||"未登録",140))+
    "。マッチングは参考候補であり、所属・募集継続・条件を確認してから公開してください。";
  top.append(basis);
  if(loadError){
    const failed=mk("div",null,"lp-compact-load-error");
    failed.setAttribute("role","alert");
    failed.append(mk("strong","AI分析の照合結果を取得できませんでした"));
    failed.append(mk("p",loadError));
    const retry=mk("button","照合結果を再取得","lp-compact-secondary");
    retry.type="button";
    retry.addEventListener("click",()=>{if(typeof onRetry==="function")onRetry();});
    failed.append(retry);
    top.append(failed);
  }
  wrap.append(top);
  const content=mk("div",null,"lp-compact-content");
  const message=mk("p","","lp-compact-message");message.setAttribute("role","status");message.setAttribute("aria-live","polite");
  const columns=mk("div",null,"lp-compact-columns");
  content.append(message,columns);wrap.append(content);
  const footer=mk("footer",null,"lp-compact-footer");
  const selection=mk("div",null,"lp-compact-selection");
  const count=mk("strong","候補を読み込み中"),selectionHelp=mk("small","");
  selection.append(count,selectionHelp);
  const go=mk("a","ENGER商談を開始","lp-compact-go");
  go.href="/sales/enger-meeting.html?"+new URLSearchParams({companyId});
  go.target="_blank";go.rel="noopener noreferrer";
  footer.append(selection,go);wrap.append(footer);host.append(wrap);
  const controller=new AbortController();
  document.getElementById("lc-dialog")?.addEventListener("close",()=>controller.abort(),{once:true,signal:controller.signal});
  function notice(text){message.textContent=text||"";}
  // 検索一覧に実際に表示している公開可能候補だけを商談へ持ち込む。
  // 「AIおすすめ」は分析済みの参考表示、未分析はENGER登録候補と明記する。
  function visibleCandidates(){
    const gathered=[];
    const seen=new Set();
    for(const which of ["talent","job"]){
      if(type!=="all"&&type!==which)continue;
      const group=mode==="recommended"?
        (rec[which].length?rec[which]:starter[which]):results[which];
      for(const item of group){
        if(!item||item.inactive===true)continue;
        const key=item.kind+":"+item.id;
        if(seen.has(key))continue;
        seen.add(key);gathered.push(item);
      }
    }
    return gathered.slice(0,30);
  }
  function updateFooter(){
    count.textContent=visibleCandidates().length+"件の参考候補";
    selectionHelp.textContent="商談・検索・候補保存はENGERで進めます。ここに表示しただけでは企業へ公開されません。";
  }
  function card(item){
    const row=mk("div",null,"lp-compact-item");
    const main=mk("div",null,"lp-compact-item-main");
    const line=mk("div",null,"lp-compact-item-title");
    line.append(mk("strong",item.name));
    if(item.matched)line.append(mk("span","スキル一致 "+item.matched+"件","lp-compact-match"));
    if(item.source==="ai")line.append(mk("span","おすすめ","lp-compact-ai"));
    main.append(line);
    if(item.skills.length){
      const chips=mk("div",null,"lp-compact-skills");
      for(const skill of item.skills)chips.append(mk("span",skill));
      main.append(chips);
    }
    if(item.detail)main.append(mk("small",item.detail,"lp-compact-meta"));
    row.append(main);
    if(item.kind==="talent"&&onTalent){
      const detail=mk("button","詳細","lp-compact-detail");detail.type="button";
      detail.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();onTalent(item.id);});
      row.append(detail);
    }
    return row;
  }
  function draw(){
    columns.replaceChildren();
    for(const [which,label]of [["talent","おすすめ人材"],["job","おすすめ案件"]]){
      if(type!=="all"&&type!==which)continue;
      const sourceList=mode==="recommended"?(rec[which].length?rec[which]:starter[which]):results[which];
      const list=sourceList.filter(item=>item.inactive!==true);
      const section=mk("section",null,"lp-compact-col");
      const heading=mk("div",null,"lp-compact-col-head");
      const label=mode!=="recommended"?"検索結果":rec[which].length?"AIおすすめ":"登録候補（未照合）";
      heading.append(mk("strong",label+"・"+(which==="talent"?"人材":"案件")),
        mk("small",starterLoading&&!rec[which].length&&mode==="recommended"?"読み込み中":list.length+"件表示"));
      section.append(heading);
      const scroll=mk("div",null,"lp-compact-scroll");
      if(!list.length)scroll.append(mk("p",starterLoading&&mode==="recommended"?"ENGERの登録候補を読み込んでいます…":
         mode==="recommended"&&starterError?"登録候補を取得できませんでした。検索から再取得してください。":
         loadError&&mode==="recommended"?"AI照合を取得できていません。上の再取得をお試しください。":
         mode==="recommended"?"現在表示できる候補がありません。手動検索から探せます。":
         "該当する候補はありません。検索条件を変えてください。","lp-compact-empty"));
      else for(const item of list)scroll.append(card(item));
      section.append(scroll);
      columns.append(section);
    }
    if(loadedState&&!canShare)notice("この企業は連絡注意・非表示のため候補を公開できません。企業状態を先に確認してください。");
    else if(mode==="recommended"){
      if(loadError){
        notice("照合できなかったため件数は未確定です。上の「再取得」を押してください。手動検索は利用できます。");
        updateFooter();
        return;
      }
      notice(rec.talent.length+rec.job.length?
        "AI分析とENGERの登録情報から参考候補を表示しました。提案前に条件を確認してください。":
        starterLoading?"ENGERの登録候補を読み込み中です…":
        starterError?"登録候補の取得に失敗しました。上部の検索から再取得してください。":
        "AI分析がないためENGERの登録候補を表示しています。正式なニーズ確認・提案承認は別途必要です。");
    }
    updateFooter();
  }
  form.onsubmit=async(e)=>{
    e.preventDefault();if(busy)return;
    const q=query.value.trim();type=kind.value;mode="search";busy=true;search.disabled=true;showAI.disabled=true;
    let failure=null;
    notice("ENGERの案件・人材を検索しています…");
    try{
      const params=new URLSearchParams({companyId,q});
      const tasks=[];
      if(type!=="job")tasks.push(API.api("/api/sales/company-talents?"+new URLSearchParams({companyId,tab:"all",page:"1",q})).then(d=>{
        if(!Array.isArray(d.rows))throw Error("人材を取得できませんでした");
        results.talent=d.rows.slice(0,30).map(x=>candidate("talent",x,"search")).filter(Boolean);
      }));
      else results.talent=[];
      if(type!=="talent")tasks.push(API.api("/api/sales/company-shortlist?"+new URLSearchParams({companyId,mode:"search",type:"job",tab:"all",q})).then(d=>{
        if(!Array.isArray(d.rows))throw Error("案件を取得できませんでした");
        results.job=d.rows.slice(0,30).map(x=>candidate("job",x,"search")).filter(Boolean);
      }));
      else results.job=[];
      await Promise.all(tasks);
      draw();
      notice("参考候補を最大各30件表示しています。候補の保存・提示はENGER商談で行います。");
    }catch(err){failure=err?.hint||err?.message||"検索できませんでした。再実行してください。";}
    finally{
      busy=false;search.disabled=false;showAI.disabled=false;draw();
      if(failure)notice(failure);
      else if(!canShare)notice("この企業は公開できない状態です。営業側の企業状態を確認してください。");
      else notice("検索は直近の登録候補からの参考結果です。条件を確認して選んでください。");
    }
  };
  draw();
  API.api("/api/sales/company-shortlist?"+new URLSearchParams({companyId}))
    .then(state=>{
      loadedState=true;canShare=state.canShare!==false;
      for(const item of state.items||[])existing.set(item.itemType+":"+item.itemId,item.status);
      if(!canShare)notice("この企業は連絡注意・非表示のため、候補を公開できません。企業状態を確認してください。");
      draw();
    })
    .catch(err=>{loadedState=false;canShare=false;notice(err?.hint||"企業の公開権限を確認できません。");updateFooter();});
  // AI結果が空の場合でも、登録済み人材・案件の先頭候補を自動で取得する。
  const pending=[];
  if(!rec.talent.length){
    pending.push(API.api("/api/sales/company-talents?"+
      new URLSearchParams({companyId,tab:"all",page:"1"})).then(d=>{
       if(!Array.isArray(d.rows))throw Error("人材候補を取得できませんでした");
       starter.talent=d.rows.slice(0,30).map(x=>candidate("talent",x,"search")).filter(Boolean);
    }));
  }
  if(!rec.job.length){
    pending.push(API.api("/api/sales/company-shortlist?"+
      new URLSearchParams({companyId,mode:"search",type:"job",tab:"all"})).then(d=>{
       if(!Array.isArray(d.rows))throw Error("案件候補を取得できませんでした");
       starter.job=d.rows.slice(0,30).map(x=>candidate("job",x,"search")).filter(Boolean);
    }));
  }
  if(pending.length){
    starterLoading=true;draw();
    Promise.allSettled(pending).then(rows=>{
      if(controller.signal.aborted)return;
      const rejected=rows.find(x=>x.status==="rejected");
      if(rejected)starterError="登録候補の取得に失敗しました";
      starterLoading=false;draw();
    });
  }
}
