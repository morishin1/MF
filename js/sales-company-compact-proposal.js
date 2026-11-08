import {createMeetingCredentialPanel} from "./sales-company-meeting-credentials.js?v=20261108credentials1";
import {mountMeetingCalendar} from "./sales-company-meeting-calendar.js?v=20261108gcal1";
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
  const selected=new Map(),existing=new Map();
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
  const hint=mk("small","AI分析済みならおすすめ候補を、未分析ならENGERの登録候補を表示します。候補をチェックして商談へ進めます。");
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
  const preTitle=mk("h2","商談の準備","");preTitle.id="lp-meeting-preflight-title";
  const preClose=mk("button","×","lp-meeting-preflight-close");
  preClose.type="button";preClose.setAttribute("aria-label","閉じる");
  preHead.append(preTitle,preClose);
  const preInfo=mk("p","日時の登録は任意です。必要であればGoogleカレンダーに追加し、その後商談画面を開きます。","lp-meeting-preflight-intro");
  const calendarHost=mk("section",null,"lp-calendar-host");
  const loginDetails=mk("details",null,"lp-meeting-login-details");
  const loginSummary=mk("summary","企業ログインの確認・発行（必要な場合）");
  const credentialHost=mk("section",null,"lp-compact-credential-host");
  credentialHost.hidden=true;
  loginDetails.append(loginSummary,credentialHost);
  const preMessage=mk("p","","lp-meeting-preflight-status");
  preMessage.setAttribute("role","status");preMessage.setAttribute("aria-live","polite");
  const preActions=mk("div",null,"lp-meeting-preflight-actions");
  const cancel=mk("button","戻る","lp-meeting-preflight-cancel");cancel.type="button";
  const begin=mk("button","商談画面を開く","lp-meeting-preflight-next");begin.type="button";
  preActions.append(cancel,begin);
  preflight.append(preHead,preInfo,calendarHost,loginDetails,preMessage,preActions);
  wrap.append(preflight);
  let credentialPanel=null;
  const footer=mk("footer",null,"lp-compact-footer");
  const selection=mk("div",null,"lp-compact-selection");
  const count=mk("strong","0件選択"),selectionHelp=mk("small","提案する候補を選ぶと商談に進めます。");
  selection.append(count,selectionHelp);
  const go=mk("button","商談","lp-compact-go");go.type="button";go.disabled=true;
  footer.append(selection,go);wrap.append(footer);host.append(wrap);
  credentialPanel=createMeetingCredentialPanel(credentialHost,{companyId,onChange:()=>updateFooter()});
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
  document.addEventListener("sales:proposal-stage-shown",e=>{
    if(e.detail?.companyId===companyId)credentialPanel?.setVisible(selected.size>0);
  },{signal:controller.signal});
  function notice(text){message.textContent=text||"";}
  function keyFor(item){return item.kind+":"+item.id;}
  function updateFooter(){
    count.textContent=selected.size+"件選択";
    selectionHelp.textContent=selected.size?
      "公開内容を確認して商談開始。企業は事前に別アカウントでログインします。":
      "案件・人材にチェックを入れてください（最大10件）。";
    go.disabled=!loadedState||!canShare||busy||selected.size<1||selected.size>10;
    begin.disabled=go.disabled;preClose.disabled=busy;cancel.disabled=busy;
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
      const sourceList=mode==="recommended"?(rec[which].length?rec[which]:starter[which]):results[which];
      const list=mode==="recommended"&&!expanded?sourceList.slice(0,3):sourceList;
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
      if(mode==="recommended"&&sourceList.length>3){
        const more=mk("button",expanded?"上位3件へ戻す":"もっと見る（全"+sourceList.length+"件）","lp-compact-secondary lp-ai-more");
        more.type="button";more.onclick=()=>{expanded=!expanded;draw();};section.append(more);
      }
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
  go.onclick=()=>{
    if(busy||!canShare||!selected.size||selected.size>10)return;
    preMessage.textContent="今回の候補は公開前に稼働状況・募集継続・商流を確認してください。";
    credentialPanel?.setVisible(true);
    if(!preflight.open)preflight.showModal();
  };
  begin.onclick=async()=>{
    if(busy||!preflight.open||!canShare||!selected.size||selected.size>10)return;
    const chosen=[...selected.values()];
    // この明示操作で候補の公開承認と商談開始を行う。
    // Synchronously open a separate tab from the user's click to avoid popup blockers.
    const tab=window.open("about:blank","_blank");
    if(tab){tab.opener=null;tab.document.title="商談画面を準備中";tab.document.body.textContent="商談画面を準備しています…";}
    busy=true;go.disabled=true;begin.disabled=true;cancel.disabled=true;preClose.disabled=true;
    notice("選んだ"+chosen.length+"件の公開可能性を照合・保存しています…");
    preMessage.textContent="商談画面を準備しています…";
    let done=0;
    try{
      // 日時が入力されている場合は先にSalesへ保存。空欄なら日時未定で進める。
      await calendar?.saveIfFilled();
      for(const item of chosen){
        await API.api("/api/sales/company-shortlist",{method:"POST",body:{
          companyId,itemType:item.kind,itemId:item.id,action:"publish",confirmed:true
        }});
        done++;
      }
      // 公開済みの選択候補をサーバで再照合して、企業別の共有商談セッションを開始する。
      const sessionResponse=await API.api("/api/sales/meeting-session",{
        method:"POST",body:{companyId,selectedKeys:chosen.map(x=>x.kind+":"+x.id)}
      });
      const sessionId=sessionResponse?.session?.id;
      if(!UUID.test(sessionId||""))throw Error("商談セッションを開始できませんでした。");
      // 営業側はGWのSales認証をそのまま利用する。企業側は別のログインが必要。
      const staffUrl=new URL("/sales/company-meeting.html",window.location.origin);
      staffUrl.searchParams.set("sessionId",sessionId);
      staffUrl.searchParams.set("companyId",companyId);
      staffUrl.searchParams.set("selection",chosen.map(x=>x.kind+":"+x.id).join(","));
      notice(chosen.length+"件の公開承認が完了しました。双方で進行を共有する商談画面を開きます。");
      document.dispatchEvent(new CustomEvent("sales:proposal-prepared",{detail:{companyId}}));
      if(onPublished)onPublished(chosen);
      if(preflight.open)preflight.close();
      credentialPanel?.setVisible(false);
      if(tab)tab.location.replace(staffUrl.href);
      else window.location.assign(staffUrl.href);
    }catch(err){
      if(tab)tab.close();
      const warning=(err?.hint||err?.message||"商談候補を準備できませんでした。")+
        (done?" "+done+"件の公開保存は完了しています。状態を再確認してから実行してください。":"");
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
       starter.talent=d.rows.slice(0,12).map(x=>candidate("talent",x,"search")).filter(Boolean);
    }));
  }
  if(!rec.job.length){
    pending.push(API.api("/api/sales/company-shortlist?"+
      new URLSearchParams({companyId,mode:"search",type:"job",tab:"all"})).then(d=>{
       if(!Array.isArray(d.rows))throw Error("案件候補を取得できませんでした");
       starter.job=d.rows.slice(0,12).map(x=>candidate("job",x,"search")).filter(Boolean);
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
