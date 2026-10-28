// Marketing feature health: read-only states from the actual authorized API responses.
// Never guesses data counts, never writes to the DB, never shows a green status before success.
(function(){
  "use strict";
  const labels={pr:"PR原稿保存",production:"制作・PR一覧",intake:"問い合わせ受付",analytics:"効果計測"};
  const statuses={pr:{state:"checking"},production:{state:"checking"},intake:{state:"checking"},analytics:{state:"unconnected"}};
  const labelOf={checking:"確認中",ok:"利用可能",not_ready:"保存先未準備",forbidden:"権限なし",failed:"接続エラー",unconnected:"未接続",partial:"一部利用可能"};
  function render(){
    const root=document.getElementById("marketing-connection-summary");
    if(!root)return;
    root.replaceChildren();
    const lead=document.createElement("span");
    lead.className="mkcs-label";lead.textContent="機能の接続状況";
    root.append(lead);
    for(const key of Object.keys(labels)){
      const item=document.createElement("span");
      const state=statuses[key].state;
      item.className="mkcs-item mkcs-"+state;
      item.setAttribute("data-connection",key);
      const title=document.createElement("span");
      title.textContent=labels[key]+"：";
      const value=document.createElement("strong");
      value.textContent=labelOf[state]||"確認が必要";
      item.append(title,value);
      if(statuses[key].hint)item.title=statuses[key].hint;
      root.append(item);
    }
    const link=document.createElement("button");
    link.type="button";link.className="mkcs-more";
    link.textContent="接続状況を再確認";
    link.onclick=()=>{
      // Only a GET. Recheck the separate intake service; the other three results
      // come from the normal page/composer loaders to avoid resetting editor data.
      checkIntake();
      document.getElementById("mkt-tab-pr")?.click();
    };
    root.append(link);
  }
  const normalized=(err)=>{
    const code=err?.body?.error||err?.code||"";
    const status=err?.status||err?.statusCode;
    if(status===401||status===403||code==="forbidden"||code==="unauthorized")return "forbidden";
    if(status===503||code==="not_ready"||code==="db_not_ready")return "not_ready";
    return "failed";
  };
  function set(name,state,hint=""){
    if(!Object.hasOwn(labels,name))return;
    if(!Object.hasOwn(labelOf,state))state="failed";
    statuses[name]={state,hint:String(hint||"").slice(0,160)};
    render();
  }
  async function checkIntake(){
    set("intake","checking");
    try{
      const result=await window.API.api("/api/marketing/intake");
      set("intake",Array.isArray(result?.items)?"ok":"partial",
        Array.isArray(result?.items)?"問い合わせ台帳の読み取りができました":"台帳の読み取り結果を確認してください");
    }catch(err){set("intake",normalized(err),err?.body?.hint||"問い合わせ受付画面で状況を確認してください");}
  }
  window.MarketingStatusUI={set,normalized,checkIntake,render};
})();
