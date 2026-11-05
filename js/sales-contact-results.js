import {summarizeContactResults} from '../lib/sales-contact-results.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'日時未記録';
let kind='contact',rows=[],reason='',busy=false,version=0;
function render(){
  const owner=$('cr-owner').value,outcome=$('cr-outcome').value,q=$('cr-search').value.trim().toLowerCase();
  const filtered=rows.filter(r=>(!owner||(r.ownerId||r.owner)===owner)&&(!outcome||kind!=='contact'||r.statusCode===outcome)&&(!q||`${r.company} ${r.contact}`.toLowerCase().includes(q)));
  const totals=summarizeContactResults(filtered);
  $('cr-summary').innerHTML=`<button class="cr-button" data-clear-reason>全件表示<strong>${filtered.length}</strong>${kind==='contact'?'対応記録':kind==='proposal_ng'?'提案':'企業'}</button><span class="cr-hint">担当者 ${totals.owners.length}名／企業 ${new Set(filtered.map(r=>r.companyId||r.company)).size}社</span>`;
  $('cr-reasons').innerHTML=totals.reasons.map(r=>`<button class="cr-button" data-reason="${esc(r.key)}" aria-pressed="${r.key===reason}">${esc(r.label)}<strong>${r.count}</strong></button>`).join('');
  const visible=filtered.filter(r=>!reason||r.kind+':'+r.reasonCode===reason);
  $('cr-rows').innerHTML=visible.length?visible.map(r=>`<tr tabindex="0" role="button" data-id="${esc(r.id)}" aria-label="${esc(r.company)}の詳細"><td>${esc(date(r.date))}<strong class="sl-nm">${esc(r.company)}</strong></td><td>${esc(r.contact||'先方未記録')}<span class="sl-sub2">当社：${esc(r.owner)}</span></td><td>${esc(r.channel)} ${esc(r.status)}<span class="sl-sub2">${esc(r.reason)}</span></td><td>${esc(r.nextAction||'次の対応未記録')}<span class="sl-sub2">${esc(r.nextDue)}</span></td></tr>`).join(''):'<tr><td colspan="4">条件に一致する記録はありません。</td></tr>';
}
async function load(){
  const current=++version;busy=true;$('cr-refresh').disabled=true;rows=[];reason='';render();$('cr-state').textContent='記録を読み込んでいます…';$('cr-basis').textContent='';
  const params=new URLSearchParams({kind,period:$('cr-period').value,from:$('cr-from').value,to:$('cr-to').value});
  try{
    const result=await API.api('/api/sales/contact-results?'+params);
    if(current!==version)return;
    rows=result.rows||[];$('cr-state').className=result.capped?'cr-error':'';
    $('cr-state').textContent=result.capped?`対象 ${result.total}件のうち最新 ${rows.length}件を表示・集計しています。期間を絞ってください。`:`対象 ${result.total}件`;
    $('cr-basis').textContent=result.basis;
    const options=summarizeContactResults(rows).owners;
    $('cr-owner').innerHTML='<option value="">全担当者</option>'+options.map(o=>`<option value="${esc(o.key)}">${esc(o.label)}（${o.count}件）</option>`).join('');render();
  }catch(e){if(current!==version)return;$('cr-state').className='cr-error';$('cr-state').textContent=e.hint||'記録を取得できませんでした。権限・接続を確認して再取得してください。';$('cr-rows').innerHTML='<tr><td colspan="4">データ未取得</td></tr>';}
  finally{if(current===version){busy=false;$('cr-refresh').disabled=false;}}
}
function detail(id){
  const r=rows.find(x=>x.id===id);if(!r)return;
  $('cr-detail-body').innerHTML=`<h2>${esc(r.company)}</h2><p>${esc(date(r.date))} ／ ${esc(r.status)}</p><dl><dt>当社担当者</dt><dd>${esc(r.owner)}</dd><dt>記録者</dt><dd>${esc(r.recorder)}</dd><dt>先方担当者</dt><dd>${esc(r.contact||'未記録')}</dd><dt>連絡先・手段</dt><dd>${esc(r.side)} ${esc(r.channel)}</dd><dt>理由</dt><dd>${esc(r.reason)}</dd><dt>次の対応</dt><dd>${esc(r.nextAction||'未記録')} ${esc(r.nextDue)}</dd></dl><p>${esc(r.note)}</p>${r.job?`<p>案件：${esc(r.job)}／人材：${esc(r.candidate)}</p>`:''}<div class="cr-cards">${r.proposalId?`<a class="cr-button" href="https://dx.enger.jp/proposals/${encodeURIComponent(r.proposalId)}" target="_blank" rel="noopener noreferrer">提案・連絡履歴を開く ↗</a>`:''}${r.companyId?`<a class="cr-button" href="https://dx.enger.jp/companies/${encodeURIComponent(r.companyId)}" target="_blank" rel="noopener noreferrer">企業情報・連絡履歴を開く ↗</a>`:''}${r.evidenceUrl?`<a class="cr-button" href="${esc(r.evidenceUrl)}" target="_blank" rel="noopener noreferrer">根拠メールを開く ↗</a>`:''}</div>`;
  $('cr-detail').showModal();
}
function dateControls(){const custom=$('cr-period').value==='custom'&&kind!=='company_ng';$('cr-from').disabled=!custom;$('cr-to').disabled=!custom;$('cr-period').disabled=kind==='company_ng';$('cr-outcome').disabled=kind!=='contact';}
$('cr-filter').onsubmit=e=>{e.preventDefault();if(!busy)void load();};
$('cr-period').onchange=()=>{dateControls();if($('cr-period').value!=='custom')void load();};
for(const id of ['cr-owner','cr-outcome','cr-search'])$(id).addEventListener('input',()=>{reason='';render();});
$('cr-tabs').onclick=e=>{const b=e.target.closest('[data-kind]');if(!b)return;kind=b.dataset.kind;for(const tab of $('cr-tabs').querySelectorAll('button'))tab.setAttribute('aria-pressed',String(tab===b));$('cr-outcome').value='';dateControls();void load();};
$('cr-reasons').onclick=e=>{const b=e.target.closest('[data-reason]');if(!b)return;reason=reason===b.dataset.reason?'':b.dataset.reason;render();};
$('cr-summary').onclick=e=>{if(e.target.closest('[data-clear-reason]')){reason='';render();}};
$('cr-rows').onclick=e=>{const row=e.target.closest('[data-id]');if(row)detail(row.dataset.id);};
$('cr-rows').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){const row=e.target.closest('[data-id]');if(row){e.preventDefault();detail(row.dataset.id);}}};
$('cr-close').onclick=()=>$('cr-detail').close();
try{const ctx=await SalesLayout.init({active:'analytics'});if(ctx)await load();else $('cr-state').textContent='この一覧を閲覧する権限がありません。';}
catch{$('cr-state').textContent='アクセス権を確認できません。';}
