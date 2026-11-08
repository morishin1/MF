// Office / KEIEI 共通の契約・提出書類モーダル。追加機能は1つのボタンにまとめる。
(function () {
  const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let current=null,root=null,detail=null,summaryMap=new Map(),onUpdated=null,busy=false,summaryError=null;
  let focusedKey=null,previewBlob=null;
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
      ".md-modal.md-focus{top:50%;left:50%;right:auto;bottom:auto;transform:translate(-50%,-50%);width:min(620px,94vw);max-height:90vh;border-radius:13px}"+
      ".md-focus .md-wrap{padding:16px 20px 22px}"+
      ".md-doc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}"+
      ".md-doc-head h3{font-size:18px;line-height:1.4;margin:0 0 6px}"+
      ".md-dl{display:grid;grid-template-columns:105px minmax(0,1fr);font-size:13px;gap:9px 14px;margin:10px 0;line-height:1.55}"+
      ".md-dl dt{color:#6b7080}.md-dl dd{margin:0;overflow-wrap:anywhere}"+
      ".md-preview{margin:12px 0;min-height:0;border-radius:8px;overflow:hidden}"+
      ".md-preview iframe{display:block;width:100%;height:420px;border:1px solid #d4d7dc;border-radius:8px}"+
      ".md-preview img{display:block;max-width:100%;height:auto;margin:auto}"+
      ".md-modal.md-focus .md-box{margin-bottom:10px}"+
      ".md-rail{max-width:390px;min-width:280px;display:flex;gap:8px;overflow-x:auto;scrollbar-width:thin;padding:3px 0 7px}"+
      ".md-rail-phase{display:flex;flex-direction:column;gap:3px;padding-right:8px;border-right:1px solid #e2e2dc;flex:none}"+
      ".md-rail-phase:last-child{border-right:0}"+
      ".md-rail-title{font-size:10px;color:#6b7080;font-weight:700}"+
      ".md-rail-controls{display:flex;gap:4px}"+
      ".md-rail-button{font:inherit;font-size:10px;border:1px solid #d5dbe4;border-radius:6px;min-width:66px;max-width:105px;padding:5px;"+
        "display:flex;flex-direction:column;align-items:flex-start;cursor:pointer;color:#1b2440;background:#fff;line-height:1.4;text-align:left}"+
      ".md-rail-button span:first-child{font-weight:700}"+
      ".md-rail-button span:last-child{font-size:9px;color:#697589}"+
      ".md-rail-button.good{background:#edf7ed;border-color:#b5d7ba}"+
      ".md-rail-button.warn{background:#fff7e9;border-color:#e5c887}"+
      ".md-rail-button.missing{background:#fff4f0;border-color:#e9c3b9}"+
      ".md-rail-button.future{background:#f6f7f9;color:#87919e}"+
      ".md-rail-button:hover{outline:1px solid #426fb4}"+
      ".md-template-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}"+
      ".md-template-actions{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}"+
      ".md-template-body{display:block;box-sizing:border-box;width:100%;min-height:170px;max-height:55vh;"+
        "border:1px solid #c9d1db;border-radius:7px;padding:10px;font:12px/1.7 monospace;white-space:pre-wrap}"+
      ".md-template-select{max-width:100%;width:100%;font:inherit;font-size:12px;padding:8px;border:1px solid #c7cad4;border-radius:6px}"+
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

  // Compact same-order button rail for Office and KEIEI staff rosters.
  function rail(summary,{context="office"}={}){
    const phases=summary?.lifecycle?.phases||[];
    const buttons=summary?.lifecycle?.buttons||[];
    if(!phases.length||!buttons.length)return badge(summary);
    const updated=context==="keiei"?"KeieiMembers.onDocuments":"render";
    const status={
      signed:"署名済",accepted:"承諾済",verified:"確認済",issued:"発行済",
      received:"受領済",contract_unconfirmed:"署名未確認",
      record_only:"記録のみ",missing:"未登録",future:"今後",processing:"準備中",check:"要否確認",
    };
    const cls=(x)=>["signed","accepted","verified","issued"].includes(x)?"good":
      x==="missing"?"missing": ["received","contract_unconfirmed","record_only","processing"].includes(x)?"warn":"future";
    return "<div class='md-rail' tabindex='0' aria-label='採用から退社までの書類ボタン'>"+
      phases.map(p=>{
        const xs=buttons.filter(b=>b.phase===p.key);
        if(!xs.length)return "";
        return "<div class='md-rail-phase'><span class='md-rail-title'>"+esc(p.label)+"</span>"+
          "<div class='md-rail-controls'>"+xs.map(b=>
            "<button type='button' class='md-rail-button "+cls(b.state)+"' "+
            "aria-label='"+esc(b.label)+"・"+esc(status[b.state]||"確認中")+"' "+
            "onclick=\"MemberDocs.openDocument('"+esc(summary.employeeId)+"','"+esc(b.key)+"',{onUpdated:"+updated+"})\">"+
            "<span>"+esc(b.label)+"</span><span>"+esc(status[b.state]||"確認中")+"</span></button>").join("")+
          "</div></div>";
      }).join("")+"</div>";
  }

  const badge=(s)=>!s?dot(summaryError?"書類情報を取得できません":"書類情報を確認中",summaryError?"warn":""):(s.requiredConfigured
    ?(!s.requiredCount?dot("個人の必須書類なし"):dot("書類 "+s.receivedCount+"/"+s.requiredCount+"件"+(s.missingCount?"・未登録 "+s.missingCount:"")+(s.reviewCount?"・要確認 "+s.reviewCount:""),s.missingCount||s.reviewCount?"warn":"done")
    ):dot("必要書類の基準未設定","warn"));
  function open(id,opts={}){
    if(!id)return;
    close();css();
    current=id;detail=null;onUpdated=opts.onUpdated||null;
    focusedKey=opts.docKey||null;
    root=document.createElement("div");root.id="member-doc-root";
    root.innerHTML="<div class=\"md-bg\" onclick=\"MemberDocs.close()\"></div>"+
      "<aside class=\"md-modal"+(focusedKey?" md-focus":"")+"\" role=\"dialog\" aria-modal=\"true\" aria-label=\"契約・書類\" tabindex=\"-1\">"+
      "<div class=\"md-head\"><div><h2>"+(focusedKey?"書類の確認":"契約・提出書類")+"</h2>"+(!focusedKey?"<div class=\"md-muted\">メンバーの原本をまとめて確認します</div>":"")+"</div>"+
      "<button class=\"md-btn\" onclick=\"MemberDocs.close()\">閉じる</button></div>"+
      "<div class=\"md-wrap\" id=\"md-main\"><div class=\"md-empty\">読み込み中…</div></div></aside>";
    document.body.appendChild(root);root.querySelector(".md-modal").focus();
    refresh();
  }
  function close(){
    if(previewBlob)URL.revokeObjectURL(previewBlob);
    previewBlob=null;
    if(root)root.remove();
    root=null;current=null;detail=null;focusedKey=null;busy=false;
  }
  function openDocument(id,key,opts={}) {
    open(id,{...opts,docKey:key});
  }
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
    if(focusedKey){drawFocused();return;}
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

  const stageLabels={
    signed:"電子署名済",accepted:"承諾済",verified:"確認済",issued:"発行済",
    received:"受領済・内容確認待ち",contract_unconfirmed:"書類あり・署名未確認",
    record_only:"提出・完了の記録あり（原本未連携）",missing:"台帳未登録",
    future:"今後の手続き",processing:"発行準備中",check:"提出・適用要否を確認",
  };
  function drawFocused(){
    const box=root?.querySelector("#md-main");
    const entry=(detail?.lifecycle?.buttons||[]).find(x=>x.key===focusedKey);
    if(!box)return;
    if(!entry){box.innerHTML="<div class='md-box md-error'>この書類の情報を取得できませんでした。</div>";return;}
    const employee=detail.employee||{};
    const phase=detail.lifecycle?.phases?.find(p=>p.key===entry.phase)?.label||"書類";
    const related=(detail.documents||[]).filter(d=>d.hasFile && entry.docKinds?.includes(d.kind));
    const show=(value)=>value?esc(String(value)):"—";
    const date=value=>value?esc(String(value).slice(0,10)):"—";
    const status=stageLabels[entry.state]||"確認待ち";
    const more=entry.state==="record_only"?"提出記録がありますが、プレビュー可能な原本が台帳に紐づいていません。":
      entry.state==="future"?"退職など該当する時期に、必要な書類を確認してください。":
      entry.state==="check"?"この書類が必要か、Officeで確認してください。":
      entry.state==="missing"?"この書類の原本がシステム上で確認できません。本人の未提出とは限りません。":"";
    const term=entry.period?
      "<dt>関連契約期間</dt><dd>"+show(entry.period.from)+" 〜 "+show(entry.period.to)+
        (entry.period.contractType?"<div class='md-muted'>"+esc(entry.period.contractType)+"</div>":"")+"</dd>":"";
    const retirement=entry.phase==="leave"?
      "<dt>退職日</dt><dd>"+date(employee.left_on)+"</dd>":"";
    const saved=related.map(d=>
      "<div class='md-row'><div style='min-width:0;flex:1'><b style='font-size:13px;overflow-wrap:anywhere'>"+esc(d.filename||d.title)+"</b>"+
      "<div class='md-muted'>"+esc(d.status||"登録済")+" ／ 登録 "+date(d.createdAt)+(d.signed?" ／ 電子署名記録あり":"")+"</div></div>"+
      "<div class='md-actions'><button class='md-btn primary' onclick=\"MemberDocs.inlinePreview('"+esc(d.source)+"','"+esc(d.id)+"')\">プレビュー</button>"+
      "<button class='md-btn' onclick=\"MemberDocs.file('"+esc(d.source)+"','"+esc(d.id)+"',true)\">保存</button>"+
      (d.source==="manual"&&!d.verified?
        "<button class='md-btn' onclick=\"MemberDocs.verify('"+esc(d.id)+"')\">確認済み</button>":"")+
      "</div></div>").join("");
    const suggested=entry.phase==="leave"?
      "<p class='md-muted'>退職書類の正式な発行・公開はOfficeのメンバー管理「退職手続き」から行います。</p>":
      ["offer_letter","accepted_offer"].includes(entry.key)?
      "<p class='md-muted'>内定通知・本人承諾は採用HRの正式な内定手続きから記録します。</p>":"";
    const canUpload=Boolean(detail.uploadReady&&entry.uploadKind&&!entry.restricted);
    const button=canUpload?
      "<button class='md-btn primary' onclick=\"MemberDocs.showUpload('"+esc(entry.uploadKind)+"')\">"+
      (entry.hasFile?"別の版を追加":"この書類を追加")+"</button>":"";
    box.innerHTML=
      "<div class='md-box'><div class='md-doc-head'><div><div class='md-muted'>"+esc(phase)+" ／ "+esc(employee.display_name||"メンバー")+"</div>"+
      "<h3>"+esc(entry.label)+"</h3></div>"+dot(status,
        ["signed","accepted","verified","issued"].includes(entry.state)?"done":
        ["missing","contract_unconfirmed","record_only","processing"].includes(entry.state)?"warn":"")+"</div>"+
      "<dl class='md-dl'><dt>必要性</dt><dd>"+esc(entry.requiredLabel||"要確認")+"</dd>"+
      "<dt>提出・登録</dt><dd>"+(entry.hasFile?"ファイル登録済":"原本未登録")+"</dd>"+
      "<dt>登録日</dt><dd>"+date(entry.fileDate)+"</dd>"+
      (entry.issueDate?"<dt>発行日</dt><dd>"+date(entry.issueDate)+"</dd>":"")+
      (entry.dueOn?"<dt>期日</dt><dd>"+date(entry.dueOn)+"</dd>":"")+
      term+retirement+"</dl>"+
      (more?"<p class='md-muted'>"+esc(more)+"</p>":"")+
      (entry.restricted?"<p class='md-muted'>原本の閲覧には給与・報酬の閲覧権限が必要です。</p>":"")+
      "</div>"+
      "<div class='md-box'><div class='md-row' style='border:0;padding:0 0 6px'><h3>登録ファイル</h3>"+button+"</div>"+
      (saved||"<p class='md-empty'>プレビューできるファイルは未登録です。</p>")+
      suggested+"<div class='md-preview' id='md-preview'></div></div>"+
      templateSection(entry)+
      "<div id='md-upload'></div>";
  }

  const templateText=t=>t?.status==="review"?"社内確認前":t?.status==="linked"?"雛形登録済":
    t?.status==="workflow"?"正式手続きで発行":t?.status==="not_needed"?"本人・発行元の原本":
    t?.status==="broken"?"紐づけ先が不明":"雛形未登録";
  function templateSection(entry){
    const t=entry.template||{status:"missing",source:"missing"};
    const status=templateText(t);
    const valid=t.source!=="missing"&&t.source!=="original";
    const primary=valid?'<button type="button" class="md-btn primary" onclick="MemberDocs.previewTemplate()">'+
      (t.source==="sign"?"電子契約の雛形を使う":t.source==="workflow"?"正式手続きへ":
        t.source==="official"?"公式様式を開く":"雛形を開く")+'</button>':
      t.source==="original"?"":'<a class="md-btn" target="_blank" rel="noopener" href="/admin-docs.html?tab=templates&newTemplate=1&docKey='+encodeURIComponent(entry.key)+'">社内文書で雛形を作成</a>';
    const title=t.title&&t.source!=="original"?'<div class="md-muted">'+esc(t.title)+'</div>':"";
    const note=t.status==="review"?"<p class='md-muted'>この雛形は社内確認前です。正式送付前に内容を確認してください。</p>":
      t.source==="original"?"<p class='md-muted'>"+esc(t.note||"この書類は本人・発行元の原本を受領します。共通の雛形は不要です。")+"</p>":"";
    const editLink=t.source==="general"&&t.id?
      '<a class="md-btn" href="/admin-docs.html?tab=templates&templateId='+encodeURIComponent(t.id)+'" target="_blank" rel="noopener">社内文書で編集</a>':"";
    const reference=t.reference?
      '<div class="md-muted">関連する社内文書：<a target="_blank" rel="noopener" href="'+esc(t.reference.url)+'">'+esc(t.reference.title)+'</a></div>':"";
    const official=(entry.key==="employment_contract"||entry.key==="labor_notice"||entry.key==="retire_certificate")?
      '<div class="md-muted"><a href="https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/roudoukijunkankei.html" target="_blank" rel="noopener">厚生労働省の公式様式も確認</a></div>':"";
    return "<div class='md-box' data-sec='template'><div class='md-template-bar'><h3>本人に渡す雛形</h3>"+
      dot(status,t.status==="linked"?"done":t.status==="review"?"warn":"")+
      "</div>"+title+note+
      "<div class='md-template-actions'>"+primary+editLink+
        "<button type='button' class='md-btn' onclick='MemberDocs.templateChoices()'>社内文書と紐づける</button>"+
      "</div>"+official+reference+
      "<div id='md-template-config'></div><div id='md-template-output'></div></div>";
  }
  async function templateChoices(){
    if(!root||!current||!focusedKey)return;
    const panel=root.querySelector("#md-template-config");
    if(!panel)return;
    panel.innerHTML="<p class='md-muted'>社内文書と雛形の一覧を読み込み中…</p>";
    const key=focusedKey,id=current,oldRoot=root;
    try{
      const r=await API.api("/api/member-documents?templates=1");
      if(!root||root!==oldRoot||current!==id||focusedKey!==key)return;
      const types={library:"社内文書",general:"差し込み雛形",sign:"電子契約雛形"};
      const opts=(r.choices||[]).map(x=>'<option value="'+esc(x.source+"|"+x.id)+'">'+
        esc((types[x.source]||"雛形")+"： "+x.title)+(x.source==="library"&&!x.published?"（非公開）":"")+'</option>').join("");
      panel.innerHTML="<label class='md-muted' for='md-template-id'>この書類に使う雛形を選択</label>"+
        "<select class='md-template-select' id='md-template-id'><option value=''>選択してください</option>"+opts+"</select>"+
        "<div class='md-template-actions'><button type='button' class='md-btn primary' onclick='MemberDocs.saveTemplateLink()'>この雛形を紐づける</button>"+
        "<button type='button' class='md-btn' onclick='MemberDocs.clearTemplateLink()'>個別の紐づけを解除</button>"+
        "<a class='md-btn' href='/admin-docs.html?tab=templates&newTemplate=1&docKey="+encodeURIComponent(key)+"' target='_blank' rel='noopener'>社内文書で雛形を作成</a></div>"+
        "<div id='md-template-msg' class='md-muted'></div>";
    }catch(e){panel.innerHTML="<p class='md-error'>"+esc(e.hint||e.message||"雛形一覧を取得できません")+"</p>";}
  }
  async function saveTemplateLink(){
    const picked=root?.querySelector("#md-template-id")?.value||"";
    const [sourceKind,sourceId]=picked.split("|");
    const msg=root?.querySelector("#md-template-msg");
    if(!sourceKind||!sourceId){if(msg)msg.textContent="紐づける雛形を選んでください。";return;}
    const key=focusedKey,id=current;
    try{
      await API.api("/api/member-documents",{method:"POST",body:{
        action:"templateLink",employeeId:id,docKey:key,sourceKind,sourceId,
      }});
      await changed(id);
    }catch(e){if(msg)msg.textContent=e.hint||e.message||"保存できませんでした";}
  }
  async function clearTemplateLink(){
    if(!root||!focusedKey||!current)return;
    const key=focusedKey,id=current;
    try{
      await API.api("/api/member-documents",{method:"POST",body:{
        action:"templateUnlink",employeeId:id,docKey:key,
      }});
      await changed(id);
    }catch(e){const msg=root?.querySelector("#md-template-msg");if(msg)msg.textContent=e.hint||e.message||"解除できませんでした";}
  }
  function filledTemplate(body,employee){
    const map={"氏名":employee?.display_name||"","部署":employee?.department||"",
      "役職":employee?.position||"","雇用区分":employee?.employment_type||"",
      "入社日":employee?.joined_on||"","メール":employee?.email||"",
      "会社名":employee?.company_name||"＿＿＿＿＿＿","今日":new Date().toLocaleDateString("ja-JP")};
    return String(body||"").replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_,key)=>map[key]||"＿＿＿＿＿＿");
  }
  function toRtf(text){
    let out="{\\rtf1\\ansi\\deff0\\uc1{\\fonttbl{\\f0\\fnil MS Gothic;}}\\f0\\fs22 ";
    for(let i=0;i<text.length;i++){
      const code=text.charCodeAt(i),ch=text[i];
      if(ch==="\n")out+="\\par\n";
      else if(ch==="\t")out+="\\tab ";
      else if(ch==="{"||ch==="}"||ch==="\\")out+="\\"+ch;
      else if(code<32)continue;
      else if(code<128)out+=ch;
      else out+="\\u"+(code>32767?code-65536:code)+"?";
    }
    return out+"}";
  }
  function downloadTemplate(){
    const panel=root?.querySelector("#md-template-body");
    if(!panel||!panel.value)return;
    const entry=detail?.lifecycle?.buttons?.find(b=>b.key===focusedKey);
    const name=(entry?.label||"雛形").replace(/[\\/:*?"<>|]/g,"_").slice(0,45);
    const employee=(detail?.employee?.display_name||"").replace(/[\\/:*?"<>|]/g,"_").slice(0,28);
    const blob=new Blob([toRtf(panel.value)],{type:"application/rtf"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download=name+"_"+employee+"_雛形.rtf";a.style.display="none";
    document.body.appendChild(a);a.click();
    setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},3000);
  }
  async function previewTemplate(){
    if(!root||!current||!focusedKey)return;
    const id=current,key=focusedKey,oldRoot=root;
    const panel=root.querySelector("#md-template-output");
    if(!panel)return;
    // Open a blank tab from the real click to avoid popup blocking for external/linked files.
    const t=detail?.lifecycle?.buttons?.find(b=>b.key===key)?.template;
    const opensTab=["library","official","sign","workflow"].includes(t?.source);
    const tab=opensTab?window.open("about:blank","_blank"):null;
    if(tab)tab.opener=null;
    panel.innerHTML="<p class='md-muted'>雛形を読み込み中…</p>";
    try{
      const r=await API.api("/api/member-documents?template=1&docKey="+encodeURIComponent(key)+
        "&employeeId="+encodeURIComponent(id));
      if(root!==oldRoot||current!==id||focusedKey!==key){tab?.close();return;}
      if(r.source==="general"){
        const text=filledTemplate(r.body,{...detail.employee,company_name:detail.companyName});
        panel.innerHTML="<p class='md-muted'>編集してWordで開けるRTFファイルとして保存できます。個人情報を入れたまま共有しないよう、確認してください。</p>"+
          (r.reviewRequired?"<p class='md-error'>社内確認前です。内容を確認・承認してから本人に渡してください。</p>":"")+
          "<textarea id='md-template-body' class='md-template-body' aria-label='雛形プレビュー'></textarea>"+
          "<div class='md-template-actions'><button type='button' class='md-btn primary' onclick='MemberDocs.downloadTemplate()'>"+
          (r.reviewRequired?"確認用Wordファイルを保存":"本人用Wordファイルを保存")+"</button></div>";
        panel.querySelector("#md-template-body").value=text;
        if(tab)tab.close();
      }else if(r.url){
        if(tab)tab.location.replace(r.url);else window.open(r.url,"_blank","noopener");
        panel.innerHTML="<p class='md-muted'>雛形を別タブで開きました。正式な配布前に内容・最新版を確認してください。</p>";
        if(r.source==="library"&&r.shareUrl){
          panel.innerHTML+="<button type='button' class='md-btn' onclick='MemberDocs.copyTemplateLink()'>社内向け文書リンクをコピー</button>";
        }
      }else{
        tab?.close();
        panel.innerHTML="<p class='md-muted'>"+esc(r.note||"雛形が未登録です。社内文書で作成してください。")+"</p>";
      }
    }catch(e){
      tab?.close();
      if(root===oldRoot)panel.innerHTML="<p class='md-error'>"+esc(e.hint||e.message||"雛形を開けませんでした")+"</p>";
    }
  }
  async function copyTemplateLink(){
    const key=focusedKey,id=current;
    try{
      const r=await API.api("/api/member-documents?template=1&docKey="+encodeURIComponent(key)+
        "&employeeId="+encodeURIComponent(id));
      if(!r.shareUrl)return;
      const link=new URL(r.shareUrl,location.origin).href;
      await navigator.clipboard.writeText(link);
      const panel=root?.querySelector("#md-template-output");
      if(panel)panel.innerHTML+="<p class='md-muted'>社内向け文書リンクをコピーしました。ログインが必要な場合があります。</p>";
    }catch(e){alert(e.hint||e.message||"コピーできませんでした");}
  }

  async function inlinePreview(source,docId){
    const id=current,oldRoot=root;
    if(!id||!oldRoot)return;
    const viewer=oldRoot.querySelector("#md-preview");
    if(!viewer)return;
    viewer.innerHTML="<div class='md-muted'>ファイルを読み込み中…</div>";
    try{
      const r=await API.api(docUrl(id,{source,id:docId},false));
      const response=await fetch(r.url,{cache:"no-store"});
      if(!response.ok)throw new Error("ファイルを取得できませんでした");
      const blob=await response.blob();
      if(current!==id||root!==oldRoot)return;
      if(previewBlob)URL.revokeObjectURL(previewBlob);
      previewBlob=URL.createObjectURL(blob);
      if(blob.type==="application/pdf"){
        viewer.innerHTML="<iframe title='書類プレビュー' src='"+previewBlob+"#toolbar=1'></iframe>";
      }else if(blob.type.startsWith("image/")){
        viewer.innerHTML="<img alt='書類プレビュー' src='"+previewBlob+"'>";
      }else{
        viewer.innerHTML="<p class='md-muted'>この形式は画面内でプレビューできません。［保存］から開いてください。</p>";
      }
    }catch(e){
      if(current===id&&root===oldRoot)
        viewer.innerHTML="<p class='md-error'>画面内に表示できませんでした。［保存］または別タブで原本を確認してください。"+
        esc(e.hint||e.message||"")+"</p>"+
        "<button class='md-btn' onclick=\"MemberDocs.file('"+esc(source)+"','"+esc(docId)+"',false)\">別タブで開く</button>";
    }
  }

  function showUpload(defaultKind){
    if(!root||!detail||!detail.uploadReady)return;
    const options=(detail.types||[]).filter(x=>!["offer_letter","accepted_offer"].includes(x.key)&&!x.key.startsWith("retire_")).map(x=>"<option value=\""+esc(x.key)+"\""+
      (defaultKind===x.key?" selected":"")+">"+esc(x.label)+"</option>").join("");
    const lockedKind=focusedKey&&detail.lifecycle?.buttons?.some(b=>b.key===focusedKey&&b.uploadKind===defaultKind);
    const kindPicker=lockedKind?
      "<div class='md-muted'>"+esc(detail.lifecycle.buttons.find(b=>b.key===focusedKey)?.label||"書類")+"</div>"+
      "<input id='md-kind' type='hidden' value='"+esc(defaultKind)+"'>":
      "<label for='md-kind'>書類の種類</label><select id='md-kind'>"+options+"</select>";
    root.querySelector("#md-upload").innerHTML="<div class=\"md-box md-upload\">"+
      "<h3>書類を追加</h3>"+kindPicker+
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
  async function file(source,docId,download,employeeId){
    const personId=employeeId||current;
    if(!personId)return;
    // ポップアップブロックを避けるためクリック直後に別タブを作る。
    const tab=window.open("about:blank","_blank");
    if(tab)tab.opener=null;
    try{
      const r=await API.api(docUrl(personId,{source,id:docId},download));
      if(download){if(tab)tab.location.href=r.url;else window.location.href=r.url;return;}
      let blob;
      try {
        const fetched=await fetch(r.url,{cache:"no-store"});
        if(!fetched.ok)throw new Error("ファイルを取得できません");
        blob=await fetched.blob();
        if(!/application\/pdf|image\//i.test(blob.type))throw new Error("PDF・画像として読み込めません");
      } catch(previewError) {
        // If storage CORS prevents blob preview, the short-lived signed URL
        // is still an authorized fallback. It can open or download in the browser.
        if(tab){tab.location.replace(r.url);return;}
        throw previewError;
      }
      const url=URL.createObjectURL(blob);
      if(tab)tab.location.replace(url);else window.open(url,"_blank","noopener");
      setTimeout(()=>URL.revokeObjectURL(url),300000);
    }catch(e){if(tab)tab.close();alert(e.hint||e.message||"書類を開けませんでした");}
  }
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&root)close();});
  css();
  window.MemberDocs={open,openDocument,close,refresh,summaries,getSummary,badge,rail,
    showUpload,hideUpload,upload,verify,file,inlinePreview,
    previewTemplate,templateChoices,saveTemplateLink,clearTemplateLink,downloadTemplate,copyTemplateLink};
})();
