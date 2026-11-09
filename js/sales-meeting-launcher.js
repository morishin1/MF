/* Sales dashboard meeting launcher: existing company or official-API new registration. */
(() => {
  "use strict";
  const dialog=document.getElementById("db-meeting-dialog");
  if(!dialog)return;
  const $=id=>document.getElementById(id);
  const input=$("db-meeting-search"),segment=$("db-meeting-segment");
  const results=$("db-meeting-results"),status=$("db-meeting-status");
  const previous=$("db-meeting-prev"),next=$("db-meeting-next");
  const existingPanel=$("db-meeting-existing-panel"),newPanel=$("db-meeting-new-panel");
  const existingChoice=$("db-meeting-existing-choice"),newChoice=$("db-meeting-new-choice");
  const newSearch=$("db-meeting-new-search"),newResults=$("db-meeting-new-results");
  const newStatus=$("db-meeting-new-status"),newConfirm=$("db-meeting-new-confirm");
  const newWebsite=$("db-meeting-new-website"),newRegister=$("db-meeting-new-register");
  const newFacts=$("db-meeting-new-facts"),newFind=$("db-meeting-new-find");
  let page=1,sequence=0,newSequence=0,timer=null,restoreFocus=null,mode=null;
  let selectedOfficial=null,requestKey=null,submitting=false,registrationOnly=false;

  const text=(tag,value,cls="")=>{
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    el.textContent=String(value==null?"":value);
    return el;
  };
  const setStatus=message=>{status.textContent=message;};
  const setNewStatus=message=>{newStatus.textContent=message;};
  const companyLink=r=>{
    if(r.companyId){
      const params=new URLSearchParams({companyId:r.companyId});
      if(!registrationOnly)params.set("meeting","info");
      return "/sales/company-segments.html?"+params.toString();
    }
    return r.salesId?"/sales/companies.html?id="+encodeURIComponent(r.salesId):"";
  };
  function renderExisting(rows){
    results.replaceChildren();
    if(!rows.length){
      results.append(text("p","該当する企業がありません。検索条件や区分を変更してください。","db-meeting-empty"));
      return;
    }
    for(const r of rows){
      const row=document.createElement("div");row.className="db-meeting-result";
      const details=document.createElement("div");details.className="db-meeting-result-info";
      details.append(text("strong",r.name||"企業名未登録"));
      const labels=[];
      if(r.statusLabel)labels.push(r.statusLabel);
      if(r.owner)labels.push("担当："+r.owner);
      if(r.lastContact)labels.push("最終接点："+String(r.lastContact).slice(0,10));
      details.append(text("small",labels.join(" ／ ")||"企業情報を確認してください。"));
      if(!r.companyId)details.append(text("small","ENGER企業ID未連携：先に企業情報を確認してください。","db-meeting-warn"));
      if(r.blocked)details.append(text("small","NG・連絡先の要確認あり。先に企業情報を確認してください。","db-meeting-warn"));
      const link=companyLink(r);
      if(link){
        const action=document.createElement("a");
        action.href=link;action.className="db-meeting-go";
        action.textContent=r.companyId&&!r.blocked?"商談フローへ":"企業情報を確認";
        action.setAttribute("aria-label",String(r.name||"企業")+"の"+action.textContent);
        row.append(details,action);
      }else row.append(details,text("span","操作不可","db-meeting-unavailable"));
      results.append(row);
    }
  }
  async function loadExisting(){
    const n=++sequence;
    const params=new URLSearchParams({
      segment:segment.value,q:input.value.trim().slice(0,100),page:String(page),
      sort:"name",direction:"asc"
    });
    previous.disabled=next.disabled=true;
    setStatus("企業リストを検索中…");results.replaceChildren();
    try{
      const data=await API.api("/api/sales/company-lifecycle?"+params.toString());
      if(n!==sequence||!dialog.open||mode!=="existing")return;
      if(!data.complete||!Array.isArray(data.rows)||!Number.isFinite(Number(data.selectedCount)))
        throw Error("企業リストを確認できませんでした。");
      renderExisting(data.rows);
      const count=Number(data.selectedCount);
      $("db-meeting-page").textContent=count?(page+" / "+Math.max(1,Math.ceil(count/50))+"ページ"):"0件";
      previous.disabled=page<=1;next.disabled=page*50>=count;
      setStatus(count.toLocaleString("ja-JP")+"社が該当します。企業を選ぶと商談準備へ進みます。");
    }catch(error){
      if(n!==sequence||!dialog.open||mode!=="existing")return;
      results.append(text("p",error?.hint||"企業リストを取得できませんでした。再検索してください。","db-meeting-empty"));
      $("db-meeting-page").textContent="未取得";
      setStatus("企業リストを取得できませんでした。");
    }
  }
  function clearNewSelection(){
    selectedOfficial=null;requestKey=null;
    newConfirm.hidden=true;newRegister.disabled=false;
    newFacts.replaceChildren();newWebsite.value="";
  }
  function chooseMode(nextMode){
    if(!["existing","new"].includes(nextMode))return;
    mode=nextMode;sequence++;newSequence++;
    existingPanel.hidden=mode!=="existing";newPanel.hidden=mode!=="new";
    existingChoice.setAttribute("aria-pressed",String(mode==="existing"));
    newChoice.setAttribute("aria-pressed",String(mode==="new"));
    if(mode==="existing"){
      page=1;input.value="";segment.value="all";
      void loadExisting();input.focus();
    }else{
      clearNewSelection();newResults.replaceChildren();
      newSearch.value="";setNewStatus("企業名または13桁の法人番号を入力してください。");
      newSearch.focus();
    }
  }
  const factsRow=(key,value)=>{
    newFacts.append(text("dt",key),text("dd",value||"未確認"));
  };
  function showConfirmation(company){
    selectedOfficial=company;
    requestKey=window.crypto.randomUUID();
    newFacts.replaceChildren();
    factsRow("企業名",company.name);
    factsRow("法人番号",company.corporateNumber);
    factsRow("所在地",company.address);
    factsRow("業種",company.industry);
    newWebsite.value=company.website||"";
    newConfirm.hidden=false;newRegister.disabled=false;
    setNewStatus(registrationOnly
      ?"法人番号・企業名・所在地を確認しました。登録後、企業詳細を開きます。"
      :"法人番号と企業名を確認しました。登録すると既存企業と同じ商談フローへ進みます。");
  }
  async function verifyNumber(number){
    const n=++newSequence;
    clearNewSelection();setNewStatus("公的APIで法人番号を再確認中…");
    try{
      const info=await API.api("/api/sales/meeting-company?"+new URLSearchParams({mode:"number",number}));
      if(n!==newSequence||!dialog.open||mode!=="new")return;
      if(!info.verified||!info.company)throw Error(info.hint||"公的法人番号情報を取得できませんでした。");
      if(info.company.reviewExisting)throw Error("過去登録・別テナントの企業が見つかりました。管理者が確認してください。");
      if(info.company.existingCompanyId){
        renderNewResults([info.company]);
        setNewStatus("この法人は登録済みです。既存企業を開いて商談を始めてください。");
        return;
      }
      showConfirmation(info.company);
    }catch(error){
      if(n!==newSequence||!dialog.open||mode!=="new")return;
      setNewStatus(error?.hint||error?.message||"法人番号を確認できませんでした。");
    }
  }
  function renderNewResults(rows){
    newResults.replaceChildren();
    if(!rows.length){
      newResults.append(text("p","該当企業がありません。企業名を詳しく入力するか、法人番号で検索してください。","db-meeting-empty"));
      return;
    }
    for(const r of rows){
      const row=document.createElement("div");row.className="db-meeting-api-result";
      const details=document.createElement("div");
      details.append(text("strong",r.name||"企業名未確認"));
      details.append(text("small","法人番号："+r.corporateNumber+" ／ "+(r.prefecture||r.address||"所在地未確認")));
      if(r.existingCompanyId)
        details.append(text("small","ENGERに登録済みです。新しい企業を作りません。","db-meeting-api-warn"));
      else if(r.reviewExisting)
        details.append(text("small","既存・非公開データの照合が必要です。","db-meeting-api-warn"));
      let action;
      if(r.existingCompanyId){
        action=document.createElement("a");action.href=companyLink({companyId:r.existingCompanyId});
        action.textContent="既存企業で商談";
      }else{
        action=document.createElement("button");action.type="button";action.textContent=r.reviewExisting?"要確認":"この企業を選ぶ";
        if(r.reviewExisting)action.disabled=true;
        else action.addEventListener("click",()=>void verifyNumber(r.corporateNumber));
      }
      row.append(details,action);newResults.append(row);
    }
  }
  async function searchNew(){
    const query=newSearch.value.trim(),n=++newSequence;
    clearNewSelection();newResults.replaceChildren();
    const isNumber=/^[0-9]{13}$/.test(query);
    if(!isNumber&&query.length<2){
      setNewStatus("企業名は2文字以上、または法人番号13桁で入力してください。");
      return;
    }
    newFind.disabled=true;setNewStatus("国税庁・gBizINFOの企業情報を検索中…");
    try{
      const params=new URLSearchParams(isNumber?{mode:"number",number:query}:{mode:"name",name:query});
      const info=await API.api("/api/sales/meeting-company?"+params);
      if(n!==newSequence||!dialog.open||mode!=="new")return;
      if(isNumber){
        if(!info.verified||!info.company)throw Error(info.hint||"法人番号を確認できませんでした。");
        renderNewResults([info.company]);
        if(!info.company.existingCompanyId&&!info.company.reviewExisting)showConfirmation(info.company);
      }else renderNewResults(Array.isArray(info.results)?info.results:[]);
      if(isNumber&&info.company?.existingCompanyId)
        setNewStatus("登録済みの企業です。既存企業を開いてください。");
      else if(!isNumber)
        setNewStatus(info.results?.length?info.results.length+"社の候補が見つかりました。法人番号と所在地を確認してください。":info.hint||"該当企業がありません。");
    }catch(error){
      if(n!==newSequence||!dialog.open||mode!=="new")return;
      setNewStatus(error?.hint||error?.message||"検索できませんでした。法人番号で再検索してください。");
    }finally{newFind.disabled=false;}
  }
  async function registerNew(){
    if(submitting||!selectedOfficial||!requestKey)return;
    const c=selectedOfficial;
    if(!window.confirm(c.name+"（法人番号："+c.corporateNumber+"）を"+(registrationOnly?"登録して企業詳細を開きますか？":"登録して商談を始めますか？")))return;
    submitting=true;newRegister.disabled=true;
    setNewStatus("公式情報を確認して企業を登録中…");
    try{
      const result=await API.api("/api/sales/meeting-company",{
        method:"POST",body:{action:"register",confirmed:true,expectedName:c.name,
          corporateNumber:c.corporateNumber,website:newWebsite.value.trim(),requestKey}
      });
      if(!dialog.open||mode!=="new")return;
      if(!result.companyId||!(result.created||result.existing))throw Error("登録結果の企業IDを確認できませんでした。");
      setNewStatus(result.created
        ?(registrationOnly?"企業登録が完了しました。企業詳細を開きます。":"企業登録が完了しました。商談フローを開きます。")
        :(registrationOnly?"既存企業が見つかりました。企業詳細を開きます。":"既存企業が見つかりました。商談フローを開きます。"));
      const dest=new URLSearchParams({companyId:result.companyId});
      if(!registrationOnly)dest.set("meeting","info");
      window.location.assign("/sales/company-segments.html?"+dest);
    }catch(error){
      setNewStatus(error?.hint||error?.message||"登録できませんでした。重複操作せず、既存企業を確認してください。");
    }finally{submitting=false;newRegister.disabled=false;}
  }
  function open({registration=false}={}){
    if(dialog.open)return;
    registrationOnly=registration;
    restoreFocus=document.activeElement;mode=null;sequence++;newSequence++;
    existingPanel.hidden=true;newPanel.hidden=true;
    existingChoice.setAttribute("aria-pressed","false");newChoice.setAttribute("aria-pressed","false");
    $("db-meeting-title").textContent=registration?"企業追加・公的法人検索":"商談する企業を選ぶ";
    newRegister.textContent=registration?"この企業を登録する":"この企業を登録して商談を始める";
    clearNewSelection();dialog.showModal();
    if(registration)chooseMode("new");
    else existingChoice.focus();
  }
  window.SalesMeetingLauncher={openCompanyAdd:()=>open({registration:true})};
  document.querySelectorAll("[data-meeting-launch]").forEach(button=>button.addEventListener("click",()=>open()));
  existingChoice.addEventListener("click",()=>chooseMode("existing"));
  newChoice.addEventListener("click",()=>chooseMode("new"));
  $("db-meeting-close").addEventListener("click",()=>dialog.close());
  dialog.addEventListener("close",()=>{
    sequence++;newSequence++;clearTimeout(timer);
    if(registrationOnly){
      const url=new URL(location.href);
      if(url.searchParams.get("companyAdd")==="1"){
        url.searchParams.delete("companyAdd");
        history.replaceState(history.state,"",url);
      }
    }
    registrationOnly=false;
    if(restoreFocus?.isConnected)restoreFocus.focus();
  });
  dialog.addEventListener("click",e=>{if(e.target===dialog)dialog.close();});
  input.addEventListener("input",()=>{
    clearTimeout(timer);page=1;timer=setTimeout(()=>{if(mode==="existing")void loadExisting();},300);
  });
  segment.addEventListener("change",()=>{page=1;if(mode==="existing")void loadExisting();});
  $("db-meeting-search-form").addEventListener("submit",e=>{
    e.preventDefault();clearTimeout(timer);page=1;if(mode==="existing")void loadExisting();
  });
  previous.addEventListener("click",()=>{if(page>1&&mode==="existing"){page--;void loadExisting();}});
  next.addEventListener("click",()=>{if(mode==="existing"){page++;void loadExisting();}});
  $("db-meeting-new-search-form").addEventListener("submit",e=>{e.preventDefault();void searchNew();});
  newRegister.addEventListener("click",()=>void registerNew());
})();