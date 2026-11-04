// ENGER企業マスターの読み取り専用ビュー。3区分はSQLビューに由来し、勝手にSalesへ登録しない。
// 営業NG・旧配信停止はモーダルで注意を表示し、直接連絡はさせない。
(() => {
 const root=document.getElementById("enger-company-directory");
 if(!root)return;
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
 const fmt=n=>Number(n??0).toLocaleString("ja-JP");
 const labels={existing:"既存",revive:"掘り起こし",new:"新規"};
 const notes={existing:"既存登録・直近の面談記録がある企業。現在の契約・やり取りは要確認",
  revive:"旧営業資料・過去の接点がある企業。再連絡の前に履歴と連絡許可を確認",
  new:"営業実績が確認できていない企業。まず発注・人材提供の可能性を調査"};
 let state={bucket:"revive",page:1,q:"",siSes:false,priority:""};
 let cached=null,seq=0;
 const status=document.getElementById("enger-directory-status");
 const results=document.getElementById("enger-directory-results");
 const modal=document.getElementById("enger-directory-modal");
 const setStatus=message=>{if(status)status.textContent=message;};
 const csv=()=>{
  if(!cached?.rows?.length)return;
  const heads=["企業名","区分","業種","地域","旧優先度","営業確認根拠","SI/SES候補","要連絡確認","ENGER企業ID"];
  const values=cached.rows.map(r=>[r.name,labels[r.bucket]||r.bucket,r.industry||"",r.prefecture||"",r.sourcePriority||"",
    r.classificationBasis||"",r.siSesCandidate?"候補":"",r.needsContactReview?"要確認":"",r.id]);
  const quote=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  const file="\ufeff"+[heads,...values].map(row=>row.map(quote).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([file],{type:"text/csv;charset=utf-8"}));
  const a=document.createElement("a");a.href=url;a.download="enger_companies_"+state.bucket+".csv";
  document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);
 };
 const openModal=id=>{
   const r=cached?.rows?.find(r=>r.id===id);if(!r)return;
   // ENGERのID・旧営業優先度・連絡可否は混同しない。
   const caution=r.needsContactReview
     ? '<p class="engr-alert" role="alert">旧台帳のNG・配信停止または企業注意情報あり。営業可否を確認するまで連絡しないでください。</p>'
     : '<p class="engr-muted">営業可否・担当連絡先は未確認です。電話・メールの送信前に必ず確認してください。</p>';
   const row=(label,value)=>'<div class="engr-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value||"—")+'</dd></div>';
   modal.innerHTML='<div class="engr-modal-bg" data-engr-close="1"></div>'+
    '<section class="engr-modal" role="dialog" aria-modal="true" aria-label="'+esc(r.name)+' の企業情報">'+
    '<header class="engr-modal-head"><div><h2>'+esc(r.name)+'</h2><p>'+esc(labels[r.bucket])+' ／ '+esc(r.industry||"業種未登録")+'</p></div>'+
    '<button type="button" class="btn btn-secondary btn-sm" data-engr-close="1">閉じる</button></header>'+
    '<div class="engr-modal-content">'+caution+
    '<h3>企業情報・分類根拠</h3><dl class="engr-dl">'+
      row("登録ステータス",r.status)+row("都道府県",r.prefecture)+row("分類の根拠",r.classificationBasis)+
      row("旧営業資料の優先度",r.sourcePriority ? r.sourcePriority+"（参考・現在の評価ではない）":"未登録")+
      row("旧営業の最終接触日",r.historicalContactDate)+row("旧営業の活動記録",r.historicalActivityCount?fmt(r.historicalActivityCount)+"件":"記録なし")+
      row("SI・SES/人材",r.siSesCandidate?"業種からの候補（要事業確認）":"未判定")+
     '</dl>'+
    '<h3>次にやること</h3><p>案件を持っているか、人材を紹介できるか、取引担当と現在の連絡許可を確認。受領した案件・人材情報はENGERで正式登録してください。</p>'+
    '<div class="engr-modal-actions">'+
      '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener noreferrer" href="https://dx.enger.jp/companies/'+encodeURIComponent(r.id)+'">ENGERの企業詳細へ</a>'+
      '<button type="button" class="btn btn-secondary btn-sm" data-engr-find-sales="'+esc(r.name)+'">Sales既存企業を検索</button>'+
      (r.website?'<a class="btn btn-secondary btn-sm" href="'+esc(r.website)+'" rel="noopener noreferrer" target="_blank">企業サイトで確認</a>':"")+
    '</div><p class="engr-muted">ENGER⇔Salesの企業IDの自動対応は未確定です。ここからの一括営業送信・自動統合は行いません。</p>'+
    '<div id="enger-supply-pipeline" aria-label="案件・人材情報の提供依頼履歴"></div>'+
    '</div></section>';
   modal.hidden=false;
   document.dispatchEvent(new CustomEvent("enger:company-open",{detail:{company:r}}));
   modal.querySelector("[data-engr-close]")?.focus?.();
 };
 const closeModal=()=>{modal.innerHTML="";modal.hidden=true;};
 const draw=data=>{
   cached=data;
   for(const tab of root.querySelectorAll("[data-engr-bucket]")){
     const key=tab.dataset.engrBucket;
     tab.textContent=labels[key]+" "+fmt(data.counts[key]);
     tab.classList.toggle("on",key===state.bucket);
     tab.setAttribute("aria-selected",String(key===state.bucket));
   }
   const tot=root.querySelector("#enger-dir-total");
   if(tot)tot.textContent="ENGER企業マスター "+fmt(data.total)+"社 ／ SI・SES関連候補 "+fmt(data.sectorTotal)+"社";
   const start=data.selectedCount?(state.page-1)*data.pageSize+1:0;
   setStatus(labels[state.bucket]+"：絞り込み後 "+fmt(data.selectedCount)+"社 ／ "+fmt(start)+"〜"+fmt(Math.min(data.selectedCount,state.page*data.pageSize))+"社を表示");
   const rows=(data.rows||[]).map(r=>'<tr>'+
     '<td><button type="button" class="engr-company-name" data-engr-detail="'+esc(r.id)+'">'+esc(r.name)+'</button>'+
       '<small>'+esc(r.industry||"業種未登録")+' ／ '+esc(r.prefecture||"地域未登録")+'</small></td>'+
     '<td>'+esc(r.status||"未設定")+'<small>'+esc(r.classificationBasis||"")+'</small></td>'+
     '<td>'+esc(r.sourcePriority||"—")+'</td>'+
     '<td>'+(r.siSesCandidate?'SI/SES候補':'—')+'</td>'+
     '<td>'+(r.needsContactReview?'<strong class="engr-danger">連絡要確認</strong>':'<span class="engr-muted">未確認</span>')+'</td>'+
     '<td><button type="button" class="btn btn-secondary btn-sm" data-engr-detail="'+esc(r.id)+'">詳細・営業判断</button></td>'+
    '</tr>').join("");
   const pages=Math.ceil(data.selectedCount/data.pageSize);
   results.innerHTML='<div class="engr-table-wrap"><table class="sl-table"><thead>'+
     '<tr><th>企業名・業種</th><th>登録状況と根拠</th><th>旧優先度</th><th>事業区分</th><th>営業可否</th><th>確認</th></tr></thead>'+
     '<tbody>'+(rows||'<tr><td colspan="6" class="sl-empty">該当する企業はありません。</td></tr>')+'</tbody></table></div>'+
    '<div class="engr-pager">'+
    '<button type="button" class="btn btn-secondary btn-sm" data-engr-page="-1" '+(state.page<=1?"disabled":"")+'>前へ</button>'+
    '<span>'+fmt(state.page)+' / '+fmt(Math.max(1,pages))+'ページ（50社ずつ）</span>'+
    '<button type="button" class="btn btn-secondary btn-sm" data-engr-page="1" '+(state.page>=pages?"disabled":"")+'>次へ</button>'+
    '<button type="button" class="btn btn-secondary btn-sm" id="enger-dir-csv" '+(!data.rows.length?"disabled":"")+'>表示中50社をCSV</button>'+
    '</div>';
   const note=root.querySelector("#enger-directory-note");
   if(note)note.textContent=notes[state.bucket]+"。分類は営業判断のための暫定値です。";
 };
 const load=async()=>{
   const ticket=++seq;setStatus("ENGER企業を読み込み中…");
   const p=new URLSearchParams({bucket:state.bucket,page:String(state.page)});
   if(state.q)p.set("q",state.q);
   if(state.siSes)p.set("siSes","1");
   if(state.priority)p.set("priority",state.priority);
   try{
     const d=await window.API.api("/api/sales/enger-company-directory?"+p);
     if(ticket!==seq)return;
     if(!d.complete||!d.readonly)throw new Error("企業DBの件数を確認できません。");
     draw(d);
   }catch(e){
     if(ticket!==seq)return;
     cached=null;setStatus("企業DBを取得できません。権限・接続を確認してください。");
     results.innerHTML='<p class="engr-alert" role="alert">'+esc(e.hint||"ENGER企業DBの読み込みに失敗しました。")+'</p>'+
        '<button type="button" class="btn btn-secondary btn-sm" id="enger-dir-retry">再取得</button>';
   }
 };
 root.addEventListener("click",e=>{
   const tab=e.target.closest("[data-engr-bucket]");
   if(tab){state.bucket=tab.dataset.engrBucket;state.page=1;void load();return;}
   const next=e.target.closest("[data-engr-page]");
   if(next&&!next.disabled){state.page+=Number(next.dataset.engrPage);void load();return;}
   if(e.target.closest("#enger-dir-retry")){void load();return;}
   if(e.target.closest("#enger-dir-csv")){csv();return;}
   const detail=e.target.closest("[data-engr-detail]");
   if(detail){openModal(detail.dataset.engrDetail);return;}
 });
 modal.addEventListener("click",e=>{
   if(e.target.closest("[data-engr-close]")){closeModal();return;}
   const find=e.target.closest("[data-engr-find-sales]");
   if(find)location.assign("/sales/companies.html?q="+encodeURIComponent(find.dataset.engrFindSales));
 });
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!modal.hidden)closeModal();});
 let debounce;
 root.querySelector("#enger-dir-search")?.addEventListener("input",e=>{
   clearTimeout(debounce);
   debounce=setTimeout(()=>{state.q=e.target.value.trim();state.page=1;void load();},350);
 });
 root.querySelector("#enger-dir-sector")?.addEventListener("change",e=>{state.siSes=e.target.checked;state.page=1;void load();});
 root.querySelector("#enger-dir-priority")?.addEventListener("change",e=>{state.priority=e.target.value;state.page=1;void load();});
 void load();
})();
