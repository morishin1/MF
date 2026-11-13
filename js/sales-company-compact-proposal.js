import {createMeetingCredentialPanel} from "./sales-company-meeting-credentials.js?v=20261109eightCharSales1";
import {mountMeetingCalendar} from "./sales-company-meeting-calendar.js?v=20261108preflight1";
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
  const hint=mk("small","表示中の公開可能な人材・案件はチェック不要で、すべて商談画面に引き継ぎます。");
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
  // 候補一覧を最初に見せる。日時とGoogleカレンダーは「商談」からモーダル表示する。
  const preflight=mk("dialog",null,"lp-meeting-preflight");
  preflight.setAttribute("aria-labelledby","lp-meeting-preflight-title");
  const preHead=mk("div",null,"lp-meeting-preflight-head");
  const summaryPanel=mk("section",null,"lp-meeting-preflight-summary");
  const idLabel=mk("p","企業ID：確認中");
  const companyName=mk("strong",brief?.company?.name||"対象企業");
  const summaryLabel=mk("p",max(brief?.summary?.text||"企業サマリーは未登録です。商談で課題を確認してください。",720));
  summaryPanel.append(companyName,idLabel,summaryLabel);
  const preTitle=mk("h2","商談の準備","");preTitle.id="lp-meeting-preflight-title";
  const beginTop=mk("button","商談画面を開く（企業ログイン不要）","lp-meeting-preflight-topstart");beginTop.type="button";beginTop.hidden=true;
  const preClose=mk("button","×","lp-meeting-preflight-close");
  preClose.type="button";preClose.setAttribute("aria-label","閉じる");
  preHead.append(preTitle,beginTop,preClose);
  
  const calendarHost=mk("section",null,"lp-calendar-host");
  const loginPanel=mk("section",null,"lp-meeting-login-panel");
  const loginTitle=mk("h3","企業ログイン（後から発行できます・商談開始に不要）");
  const credentialHost=mk("section",null,"lp-compact-credential-host");
  credentialHost.hidden=true;
  loginPanel.append(loginTitle,credentialHost);
  const preMessage=mk("p","","lp-meeting-preflight-status");
  preMessage.setAttribute("role","status");preMessage.setAttribute("aria-live","polite");
  const preActions=mk("div",null,"lp-meeting-preflight-actions");
  const cancel=mk("button","戻る","lp-meeting-preflight-cancel");cancel.type="button";
  const begin=mk("button","商談画面を開く（ログイン不要）","lp-meeting-preflight-next");begin.type="button";
  preActions.append(begin);
  beginTop.onclick=()=>begin.click();
  loginPanel.hidden=true;calendarHost.hidden=true;
  preflight.append(preHead,summaryPanel,loginPanel,calendarHost,preMessage,preActions);
  wrap.append(preflight);
  let credentialPanel=null;
  const footer=mk("footer",null,"lp-compact-footer");
  const selection=mk("div",null,"lp-compact-selection");
  const count=mk("strong","候補を読み込み中"),selectionHelp=mk("small","公開できる候補をすべて商談画面に表示します。チェックは不要です。");
  selection.append(count,selectionHelp);
  const go=mk("button","商談","lp-compact-go");go.type="button";go.disabled=true;
  footer.append(selection,go);wrap.append(footer);host.append(wrap);
  credentialPanel=createMeetingCredentialPanel(credentialHost,{companyId,onChange:()=>updateFooter(),onLogin:openCompanyLogin});
  const calendar=mountMeetingCalendar(calendarHost,{companyId});
  preflight.addEventListener("close",()=>credentialPanel?.setVisible(false));
  preflight.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  preClose.onclick=()=>{if(!busy)preflight.close();};
  cancel.onclick=()=>{if(!busy)preflight.close();};
  const controller=new AbortController();
  const dialog=document.getElementById("lc-dialog");
  dialog?.addEventListener("close",()=>{
    if(preflight.open)preflight.close();
    credentialPanel?.dispose();calendar?.dispose();controller.abort();
  },{signal:controller.signal});
  document.addEventListener("sales:proposal-stage-hidden",e=>{
    if(e.detail?.companyId===companyId)credentialPanel?.setVisible(false);
  },{signal:controller.signal});
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
    const n=visibleCandidates().length;
    count.textContent=n+"件を商談に表示";
    selectionHelp.textContent=n?
      "社内一覧では各30件まで確認できます。商談へ共有するのは先頭30件までで、企業ログインは商談後でも発行できます。":
      "候補がなくても、会社紹介から商談を開始できます。";
    go.disabled=busy;
    // Sales's own session must not depend on a business contact or login.
    // Only an external company login is gated on an issued company account.
    begin.disabled=go.disabled;
    beginTop.disabled=begin.disabled;
    preClose.disabled=busy;cancel.disabled=busy;
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
      notice("検索結果は最大各30件を表示します。商談へ共有するのは最大30件です。");
    }catch(err){failure=err?.hint||err?.message||"検索できませんでした。再実行してください。";}
    finally{
      busy=false;search.disabled=false;showAI.disabled=false;draw();
      if(failure)notice(failure);
      else if(!canShare)notice("この企業は公開できない状態です。営業側の企業状態を確認してください。");
      else notice("検索は直近の登録候補からの参考結果です。条件を確認して選んでください。");
    }
  };
  async function prepareSession(){
    const chosen=visibleCandidates();
    const shared=await API.api("/api/sales/meeting-visible-publish",{
      method:"POST",
      body:{companyId,items:chosen.map(({kind,id})=>({kind,id})),confirmed:true}
    });
    if(!shared?.ok||!Array.isArray(shared.keys))throw Error("公開対象の確認が完了しませんでした");
    const sessionResponse=await API.api("/api/sales/meeting-session",{
      method:"POST",body:{companyId,selectedKeys:shared.keys}
    });
    const sessionId=sessionResponse?.session?.id;
    if(!UUID.test(sessionId||""))throw Error("商談セッションを開始できませんでした");
    document.dispatchEvent(new CustomEvent("sales:proposal-prepared",{detail:{companyId}}));
    if(onPublished)onPublished(chosen);
    return {sessionId,chosen,shared};
  }
  // Explicit button in the credentials panel: publish selected visible rows BEFORE
  // opening the company login. Otherwise users land on an empty page with no session.
  async function openCompanyLogin(rawUrl,mode){
    if(busy||!canShare||!loadedState)return;
    if(!(credentialPanel?.state()?.active?.length>0)){
      preMessage.textContent="企業ログインの発行完了後に商談用の候補を共有してください。";
      return;
    }
    const tab=mode==="open"?window.open("about:blank","_blank"):null;
    if(tab){tab.opener=null;tab.document.title="企業商談の準備";tab.document.body.textContent="候補を確認中です…";}
    busy=true;updateFooter();
    preMessage.textContent="表示中の候補を公開可能か確認しています…";
    try{
      const prepared=await prepareSession();
      const url=new URL(rawUrl);
      const next="/business/meeting?companyId="+encodeURIComponent(companyId)+
        "&session="+encodeURIComponent(prepared.sessionId);
      url.searchParams.set("next",next);
      if(mode==="copy"){
        await navigator.clipboard.writeText(url.href);
        preMessage.textContent=prepared.shared.keys.length+"件の公開候補を準備し、企業ログインURLをコピーしました。";
      }else if(tab&&!tab.closed){
        tab.location.replace(url.href);
        preMessage.textContent=prepared.shared.keys.length+"件の公開候補を準備しました。企業ログイン画面を開いています。";
      }else{
        // Browser may block popups; offer a safe explicit link without secrets.
        const a=document.createElement("a");
        a.href=url.href;a.target="_blank";a.rel="noopener noreferrer";
        a.textContent="準備した企業ログインを開く";
        preMessage.replaceChildren(a);
      }
    }catch(error){
      if(tab&&!tab.closed)tab.close();
      preMessage.textContent=error?.hint||error?.message||"候補を準備できませんでした。";
    }finally{busy=false;updateFooter();}
  }
  go.onclick=()=>{
    if(busy)return;
    preMessage.textContent="企業ログインIDと専用URLは商談STEP1で案内します。既存パスワードの再表示・自動変更は行いません。商談はすぐ開始できます。";
    // Corporate credentials belong to Step 4 of the Sales navigator,
    // never in this single-action meeting-preparation popup.
    if(!preflight.open)preflight.showModal();
    API.api("/api/sales/company-portal?"+new URLSearchParams({companyId}))
      .then(d=>{idLabel.textContent="企業ID："+String(d?.portal?.displayId||"確認中");})
      .catch(()=>{idLabel.textContent="企業ID：後で確認";});
  };
  begin.onclick=async()=>{
    if(busy||!preflight.open)return;
    const companyLoginReady=Boolean(credentialPanel?.state()?.active?.length);
    if(!companyLoginReady)preMessage.textContent="担当者・メール未登録でも社内商談を開始できます。企業ログインは後から発行できます。";
    const chosen=visibleCandidates();
    // この明示操作で候補の公開承認と商談開始を行う。
    // Synchronously open a separate tab from the user's click to avoid popup blockers.
    const tab=window.open("about:blank","_blank");
    if(tab){tab.opener=null;tab.document.title="商談画面を準備中";tab.document.body.textContent="商談画面を準備しています…";}
    busy=true;go.disabled=true;begin.disabled=true;beginTop.disabled=true;cancel.disabled=true;preClose.disabled=true;
    notice("表示中の"+chosen.length+"件を公開可能な範囲で照合・保存しています…");
    preMessage.textContent="商談画面を準備しています…";
    try{
      // 日時が入力されている場合は先にSalesへ保存。空欄なら日時未定で進める。
      // 日時登録は任意であり、失敗しても社内商談をブロックしない。
      try{await calendar?.saveIfFilled();}catch(error){
        notice("カレンダー登録は未完了です："+(error?.hint||"後で予定を確認してください。"));
      }
      let sessionId=null,sharedCount=0,staffOnly=false,sharingIssue="";
      try{
        if(!loadedState||!canShare)throw Error("候補の公開確認が未完了のため、社内参考候補を表示します。");
        const prepared=await prepareSession();
        sessionId=prepared.sessionId;sharedCount=prepared.shared.keys.length;
        if(sharedCount===0)staffOnly=true;
      }catch(error){
        // Public sharing is distinct from staff-only meeting preparation.
        // Fallback must never expose unapproved assets to business accounts.
        sharingIssue=error?.hint||error?.message||"公開候補を保存できませんでした";
        const internal=await API.api("/api/sales/meeting-session",{
          method:"POST",body:{companyId,selectedKeys:[]}
        });
        if(!UUID.test(internal?.session?.id||""))throw Error("社内商談のセッションを開始できませんでした。");
        sessionId=internal.session.id;staffOnly=true;
      }
      // 営業側はGWのSales認証をそのまま利用する。企業側は別のログインが必要。
      const staffUrl=new URL("/sales/company-meeting.html",window.location.origin);
      staffUrl.searchParams.set("sessionId",sessionId);
      staffUrl.searchParams.set("companyId",companyId);
      if(staffOnly)staffUrl.searchParams.set("staffPreview","1");
      notice(staffOnly?
        "社内商談を開始しました。公開候補の準備は未完了です："+sharingIssue:
        sharedCount+"件の公開確認が完了しました。"+(companyLoginReady?"企業とも進行を共有できます。":"社内商談を開始します。企業ログインは後から準備できます。"));
      if(preflight.open)preflight.close();
      credentialPanel?.setVisible(false);
      if(tab)tab.location.replace(staffUrl.href);
      else window.location.assign(staffUrl.href);
    }catch(err){
      if(tab)tab.close();
      const warning=err?.hint||err?.message||"商談候補を準備できませんでした。";
      notice(warning);preMessage.textContent=warning;
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
