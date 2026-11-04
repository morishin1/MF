import {createCompanyWorkbench} from './sales-company-workbench.js';
(() => {
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>Number(n||0).toLocaleString('ja-JP');
 const date=v=>v?new Date(v).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
 const draft=new Map(),selected=new Set();let rows=[],page=1,segment='current',seq=0,total=0;let viewerName='';
 const copy={current:'ENGERで進行中の提案と、確認済みの取引中企業。社名のみの活動記録は企業ID照合待ちとして表示します。',past:'過去の接点を確認し、再連絡の理由を決めます。「旧接点候補」は過去の取引確定を意味しません。',future:'連絡先の調査 → 初回連絡 → ニーズ確認。旧新規区分の企業も、過去の接点がないかを確認してから進めます。',pending:'分類未確定の企業。企業ID・過去の履歴・連絡先を確認して、現在・過去・未来へ整理します。',all:'企業IDごとの一覧。同名の企業は別行に保持しています。企業名の一致だけでは統合しません。'};
 const effective=r=>({...r,...draft.get(r.id)});
 function clear(){selected.clear();$('lc-select-all').checked=false;$('lc-select-all').indeterminate=false;syncSelection();}
 function syncSelection(){
  $('lc-bulk').hidden=!selected.size;$('lc-selected').textContent=fmt(selected.size)+'件を選択';
  document.querySelectorAll('[data-select]').forEach(c=>{c.checked=selected.has(c.dataset.select);c.closest('tr').classList.toggle('chosen',c.checked);});
  $('lc-select-all').checked=rows.length>0&&rows.every(r=>selected.has(r.id));$('lc-select-all').indeterminate=rows.some(r=>selected.has(r.id))&&!$('lc-select-all').checked;
 }
 function status(r){return r.blocked?'<span class="lc-badge blocked">連絡停止・注意</span>':r.companyId===null?'<span class="lc-badge warning">進行中・ID照合待ち</span>':r.confirmed?'<span class="lc-badge">'+(r.segment==='current'?'現在・確認済み':'過去取引・確認済み')+'</span>':'<span class="lc-badge warning">'+({revive:'旧接点候補',new:'新規候補',existing:'旧既存区分・要確認'}[r.legacyBucket]||'分類未確定')+'</span>';}
 function icons(r){if(!r.contactKnown)return '<small>連絡先は企業ID照合後に確認</small>';return '<div class="lc-contact-icons">'+[['email','mail','メール'],['phone','call','電話'],['form','contact_page','フォーム']].filter(([k])=>r[k]).map(([,i,t])=>'<span class="lc-contact-icon"><span class="material-symbols-outlined" aria-hidden="true">'+i+'</span>'+t+'</span>').join('')+'</div>'+(!r.hasContact?'<small>連絡先の調査が必要</small>':'');}
 function drawRows(){
  $('lc-rows').innerHTML=rows.length?rows.map(source=>{const r=effective(source);return '<tr data-id="'+esc(r.id)+'"><td><input type="checkbox" data-select="'+esc(r.id)+'" aria-label="'+esc(r.name)+'を選択"></td><td><button type="button" class="lc-name" data-open="'+esc(r.id)+'">'+esc(r.name)+'</button>'+(r.companyId?'<small class="lc-row-id" title="'+esc(r.companyId)+'">ID '+esc(r.companyId.slice(0,8))+'…'+esc(r.companyId.slice(-4))+'</small>':'')+icons(r)+(draft.has(r.id)?'<small>確認用の下書きあり</small>':'')+'</td><td>'+status(r)+'<small>'+esc(r.reason)+'</small>'+(r.proposals.length?'<small>進行中 '+fmt(r.proposals.length)+'提案</small>':'')+'</td><td>'+esc(date(r.lastContact))+'<small>'+esc(r.lastContactKind||'連絡日未登録')+'</small></td><td>'+esc(r.nextAction||'次の対応を設定')+'</td><td>'+esc(r.owner||'未設定')+'<small>'+esc(r.nextDate||'期限未設定')+'</small></td></tr>';}).join(''):'<tr><td colspan="6">該当企業はありません。検索・絞り込み条件を変更してください。</td></tr>';
  syncSelection();
 }
 async function load(){
  const n=++seq;clear();$('lc-status').textContent='企業・提案・連絡先を照合しています…';$('lc-rows').innerHTML='<tr><td colspan="6">読み込み中…</td></tr>';$('lc-prev').disabled=true;$('lc-next').disabled=true;$('lc-select-all').disabled=true;rows=[];
  const params=new URLSearchParams({segment,page:String(page),q:$('lc-search').value,contact:$('lc-contact').value,quick:$('lc-quick').value,sort:$('lc-sort').value});
  try{
   const d=await API.api('/api/sales/company-lifecycle?'+params);if(n!==seq)return;if(!d.complete)throw Error('incomplete');
   rows=d.rows;total=d.selectedCount;const c=d.counts;
   $('lc-current').textContent=fmt(c.current)+'社 ＋ '+fmt(c.activityNames)+'活動記録';$('lc-past').textContent=fmt(c.past+c.pastCandidates)+'社';$('lc-future').textContent=fmt(c.futureCandidates)+'社';$('lc-pending').textContent=fmt(c.pending)+'社';$('lc-all').textContent=fmt(c.total)+'社';
   $('lc-explain').textContent=copy[segment];$('lc-status').textContent=fmt(total)+'件中 '+fmt(total?(page-1)*50+1:0)+'〜'+fmt(Math.min(page*50,total))+'件表示';$('lc-observed').textContent='取得 '+new Date(d.observedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+' JST';
   $('lc-page').textContent=page+' / '+Math.max(1,Math.ceil(total/50))+'ページ';$('lc-prev').disabled=page<=1;$('lc-next').disabled=page*50>=total;$('lc-select-all').disabled=!rows.length;drawRows();
  }catch(e){if(n!==seq)return;$('lc-status').textContent='取得できませんでした';$('lc-rows').innerHTML='<tr><td colspan="6"><p class="lc-error">'+esc(e.hint||'通信・ログイン状態をご確認のうえ「再取得」を押してください。')+'</p></td></tr>';}
 }
 const workbench=createCompanyWorkbench({draft,onChange:drawRows,viewer:()=>viewerName});
 const open=r=>workbench.open(r);
 document.querySelectorAll('[data-segment]').forEach(b=>b.onclick=()=>{segment=b.dataset.segment;page=1;document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));void load();});
 let debounce;$('lc-search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{page=1;if(/^[a-f0-9-]{8,}$/i.test($('lc-search').value.trim())){segment='all';$('lc-contact').value='';$('lc-quick').value='';document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t.dataset.segment==='all')));}void load();},300);};
 for(const id of ['lc-contact','lc-quick','lc-sort'])$(id).onchange=()=>{page=1;void load();};
 $('lc-prev').onclick=()=>{page--;void load();};$('lc-next').onclick=()=>{page++;void load();};$('lc-refresh').onclick=()=>void load();
 $('lc-rows').onclick=e=>{if(e.target.closest('[data-select]'))return;const tr=e.target.closest('[data-id]');if(tr){const r=rows.find(r=>r.id===tr.dataset.id);if(r)open(r);}};
 $('lc-rows').onchange=e=>{const cb=e.target.closest('[data-select]');if(!cb)return;if(cb.checked)selected.add(cb.dataset.select);else selected.delete(cb.dataset.select);syncSelection();};
 $('lc-select-all').onchange=e=>{selected.clear();if(e.target.checked)rows.forEach(r=>selected.add(r.id));syncSelection();};$('lc-clear').onclick=clear;
 $('lc-bulk-save').onclick=()=>{
  const patch={};if($('lc-bulk-owner').value.trim())patch.owner=$('lc-bulk-owner').value.trim();if($('lc-bulk-date').value)patch.nextDate=$('lc-bulk-date').value;if($('lc-bulk-action').value.trim())patch.nextAction=$('lc-bulk-action').value.trim();
  if(!Object.keys(patch).length){$('lc-status').textContent='担当・次回予定・次の対応のいずれかを入力してください。';return;}
  const n=selected.size;for(const id of selected)draft.set(id,{...draft.get(id),...patch});clear();drawRows();$('lc-status').textContent=fmt(n)+'件の下書きを更新しました。本番には保存していません。';
 };
 $('lc-close').onclick=()=>{$('lc-dialog').close();};
 SalesLayout.init({active:'companies'}).then(ctx=>{if(ctx){viewerName=ctx.me?.gw?.employee?.display_name||'';void load();}}).catch(()=>{$('lc-status').textContent='ログイン状態を確認できません。ページを再読み込みしてください。';});
})();
