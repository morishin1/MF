import {renderLocalAIControls} from "./sales-company-local-ai-ui.js?v=20261107info4";
import {createOfficialCompanyUI} from "./sales-company-official-ui.js?v=20261107official1";
const $ = id => document.getElementById(id);
const api = path => window.API.api(path);
export function createCompanyAIInfoToolbar(){
  let selected=null;
  let exporting=false,analyzing=false;
  const official=createOfficialCompanyUI({onSaved:detail=>{
    window.dispatchEvent(new CustomEvent("sales:companyOfficialSaved",{detail}));
  }});
  const buttons=["lc-ai-auto","lc-ai-export","lc-ai-import","lc-ai-gbiz"];
  const setSelected=(r)=>{
    selected=r?.companyId?{id:r.companyId,name:String(r.name||"")}:null;
    official.setSelected(selected);
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
  async function analyzeViaAPI(){
    if(!selected||analyzing)return;
    const company={...selected};analyzing=true;
    const button=$("lc-ai-auto");if(button)button.disabled=true;
    $("lc-ai-quick-status").textContent="企業DB・受領情報をAIが分析しています…";
    try{
      const result=await api("/api/sales/company-ai-auto",{method:"POST",body:{companyId:company.id}});
      if(selected?.id!==company.id||!result?.ok||!result.json)return;
      importResult();
      const textArea=$("lp-ai-result");
      if(textArea){
        textArea.value=result.json;
        textArea.dispatchEvent(new Event("input",{bubbles:true}));
        $("lp-ai-preview")?.click();
      }
      $("lc-ai-quick-status").textContent="AI分析を作成しました。差分・マッチング項目を確認してから保存してください。";
    }catch(e){
      if(selected?.id===company.id)$("lc-ai-quick-status").textContent=e?.hint||"APIで分析できませんでした。MD出力も利用できます。";
    }finally{analyzing=false;if(button)button.disabled=!selected;}
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
    official.open({openSearch:true});
    $("lc-ai-quick-status").textContent=
      "選択中の企業名でgBizINFOを検索しています。法人番号・所在地を確認して登録してください。";
  }
  $("lc-ai-auto")?.addEventListener("click",()=>void analyzeViaAPI());
  $("lc-ai-export")?.addEventListener("click",()=>void exportMd());
  $("lc-ai-import")?.addEventListener("click",importResult);
  $("lc-ai-gbiz")?.addEventListener("click",openGbiz);
  // The company registration pane is generated after the detail API loads.
  $("lc-dialog")?.addEventListener("click",event=>{
    const btn=event.target.closest("[data-official-number]");
    if(!btn||!selected)return;
    official.open({number:$("lc-corporate-number")?.value?.trim()||""});
  });
  $("lc-ai-close")?.addEventListener("click",()=>$("lc-ai-dialog")?.close());
  $("lc-ai-dialog")?.addEventListener("click",e=>{
    if(e.target===$("lc-ai-dialog"))$("lc-ai-dialog").close();
  });
  return {setSelected};
}
