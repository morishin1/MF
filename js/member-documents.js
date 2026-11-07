// Office / KEIEI 共通の契約・提出書類モーダル。追加機能は1つのボタンにまとめる。
(function () {
  const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let current=null,root=null,detail=null,summaryMap=new Map(),onUpdated=null,busy=false,summaryError=null;
  const urlFor=(id)=>"/api/member-documents?employeeId="+encodeURIComponent(id);
  const docUrl=(id,d,download)=>urlFor(id)+"&file=1&source="+encodeURIComponent(d.source)+
    "&docId="+encodeURIComponent(d.id)+(download?"&download=1":"");
  const labels={signed:"電子署名済",verified:"確認済",received:"受領・確認待ち",
    contract_unconfirmed:"契約書あり・締結未確認",record_only:"提出記録のみ（ファイル未紐付け）",
    missing:"台帳に未登録"};
  const docAction=(key)=>{
    if(key==="doc_contract")return "employment_contract";
    if(key==="doc_contract_gyomu")return "service_contract";
    if(key==="doc_resume")return "resume";
    if(key==="doc_dependents")return "dependents";
    if(key==="doc_nda")return "nda";
    return "other";
  };
  function css(){
    if(document.getElementById("member-doc-style"))return;
    const s=document.createElement("style");s.id="member-doc-style";s.textContent=
      ".md-bg{position:fixed;inset:0;z-index:900;background:rgba(27,36,64,.42)}"+
      ".md-modal{position:fixed;z-index:901;top:0;right:0;bottom:0;width:min(650px,100vw);overflow:auto;"+
        "box-shadow:-6px 0 24px #2223;background:#fafaf7;color:#1b2440;font-family:inherit}"+
      ".md-head{position:sticky;top:0;z-index:2;background:white;border-bottom:1px solid #ddd;"+
        "padding:17px 20px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px}"+
      ".md-head h2{font-size:19px;margin:0}.md-wrap{padding:16px 20px 40px}"+
      ".md-box{background:#fff;border:1px solid #e2e2dc;border-radius:11px;padding:15px;margin-bottom:12px}"+
      ".md-box h3{font-size:14px;margin:0 0 10px}.md-row{border-top:1px solid #eee;padding:9px 0;display:flex;"+
        "justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}"+
      ".md-muted{color:#6b7080;font-size:12px;line-height:1.6}.md-actions{display:flex;gap:6px;flex-wrap:wrap}"+
      ".md-btn{background:#fff;border:1px solid #c7cad4;color:#1b2440;padding:6px 11px;"+
        "border-radius:7px;font:inherit;font-size:12px;cursor:pointer;text-decoration:none}"+
      ".md-btn.primary{background:#1f5fbf;color:#fff;border-color:#1f5fbf}"+
      ".md-btn:disabled{opacity:.5;cursor:default}.md-state{font-size:11.5px;background:#efefeb;"+
        "border-radius:6px;padding:3px 7px;white-space:normal}"+
      ".md-state.warn{background:#fff2d7;color:#895500}.md-state.done{background:#e5f1e2;color:#2f6f3a}"+
      ".md-status{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}"+
      ".md-upload label{font-size:12px;font-weight:700;display:block;margin:8px 0 3px}"+
      ".md-upload select,.md-upload input{box-sizing:border-box;display:block;width:100%;padding:9px;"+
        "border:1px solid #c7cad4;border-radius:7px;background:#fff;font:inherit}"+
      ".md-error{color:#b3261e;font-size:12px;white-space:pre-wrap;margin-top:8px}"+
      ".md-mini{display:inline-block;padding:3px 7px;border:1px solid #e2e2dc;border-radius:6px;"+
        "font-size:11px;cursor:pointer;background:#fff}"+
      ".md-empty{color:#6b7080;font-size:12px;padding:8px 0}"+
      "@media(max-width:600px){.md-wrap{padding:12px 14px 24px}.md-head{padding:14px}.md-row{align-items:flex-start}}";
    document.head.appendChild(s);
  }
  const dot=(v,type)=>"<span class=\"md-state "+esc(type||"")+"\">"+esc(v)+"</span>";
  const getSummary=(id)=>summaryMap.get(id)||null;
  async function summaries(onRender){
    try{
      const r=await API.api("/api/member-documents?summary=1");
      summaryError=null;
      summaryMap=new Map((r.members||[]).map(s=>[s.employeeId,s]));
      if(typeof onRender==="function")onRender(r.members||[]);
      return r.members||[];
    }catch(e){
      summaryError=e;
      if(typeof onRender==="function")onRender([],e);
      return [];
    }
  }
  const badge=(s)=>!s?dot(summaryError?"書類情報を取得できません":"書類情報を確認中",summaryError?"warn":""):(s.requiredConfigured
    ?(!s.requiredCount?dot("個人の必須書類なし"):dot("書類 "+s.receivedCount+"/"+s.requiredCount+"件"+(s.missingCount?"・未登録 "+s.missingCount:"")+(s.reviewCount?"・要確認 "+s.reviewCount:""),s.missingCount||s.reviewCount?"warn":"done")
    ):dot("必要書類の基準未設定","warn"));
  function open(id,opts={}){
    if(!id)return;
    close();css();
    current=id;detail=null;onUpdated=opts.onUpdated||null;
    root=document.createElement("div");root.id="member-doc-root";
    root.innerHTML="<div class=\"md-bg\" onclick=\"MemberDocs.close()\"></div>"+
      "<aside class=\"md-modal\" role=\"dialog\" aria-modal=\"true\" aria-label=\"契約・書類\" tabindex=\"-1\">"+
      "<div class=\"md-head\"><div><h2>契約・提出書類</h2><div class=\"md-muted\">メンバーの原本をまとめて確認します</div></div>"+
      "<button class=\"md-btn\" onclick=\"MemberDocs.close()\">閉じる</button></div>"+
      "<div class=\"md-wrap\" id=\"md-main\"><div class=\"md-empty\">読み込み中…</div></div></aside>";
    document.body.appendChild(root);root.querySelector(".md-modal").focus();
    refresh();
  }
  function close(){if(root)root.remove();root=null;current=null;detail=null;busy=false;}
  async function refresh(){
    if(!root||!current)return;
    const id=current;
    try{
      const r=await API.api(urlFor(id));
      if(current!==id||!root)return;
      detail=r;draw();
    }catch(e){if(root&&current===id)root.querySelector("#md-main").innerHTML=
      "<div class=\"md-box md-error\">"+esc(e.hint||e.message||"読み込めませんでした")+"</div>";}
  }
  function draw(){
    if(!root||!detail)return;
    const s=detail.summary,e=detail.employee;
    const required=(s.required||[]).filter(x=>x.state!=="signed"&&x.state!=="verified");
    const reqLine=(x)=>{
      const label=labels[x.state]||x.state;
      return "<div class=\"md-row\"><div><b>"+esc(x.label)+"</b><div class=\"md-muted\">"+esc(label)+"</div></div>"+
        "<div class=\"md-actions\">"+(detail.uploadReady&&x.state==="missing"?
          "<button class=\"md-btn\" onclick=\"MemberDocs.showUpload('"+esc(docAction(x.key))+"')\">追加する</button>":"")+
        "</div></div>";
    };
    const documents=(group)=>{
      const found=(detail.documents||[]).filter(d=>d.group===group&&d.hasFile);
      return found.length?found.map(d=>"<div class=\"md-row\"><div style=\"min-width:0;flex:1\">"+
        "<div style=\"font-size:13px;font-weight:700;overflow-wrap:anywhere\">"+esc(d.title)+"</div>"+
        "<div class=\"md-muted\">"+esc(d.filename)+"　"+esc(d.status)+(d.signed?"（署名証跡あり）":"")+"</div></div>"+
        "<div class=\"md-actions\"><button class=\"md-btn\" onclick=\"MemberDocs.file('"+esc(d.source)+"','"+esc(d.id)+"',false)\">見る</button>"+
        "<button class=\"md-btn\" onclick=\"MemberDocs.file('"+esc(d.source)+"','"+esc(d.id)+"',true)\">保存</button>"+
        (d.source==="manual"&&!d.verified?"<button class=\"md-btn\" onclick=\"MemberDocs.verify('"+esc(d.id)+"')\">確認済みにする</button>":"")+
        "</div></div>").join(""):"<p class=\"md-empty\">登録済みファイルはありません</p>";
    };
    const terms=(detail.contracts||[]).filter(c=>!c.hasFile);
    root.querySelector("#md-main").innerHTML=
      "<div class=\"md-box\"><h3>"+esc(e.display_name)+"</h3>"+
      "<div class=\"md-status\">"+dot(s.employmentStatus)+dot(e.employment_type||"雇用区分未設定")+
      dot("契約："+s.contractStatus,s.contractStatus==="締結済"?"done":"warn")+"</div>"+
      "<div class=\"md-muted\">必要書類："+(s.requiredConfigured?
        s.receivedCount+"/"+s.requiredCount+"件受領・確認済み "+s.completeCount+"件":"基準未設定")+"　"+
        "未登録 "+s.missingCount+"件／確認待ち "+s.reviewCount+"件</div>"+
      (s.contractAlert?"<p>"+dot(s.contractAlert,"warn")+"</p>":"")+"</div>"+
      "<div class=\"md-box\"><h3>今確認する書類</h3>"+
      (s.requiredConfigured?(required.length?required.map(reqLine).join(""):"<p class=\"md-empty\">必要書類はすべて確認済みです</p>"):
        "<p class=\"md-muted\">雇用区分が未設定、または書類基準が未定義です。Officeで雇用区分と必要書類を確認してください。</p>")+
      "<div class=\"md-muted\">判定基準："+(s.requiredOrigin==="checklist"?"入社手続きの必須書類":s.requiredOrigin==="default"?"雇用区分からの初期基準（人事確認推奨）":"未設定")+"</div></div>"+
      "<div class=\"md-box\"><div class=\"md-row\" style=\"border:0;padding:0 0 8px\"><h3>契約書・通知書</h3>"+
      (detail.uploadReady?"<button class=\"md-btn primary\" onclick=\"MemberDocs.showUpload('employment_contract')\">書類追加</button>":"")+"</div>"+
      documents("contract")+
      (terms.length?"<details><summary class=\"md-mini\">ファイル未登録の契約条件 "+terms.length+"件</summary>"+
        terms.map(c=>"<p class=\"md-muted\">"+esc(c.contractType||"契約条件")+"："+
          esc(c.status||"状態未設定")+"（契約書PDF・署名は未確認）"+
          (c.periodTo?"　期限 "+esc(c.periodTo):"")+"</p>").join("")+"</details>":"")+"</div>"+
      "<div class=\"md-box\"><div class=\"md-row\" style=\"border:0;padding:0 0 8px\"><h3>本人からの提出書類</h3>"+
      (detail.uploadReady?"<button class=\"md-btn\" onclick=\"MemberDocs.showUpload('resume')\">書類追加</button>":"")+"</div>"+
      documents("submitted")+"</div>"+
      (!detail.uploadReady?"<p class=\"md-error\">アップロード機能はDB準備中です。既存書類の閲覧は引き続きできます。</p>":"")+
      "<div id=\"md-upload\"></div>";
  }
  function showUpload(defaultKind){
    if(!root||!detail||!detail.uploadReady)return;
    const options=(detail.types||[]).filter(x=>!["offer_letter","accepted_offer"].includes(x.key)).map(x=>"<option value=\""+esc(x.key)+"\""+
      (defaultKind===x.key?" selected":"")+">"+esc(x.label)+"</option>").join("");
    root.querySelector("#md-upload").innerHTML="<div class=\"md-box md-upload\">"+
      "<h3>書類を追加</h3><label for=\"md-kind\">書類の種類</label><select id=\"md-kind\">"+options+"</select>"+
      "<label for=\"md-file\">PDF・JPG・PNG（10MBまで）</label>"+
      "<input id=\"md-file\" type=\"file\" accept=\".pdf,.jpg,.jpeg,.png\">"+
      "<div class=\"md-error\" id=\"md-error\"></div>"+
      "<div class=\"md-actions\" style=\"margin-top:12px\"><button class=\"md-btn primary\" id=\"md-send\" onclick=\"MemberDocs.upload()\">登録する</button>"+
      "<button class=\"md-btn\" onclick=\"MemberDocs.hideUpload()\">キャンセル</button></div></div>";
    root.querySelector("#md-upload").scrollIntoView({behavior:"smooth",block:"nearest"});
  }
  function hideUpload(){root?.querySelector("#md-upload")?.replaceChildren();}
  async function upload(){
    if(busy||!root||!current)return;
    const f=root.querySelector("#md-file")?.files?.[0];
    const kind=root.querySelector("#md-kind")?.value;
    const error=root.querySelector("#md-error");
    if(!f){error.textContent="ファイルを選んでください";return;}
    if(f.size>10*1024*1024){error.textContent="10MB以下のファイルを選んでください";return;}
    const mime=f.type||(/\.pdf$/i.test(f.name)?"application/pdf":/\.png$/i.test(f.name)?"image/png":"image/jpeg");
    const id=current;busy=true;
    const btn=root.querySelector("#md-send");btn.disabled=true;btn.textContent="登録中…";
    try{
      const common={employeeId:id,docKind:kind,filename:f.name,mimeType:mime,sizeBytes:f.size};
      const signed=await API.api("/api/member-documents",{method:"POST",body:{action:"prepare",...common}});
      const put=await fetch(signed.uploadUrl,{method:"PUT",headers:{"Content-Type":mime,"x-upsert":"false"},body:f});
      if(!put.ok)throw new Error("ファイルの転送に失敗しました（"+put.status+"）");
      await API.api("/api/member-documents",{method:"POST",body:{action:"attach",...common,path:signed.path}});
      hideUpload();
      await changed(id);
    }catch(e){if(error)error.textContent=e.hint||e.message||"登録できませんでした";}
    finally{busy=false;if(btn&&btn.isConnected){btn.disabled=false;btn.textContent="登録する";}}
  }
  async function verify(docId){
    if(!root||!current||!confirm("ファイルの内容を確認しましたか？\n電子署名済みを意味する操作ではありません。"))return;
    const id=current;
    try{await API.api("/api/member-documents",{method:"POST",body:{action:"verify",employeeId:id,documentId:docId}});
      await changed(id);}catch(e){alert(e.hint||e.message||"確認を保存できませんでした");}
  }
  async function changed(id){
    await summaries(onUpdated);
    if(current===id)await refresh();
  }
  async function file(source,docId,download){
    if(!current)return;
    // ポップアップブロックを避けるためクリック直後に別タブを作る。
    const tab=window.open("about:blank","_blank");
    if(tab)tab.opener=null;
    try{
      const r=await API.api(docUrl(current,{source,id:docId},download));
      if(download){if(tab)tab.location.href=r.url;else window.location.href=r.url;return;}
      const fetched=await fetch(r.url,{cache:"no-store"});
      if(!fetched.ok)throw new Error("ファイルを取得できません");
      const blob=await fetched.blob();
      const url=URL.createObjectURL(blob);
      if(tab)tab.location.replace(url);else window.open(url,"_blank","noopener");
      setTimeout(()=>URL.revokeObjectURL(url),300000);
    }catch(e){if(tab)tab.close();alert(e.hint||e.message||"書類を開けませんでした");}
  }
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&root)close();});
  css();
  window.MemberDocs={open,close,refresh,summaries,getSummary,badge,showUpload,hideUpload,upload,verify,file};
})();
