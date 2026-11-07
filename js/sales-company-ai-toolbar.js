import {renderLocalAIControls} from "./sales-company-local-ai-ui.js?v=20261107info4";
const $ = id => document.getElementById(id);
const api = path => window.API.api(path);
export function createCompanyAIInfoToolbar(){
  let selected=null;
  let exporting=false;
  const buttons=["lc-ai-export","lc-ai-import","lc-ai-gbiz"];
  const setSelected=(r)=>{
    selected=r?.companyId?{id:r.companyId,name:String(r.name||"")}:null;
    for(const id of buttons)if($(id))$(id).disabled=!selected;
    const status=$("lc-ai-quick-status");
    if(status)status.textContent=selected?"企業情報を整理し、ローカルAIで分析できます。":"ENGER企業IDの照合後に利用できます。";
  };
  function startDownload(name,text){
    const file=new Blob([text],{type:"text/markdown;charset=utf-8"});
    const url=URL.createObjectURL(file),a=document.createElement("a");
    a.href=url;a.download=name;a.style.display="none";document.body.append(a);
    a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);
  }
  async function exportMd(){
    if(!selected||exporting)return;
    const company={...selected}; exporting=true;$("lc-ai-export").disabled=true;
    $("lc-ai-quick-status").textContent="企業データを収集中…";
    try{
      const r=await api("/api/sales/company-local-ai?"+new URLSearchParams({companyId:company.id}));
      if(selected?.id!==company.id||typeof r.markdown!=="string"||!r.sourceHash)return;
      startDownload("ENGER-company-"+company.id.slice(0,8)+"-AI.md",r.markdown);
      $("lc-ai-quick-status").textContent="MDを書き出しました。ローカルAIで分析後、結果をアップロードしてください。";
    }catch(e){
      if(selected?.id===company.id)$("lc-ai-quick-status").textContent=e?.hint||"企業MDを作成できませんでした。";
    }finally{exporting=false;if($("lc-ai-export"))$("lc-ai-export").disabled=!selected;}
  }
  function importResult(){
    if(!selected)return;
    const dialog=$("lc-ai-dialog");
    const company={...selected};
    $("lc-ai-company").textContent=company.name+"｜ローカルAI分析";
    renderLocalAIControls($("lc-ai-form"),company.id,{hideExport:true});
    dialog.showModal();
  }
  function openGbiz(){
    if(!selected)return;
    // Official gBizINFO portal; no automatic fuzzy company-ID merge.
    window.open("https://info.gbiz.go.jp/","_blank","noopener,noreferrer");
    $("lc-ai-quick-status").textContent=
      "Gビズインフォで法人名・法人番号を確認してください。ENGER企業ID（UUID）とは別番号です。自動上書きはしません。";
  }
  $("lc-ai-export")?.addEventListener("click",()=>void exportMd());
  $("lc-ai-import")?.addEventListener("click",importResult);
  $("lc-ai-gbiz")?.addEventListener("click",openGbiz);
  $("lc-ai-close")?.addEventListener("click",()=>$("lc-ai-dialog")?.close());
  $("lc-ai-dialog")?.addEventListener("click",e=>{
    if(e.target===$("lc-ai-dialog"))$("lc-ai-dialog").close();
  });
  return {setSelected};
}
