import {createMeetingCredentialPanel} from "./sales-company-meeting-credentials.js?v=20261108credentials1";
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
  let mode="recommended",type="all",busy=false,canShare=false,loadedState=false;
  let results={job:[],talent:[]};
  const selected=new Map(),existing=new Map();
  const summary=brief?.suggestions||{};
  const rec={
    job:asList(summary.jobs,8).map(x=>candidate("job",x,"ai")).filter(Boolean),
    talent:asList(summary.talents,8).map(x=>candidate("talent",x,"ai")).filter(Boolean),
  };
  // Existing DX matching: the backend labels its evidence as confirmed or unverified.
  const verified=summary.verified===true;
  const wrap=mk("div",null,"lp-compact-wrap");
  const top=mk("section",null,"lp-compact-top");
  const head=mk("div",null,"lp-compact-heading");
  const title=mk("strong","候補を検索・選択");
  const hint=mk("small","AI分析の参考候補とENGER登録情報から、商談で見せる案件・人材を選びます。");
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
  showAI.addEventListener("click",()=>{mode="recommended";type="all";kind.value="all";query.value="";draw();});
  form.append(query,kind,search,showAI);top.append(form);
  const basis=mk("p",null,"lp-compact-basis");
  basis.textContent=(verified?"企業IDに紐づく登録済みの案件・人材・ニーズを優先":"AI分析・公開情報からの仮説（需要は未確認）")+
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
  const credentialHost=mk("section",null,"lp-compact-credential-host");
  credentialHost.hidden=true;
  wrap.append(credentialHost);
  let credentialPanel=null;
  const footer=mk("footer",null,"lp-compact-footer");
  const selection=mk("div",null,"lp-compact-selection");
  const count=mk("strong","0件選択"),selectionHelp=mk("small","候補をチェックすると商談画面に進めます。");
  selection.append(count,selectionHelp);
  const go=mk("button","商談へ進む","lp-compact-go");go.type="button";go.disabled=true;go.hidden=true;
  footer.append(selection,go);wrap.append(footer);host.append(wrap);
  credentialPanel=createMeetingCredentialPanel(credentialHost,{companyId,onChange:()=>updateFooter()});
  const controller=new AbortController();
  const dialog=document.getElementById("lc-dialog");
  dialog?.addEventListener("close",()=>{credentialPanel?.dispose();controller.abort();},{signal:controller.signal});
  document.addEventListener("sales:proposal-stage-hidden",e=>{
    if(e.detail?.companyId===companyId)credentialPanel?.setVisible(false);
  },{signal:controller.signal});
  document.addEventListener("sales:proposal-stage-shown",e=>{
    if(e.detail?.companyId===companyId)credentialPanel?.setVisible(selected.size>0);
  },{signal:controller.signal});
  function notice(text){message.textContent=text||"";}
  function keyFor(item){return item.kind+":"+item.id;}
  function updateFooter(){
    count.textContent=selected.size+"件選択";
    selectionHelp.textContent=selected.size?
      "公開項目と募集・稼働条件を確認して、選んだ候補を商談画面に表示します。":
      "案件・人材にチェックを入れてください（最大10件）。";
    const readyAccount=credentialPanel?.state()?.active?.length>0;
    go.hidden=selected.size<1;
    credentialPanel?.setVisible(selected.size>0);
    go.disabled=!loadedState||!canShare||busy||selected.size<1||selected.size>10||!readyAccount;
  }
  function card(item){
    const row=mk("label",null,"lp-compact-item");
    if(item.inactive)row.classList.add("inactive");
    if(selected.has(keyFor(item)))row.classList.add("checked");
    const checkbox=mk("input");checkbox.type="checkbox";checkbox.checked=selected.has(keyFor(item));
    checkbox.disabled=busy||item.inactive||!canShare;
    checkbox.setAttribute("aria-label",item.name+"を商談用に選択");
    checkbox.onchange=()=>{
      const key=keyFor(item);
      if(checkbox.checked){
        if(selected.size>=10){checkbox.checked=false;notice("一度の商談で選べる候補は最大10件です。");return;}
        selected.set(key,item);
      }else selected.delete(key);
      updateFooter();row.classList.toggle("checked",checkbox.checked);
    };
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
    row.append(checkbox,main);
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
      const list=mode==="recommended"?rec[which]:results[which];
      const section=mk("section",null,"lp-compact-col");
      const heading=mk("div",null,"lp-compact-col-head");
      heading.append(mk("strong",(mode==="recommended"?"AI参考":"検索結果")+"・"+(which==="talent"?"人材":"案件")),
        mk("small",loadError&&mode==="recommended"?"取得できていません":list.length+"件表示"));
      section.append(heading);
      const scroll=mk("div",null,"lp-compact-scroll");
      if(!list.length)scroll.append(mk("p",loadError&&mode==="recommended"?
         "AIおすすめを取得できていません。再取得してください。":
         mode==="recommended"?
         "照合条件がまだありません。AI分析を行うか、上の検索で候補を探してください。":
         "該当する候補はありません。検索条件を変えてください。","lp-compact-empty"));
      else for(const item of list)scroll.append(card(item));
      section.append(scroll);columns.append(section);
    }
    if(loadedState&&!canShare)notice("この企業は連絡注意・非表示のため候補を公開できません。企業状態を先に確認してください。");
    else if(mode==="recommended"){
      if(loadError){
        notice("照合できなかったため件数は未確定です。上の「再取得」を押してください。手動検索は利用できます。");
        updateFooter();
        return;
      }
      notice(rec.talent.length+rec.job.length?
        "登録情報とAI分析から抽出した参考候補です。正式な提案可否は確認してください。":
        "分析根拠のあるおすすめは未生成です。上部の検索から案件・人材を探せます。");
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
        results.talent=d.rows.slice(0,12).map(x=>candidate("talent",x,"search")).filter(Boolean);
      }));
      else results.talent=[];
      if(type!=="talent")tasks.push(API.api("/api/sales/company-shortlist?"+new URLSearchParams({companyId,mode:"search",type:"job",tab:"all",q})).then(d=>{
        if(!Array.isArray(d.rows))throw Error("案件を取得できませんでした");
        results.job=d.rows.slice(0,12).map(x=>candidate("job",x,"search")).filter(Boolean);
      }));
      else results.job=[];
      await Promise.all(tasks);
      draw();
      notice("検索結果は最大各12件を表示しています。条件を確認して選んでください。");
    }catch(err){failure=err?.hint||err?.message||"検索できませんでした。再実行してください。";}
    finally{
      busy=false;search.disabled=false;showAI.disabled=false;draw();
      if(failure)notice(failure);
      else if(!canShare)notice("この企業は公開できない状態です。営業側の企業状態を確認してください。");
      else notice("検索は直近の登録候補からの参考結果です。条件を確認して選んでください。");
    }
  };
  go.onclick=async()=>{
    if(busy||!canShare||!selected.size||selected.size>10)return;
    const chosen=[...selected.values()];
    const ask=chosen.length+"件を商談用に準備します。公開する情報、候補者の稼働状況、案件の募集継続、条件を確認しましたか？\n※選んだ候補は企業ログイン後にも公開されます。";
    if(!window.confirm(ask))return;
    // Synchronously open a separate tab from the user's click to avoid popup blockers.
    const tab=window.open("about:blank","_blank");
    if(tab){tab.opener=null;tab.document.title="商談画面を準備中";tab.document.body.textContent="商談画面を準備しています…";}
    busy=true;go.disabled=true;
    notice("選んだ"+chosen.length+"件の公開可能性を照合・保存しています…");
    let done=0;
    try{
      for(const item of chosen){
        await API.api("/api/sales/company-shortlist",{method:"POST",body:{
          companyId,itemType:item.kind,itemId:item.id,action:"publish",confirmed:true
        }});
        done++;
      }
      const raw=typeof getLoginUrl==="function"?getLoginUrl():null;
      const url=new URL(raw||"https://enger.jp/business/login");
      if(url.protocol!=="https:"||!(url.hostname==="enger.jp"||
        /^enger-[a-z0-9-]+\.vercel\.app$/.test(url.hostname)))
        throw Error("企業ログインURLを確認できません。");
      // The next path contains identifiers only, never a password or account secret.
      const next=new URL("/business/meeting","https://enger.jp");
      next.searchParams.set("companyId",companyId);
      next.searchParams.set("selection",chosen.map(x=>x.kind+":"+x.id).join(","));
      url.pathname="/business/login";
      url.searchParams.set("next",next.pathname+next.search);
      notice(chosen.length+"件を商談用に準備しました。企業ログイン画面から商談を開始できます。");
      document.dispatchEvent(new CustomEvent("sales:proposal-prepared",{detail:{companyId}}));
      if(onPublished)onPublished(chosen);
      credentialPanel?.setVisible(false);
      if(tab)tab.location.replace(url.href);
      else window.location.assign(url.href);
    }catch(err){
      if(tab)tab.close();
      notice((err?.hint||err?.message||"商談候補を準備できませんでした。")+
        (done?" "+done+"件の保存は完了しています。状態を再確認してからもう一度実行してください。":""));
    }finally{busy=false;updateFooter();}
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
}
