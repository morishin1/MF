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
 let loaded=null,ticket=0,detailTicket=0,selected=new Set(),detailId=null,bulkBusy=false;
 let modalPayload=null,modalTab="overview",modalMode="overview",actionReturn="overview";
 const detailCache=new Map();
 const hover=document.createElement("div");
 hover.id="engr-hover-preview";hover.className="engr-hover-card";hover.hidden=true;
 hover.setAttribute("role","tooltip");document.body.append(hover);
 let hoverTimer,hoverAnchor=null,hoverTicket=0;
 const hideHover=()=>{clearTimeout(hoverTimer);++hoverTicket;hoverAnchor=null;hover.hidden=true;};
 const getDetail=id=>{
  if(!detailCache.has(id)){
   const request=api("/api/sales/enger-company-detail?id="+encodeURIComponent(id)).then(payload=>{
    if(!payload.company||!payload.evidence)throw Error("企業情報を取得できませんでした");
    return payload;
   }).catch(error=>{detailCache.delete(id);throw error;});
   detailCache.set(id,request);
  }
  return detailCache.get(id);
 };
 function positionHover(anchor){
  const box=anchor.getBoundingClientRect(),gap=10;
  hover.style.left=Math.max(gap,Math.min(box.left,innerWidth-hover.offsetWidth-gap))+"px";
  const below=box.bottom+gap;
  hover.style.top=Math.max(gap,Math.min(below+hover.offsetHeight<innerHeight?below:box.top-hover.offsetHeight-gap,innerHeight-hover.offsetHeight-gap))+"px";
 }
 function scheduleHover(anchor){
  if(hoverAnchor===anchor||!modal.hidden||bulkBusy)return;
  hideHover();hoverAnchor=anchor;
  const id=anchor.dataset.engrRow;
  const r=loaded?.rows?.find(item=>item.id===id);if(!r)return;
  const n=hoverTicket;
  hoverTimer=setTimeout(async()=>{
   hover.innerHTML=preview(r)+'<small>連絡先を確認中…</small>';hover.hidden=false;positionHover(anchor);
   try{
    const {company:c,evidence:e}=await getDetail(id);
    if(n!==hoverTicket||hoverAnchor!==anchor)return;
    hover.innerHTML=preview(c)+
     '<small>電話：'+esc(c.phone||"未登録")+'</small>'+
     '<small>メール：'+esc(c.contactEmail||"未登録")+'</small>'+
     '<small>ホームページ：'+esc(c.website||"未登録")+'</small>'+
     '<small>担当者：'+esc(c.contactName||"未登録")+'</small>'+
     '<small>企業IDに紐付いた提案：'+fmt(e.proposalCount)+'件</small>'+
     (c.needsContactReview?'<small class="engr-danger">連絡・配信の前に管理者確認が必要です</small>':'')+
     '<small>クリックで営業履歴を含む詳細を開く</small>';
   }catch{if(n!==hoverTicket)return;hover.innerHTML=preview(r)+'<small>連絡先を取得できませんでした。クリックして再確認してください。</small>';}
   positionHover(anchor);
  },350);
 }
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
  return '<div id="engr-bulk-toolbar" class="sl-bulkbar engr-bulk-toolbar" role="toolbar" aria-label="選択したENGER企業の操作" '+(disabled?'hidden':'')+'>'+
   '<strong class="cnt" id="engr-bulk-count">'+fmt(selected.size)+'社選択</strong>'+
   '<button class="btn btn-primary btn-sm" id="engr-bulk-edit" type="button" aria-expanded="false" aria-controls="engr-bulk-fields">更新</button>'+
   '<button class="btn btn-danger btn-sm" id="engr-bulk-delete" type="button">削除</button>'+
   '<button class="btn btn-secondary btn-sm" id="engr-bulk-clear" type="button">選択解除</button>'+
   '<div id="engr-bulk-fields" class="engr-bulk-fields" hidden>'+
   '<strong>選択した企業を一括更新</strong>'+
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
   '<span class="engr-muted">削除は営業一覧からの除外です。企業情報・履歴は残り、復元できます。</span></div>'+
   '</div>';
 }
 const selectedSync=()=>{
  const bar=resultEl.querySelector("#engr-bulk-toolbar");if(bar)bar.hidden=selected.size===0;
  root.classList.toggle("engr-has-selection",selected.size>0);
  for(const cb of resultEl.querySelectorAll("[data-engr-select]")){
   cb.checked=selected.has(cb.dataset.engrSelect);cb.closest("tr").classList.toggle("sel",cb.checked);
  }
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
  return '<b>'+esc(r.name)+'</b><small>'+esc(r.industry||"業種未登録")+' ／ '+esc(r.prefecture||"地域未登録")+'</small>'+
    '<small>優先度：'+esc(r.priority||"—")+' ／ 取引：'+esc(relationLabels[r.relationshipStatus]||"未確認")+'</small>'+
    '<small>旧活動 '+fmt(r.historicalActivityCount)+'件 ／ 最終接触 '+esc(r.historicalContactDate||"不明")+'</small>';
 };
 function draw(d){
  hideHover();detailCache.clear();loaded=d;resetSelection();
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
    heading("優先","effective_priority")+heading("企業","name")+heading("連絡先")+
    heading("業種・地域","industry")+heading("営業状況")+heading("担当")+
    heading("次の対応・期限")+heading("取引確認","relationship_status")+heading("アタック")+'</tr>';
  const rows=(d.rows||[]).map(r=>{
    const sales=r.sales,blocked=r.needsContactReview||r.excluded||sales?.hidden||sales?.ngReason;
    const hasContact=r.phone||r.contactEmail||r.formUrl||(sales?sales.website:r.website);
    const contactText=[r.phone?'電話 '+esc(r.phone):'',r.contactEmail?'メール '+esc(r.contactEmail):'',r.formUrl?'フォームあり':''].filter(Boolean).join('<br>');
    return '<tr data-engr-row="'+esc(r.id)+'" class="'+(r.excluded?'engr-excluded':'')+'" tabindex="0" aria-label="'+esc(r.name)+'の企業詳細を開く">'+
    '<td><input type="checkbox" data-engr-select="'+esc(r.id)+'" aria-label="'+esc(r.name)+'を選択"></td>'+
    '<td><b>'+esc(r.priority||"—")+'</b></td>'+
    '<td class="engr-hover-cell"><strong class="engr-company-name">'+esc(r.name)+'</strong>'+
      '<small>'+esc(r.status||"区分未登録")+(r.siSesCandidate?' ／ SI・SES':'')+'</small></td>'+
    '<td class="engr-contact-cell">'+(contactText||'<span class="engr-muted">電話・メール未登録</span>')+
      '<small>'+((sales?sales.website:r.website)?'企業サイトあり':'')+'</small></td>'+
    '<td>'+esc(r.industry||"未設定")+'<small>'+esc(r.prefecture||"—")+'</small></td>'+
    '<td>'+esc(blocked?'連絡停止・要確認':sales?.statusLabel||'営業未開始')+'</td>'+
    '<td>'+esc(sales?.ownerName||'未割当')+'</td>'+
    '<td>'+esc(sales?.nextAction||(blocked?'管理者が確認':hasContact?'アタックする':'連絡先を登録'))+
      '<small>'+esc(sales?.nextActionOn||'期限未設定')+'</small></td>'+
    '<td>'+esc(relationLabels[r.relationshipStatus]||"未確認")+'</td>'+
    '<td><button class="btn btn-primary btn-sm" type="button" data-engr-action="'+(hasContact?'attack':'edit')+'" data-engr-id="'+esc(r.id)+'" '+(blocked?'disabled':'')+'>'+ (hasContact?'アタック':'連絡先を登録')+'</button></td></tr>';
  }).join("");
  const pages=Math.ceil(d.selectedCount/d.pageSize);
  resultEl.innerHTML=bulkBar()+
    '<div class="engr-table-wrap"><table class="sl-table"><thead>'+head+'</thead><tbody>'+
    (rows||'<tr><td colspan="10" class="sl-empty">該当企業はありません。</td></tr>')+'</tbody></table></div>'+
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
  hideHover();resetSelection();selectedSync();resultEl.inert=true;
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
  }finally{if(n===ticket)resultEl.inert=false;}
 }
 function modalShell(name){
  modal.innerHTML='<div class="engr-modal-bg" data-engr-close="1"></div>'+
   '<section class="engr-modal" role="dialog" aria-modal="true" aria-label="'+esc(name)+'の企業情報">'+
   '<header class="engr-modal-head"><div><h2>'+esc(name)+'</h2><p>企業詳細・連絡先・営業履歴</p></div>'+
   '<button class="btn btn-secondary btn-sm" type="button" data-engr-close="1">閉じる</button></header>'+
   '<div class="engr-modal-content" id="engr-modal-body"><p class="engr-muted">読み込み中…</p></div>'+
   '<div id="engr-action-panel" hidden></div><div id="engr-attack-slot" hidden></div></section>';
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
 function setMode(mode){
  modalMode=mode;
  modal.querySelector('#engr-modal-body').hidden=mode!=="overview";
  modal.querySelector('#engr-action-panel').hidden=mode!=="action";
  modal.querySelector('#engr-attack-slot').hidden=mode!=="attack";
  modal.querySelector('.engr-modal').scrollTop=0;
 }
 function setupSingleModal(){
  window.beginEngerCompanyModal({
   showAction(html){
    if(modalMode!=="action")actionReturn=modalMode;
    modal.querySelector('#engr-action-panel').innerHTML='<button type="button" class="btn btn-secondary btn-sm" data-engr-back>← 戻る</button>'+html;
    setMode('action');
   },
   closeAction(){setMode(actionReturn);modal.querySelector('#engr-action-panel').innerHTML='';},
   mountAttack(root){modal.querySelector('#engr-attack-slot').append(root);setMode('attack');},
   closeAttack(){setMode('overview');},
  });
 }
 async function refreshOverview(){
  if(!detailId||modal.hidden)return;
  const id=detailId,n=detailTicket;
  try{
   const payload=await getDetail(id);
   if(n!==detailTicket||id!==detailId)return;
   paintDetail(payload);
  }catch(error){
   if(n!==detailTicket)return;
   const msg=modal.querySelector('#engr-detail-message');
   if(msg)msg.textContent=error.hint||'最新情報を取得できませんでした。';
  }
 }
 async function selectModalTab(tab){
  modalTab=tab;
  for(const button of modal.querySelectorAll('[data-engr-tab]'))button.setAttribute('aria-selected',String(button.dataset.engrTab===tab));
  for(const panel of modal.querySelectorAll('[data-engr-panel]'))panel.hidden=panel.dataset.engrPanel!==tab;
  if(tab==='history'){
   const target=modal.querySelector('#engr-sales-history'),id=modalPayload?.evidence?.linkedSalesCompanyId||modalPayload?.company?.sales?.id,n=detailTicket;
   if(!target||target.dataset.loaded)return;
   target.textContent=id?'履歴を読み込み中…':'まだ営業履歴はありません。';
   if(!id)return;
   try{
    const html=await window.engerSalesHistory(id);
    if(n!==detailTicket||!target.isConnected)return;
    target.innerHTML=html;target.dataset.loaded='1';
   }catch{if(n===detailTicket&&target.isConnected)target.innerHTML='<p class="engr-alert">営業履歴を取得できませんでした。</p><button type="button" class="btn btn-secondary btn-sm" data-engr-tab="history">再取得</button>';}
  }
  if(tab==='more'&&modalPayload)document.dispatchEvent(new CustomEvent('enger:company-open',{detail:{company:modalPayload.company}}));
 }
 function paintDetail(payload){
  modalPayload=payload;
  const c=payload.company,e=payload.evidence;
  const blocked=c.needsContactReview||c.directoryExcluded||c.sales?.hidden||c.sales?.ngReason;
  const warning=blocked?'<p class="engr-alert">営業禁止・除外または連絡注意の情報があります。管理者が確認してください。</p>':'';
  const button=(action,label,primary=false)=>'<button type="button" class="btn '+(primary?'btn-primary':'btn-secondary')+' btn-sm" data-engr-action="'+action+'" data-engr-id="'+esc(c.id)+'" '+(blocked?'disabled':'')+'>'+label+'</button>';
  const contact=(label,value,href)=>'<div class="engr-kv"><dt>'+esc(label)+'</dt><dd>'+
   (href&&!blocked?'<a class="engr-contact-link" href="'+esc(href)+'">'+esc(value)+'</a>':esc(value||'未登録'))+'</dd></div>';
  const site=(url,label)=>safeWebsite(url)?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+label+'</a>':'未登録';
  const history=(e.touchpoints||[]).map(t=>'<li><time>'+esc(textdate(t.occurredAt))+'</time> '+esc(t.summary||t.kind||'活動')+
   (t.detail?'<small>'+esc(t.detail)+'</small>':'')+(t.createdBy?'<small>記録者：'+esc(t.createdBy)+'</small>':'')+
   (t.nextAction?'<small>次の対応：'+esc(t.nextAction)+'</small>':'')+'</li>').join('');
  const body=modal.querySelector('#engr-modal-body');if(!body)return;
  body.innerHTML=warning+
   '<nav class="engr-modal-nav" role="tablist" aria-label="企業情報の表示">'+
   [['overview','基本情報'],['history','履歴'],['more','その他']].map(([key,label])=>'<button type="button" role="tab" data-engr-tab="'+key+'" aria-selected="'+(modalTab===key)+'">'+label+'</button>').join('')+'</nav>'+
   '<section data-engr-panel="overview" aria-label="基本情報">'+
    '<p class="engr-muted">'+esc(c.sales?.statusLabel||'営業未開始')+' ／ 担当：'+esc(c.sales?.ownerName||'未割当')+'</p>'+
    '<div class="engr-next">'+button('status','変更')+'<small>次の対応</small><strong>'+esc(c.sales?.nextAction||'連絡先を確認してアタック')+'</strong><small>'+esc(c.sales?.nextActionOn||'期限未設定')+'</small></div>'+
    '<dl class="engr-dl">'+
      contact('電話',c.phone,safePhone(c.phone)?'tel:'+c.phone.replace(/[^\d+]/g,''):null)+
      contact('メール',c.contactEmail,safeEmail(c.contactEmail)?'mailto:'+encodeURIComponent(c.contactEmail):null)+
      '<div class="engr-kv"><dt>企業サイト</dt><dd>'+site(c.website,'サイトを開く')+'</dd></div>'+
      '<div class="engr-kv"><dt>問い合わせフォーム</dt><dd>'+site(c.formUrl,'フォームを開く')+'</dd></div>'+
    '</dl><div class="engr-modal-actions">'+button('attack','アタック',true)+button('record','対応を記録')+button('edit','編集')+'</div>'+
   '</section>'+
   '<section data-engr-panel="history" aria-label="営業履歴" hidden><div id="engr-sales-history"></div>'+
    '<details class="engr-more"><summary>ENGER・旧台帳の履歴</summary>'+
     (history?'<ol class="engr-history">'+history+'</ol>':'<p class="engr-muted">ENGERの活動記録はありません。</p>')+
     '<p class="engr-muted">旧台帳：'+fmt(c.historicalActivityCount)+'件 ／ 最終接触：'+esc(c.historicalContactDate||'不明')+'（契約実績とは別）</p>'+
     '<dl class="engr-dl">'+row('打ち合わせ済み記録',c.meetingDone?'あり（契約とは別）':'未確認')+row('過去の打ち合わせ日',c.meetingDoneAt?textdate(c.meetingDoneAt):null)+row('ENGER記録上の最終連絡',c.lastContactedAt?textdate(c.lastContactedAt):null)+'</dl>'+
     '<p class="engr-muted">提案 '+fmt(e.proposalCount)+'件 ／ 案件・人材の本登録 '+fmt(e.registeredSupplies)+'件</p></details></section>'+
   '<section data-engr-panel="more" aria-label="その他の企業情報" hidden>'+
    '<details class="engr-more"><summary>業種・所在地など</summary><dl class="engr-dl">'+row('業種',c.industry)+row('地域',c.prefecture)+row('住所',c.address)+row('窓口担当者',c.contactName)+row('登録区分',c.status)+row('分類の根拠',c.classificationBasis)+row('旧資料の優先度',c.sourcePriority)+'</dl></details>'+
    '<details class="engr-more"><summary>優先度・取引確認</summary><div class="engr-detail-actions">'+
     '<label>営業優先度<select id="engr-detail-priority">'+priorityOptions(c.manualPriority||'')+'</select></label>'+
     '<button class="btn btn-secondary btn-sm" data-engr-detail-save="priority" type="button">優先度を保存</button>'+
     '<label>取引状況<select id="engr-detail-relation">'+actionOptions(relationLabels,c.relationshipStatus)+'</select></label>'+
     '<label>確認根拠（10文字以上）<textarea id="engr-detail-evidence" rows="2">'+esc(c.relationshipEvidence||'')+'</textarea></label>'+
     '<button class="btn btn-secondary btn-sm" data-engr-detail-save="relationship" type="button">取引状況を記録</button></div></details>'+
    '<details class="engr-more"><summary>案件・人材情報の依頼</summary><div id="enger-supply-pipeline" aria-label="案件・人材情報の提供依頼履歴"></div></details>'+
    '<details class="engr-more"><summary>表示設定・外部リンク</summary><div class="engr-modal-actions">'+
     '<button class="btn btn-secondary btn-sm" data-engr-detail-save="'+(c.directoryExcluded?'restore':'exclude')+'" type="button">'+(c.directoryExcluded?'一覧への表示を戻す':'一覧から除外（履歴は残す）')+'</button>'+
     '<a class="btn btn-secondary btn-sm" href="https://dx.enger.jp/companies/'+encodeURIComponent(c.id)+'" target="_blank" rel="noopener noreferrer">ENGERで開く</a></div></details>'+
   '</section><p id="engr-detail-message" class="engr-muted" role="status"></p>';
  void selectModalTab(modalTab);
 }
 async function openModal(id){
  hideHover();const d=loaded?.rows?.find(r=>r.id===id);if(!d)return false;
  if(!modal.hidden)closeModal();
  detailId=id;modalTab="overview";modalMode="overview";modalPayload=null;
  const n=++detailTicket;modalShell(d.name);setupSingleModal();
  try{
   const payload=await getDetail(id);
   if(n!==detailTicket||detailId!==id)return;
   if(!payload.company||!payload.evidence)throw Error("企業情報の証拠を照合できません");
   paintDetail(payload);return true;
  }catch(error){
   if(n!==detailTicket)return;
   const body=modal.querySelector("#engr-modal-body");
   if(body)body.innerHTML='<p class="engr-alert" role="alert">'+esc(error.hint||"企業の詳細・営業履歴を取得できませんでした。")+'</p><button type="button" class="btn btn-secondary" data-engr-retry-detail="1">再取得</button>';
  }
 }
 function closeModal(){++detailTicket;detailId=null;modalPayload=null;window.endEngerCompanyModal?.();modal.innerHTML="";modal.hidden=true;}
 let actionBusy=false;
 async function startSalesAction(btn){
  if(actionBusy||btn.disabled)return;
  const id=btn.dataset.engrId,action=btn.dataset.engrAction;
  actionBusy=true;hideHover();btn.disabled=true;
  if((modal.hidden||detailId!==id)&&!await openModal(id)){actionBusy=false;btn.disabled=false;return;}
  const msg=modal.hidden?statusEl:modal.querySelector('#engr-detail-message');
  if(msg)msg.textContent='営業情報を開いています…';
  const seq=detailTicket;
  try{
   const result=await api('/api/sales/enger-company-action',{method:'POST',body:{id}});
   detailCache.delete(id);
   if(seq!==detailTicket)return;
   await window.openEngerSalesAction(result.companyId,action);
   void refreshOverview();void load();
  }catch(error){if(msg)msg.textContent=error.hint||'営業情報を開けませんでした。再度お試しください。';}
  finally{actionBusy=false;btn.disabled=false;}
 }
 document.addEventListener('sales:company-changed',()=>{detailCache.clear();void refreshOverview();void load();});
 async function perform(action,ids,priority,relationshipStatus,evidence){
  if(!ids.length)throw Error("企業を選択してください。");
  const body={action,ids,priority,relationshipStatus,evidence};
  const result=await api("/api/sales/enger-company-bulk",{method:"PATCH",body});
  ids.forEach(id=>detailCache.delete(id));return result;
 }
 async function bulkSave(overrideAction){
  if(bulkBusy)return;
  const action=overrideAction||resultEl.querySelector("#engr-bulk-action")?.value;
  const ids=[...selected];
  if(!ids.length||!action)return;
  const priority=resultEl.querySelector("#engr-bulk-priority")?.value||null;
  const relationshipStatus=resultEl.querySelector("#engr-bulk-relationship")?.value||"unknown";
  const evidence=resultEl.querySelector("#engr-bulk-evidence")?.value||"";
  if(action==="relationship"&&relationshipStatus!=="unknown"&&evidence.trim().length<10){
   setStatus("取引の確認根拠を10文字以上入力してください。");return;
  }
  if(action==="exclude"&&!confirm(fmt(ids.length)+"社を営業一覧から除外します。企業本体と履歴は残ります。実行しますか？"))return;
  bulkBusy=true;
  const controls=[...root.querySelectorAll("button,input,select,textarea")];
  const disabled=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);
  setStatus("選択した企業を更新しています…");
  try{
   const res=await perform(action,ids,priority,relationshipStatus,evidence);
   if(!res.complete)throw Error("更新結果を検証できません");
   resetSelection();await load();
   setStatus(fmt(res.updated)+"社を更新しました。除外した企業は「除外を含む」で復元できます。");
  }catch(error){setStatus(error.hint||"変更を保存できません。再表示して確認してください。");}
  finally{bulkBusy=false;controls.forEach((control,i)=>control.disabled=disabled[i]);}
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
  if(bulkBusy)return;
  if(e.target.closest("#engr-bulk-edit")){
   hideHover();const fields=resultEl.querySelector("#engr-bulk-fields");fields.hidden=!fields.hidden;
   e.target.closest("button").setAttribute("aria-expanded",String(!fields.hidden));
   if(!fields.hidden)resultEl.querySelector("#engr-bulk-action").focus();return;
  }
  if(e.target.closest("#engr-bulk-delete")){void bulkSave("exclude");return;}
  if(e.target.closest("#engr-bulk-clear")){resetSelection();selectedSync();return;}
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
  const action=e.target.closest('[data-engr-action]');
  if(action){void startSalesAction(action);return;}
  const companyRow=e.target.closest("[data-engr-row]");
  if(companyRow&&!e.target.closest("button,input,label,a,select,textarea"))void openModal(companyRow.dataset.engrRow);
 });
 resultEl.addEventListener("pointerover",e=>{
  if(e.pointerType==="touch")return;
  const anchor=e.target.closest("[data-engr-row]");
  if(e.target.closest("input,label")){hideHover();return;}
  if(anchor)scheduleHover(anchor);
 });
 resultEl.addEventListener("pointerout",e=>{
  const anchor=e.target.closest("[data-engr-row]");
  if(anchor&&!anchor.contains(e.relatedTarget)&&!hover.contains(e.relatedTarget))hideHover();
 });
 resultEl.addEventListener("focusin",e=>{
  const anchor=e.target.closest("[data-engr-row]");
  if(anchor&&!e.target.closest('input,label,button,select,textarea'))scheduleHover(anchor);
 });
 resultEl.addEventListener("focusout",()=>hideHover());
 hover.addEventListener("pointerleave",()=>hideHover());
 window.addEventListener("scroll",()=>hideHover(),true);
 window.addEventListener("resize",()=>hideHover());
 document.addEventListener("click",e=>{
  if(!e.target.closest("#engr-bulk-toolbar")){
   const fields=resultEl.querySelector("#engr-bulk-fields");if(fields)fields.hidden=true;
   resultEl.querySelector("#engr-bulk-edit")?.setAttribute("aria-expanded","false");
  }
 });
 // Keyboard-accessible row details without a separate per-row button.
 resultEl.addEventListener("keydown",e=>{
  const row=e.target.closest("[data-engr-row]");
  if(row && e.target===row && (e.key==="Enter" || e.key===" ")){
   e.preventDefault();hideHover();void openModal(row.dataset.engrRow);
  }
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
  if(e.target.closest('[data-engr-retry-detail]')){detailCache.delete(detailId);void openModal(detailId);return;}
  const action=e.target.closest('[data-engr-action]');if(action){void startSalesAction(action);return;}
  const tab=e.target.closest('[data-engr-tab]');if(tab){void selectModalTab(tab.dataset.engrTab);return;}
  if(e.target.closest('[data-engr-back]')){window.closeAction();return;}
  const find=e.target.closest("[data-engr-find-sales]");
  if(find){location.assign("/sales/companies.html?q="+encodeURIComponent(find.dataset.engrFindSales));return;}
  const save=e.target.closest("[data-engr-detail-save]");
  if(save)void detailSave(save);
 });
 document.addEventListener("keydown",e=>{if(e.key==="Escape"){
  hideHover();if(!modal.hidden)closeModal();
  const fields=resultEl.querySelector("#engr-bulk-fields");if(fields&&!fields.hidden){fields.hidden=true;const edit=resultEl.querySelector("#engr-bulk-edit");edit?.setAttribute("aria-expanded","false");edit?.focus();}
 }});
 let debounce;
 root.querySelector("#enger-dir-search")?.addEventListener("input",e=>{clearTimeout(debounce);debounce=setTimeout(()=>{
  state.q=e.target.value.trim();state.page=1;void load();},350);});
 root.querySelector("#enger-dir-sector")?.addEventListener("change",e=>{state.siSes=e.target.checked;state.page=1;void load();});
 root.querySelector("#enger-dir-priority")?.addEventListener("change",e=>{state.priority=e.target.value;state.page=1;void load();});
 const showHidden=root.querySelector("#enger-dir-hidden");
 showHidden?.addEventListener("change",e=>{state.includeHidden=e.target.checked;state.page=1;void load();});
 void load();
})();
