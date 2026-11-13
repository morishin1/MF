// Sales登録企業も企業DBと同じ中央モーダルで表示する。リード画面には適用しない。
(() => {
 let session=null,sequence=0;
 const hover=document.createElement('div');hover.className='engr-hover-card';hover.hidden=true;hover.style.pointerEvents='none';hover.setAttribute('role','tooltip');document.body.append(hover);
 let timer,anchor=null;
 const clearHover=()=>{clearTimeout(timer);anchor=null;hover.hidden=true;};
 window.clearSalesHover=clearHover;
 function preview(row){
  if(!row||session||detailHost.companyModal||anchor===row)return;clearHover();anchor=row;
  timer=setTimeout(()=>{
   const c=companies.find(c=>c.id===row.dataset.id);if(!c||!row.isConnected)return;
   hover.innerHTML=`<b>${esc(c.name)}</b><small>${esc(c.statusLabel||'未アタック')} ／ 担当：${esc(c.ownerName||'未割当')}</small><small>クリックで連絡先・営業履歴を確認</small><small>次の対応：${esc(c.nextAction||c.next||'未設定')} ${esc(c.nextActionOn||c.nextDue||'')}</small>`;
   hover.hidden=false;const r=row.getBoundingClientRect();hover.style.left=Math.max(10,Math.min(r.left,innerWidth-hover.offsetWidth-10))+'px';hover.style.top=Math.max(10,Math.min(r.bottom+6,innerHeight-hover.offsetHeight-10))+'px';
  },300);
 }
 el('rows').addEventListener('pointerover',e=>{if(e.target.closest('input,button,a'))clearHover();else preview(e.target.closest('tr[data-id]'));});
 el('rows').addEventListener('pointerout',e=>{if(anchor&&!anchor.contains(e.relatedTarget))clearHover();});
 el('rows').addEventListener('focusin',e=>{if(e.target.matches('tr[data-id]'))preview(e.target);});
 el('rows').addEventListener('focusout',clearHover);
 document.addEventListener('scroll',clearHover,true);

 const safeUrl=u=>/^https?:\/\//i.test(u||'');
 function show(mode){
  if(!session)return;
  session.mode=mode;
  for(const [id,key] of [['company-modal-view','view'],['engr-action-panel','action'],['engr-attack-slot','attack']])el(id).hidden=mode!==key;
  el('company-modal-dialog').scrollTop=0;
 }
 function tab(key){
  if(!session)return;session.tab=key;
  for(const b of el('company-modal-view').querySelectorAll('[data-sales-tab]'))b.setAttribute('aria-selected',String(b.dataset.salesTab===key));
  for(const p of el('company-modal-view').querySelectorAll('[data-sales-panel]'))p.hidden=p.dataset.salesPanel!==key;
 }
 function render(){
  if(!session||detail?.company?.id!==session.id)return;
  const d=detail,c=d.company;
  el('company-modal-title').textContent=c.name;
  const kv=(label,value)=>`<div class="engr-kv"><dt>${label}</dt><dd>${esc(value||'未登録')}</dd></div>`;
  const url=(label,value)=>`<div class="engr-kv"><dt>${label}</dt><dd>${safeUrl(value)?`<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">開く</a>`:'未登録'}</dd></div>`;
  const blocked=c.hidden||c.ngReason;
  const meeting=activeMeetingOf(d.meetings);
  el('company-modal-view').innerHTML=`<div class="engr-modal-content">
   ${blocked?`<p class="engr-alert">${c.ngReason?'営業禁止：'+esc(c.ngLabel||c.ngReason):'非表示の企業です。再表示してからアタックしてください。'}</p>`:''}
   ${d.recent && !c.ngReason ? `<div class="sl-warn sl-caution"><span class="material-symbols-outlined">warning</span><div>${recentLine(d.recent)}</div></div>` : ""}
   <nav class="engr-modal-nav" role="tablist" aria-label="企業情報の表示">
    <button role="tab" data-sales-tab="overview">基本情報</button><button role="tab" data-sales-tab="history">履歴</button><button role="tab" data-sales-tab="more">その他</button>
   </nav>
   <section data-sales-panel="overview">
    <p class="engr-muted">${esc(c.statusLabel||'未アタック')} ／ 担当：${esc(c.ownerName||'未割当')}</p>
    <div class="engr-next"><button class="btn btn-secondary btn-sm" onclick="openStatus()">変更</button><small>次の対応</small><strong>${esc(c.nextAction||c.next||'連絡先を確認してアタック')}</strong><small>${esc(c.nextActionOn||c.nextDue||'期限未設定')}</small></div>
    <dl class="engr-dl">${kv('電話',c.phone)}${kv('メール',(c.emails||[]).join(', '))}${url('企業サイト',c.siteUrl)}${url('問い合わせフォーム',c.formUrl)}</dl>
    <div class="engr-modal-actions"><button class="btn btn-primary btn-sm" onclick="openAttack('${esc(c.id)}')" ${blocked?'disabled':''}>アタック</button><button class="btn btn-secondary btn-sm" onclick="openEvent('call')">対応を記録</button><button class="btn btn-secondary btn-sm" onclick="openEdit()">編集</button></div>
    ${meeting?`<p class="engr-muted">商談：${esc(meetingStage(meeting).label)} ${esc(meeting.scheduledAt?fmt(meeting.scheduledAt):'日時未定')}</p>`:''}
   </section>
   <section data-sales-panel="history" hidden>${timelineHtml(d.timeline)}
    ${(d.approaches||[]).length?`<details class="engr-more"><summary>送った営業文</summary>${d.approaches.map(a=>`<details class="engr-more"><summary>${esc(fmt(a.sentAt||a.preparedAt))} ${esc(a.channelLabel||'')} ${esc(a.employeeName||'')}</summary><p style="white-space:pre-wrap">${esc(a.body||'')}</p></details>`).join('')}</details>`:''}
   </section>
   <section data-sales-panel="more" hidden>
    <details class="engr-more"><summary>業種・所在地・メモなど</summary><dl class="engr-dl">${kv('業種',c.industry)}${kv('所在地',c.address||c.region)}${kv('提案サービス',c.service)}${kv('キャンペーン',c.campaignName)}${contactRows(c)}</dl><p style="white-space:pre-wrap">${esc(c.note||'')}</p>${contactStatusHtml(d.contactStatus,c)}${lpBlockHtml(d.lp)}</details>
    <details class="engr-more"><summary>商談・案件</summary><div class="engr-modal-actions"><button class="btn btn-secondary btn-sm" onclick="openMeeting()">商談を予定・確認</button><button class="btn btn-secondary btn-sm" onclick="openContact()">返信・やり取りを記録</button></div>${dealsHtml()}</details>
    <details class="engr-more"><summary>営業禁止・表示設定・削除</summary><div class="engr-modal-actions"><button class="btn btn-secondary btn-sm" onclick="openNg()">${c.ngReason?'営業禁止を解除':'営業禁止にする'}</button>${c.hidden?'<button class="btn btn-secondary btn-sm" onclick="unhideOne(this)">再表示する</button>':'<button class="btn btn-secondary btn-sm" onclick="openHideOne()">非表示にする</button>'}<button class="btn btn-secondary btn-sm" onclick="openDeleteOne()">削除</button></div></details>
   </section><p id="company-modal-message" class="engr-muted" role="status"></p>
  </div>`;
  tab(session.tab);
 }
 async function refresh(){
  const s=session;if(!s)return;
  const request=++s.request;
  try{
   const d=await API.getSalesCompany(s.id);
   if(session!==s||request!==s.request)return;
   detail=d;if(d.masters)masters=d.masters;if(d.members)members=d.members;render();
  }catch(e){if(session===s&&el('company-modal-message'))el('company-modal-message').textContent=errText(e,'再取得できませんでした');}
 }
 async function open(id){
  clearHover();closeModal();
  const n=++sequence;
  const s={id,tab:'overview',mode:'view',returnMode:'view',request:0};session=s;
  el('modal-root').innerHTML=`<div class="engr-modal-bg" onclick="closeModal()"></div><section class="engr-modal" id="company-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="company-modal-title"><header class="engr-modal-head"><h2 id="company-modal-title">企業情報</h2><button class="btn btn-secondary btn-sm" onclick="closeModal()">閉じる</button></header><div id="company-modal-view"><p style="padding:22px">読み込み中…</p></div><div id="engr-action-panel" hidden></div><div id="engr-attack-slot" hidden></div></section>`;
  detailHost.companyModal={companyId:id,render,
   close(){session=null;++sequence;window.endEngerCompanyModal();closeModal();},
   showAction(html){if(s.mode!=='action')s.returnMode=s.mode;el('engr-action-panel').innerHTML='<button class="btn btn-secondary btn-sm" onclick="closeAction()">← 戻る</button>'+html;show('action');},
   closeAction(){show(s.returnMode);el('engr-action-panel').innerHTML='';},
   mountAttack(root){el('engr-attack-slot').append(root);show('attack');},
   closeAttack(){show('view');history.replaceState({},'',detailHost.urlFor(id));},
  };
  history.replaceState({},'',detailHost.urlFor(id));
  el('company-modal-view').addEventListener('click',e=>{const b=e.target.closest('[data-sales-tab]');if(b)tab(b.dataset.salesTab);});
  try{
   const d=await API.getSalesCompany(id);if(n!==sequence||session!==s)return false;
   detail=d;if(d.masters)masters=d.masters;if(d.members)members=d.members;render();return true;
  }catch(e){if(session===s)el('company-modal-view').innerHTML=`<p class="engr-alert" style="margin:22px">${esc(errText(e,'企業情報を取得できませんでした'))}</p><button class="btn btn-secondary" onclick="openDetail('${esc(id)}')">再取得</button>`;return false;}
 }
 detailHost.openCompany=open;
 document.addEventListener('sales:company-changed',()=>{void refresh();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&session)closeModal();});
})();
