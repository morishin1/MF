(() => {
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>Number(n||0).toLocaleString('ja-JP');
 const date=v=>v?new Date(v).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
 const draft=new Map(),selected=new Set();let rows=[],page=1,segment='current',seq=0,detailSeq=0,total=0,activeId=null,activeRow=null;
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
  $('lc-rows').innerHTML=rows.length?rows.map(source=>{const r=effective(source);return '<tr data-id="'+esc(r.id)+'"><td><input type="checkbox" data-select="'+esc(r.id)+'" aria-label="'+esc(r.name)+'を選択"></td><td><button type="button" class="lc-name" data-open="'+esc(r.id)+'">'+esc(r.name)+'</button>'+icons(r)+(draft.has(r.id)?'<small>確認用の下書きあり</small>':'')+'</td><td>'+status(r)+'<small>'+esc(r.reason)+'</small>'+(r.proposals.length?'<small>進行中 '+fmt(r.proposals.length)+'提案</small>':'')+'</td><td>'+esc(date(r.lastContact))+'<small>'+esc(r.lastContactKind||'連絡日未登録')+'</small></td><td>'+esc(r.nextAction||'次の対応を設定')+'</td><td>'+esc(r.owner||'未設定')+'<small>'+esc(r.nextDate||'期限未設定')+'</small></td></tr>';}).join(''):'<tr><td colspan="6">該当企業はありません。検索・絞り込み条件を変更してください。</td></tr>';
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
 function kv(label,value){return '<div class="lc-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value||'未確認')+'</dd></div>';}
 function open(r){
  activeId=r.id;activeRow=r;const n=++detailSeq,c=effective(r);$('lc-detail-title').textContent=r.name;
  $('lc-detail').innerHTML=status(r)+'<dl>'+kv('分類の根拠',r.reason)+kv('確認した取引根拠',r.relationshipEvidence)+kv('連絡・注意',r.blocked?'連絡停止・注意の確認が必要':'連絡可否は実行前に確認')+kv('最終接点',date(r.lastContact))+kv('企業ID',r.companyId||'未照合')+'</dl>'+
   (r.companyId?'<button type="button" id="lc-read-live">登録情報・営業履歴を確認</button><div id="lc-live"></div>':'<p class="lc-detail-note">同名候補は同一企業の確定ではありません。所在地・公式URL・担当者を照合してください。</p><div class="lc-candidates">'+(r.candidateIds.length?r.candidateIds.map(c=>'<button type="button" data-candidate="'+esc(c.id)+'">同名候補：'+esc(c.name)+'</button>').join(''):'同名候補なし')+'</div><div id="lc-live"></div>')+
   (r.proposals.length?'<h3>進行中提案</h3><div class="lc-proposals">'+r.proposals.map(p=>'<div class="lc-history"><strong>'+esc(p.stage)+'</strong>　更新 '+esc(date(p.updatedAt))+'<small> ／ 案件状態：'+esc(p.jobDeleted?'削除済み・確認必要':p.jobStatus||'未取得')+'</small><p>提案ID：'+esc(p.id)+'</p></div>').join('')+'</div>':'')+
   '<section class="lc-plan"><h3>次の営業を設定（確認用の下書き）</h3><div class="lc-plan-fields"><label>担当<input id="lc-owner" maxlength="80" value="'+esc(c.owner)+'" placeholder="担当者名"></label><label>次回予定<input type="date" id="lc-date" value="'+esc(c.nextDate)+'"></label><label class="wide">次にすること<input id="lc-action" maxlength="200" value="'+esc(c.nextAction)+'"></label><label class="wide">前回の結果・再連絡の理由<textarea id="lc-memo" rows="3" maxlength="2000">'+esc(c.memo||'')+'</textarea></label></div><button type="button" id="lc-save">下書きに反映</button><p class="lc-detail-note" id="lc-draft-status" role="status">下書きはこのページを再読み込みすると消えます。</p></section>';
  if(!$('lc-dialog').open)$('lc-dialog').showModal();
  $('lc-save').onclick=()=>{draft.set(r.id,{owner:$('lc-owner').value.trim(),nextDate:$('lc-date').value,nextAction:$('lc-action').value.trim(),memo:$('lc-memo').value});drawRows();$('lc-draft-status').textContent='一覧へ反映しました。本番には保存していません。';};
  const read=async(id,label)=>{
   $('lc-live').textContent='登録情報を読み込み中…';
   try{const d=await API.api('/api/sales/enger-company-detail?id='+encodeURIComponent(id));if(n!==detailSeq||!$('lc-dialog').open)return;const v=d.company;
    $('lc-live').innerHTML='<h3>'+esc(label||'登録情報')+'</h3><dl>'+kv('企業名',v.name)+kv('所在地',v.address||v.prefecture)+kv('公式URL',v.website)+kv('メール',v.contactEmail)+kv('電話',v.phone)+kv('担当窓口',v.contactName)+kv('Salesの次回予定',v.sales?.nextActionOn)+kv('Salesの担当',v.sales?.ownerName)+'</dl><h3>営業履歴</h3>'+(d.evidence.touchpoints.length?d.evidence.touchpoints.map(t=>'<div class="lc-history"><small>'+esc(date(t.occurredAt))+'　'+esc(t.kind)+'</small><p>'+esc(t.summary||t.detail||'内容未登録')+'</p></div>').join(''):'<p class="lc-detail-note">この企業IDに紐づく接点記録は取得されませんでした。別IDや未照合の記録がないことを意味しません。</p>');
   }catch(e){if(n===detailSeq)$('lc-live').textContent=e.hint||'履歴を取得できませんでした。再度お試しください。';}
  };
  if($('lc-read-live'))$('lc-read-live').onclick=()=>read(r.companyId);
  document.querySelectorAll('[data-candidate]').forEach(b=>b.onclick=()=>read(b.dataset.candidate,'同名候補の登録情報（照合未確定）'));
 }
 document.querySelectorAll('[data-segment]').forEach(b=>b.onclick=()=>{segment=b.dataset.segment;page=1;document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));void load();});
 let debounce;$('lc-search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{page=1;void load();},300);};
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
 $('lc-close').onclick=()=>{$('lc-dialog').close();++detailSeq;};$('lc-dialog').addEventListener('close',()=>{++detailSeq;activeId=null;activeRow=null;});
 SalesLayout.init({active:'companies'}).then(ctx=>{if(ctx)void load();}).catch(()=>{$('lc-status').textContent='ログイン状態を確認できません。ページを再読み込みしてください。';});
})();
