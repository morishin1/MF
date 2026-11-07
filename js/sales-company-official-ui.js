// Company corporate-number lookup and verified basic-info update dialog.
// gBizINFO official REST API requires a server token; never invent lookup results.
const $=id=>document.getElementById(id);
const esc=v=>String(v??"");
const VALID=/^[0-9]{13}$/;
const officialUrl=number=>VALID.test(number)?"https://info.gbiz.go.jp/hojin/ichiran?hojinBango="+number:"https://info.gbiz.go.jp/";
function webSearch(name){
  const q='site:info.gbiz.go.jp/hojin/ichiran "'+String(name||"").trim().slice(0,150)+'"';
  return "https://www.google.com/search?"+new URLSearchParams({q});
}
function element(tag,content,className=""){
  const n=document.createElement(tag);n.textContent=String(content??"");
  if(className)n.className=className;
  return n;
}
function link(name,url){
  const a=document.createElement("a");a.textContent=name;a.href=url;a.target="_blank";a.rel="noopener noreferrer";
  return a;
}
export function createOfficialCompanyUI({onSaved=()=>{}}={}){
  const dlg=$("lc-gbiz-dialog");
  if(!dlg)return {setSelected:()=>{},open:()=>{}};
  let selected=null,current=null,confirmedPreview=null,serial=0,busy=false;
  const status=message=>{$("lc-gbiz-status").textContent=message;};
  const setSave=()=>{$("lc-gbiz-save").disabled=busy||!confirmedPreview;};
  function setSelected(value){
    selected=value?.id?{id:value.id,name:String(value.name||"")}:null;
  }
  function selectionLive(id,n){return selected?.id===id&&serial===n&&dlg.open;}
  function renderState(state){
    current=state.company;
    $("lc-gbiz-current").textContent="現在の法人番号："+(current.corporateNumber||"未登録")+
      " ／ 企業名："+current.name+" ／ 所在地："+(current.address||"未登録");
    if(!$("lc-gbiz-number").value)$("lc-gbiz-number").value=current.corporateNumber||"";
  }
  function invalidate(){
    confirmedPreview=null;
    $("lc-gbiz-preview").replaceChildren();
    $("lc-gbiz-mismatch-line").hidden=true;
    $("lc-gbiz-manual-line").hidden=true;
    setSave();
  }
  function renderCandidates(rows){
    const host=$("lc-gbiz-results");host.replaceChildren();
    if(!rows.length){host.append(element("p","APIから候補を取得できませんでした。公式サイトで社名・所在地を照合してください。","lc-gbiz-muted"));return;}
    for(const r of rows){
      const node=element("div","","lc-gbiz-result");
      const content=element("div","","lc-gbiz-result-text");
      content.append(element("strong",r.name||"法人名未取得"),
        element("small","法人番号："+r.corporateNumber),
        element("small","所在地："+(r.address||"未取得")));
      const btn=element("button","この法人番号を使う");btn.type="button";
      btn.addEventListener("click",()=>{
        $("lc-gbiz-number").value=r.corporateNumber;
        invalidate();void previewNumber();
      });
      node.append(content,btn);host.append(node);
    }
  }
  async function searchName(){
    if(!selected||busy)return;
    const id=selected.id,n=serial;
    const name=$("lc-gbiz-name").value.trim();
    if(!name){status("企業名を入力してください。");return;}
    busy=true;setSave();status("登録法人の候補を照合しています…");
    $("lc-gbiz-web-search").href=webSearch(name);
    try{
      const response=await API.api("/api/sales/company-official?"+new URLSearchParams({
        companyId:id,mode:"search",name
      }));
      if(!selectionLive(id,n))return;
      renderCandidates(response.results||[]);
      status(response.hint||"法人名と所在地が一致する候補を選んでください。");
      if(!response.configured){
        $("lc-gbiz-api-note").textContent=
          "gBizINFO APIトークン未設定：公式サイト掲載ページの検索（Google経由）と法人番号の手動登録を利用できます。基本情報の自動補完にはAPI設定が必要です。";
      }else{
        $("lc-gbiz-api-note").textContent="gBizINFOの検索結果です。社名一致だけで登録しないでください。";
      }
    }catch(e){if(selectionLive(id,n))status(e?.hint||"gBizINFO検索に接続できませんでした。");}
    finally{busy=false;setSave();}
  }
  function drawPreview(d){
    const host=$("lc-gbiz-preview");host.replaceChildren();
    const official=d.official;
    host.append(element("strong",d.verified?"公式APIの照合結果":"法人番号の手動登録"));
    host.append(link("gBizINFOで法人番号の公式プロフィールを開く",d.profileUrl||officialUrl(d.number)));
    if(d.verified){
      const h=element("div","","lc-gbiz-diff");
      for(const row of d.diff||[]){
        if(!row.official)continue;
        const div=element("div","","lc-gbiz-diff-row");
        div.append(element("b",({name:"法人名",address:"本店所在地",website:"ホームページ",industry:"業種",prefecture:"都道府県"}[row.field]||row.field)),
          element("small","現在："+(row.before||"未登録")),
          element("small","公式："+row.official));
        if(d.patch?.[row.field])div.append(element("small","更新予定","lc-gbiz-change"));
        h.append(div);
      }
      host.append(h);
    }else{
      host.append(element("p",d.note||"APIが未接続です。法人番号のみ登録します。","lc-gbiz-muted"));
    }
    $("lc-gbiz-mismatch-line").hidden=!d.differentName;
    $("lc-gbiz-manual-line").hidden=!!d.verified;
  }
  async function previewNumber(){
    if(!selected||busy)return;
    const number=$("lc-gbiz-number").value.trim();
    if(!VALID.test(number)){status("法人番号は13桁の数字で入力してください。");return;}
    const n=serial,id=selected.id;
    busy=true;setSave();invalidate();status("公式の法人情報と登録情報を照合しています…");
    try{
      const result=await API.api("/api/sales/company-official",{
        method:"POST",body:{companyId:id,action:"preview",corporateNumber:number,
          overwrite:$("lc-gbiz-overwrite").checked},
      });
      if(!selectionLive(id,n))return;
      confirmedPreview=result;
      drawPreview(result);
      status(result.note);
    }catch(e){if(selectionLive(id,n))status(e?.hint||"法人番号を確認できませんでした。");}
    finally{busy=false;setSave();}
  }
  async function save(){
    if(!selected||!confirmedPreview||busy)return;
    const n=serial,id=selected.id,prev=confirmedPreview;
    if(!prev.verified&&!$("lc-gbiz-manual-check").checked){
      status("公的サイトで番号・法人名を確認したうえでチェックしてください。");return;
    }
    if(prev.differentName&&!$("lc-gbiz-mismatch-check").checked){
      status("登録名と公式法人名が異なります。別法人でないことを確認してください。");return;
    }
    busy=true;setSave();status("法人番号と基本情報を保存しています…");
    try{
      const result=await API.api("/api/sales/company-official",{method:"POST",body:{
        action:"save",companyId:id,corporateNumber:prev.number,
        expectedCorporateNumber:prev.current.corporateNumber||"",
        overwrite:$("lc-gbiz-overwrite").checked,
        previewDigest:prev.digest,
        confirmed:true,manualConfirmed:$("lc-gbiz-manual-check").checked,
        allowDifferentName:$("lc-gbiz-mismatch-check").checked,
        requestKey:crypto.randomUUID(),
      }});
      if(!selectionLive(id,n))return;
      confirmedPreview=null;setSave();
      current=result.company||current;
      status(result.hint||"基本情報を保存しました。");
      $("lc-gbiz-current").textContent="登録済み法人番号："+(current?.corporateNumber||prev.number)+
        " ／ "+(current?.name||"");
      onSaved({companyId:id,company:current,verified:result.verified});
      dlg.close();
    }catch(e){if(selectionLive(id,n))status(e?.hint||"法人番号を保存できませんでした。");}
    finally{busy=false;setSave();}
  }
  function open({number="",openSearch=false}={}){
    if(!selected)return;
    const id=selected.id,n=++serial;
    confirmedPreview=null;current=null;busy=false;
    $("lc-gbiz-title").textContent=selected.name+"｜公的法人情報";
    $("lc-gbiz-name").value=selected.name;
    $("lc-gbiz-number").value=number;
    $("lc-gbiz-overwrite").checked=false;
    $("lc-gbiz-manual-check").checked=false;
    $("lc-gbiz-mismatch-check").checked=false;
    $("lc-gbiz-api-note").textContent="gBizINFOの公式APIによる自動照合はAPIトークン設定時に有効になります。";
    $("lc-gbiz-web-search").href=webSearch(selected.name);
    $("lc-gbiz-results").replaceChildren();
    invalidate();
    status("企業名を入力済みです。公式法人情報を照合します。");
    if(!dlg.open)dlg.showModal();
    // Clicking gBiz opens an already-executed name search restricted to official company pages.
    // Not a fabricated gBizINFO direct-name deep link (none is documented for the 2026 site).
    if(openSearch)window.open(webSearch(selected.name),"_blank","noopener,noreferrer");
    void API.api("/api/sales/company-official?"+new URLSearchParams({companyId:id,mode:"state"}))
      .then(result=>{
        if(!selectionLive(id,n))return;
        renderState(result);
        if(result.configured)void searchName();
        else status("法人名を入れたgBizINFO限定検索を開きました。法人番号を確認して入力してください。");
      }).catch(e=>{if(selectionLive(id,n))status(e?.hint||"現在の企業情報を確認できませんでした。");});
  }
  $("lc-gbiz-search").addEventListener("click",()=>void searchName());
  $("lc-gbiz-verify").addEventListener("click",()=>void previewNumber());
  $("lc-gbiz-save").addEventListener("click",()=>void save());
  $("lc-gbiz-overwrite").addEventListener("change",()=>{
    invalidate();status("上書き対象が変わりました。もう一度［公式情報との差分を確認］を押してください。");
  });
  $("lc-gbiz-name").addEventListener("input",()=>{invalidate();$("lc-gbiz-web-search").href=webSearch($("lc-gbiz-name").value)});
  $("lc-gbiz-number").addEventListener("input",invalidate);
  $("lc-gbiz-close").addEventListener("click",()=>dlg.close());
  dlg.addEventListener("close",()=>{serial++;busy=false;});
  dlg.addEventListener("click",e=>{if(e.target===dlg)dlg.close()});
  return {setSelected,open};
}
