// ENGER企業7,218社のSales営業判断：3タブ・サーバーソート・選択一括更新・中央詳細モーダル。
// 過去の営業資料や社名一致は取引実績の証明ではない。物理削除・自動配信はしない。
(() => {
 const root=document.getElementById("enger-company-directory");
 const modal=document.getElementById("enger-directory-modal");
 if(!root||!modal)return;
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const fmt=n=>Number(n||0).toLocaleString("ja-JP");
 const labels={existing:"既存",revive:"掘り起こし",new:"新規"};
 const relationLabels={unknown:"未確認",active:"取引中（根拠確認済）",past:"過去取引あり（根拠確認済）",none_confirmed:"取引なし（根拠確認済）"};
 const colLabels={
  name:"企業",effective_priority:"優先度",status:"区分",industry:"業種",
  prefecture:"地域",historical_activity_count:"旧活動数",
  historical_contact_date:"旧最終接触",relationship_status:"取引確認",
  si_ses_candidate:"SI/SES",created_at:"登録日",
 };
 const state={bucket:"revive",page:1,q:"",siSes:false,priority:"",sort:"effective_priority",direction:"asc",includeHidden:false};
 let loaded=null,ticket=0,detailTicket=0,selected=new Set(),detailId=null;
 const statusEl=root.querySelector("#enger-directory-status");
 const resultEl=root.querySelector("#enger-directory-results");
 const setStatus=message=>{if(statusEl)statusEl.textContent=message;};
 const textdate=value=>{
  if(!value)return "—";const d=new Date(value);
  return Number.isNaN(d.getTime())?String(value).slice(0,10):d.toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo"});
 };
 const resetSelection=()=>{selected.clear();};
 const api=(path,opts)=>window.API.api(path,opts);
 const csv=()=>{
  if(!loaded?.rows?.length)return;
  const heads=["企業名","区分","業種","地域","優先度","旧資料優先度","旧営業活動数","旧最終接触","取引確認","除外","要連絡確認","ENGER企業ID"];
  const values=loaded.rows.map(r=>[r.name,labels[r.bucket]||r.bucket,r.industry||"",r.prefecture||"",r.priority||"",r.sourcePriority||"",r.historicalActivityCount||0,
    r.historicalContactDate||"",relationLabels[r.relationshipStatus]||"未確認",r.excluded?"除外":"",r.needsContactReview?"注意":"",r.id]);
  const quote=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
  const blob="\ufeff"+[heads,...values].map(a=>a.map(quote).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([blob],{type:"text/csv;charset=utf-8"}));
  const a=document.createElement("a");a.href=url;a.download="enger_company_directory_"+state.bucket+".csv";
  document.body.append(a);a.click();a.remove();URL.revokeObjectURL(url);
 };
 function bulkBar(){
  const disabled=selected.size===0;
  return '<div id="engr-bulk-toolbar" class="engr-bulk-toolbar" '+(disabled?'hidden':'')+'>'+
   '<strong id="engr-bulk-count">'+fmt(selected.size)+'社選択</strong>'+
   '<select id="engr-bulk-action" aria-label="選択企業に行う操作">'+
    '<option value="priority">優先度を更新</option><option value="relationship">取引確認を更新</option>'+
    '<option value="exclude">営業一覧から除外（復元可能）</option>'+
    '<option value="restore">除外を解除</option></select>'+
   '<select id="engr-bulk-priority" aria-label="変更する優先度">'+
    '<option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>'+
    '<option value="">独自優先度を解除</option></select>'+
   '<select id="engr-bulk-relationship" aria-label="確認した取引状況" hidden>'+
    Object.entries(relationLabels).map(([k,l])=>'<option value="'+k+'">'+esc(l)+'</option>').join("")+'</select>'+
   '<textarea id="engr-bulk-evidence" rows="2" maxlength="2000" placeholder="取引の根拠（確認相手・日時・契約/メール等、10文字以上）" hidden></textarea>'+
   '<button class="btn btn-primary btn-sm" id="engr-bulk-run" type="button">選択企業へ適用</button>'+
   '<span class="engr-muted">除外はENGER本体・履歴を削除しません。</span>'+
   '</div>';
 }
 const selectedSync=()=>{
  const bar=resultEl.querySelector("#engr-bulk-toolbar");if(bar)bar.hidden=selected.size===0;
  const count=resultEl.querySelector("#engr-bulk-count");if(count)count.textContent=fmt(selected.size)+"社選択";
  const checkAll=resultEl.querySelector("#engr-select-all");
  if(checkAll&&loaded){const ids=loaded.rows.map(r=>r.id);checkAll.checked=ids.length>0&&ids.every(id=>selected.has(id));checkAll.indeterminate=ids.some(id=>selected.has(id))&&!checkAll.checked;}
 };
 const controlsSync=()=>{
  const action=resultEl.querySelector("#engr-bulk-action")?.value;
  const pr=resultEl.querySelector("#engr-bulk-priority");
  const rel=resultEl.querySelector("#engr-bulk-relationship");
  const evidence=resultEl.querySelector("#engr-bulk-evidence");
  if(pr)pr.hidden=action!=="priority";
  if(rel)rel.hidden=action!=="relationship";
  if(evidence)evidence.hidden=action!=="relationship";
 };
 const heading=(label,key)=>{
  if(!key)return '<th>'+esc(label)+'</th>';
  const is=state.sort===key,dir=is?(state.direction==="asc"?"↑":"↓"):"↕";
  return '<th><button type="button" class="engr-sort-btn" data-engr-sort="'+esc(key)+'" aria-label="'+esc(label)+'で並べ替え">'+
    esc(label)+' <span aria-hidden="true">'+dir+'</span></button></th>';
 };
 const preview=r=>{
  return '<span class="engr-hover-card" role="tooltip">'+
    '<b>'+esc(r.name)+'</b><small>'+esc(r.industry||"業種未登録")+' ／ '+esc(r.prefecture||"地域未登録")+'</small>'+
    '<small>優先度：'+esc(r.priority||"—")+' ／ 取引：'+esc(relationLabels[r.relationshipStatus]||"未確認")+'</small>'+
    '<small>旧活動 '+fmt(r.historicalActivityCount)+'件 ／ 最終接触 '+esc(r.historicalContactDate||"不明")+'</small>'+
    '<small>クリックで企業詳細・電話・ホームページ・履歴を表示</small>'+
    '</span>';
 };
 function draw(d){
  loaded=d;resetSelection();
  for(const btn of root.querySelectorAll("[data-engr-bucket]")){
   const key=btn.dataset.engrBucket;
   btn.textContent=labels[key]+" "+fmt(d.counts[key]);
   btn.classList.toggle("on",state.bucket===key);
   btn.setAttribute("aria-selected",String(state.bucket===key));
  }
  const total=root.querySelector("#enger-dir-total");
  if(total)total.textContent="ENGER企業 "+fmt(d.total)+"社 ／ SI・SES関連候補 "+fmt(d.sectorTotal)+"社";
  const first=d.selectedCount?(state.page-1)*d.pageSize+1:0;
  setStatus(labels[state.bucket]+"：該当 "+fmt(d.selectedCount)+"社 ／ "+fmt(first)+"〜"+
    fmt(Math.min(d.selectedCount,state.page*d.pageSize))+"社表示"+(state.includeHidden?"（除外済みを含む）":""));
  const head='<tr><th><input type="checkbox" id="engr-select-all" aria-label="表示中の企業を一括選択"></th>'+
    heading("優先","effective_priority")+heading("企業","name")+heading("業種","industry")+
    heading("地域","prefecture")+heading("登録区分","status")+
    heading("旧活動数","historical_activity_count")+
    heading("旧最終接触","historical_contact_date")+heading("取引確認","relationship_status")+
    heading("SI/SES","si_ses_candidate")+'<th>操作</th></tr>';
  const rows=(d.rows||[]).map(r=>
    '<tr class="'+(r.excluded?'engr-excluded':'')+'">'+
    '<td><input type="checkbox" data-engr-select="'+esc(r.id)+'" aria-label="'+esc(r.name)+'を選択"></td>'+
    '<td><b>'+esc(r.priority||"—")+'</b>'+ (r.manualPriority?'<small>手動</small>':'')+'</td>'+
    '<td class="engr-hover-cell"><button class="engr-company-name" type="button" data-engr-detail="'+esc(r.id)+'">'+esc(r.name)+'</button>'+
      preview(r)+'</td>'+
    '<td>'+esc(r.industry||"未設定")+'</td><td>'+esc(r.prefecture||"—")+'</td>'+
    '<td>'+esc(r.status||"—")+'<small>'+esc(r.classificationBasis||"")+'</small></td>'+
    '<td>'+fmt(r.historicalActivityCount)+'</td><td>'+esc(r.historicalContactDate||"—")+'</td>'+
    '<td>'+esc(relationLabels[r.relationshipStatus]||"未確認")+'</td>'+
    '<td>'+(r.siSesCandidate?'候補':'—')+'</td>'+
    '<td><button class="btn btn-secondary btn-sm" data-engr-detail="'+esc(r.id)+'" type="button">詳細</button>'+
     (r.excluded?'<small>除外済み</small>':'')+'</td>'+
    '</tr>').join("");
  const pages=Math.ceil(d.selectedCount/d.pageSize);
  resultEl.innerHTML=bulkBar()+
    '<div class="engr-table-wrap"><table class="sl-table"><thead>'+head+'</thead><tbody>'+
    (rows||'<tr><td colspan="11" class="sl-empty">該当企業はありません。</td></tr>')+'</tbody></table></div>'+
    '<div class="engr-pager">'+
    '<button type="button" class="btn btn-secondary btn-sm" data-engr-page="-1" '+(state.page<=1?"disabled":"")+'>前へ</button>'+
    '<span>'+fmt(state.page)+' / '+fmt(Math.max(1,pages))+'ページ（50社ずつ）</span>'+
    '<button type="button" class="btn btn-secondary btn-sm" data-engr-page="1" '+(state.page>=pages?"disabled":"")+'>次へ</button>'+
    '<button type="button" class="btn btn-secondary btn-sm" id="enger-dir-csv" '+(!d.rows.length?"disabled":"")+'>表示分CSV</button></div>';
  const note=root.querySelector("#enger-directory-note");
  if(note)note.textContent="分類・旧A〜D評価は暫定情報です。取引確認済みと営業資料の評価は分けて管理します。";
  selectedSync();controlsSync();
 }
 async function load(){
  const n=++ticket;setStatus("ENGER企業を読み込み中…");
  const p=new URLSearchParams({bucket:state.bucket,page:String(state.page),sort:state.sort,
    direction:state.direction,includeHidden:state.includeHidden?"1":"0"});
  if(state.q)p.set("q",state.q);
  if(state.siSes)p.set("siSes","1");
  if(state.priority)p.set("priority",state.priority);
  try{
   const d=await api("/api/sales/enger-company-directory?"+p.toString());
   if(n!==ticket)return;
   if(!d.complete)throw Error("企業情報の件数を検証できません。");
   draw(d);
  }catch(error){
   if(n!==ticket)return;
   loaded=null;resetSelection();
   setStatus("ENGER企業一覧を取得できません。");
   resultEl.innerHTML='<p class="engr-alert" role="alert">'+esc(error.hint||"通信か権限を確認してください。")+'</p>'+
    '<button class="btn btn-secondary btn-sm" type="button" id="enger-dir-retry">再取得</button>';
  }
 }
 function modalShell(name){
  modal.innerHTML='<div class="engr-modal-bg" data-engr-close="1"></div>'+
   '<section class="engr-modal" role="dialog" aria-modal="true" aria-label="'+esc(name)+'の企業情報">'+
   '<header class="engr-modal-head"><div><h2>'+esc(name)+'</h2><p>企業詳細・連絡先・営業履歴</p></div>'+
   '<button class="btn btn-secondary btn-sm" type="button" data-engr-close="1">閉じる</button></header>'+
   '<div class="engr-modal-content" id="engr-modal-body"><p class="engr-muted">企業情報と履歴を照合しています…</p></div></section>';
  modal.hidden=false;
 }
 const row=(label,value)=>'<div class="engr-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value??"—")+'</dd></div>';
 const actionOptions=(values,chosen)=>Object.entries(values).map(([k,label])=>
   '<option value="'+esc(k)+'" '+(k===chosen?"selected":"")+'>'+esc(label)+'</option>').join("");
 const priorityOptions=chosen=>["","A","B","C","D"].map(k=>
  '<option value="'+k+'" '+(k===chosen?"selected":"")+'>'+esc(k||"手動設定なし")+'</option>').join("");
 const safePhone=phone=>/^\+?[0-9\-()\s]{6,25}$/.test(String(phone||"").trim());
 const safeEmail=email=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||"").trim());
 const safeWebsite=site=>/^https?:\/\//i.test(site||"");
 function paintDetail(payload){
  const c=payload.company,e=payload.evidence;
  const warning=c.needsContactReview
    ?'<p class="engr-alert" role="alert">旧NG・配信停止または企業注意情報あり。連絡・配信・アポイント依頼の前に管理者が確認してください。</p>'
    :'<p class="engr-muted">保存済みの電話・メールが現在有効で、連絡が許可されているかは未確認です。</p>';
  const contact=(label,value,href)=>
   '<div class="engr-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value||"未登録")+
   (href&&!c.needsContactReview? ' <a href="'+esc(href)+'" class="engr-contact-link" rel="noopener noreferrer">連絡する</a>':"")+
   '</dd></div>';
  const phoneLink=safePhone(c.phone)?"tel:"+c.phone.replace(/[^\d+]/g,""):null;
  const mailLink=safeEmail(c.contactEmail)?"mailto:"+encodeURIComponent(c.contactEmail):null;
  const site=c.website&&safeWebsite(c.website)?'<a href="'+esc(c.website)+'" target="_blank" rel="noopener noreferrer">公式サイトを開く</a>':'未登録';
  const relationship=c.relationshipStatus==="active"||c.relationshipStatus==="past";
  const relationshipSummary=relationship?"**確認した取引情報あり**":"契約・取引の根拠は未確認";
  const history=e.touchpoints.map(t=>
    '<li><time>'+esc(textdate(t.occurredAt))+'</time> <strong>'+esc(t.kind||"活動")+'</strong> '+
     esc(t.summary||"")+(t.detail?'<small>'+esc(t.detail)+'</small>':"")+
     (t.nextAction?'<small>NEXT：'+esc(t.nextAction)+'</small>':"")+'</li>').join("");
  const actionDisabled=c.needsContactReview||c.bucket==="existing";
  const supplyBefore='<div id="enger-supply-pipeline" aria-label="案件・人材情報の提供依頼履歴"></div>';
  const tradeDetails=relationship?esc(c.relationshipEvidence||"根拠未登録"):
    '<span class="engr-muted">ENGERの「既存」「打ち合わせ済」は契約実績の証明ではありません。確認して登録してください。</span>';
  const body=modal.querySelector("#engr-modal-body");
  if(!body)return;
  body.innerHTML=warning+
   '<h3>企業情報・連絡先</h3><dl class="engr-dl">'+
    row("登録区分",c.status)+row("業種",c.industry)+row("都道府県",c.prefecture)+
    row("住所",c.address)+row("担当者名",c.contactName)+
    contact("電話番号",c.phone,phoneLink)+contact("メールアドレス",c.contactEmail,mailLink)+
    '<div class="engr-kv"><dt>ホームページ</dt><dd>'+site+'</dd></div>'+
   '</dl>'+
   '<h3>過去の取引・営業状況</h3>'+
   '<p><strong>'+esc(relationLabels[c.relationshipStatus]||"未確認")+'</strong>：'+relationshipSummary+'</p>'+
   '<p>'+tradeDetails+'</p>'+
   '<dl class="engr-dl">'+
    row("企業マスター区分",c.bucket==="existing"?"既存":c.bucket==="revive"?"掘り起こし":"新規")+
    row("登録ステータス",c.status)+row("分類の根拠",c.classificationBasis)+
    row("旧優先度（旧資料）",c.sourcePriority)+row("営業優先度（現在表示）",c.priority)+
    row("旧営業資料の最終接触",c.historicalContactDate)+row("旧資料の活動記録",fmt(c.historicalActivityCount)+"件")+
    row("打ち合わせ済み記録",c.meetingDone?"あり（契約とは別）":"未確認")+
    row("過去の打ち合わせ日",c.meetingDoneAt?textdate(c.meetingDoneAt):null)+
    row("企業IDに紐付いた提案件数",fmt(e.proposalCount)+"件")+
    row("案件・人材の本登録記録",fmt(e.registeredSupplies)+"件")+
   '</dl>'+
   '<h3>企業IDに紐付いた営業履歴（直近最大40件）</h3>'+
   (history?'<ol class="engr-history">'+history+'</ol>':'<p class="engr-muted">日時・担当との紐付いた営業履歴はありません。旧台帳の活動数は別の参考情報です。</p>')+
   '<h3>優先度・取引確認を更新</h3>'+
   '<div class="engr-detail-actions">'+
    '<label>営業優先度<select id="engr-detail-priority">'+priorityOptions(c.manualPriority||"")+'</select></label>'+
    '<button class="btn btn-secondary btn-sm" data-engr-detail-save="priority" type="button">優先度を保存</button>'+
    '<label>取引状況<select id="engr-detail-relation">'+actionOptions(relationLabels,c.relationshipStatus)+'</select></label>'+
    '<label>確認根拠（10文字以上）<textarea id="engr-detail-evidence" rows="2" placeholder="契約・営業記録、確認日、相手など">'+esc(c.relationshipEvidence||"")+'</textarea></label>'+
    '<button class="btn btn-secondary btn-sm" data-engr-detail-save="relationship" type="button">取引状況を記録</button>'+
    '<button class="btn btn-secondary btn-sm" data-engr-detail-save="'+(c.directoryExcluded?"restore":"exclude")+'" type="button">'+
       (c.directoryExcluded?"一覧への表示を戻す":"一覧から除外（履歴は残す）")+'</button>'+
   '</div><p id="engr-detail-message" class="engr-muted" role="status"></p>'+
   '<h3>次にやること</h3>'+
   '<p>案件・人材の情報提供、案件配信先・人材配信先を確認。受領した情報はENGERへ本登録し、案件ID・人材IDで結果を記録します。</p>'+
   '<div class="engr-modal-actions">'+
    '<a class="btn btn-primary btn-sm" href="https://dx.enger.jp/companies/'+encodeURIComponent(c.id)+'" target="_blank" rel="noopener noreferrer">ENGERの企業詳細へ</a>'+
    '<button class="btn btn-secondary btn-sm" type="button" data-engr-find-sales="'+esc(c.name)+'">Sales既存企業を検索</button>'+
    (e.linkedSalesCompanyId?'<a class="btn btn-secondary btn-sm" href="/sales/companies.html?id='+encodeURIComponent(e.linkedSalesCompanyId)+'">紐付いたSales企業</a>':"")+
   '</div>'+
   '<p class="engr-muted">会社名だけの一致では過去の売上・契約を自動推定しません。ENGERとSalesの企業IDの名寄せは確定したものだけです。</p>'+
   supplyBefore;
  document.dispatchEvent(new CustomEvent("enger:company-open",{detail:{company:{
    id:c.id,name:c.name,bucket:c.bucket,needsContactReview:c.needsContactReview,
  }}}));
 }
 async function openModal(id){
  detailId=id;const d=loaded?.rows?.find(r=>r.id===id);if(!d)return;
  const n=++detailTicket;modalShell(d.name);
  try{
   const payload=await api("/api/sales/enger-company-detail?id="+encodeURIComponent(id));
   if(n!==detailTicket||detailId!==id)return;
   if(!payload.company||!payload.evidence)throw Error("企業情報の証拠を照合できません");
   paintDetail(payload);
  }catch(error){
   if(n!==detailTicket)return;
   const body=modal.querySelector("#engr-modal-body");
   if(body)body.innerHTML='<p class="engr-alert" role="alert">'+esc(error.hint||"企業の詳細・営業履歴を取得できませんでした。")+'</p>';
  }
 }
 function closeModal(){++detailTicket;detailId=null;modal.innerHTML="";modal.hidden=true;}
 async function perform(action,ids,priority,relationshipStatus,evidence){
  if(!ids.length)throw Error("企業を選択してください。");
  const body={action,ids,priority,relationshipStatus,evidence};
  return api("/api/sales/enger-company-bulk",{method:"PATCH",body});
 }
 async function bulkSave(){
  const action=resultEl.querySelector("#engr-bulk-action")?.value;
  const ids=[...selected];
  if(!ids.length||!action)return;
  const priority=resultEl.querySelector("#engr-bulk-priority")?.value||null;
  const relationshipStatus=resultEl.querySelector("#engr-bulk-relationship")?.value||"unknown";
  const evidence=resultEl.querySelector("#engr-bulk-evidence")?.value||"";
  if(action==="relationship"&&relationshipStatus!=="unknown"&&evidence.trim().length<10){
   setStatus("取引の確認根拠を10文字以上入力してください。");return;
  }
  if(action==="exclude"&&!confirm(fmt(ids.length)+"社を営業一覧から除外します。企業本体と履歴は残ります。実行しますか？"))return;
  const btn=resultEl.querySelector("#engr-bulk-run");if(btn)btn.disabled=true;
  setStatus("選択した企業を更新しています…");
  try{
   const res=await perform(action,ids,priority,relationshipStatus,evidence);
   if(!res.complete)throw Error("更新結果を検証できません");
   resetSelection();await load();
   setStatus(fmt(res.updated)+"社を更新しました。除外した企業は「除外を含む」で復元できます。");
  }catch(error){setStatus(error.hint||"変更を保存できません。再表示して確認してください。");if(btn)btn.disabled=false;}
 }
 async function detailSave(btn){
  if(!detailId)return;
  const action=btn.dataset.engrDetailSave;
  const priority=modal.querySelector("#engr-detail-priority")?.value||null;
  const relationshipStatus=modal.querySelector("#engr-detail-relation")?.value||"unknown";
  const evidence=modal.querySelector("#engr-detail-evidence")?.value||"";
  const msg=modal.querySelector("#engr-detail-message");
  if(action==="exclude"&&!confirm("営業一覧から除外します。ENGER企業本体と履歴は残ります。"))return;
  if(action==="relationship"&&relationshipStatus!=="unknown"&&evidence.trim().length<10){
   if(msg)msg.textContent="取引の確認根拠を10文字以上入力してください。";return;
  }
  btn.disabled=true;if(msg)msg.textContent="保存しています…";
  try{
   const id=detailId;
   const result=await perform(action,[id],priority,relationshipStatus,evidence);
   if(!result.complete)throw Error("更新件数を確認できません");
   closeModal();await load();setStatus("企業の変更を保存しました。");
  }catch(error){btn.disabled=false;if(msg)msg.textContent=error.hint||"更新できませんでした。";}
 }
 root.addEventListener("click",e=>{
  const tab=e.target.closest("[data-engr-bucket]");
  if(tab){state.bucket=tab.dataset.engrBucket;state.page=1;void load();return;}
  const sort=e.target.closest("[data-engr-sort]");
  if(sort){const key=sort.dataset.engrSort;
   state.direction=state.sort===key&&state.direction==="asc"?"desc":"asc";
   state.sort=key;state.page=1;void load();return;}
  const page=e.target.closest("[data-engr-page]");
  if(page&&!page.disabled){state.page+=Number(page.dataset.engrPage);void load();return;}
  if(e.target.closest("#enger-dir-retry")){void load();return;}
  if(e.target.closest("#enger-dir-csv")){csv();return;}
  if(e.target.closest("#engr-bulk-run")){void bulkSave();return;}
  const open=e.target.closest("[data-engr-detail]");
  if(open){void openModal(open.dataset.engrDetail);return;}
 });
 resultEl.addEventListener("change",e=>{
  const choose=e.target.closest("[data-engr-select]");
  if(choose){if(choose.checked)selected.add(choose.dataset.engrSelect);else selected.delete(choose.dataset.engrSelect);selectedSync();return;}
  if(e.target.id==="engr-select-all"){for(const r of loaded?.rows||[]){
    if(e.target.checked)selected.add(r.id);else selected.delete(r.id);
    const cb=resultEl.querySelector('[data-engr-select="'+r.id+'"]');if(cb)cb.checked=e.target.checked;
   }selectedSync();return;}
  if(e.target.id==="engr-bulk-action"){controlsSync();return;}
 });
 modal.addEventListener("click",e=>{
  if(e.target.closest("[data-engr-close]")){closeModal();return;}
  const find=e.target.closest("[data-engr-find-sales]");
  if(find){location.assign("/sales/companies.html?q="+encodeURIComponent(find.dataset.engrFindSales));return;}
  const save=e.target.closest("[data-engr-detail-save]");
  if(save)void detailSave(save);
 });
 document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!modal.hidden)closeModal();});
 let debounce;
 root.querySelector("#enger-dir-search")?.addEventListener("input",e=>{clearTimeout(debounce);debounce=setTimeout(()=>{
  state.q=e.target.value.trim();state.page=1;void load();},350);});
 root.querySelector("#enger-dir-sector")?.addEventListener("change",e=>{state.siSes=e.target.checked;state.page=1;void load();});
 root.querySelector("#enger-dir-priority")?.addEventListener("change",e=>{state.priority=e.target.value;state.page=1;void load();});
 const showHidden=root.querySelector("#enger-dir-hidden");
 showHidden?.addEventListener("change",e=>{state.includeHidden=e.target.checked;state.page=1;void load();});
 void load();
})();
