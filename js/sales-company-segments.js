import {createCompanyHistory} from './sales-company-history.js?v=20261105history1';
import {createCompanyWorkbench} from './sales-company-workbench.js?v=20261107nta1';
import {createPortalTabs} from './sales-company-portal-tabs.js?v=20261108preflight1';
import {createCompanyAIInfoToolbar} from './sales-company-ai-toolbar.js?v=20261107compact1';
(() => {
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>Number(n||0).toLocaleString('ja-JP');
 const date=v=>v?new Date(v).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
 const draft=new Map(),selected=new Set();let rows=[],page=1,segment='current',seq=0,total=0;let viewerName='',broadcastSaving=false,aiBatchSaving=false,aiBatchAllowed=false;
 let launchTarget=null,launchTab='info';
 const copy={current:'フォロー中として移動した企業、ENGERで進行中の提案、確認済みの取引中企業。社名のみの活動記録は企業ID照合待ちとして表示します。',past:'過去の接点を確認し、再連絡の理由を決めます。「旧接点候補」は過去の取引確定を意味しません。',future:'連絡先の調査 → 初回連絡 → ニーズ確認。旧新規区分の企業も、過去の接点がないかを確認してから進めます。',broadcast:'ブラストメール配信として登録した企業です。登録は保存されます。登録だけではメールを送信しません。連絡停止・注意の企業は送信対象にしないでください。',pending:'分類未確定の企業。企業ID・過去の履歴・連絡先を確認して、現在・過去・未来へ整理します。',all:'企業IDごとの一覧。同名の企業は別行に保持しています。企業名の一致だけでは統合しません。'};
 const effective=r=>({...r,...draft.get(r.id)});
 function clear(){selected.clear();$('lc-select-all').checked=false;$('lc-select-all').indeterminate=false;syncSelection();}
 function syncSelection(){
  $('lc-bulk').hidden=!selected.size;$('lc-selected').textContent=fmt(selected.size)+'件を選択';
  document.querySelectorAll('[data-select]').forEach(c=>{c.checked=selected.has(c.dataset.select);c.closest('tr').classList.toggle('chosen',c.checked);});
  const eligible=selected.size>0&&[...selected].every(id=>rows.some(r=>r.id===id&&r.companyId));
  $('lc-move').disabled=broadcastSaving||!eligible;
  $('lc-broadcast-add').disabled=broadcastSaving||!eligible;$('lc-broadcast-remove').disabled=broadcastSaving||!eligible;
  $('lc-broadcast-help').textContent=selected.size&&!eligible?'企業ID未照合の活動記録は登録できません。':'登録・解除は保存されます。メールは送信しません。';
  const selectRows=[...selected].map(id=>rows.find(r=>r.id===id));
  const aiEligible=selectRows.length>0&&selectRows.length<=10&&selectRows.every(r=>r?.companyId&&!r.salesOnly&&!r.blocked);
  const bulkAi=$('lc-bulk-ai');
  if(bulkAi)bulkAi.disabled=aiBatchSaving||!aiBatchAllowed||!aiEligible;
  $('lc-select-all').checked=rows.length>0&&rows.every(r=>selected.has(r.id));$('lc-select-all').indeterminate=rows.some(r=>selected.has(r.id))&&!$('lc-select-all').checked;
 }
 function status(r){return '<span class="lc-badge '+(r.blocked?'blocked':r.broadcast?'broadcast':!r.confirmed?'warning':'')+'">'+esc(r.statusLabel||'分類未確定')+'</span>';}
 function syncSort(){
  document.querySelectorAll('[aria-sort]').forEach(th=>th.setAttribute('aria-sort','none'));
  document.querySelectorAll('[data-sort]').forEach(b=>{const active=b.dataset.sort===$('lc-sort').value,desc=$('lc-direction').value==='desc';b.querySelector('span').textContent=active?(desc?'↓':'↑'):'↕';b.classList.toggle('active',active);b.setAttribute('aria-label',b.dataset.label+'：'+(active?(desc?'降順。昇順に切り替え':'昇順。降順に切り替え'):'昇順に並べ替え'));if(active)b.closest('th').setAttribute('aria-sort',desc?'descending':'ascending');});
 }

 function icons(r){if(!r.contactKnown)return '<small>連絡先は企業ID照合後に確認</small>';return '<div class="lc-contact-icons">'+[['email','mail','メール'],['phone','call','電話'],['form','contact_page','フォーム']].filter(([k])=>r[k]).map(([,i,t])=>'<span class="lc-contact-icon"><span class="material-symbols-outlined" aria-hidden="true">'+i+'</span>'+t+'</span>').join('')+'</div>'+(!r.hasContact?'<small>連絡先の調査が必要</small>':'');}
 function drawRows(){
  $('lc-rows').innerHTML=rows.length?rows.map(source=>{const r=effective(source);return '<tr data-id="'+esc(r.id)+'"><td><input type="checkbox" data-select="'+esc(r.id)+'" aria-label="'+esc(r.name)+'を選択"></td><td><button type="button" class="lc-name" data-open="'+esc(r.id)+'">'+esc(r.name)+'</button>'+(r.companyId?'<small class="lc-row-id" title="社内用企業番号">ID '+esc(r.displayId||'番号未登録')+'</small>':'')+icons(r)+(draft.has(r.id)?'<small>確認用の下書きあり</small>':'')+'</td><td>'+status(r)+'<small>'+esc(r.reason)+'</small>'+(r.proposals.length?'<small>進行中 '+fmt(r.proposals.length)+'提案</small>':'')+'</td><td>'+esc(date(r.lastContact))+'<small>'+esc(r.lastContactKind||'連絡日未登録')+'</small></td><td>'+esc(r.nextAction||'次の対応を設定')+'</td><td>'+esc(r.owner||'未設定')+'<small>'+esc(r.nextDate||'期限未設定')+'</small></td></tr>';}).join(''):'<tr><td colspan="6">該当企業はありません。検索・絞り込み条件を変更してください。</td></tr>';
  syncSelection();
 }
 async function load(fresh=false){
  if(segment==='history'){await history.load();return;}
  syncSort();
  const n=++seq;clear();$('lc-status').textContent='企業・提案・連絡先を照合しています…';$('lc-rows').innerHTML='<tr><td colspan="6">読み込み中…</td></tr>';$('lc-prev').disabled=true;$('lc-next').disabled=true;$('lc-select-all').disabled=true;rows=[];
  const params=new URLSearchParams({segment,page:String(page),q:$('lc-search').value,contact:$('lc-contact').value,quick:$('lc-quick').value,sort:$('lc-sort').value,direction:$('lc-direction').value,...(fresh?{refresh:'1'}:{})});
  try{
   const d=await API.api('/api/sales/company-lifecycle?'+params);if(n!==seq||segment==='history')return;if(!d.complete)throw Error('incomplete');
   rows=d.rows;total=d.selectedCount;const c=d.counts;
   $('lc-current').textContent=fmt(c.current)+'社 ＋ '+fmt(c.activityNames)+'活動記録';$('lc-past').textContent=fmt(c.past+c.pastCandidates)+'社';$('lc-future').textContent=fmt(c.futureCandidates)+'社';$('lc-pending').textContent=fmt(c.pending)+'社';$('lc-all').textContent=fmt(c.total)+'社';$('lc-broadcast').textContent=fmt(c.broadcast)+'社';
   $('lc-explain').textContent=copy[segment];$('lc-status').textContent=fmt(total)+'件中 '+fmt(total?(page-1)*50+1:0)+'〜'+fmt(Math.min(page*50,total))+'件表示';$('lc-observed').textContent='取得 '+new Date(d.observedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})+' JST';
   $('lc-page').textContent=page+' / '+Math.max(1,Math.ceil(total/50))+'ページ';$('lc-prev').disabled=page<=1;$('lc-next').disabled=page*50>=total;$('lc-select-all').disabled=!rows.length;drawRows();
    if(launchTarget){
      const match=rows.find(r=>r.companyId===launchTarget);
      launchTarget=null;
      if(match){
        await open(match);
        // A blocked or NG company must be reviewed before commercial preparation.
        // Company details are reviewed first; 商談準備 is an explicit next action.
      }else{
        $('lc-status').textContent='指定した企業IDが見つかりません。権限や企業の表示状態を確認してください。';
      }
    }
  }catch(e){if(n!==seq||segment==='history')return;$('lc-status').textContent='取得できませんでした';$('lc-rows').innerHTML='<tr><td colspan="6"><p class="lc-error">'+esc(e.hint||'通信・ログイン状態をご確認のうえ「再取得」を押してください。')+'</p></td></tr>';}
 }
 const toolbar=createCompanyAIInfoToolbar();
 const tabs=createPortalTabs();
 $('lc-dialog').addEventListener('click',event=>{
   if(event.target.closest('#lc-go-to-prep') && !event.target.closest('button')?.disabled)
     tabs.select('analysis');
 });
 const workbench=createCompanyWorkbench({draft,onChange:drawRows,onSaved:()=>{tabs.refresh('info');void history.summary();return load(true);},viewer:()=>viewerName});
 window.addEventListener("sales:companyAiSaved",event=>{
   if(!event.detail?.companyId||!$("lc-dialog")?.open)return;
   tabs.refresh("analysis");tabs.refresh("prep");
   workbench.refresh();
   const status=$("lc-ai-quick-status");
   if(status)status.textContent="企業サマリーを保存しました。商談管理にも反映されます。";
 });
 const open=r=>{
  toolbar.setSelected(r);
  if(r.salesOnly){
   $('lc-detail-title').textContent=r.name;
   $('lc-detail').innerHTML='<p>営業DBで対応中の企業です。ENGER企業IDとはまだ紐づいていません。企業IDを推測で統合せず、営業管理画面で履歴・担当・次回対応を確認してください。</p>'+
    '<p><strong>現在の状態：</strong>'+esc(r.reason)+'</p><p><strong>最終接点：</strong>'+esc(date(r.lastContact))+'</p>'+
    '<p><strong>次の対応：</strong>'+esc(r.nextAction)+'</p>'+
    '<p><a href="/sales/companies.html?id='+encodeURIComponent(r.salesId)+'">この企業の営業詳細を開く</a></p>';
   tabs.open(r);$('lc-dialog').showModal();return;
  }
  tabs.open(r);
  return workbench.open(r);
 };
 const history=createCompanyHistory({isActive:()=>segment==='history',onOpen:async r=>{
  toolbar.setSelected(r);
  const d=await API.api('/api/sales/company-lifecycle?segment=all&q='+encodeURIComponent(r.companyId));
  const company=d.rows?.find(v=>v.companyId===r.companyId);
  const target=company||{id:r.companyId,companyId:r.companyId,name:r.name,proposals:[],candidateIds:[],blocked:true,nextAction:'',nextDate:'',owner:''};
  tabs.open(target);await workbench.open(target);
 }});
 document.querySelectorAll('[data-segment]').forEach(b=>b.onclick=()=>{clearTimeout(debounce);segment=b.dataset.segment;page=1;seq++;clear();$('lc-company-panel').hidden=segment==='history';$('lc-history-panel').hidden=segment!=='history';document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));void load();});
 let debounce;$('lc-search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(()=>{page=1;if(/^[a-f0-9-]{8,}$/i.test($('lc-search').value.trim())){segment='all';$('lc-contact').value='';$('lc-quick').value='';document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t.dataset.segment==='all')));}void load();},300);};
 for(const id of ['lc-contact','lc-quick','lc-sort','lc-direction'])$(id).onchange=()=>{page=1;void load();};
 $('lc-prev').onclick=()=>{page--;void load();};$('lc-next').onclick=()=>{page++;void load();};$('lc-refresh').onclick=()=>void load(true);
 document.querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{const same=$('lc-sort').value===b.dataset.sort;$('lc-sort').value=b.dataset.sort;$('lc-direction').value=same&&$('lc-direction').value==='asc'?'desc':'asc';page=1;void load();});
 $('lc-move').onclick=async()=>{
  if(broadcastSaving||!selected.size)return;
  const ids=[...selected];if(ids.some(id=>!rows.some(r=>r.id===id&&r.companyId)))return;
  broadcastSaving=true;syncSelection();
  try{const d=await API.api('/api/sales/enger-company-bulk',{method:'PATCH',body:{action:'segment',ids,segment:$('lc-move-target').value}});if(!d.complete)throw Error();page=1;await load(true);$('lc-status').textContent=fmt(ids.length)+'社の営業区分を保存しました。';}
  catch(e){$('lc-status').textContent=e.hint||'移動結果を確認できません。再取得してください。';}
  finally{broadcastSaving=false;syncSelection();}
 };
 async function setBroadcast(blastTarget){
  if(broadcastSaving||!selected.size)return;
  const ids=[...selected];if(ids.some(id=>!rows.some(r=>r.id===id&&r.companyId)))return;
  broadcastSaving=true;syncSelection();$('lc-status').textContent='配信区分を保存しています…';
  try{
   const result=await API.api('/api/sales/enger-company-bulk',{method:'PATCH',body:{action:'broadcast',ids,blastTarget}});
   if(!result.complete||result.updated!==ids.length)throw Error('incomplete');
   page=1;await load(true);$('lc-status').textContent=fmt(ids.length)+'社を配信'+(blastTarget?'に登録':'から解除')+'しました。メールは送信していません。';
  }catch(e){$('lc-status').textContent=e.hint||'配信区分の保存結果を確認できません。「再取得」で確認してください。';}
  finally{broadcastSaving=false;syncSelection();}
 }
  $('lc-bulk-ai').onclick=async()=>{
    const picks=[...selected].map(id=>rows.find(r=>r.id===id));
    const ids=picks.map(r=>r?.companyId);
    const status=$('lc-bulk-ai-status');
    if(aiBatchSaving||!aiBatchAllowed)return;
    if(ids.length<1||ids.length>10||ids.some(id=>!id)||new Set(ids).size!==ids.length){
      status.textContent='企業IDの確認済み企業を1〜10社選択してください。';return;
    }
    if(picks.some(r=>r?.blocked||r?.salesOnly)){
      status.textContent='営業禁止・企業ID未照合の企業は対象にできません。';return;
    }
    if(!confirm(ids.length+'社をAI企業分析の試験対象として確定します。登録済み公式サイトを調査し、料金が発生するクラウドAIを使用します。よろしいですか？'))return;
    aiBatchSaving=true;syncSelection();status.textContent='企業IDと公式サイトを照合しています…';
    try{
      const reg=await API.api('/api/sales/company-ai-batch',{method:'POST',body:{companyIds:ids}});
      if(!reg.ok||!Array.isArray(reg.batch?.salesCompanyIds))throw Error('batch_not_registered');
      const names=picks.map(r=>r.name),companyIds=reg.batch.salesCompanyIds;
      let ok=0,failed=0;
      for(let i=0;i<companyIds.length;i++){
        status.textContent=(i+1)+'/'+companyIds.length+'社：'+names[i]+' をAI分析中…';
        try{
          const result=await API.api('/api/sales/company-ai-pilot',
            {method:'POST',body:{companyId:companyIds[i]}});
          if(result.ok)ok++;else failed++;
        }catch(e){failed++;status.textContent=names[i]+'：'+(e?.hint||e?.message||'分析失敗')+'。次の企業に進みます。';}
      }
      status.textContent='AI企業分析：成功 '+ok+'社／未完了 '+failed+'社。結果一覧から企業ごとの根拠を確認できます。';
      if(!document.getElementById('lc-bulk-ai-results')){
        const link=document.createElement('a');link.id='lc-bulk-ai-results';
        link.href='/sales/company-ai-pilot.html';link.textContent='10社の分析結果を表示';
        link.style.color='#fff';status.after(link);
      }
    }catch(e){status.textContent=e?.hint||e?.message||'試験対象の登録に失敗しました。企業IDと公式サイトを確認してください。';}
    finally{aiBatchSaving=false;syncSelection();}
  };
 $('lc-broadcast-add').onclick=()=>void setBroadcast(true);$('lc-broadcast-remove').onclick=()=>void setBroadcast(false);
 $('lc-rows').onclick=e=>{if(e.target.closest('[data-select]'))return;const tr=e.target.closest('[data-id]');if(tr){const r=rows.find(r=>r.id===tr.dataset.id);if(r)open(r);}};
 $('lc-rows').onchange=e=>{const cb=e.target.closest('[data-select]');if(!cb)return;if(cb.checked)selected.add(cb.dataset.select);else selected.delete(cb.dataset.select);syncSelection();};
 $('lc-select-all').onchange=e=>{selected.clear();if(e.target.checked)rows.forEach(r=>selected.add(r.id));syncSelection();};$('lc-clear').onclick=clear;
 $('lc-dialog').addEventListener('close',()=>{void history.summary();if(segment==='history')void history.load();});
 $('lc-close').onclick=()=>{$('lc-dialog').close();};
 const initial=new URLSearchParams(location.search);
  const requestedId=initial.get('companyId')||'';
  if(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(requestedId)){
    launchTarget=requestedId;launchTab=initial.get('meeting')==='prep'?'prep':'info';
    $('lc-search').value=requestedId;segment='all';
    document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t.dataset.segment===segment)));
  }else if(initial.get('q')){
    $('lc-search').value=initial.get('q');segment='all';
    document.querySelectorAll('[data-segment]').forEach(t=>t.setAttribute('aria-pressed',String(t.dataset.segment===segment)));
  }
 SalesLayout.init({active:'companies'}).then(ctx=>{if(ctx){
    viewerName=ctx.me?.gw?.employee?.display_name||'';
    void API.api('/api/sales/company-ai-batch').then(r=>{
      aiBatchAllowed=Boolean(r.canRun);
      syncSelection();
      if(!r.canRun)$('lc-bulk-ai-status').textContent=r.enabled?'AI一括分析の実行は経営者権限が必要です。':'AI一括分析はプレビュー環境でのみ実行できます。';
    }).catch(()=>{aiBatchAllowed=false;});
    void history.summary();void load();
 }}).catch(()=>{$('lc-status').textContent='ログイン状態を確認できません。ページを再読み込みしてください。';});
})();
