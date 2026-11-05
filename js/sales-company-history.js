const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=id=>document.getElementById(id);
const icons={email:'mail',phone:'call',form:'contact_page',memo:'edit_note',edit:'edit',plan:'event'};
export function createCompanyHistory({onOpen,isActive}){
 let page=1,seq=0,rows=[],selectedCount=0,debounce;
 const count=n=>$('lc-history-total').textContent=Number(n).toLocaleString('ja-JP')+'件';
 async function summary(){try{const d=await API.api('/api/sales/company-history?summary=1');if(d.complete)count(d.total);}catch{$('lc-history-total').textContent='取得未完了';}}
 async function load(){
  const n=++seq;$('lh-status').textContent='履歴を読み込み中…';$('lh-rows').innerHTML='<tr><td colspan="6">読み込み中…</td></tr>';$('lh-prev').disabled=true;$('lh-next').disabled=true;
  const params=new URLSearchParams({page:String(page),q:$('lh-search').value,kind:$('lh-kind').value,from:$('lh-from').value,to:$('lh-to').value});
  try{
   const d=await API.api('/api/sales/company-history?'+params);if(n!==seq||!isActive())return;if(!d.complete)throw Error();
   rows=d.rows;selectedCount=d.selectedCount;count(d.total);
   if(page>Math.max(1,Math.ceil(selectedCount/50))){page=Math.max(1,Math.ceil(selectedCount/50));return load();}
   $('lh-status').textContent=selectedCount.toLocaleString('ja-JP')+'件中 '+(selectedCount?(page-1)*50+1:0)+'〜'+Math.min(page*50,selectedCount)+'件表示（日本時間）';
   $('lh-page').textContent=page+' / '+Math.max(1,Math.ceil(selectedCount/50))+'ページ';$('lh-prev').disabled=page<=1;$('lh-next').disabled=page*50>=selectedCount;
   $('lh-rows').innerHTML=rows.length?rows.map((r,i)=>'<tr><td>'+esc(new Date(r.at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}))+'</td><td>'+(r.available?(r.companyId?'<button type="button" class="lc-name" data-history-open="'+i+'">'+esc(r.name)+'</button>':'<a class="lc-name" href="/sales/company-tools.html?id='+encodeURIComponent(r.salesId)+'">'+esc(r.name)+'</a>'):esc(r.name))+'<small>'+esc(r.companyId?'企業ID '+r.companyId.slice(0,8):'Sales ID '+String(r.salesId||'未登録').slice(0,8))+'</small></td><td>'+esc(r.actor)+'</td><td><span class="lh-kind"><span class="material-symbols-outlined" aria-hidden="true">'+(icons[r.kind]||'history')+'</span>'+esc(r.label)+'</span>'+(r.subject?'<small>'+esc(r.subject)+'</small>':'')+'</td><td>'+esc(r.source)+'</td><td>'+((r.detail||r.nextAction||r.nextDate)?'<details><summary>内容を見る</summary><div class="lh-detail"><p>'+esc(r.detail)+'</p>'+(r.nextAction||r.nextDate?'<p>次回：'+esc([r.nextDate,r.nextAction].filter(Boolean).join(' ／ '))+'</p>':'')+'</div></details>':'—')+'</td></tr>').join(''):'<tr><td colspan="6">該当する履歴はありません。日付や作業の種類を変更してください。</td></tr>';
  }catch(e){if(n!==seq||!isActive())return;$('lh-status').textContent=e.hint||'履歴を取得できませんでした。再取得してください。';$('lh-rows').innerHTML='<tr><td colspan="6">履歴未取得</td></tr>';}
 }
 $('lh-rows').onclick=async e=>{const b=e.target.closest('[data-history-open]');if(!b)return;const r=rows[Number(b.dataset.historyOpen)];if(!r)return;b.disabled=true;try{await onOpen(r);}catch{$('lh-status').textContent='企業詳細を開けませんでした。再取得してください。';}finally{b.disabled=false;}};
 const reset=()=>{page=1;if(isActive())void load();};
 $('lh-search').oninput=()=>{clearTimeout(debounce);debounce=setTimeout(reset,300);};
 for(const id of ['lh-kind','lh-from','lh-to'])$(id).onchange=()=>{if(id!=='lh-kind')$('lh-period').value='custom';reset();};
 $('lh-period').onchange=()=>{
  const mode=$('lh-period').value;if(mode==='custom')return;
  const now=new Date(Date.now()+9*3600000),today=now.toISOString().slice(0,10),before=days=>new Date(now.getTime()-days*86400000).toISOString().slice(0,10);
  $('lh-from').value=mode==='all'?'':mode==='today'?today:mode==='yesterday'?before(1):mode==='week'?before(6):today.slice(0,7)+'-01';
  $('lh-to').value=mode==='all'?'':mode==='yesterday'?before(1):today;reset();
 };
 $('lh-refresh').onclick=()=>void load();$('lh-prev').onclick=()=>{page--;void load();};$('lh-next').onclick=()=>{page++;void load();};
 return{load,summary};
}
