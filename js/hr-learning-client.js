(function(){
 'use strict';
 const rows=new Map();let loading=null;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function load(onPage){
  if(loading)return loading;
  loading=(async()=>{let offset=0;const all=[];do{
   const data=await API.api('/api/hr/learning?offset='+offset);
   for(const x of data.items||[]){rows.set(x.id,x);all.push(x);}
   onPage?.(data);offset=data.nextOffset;
  }while(offset!==null&&offset!==undefined);return all;})();
  try{return await loading;}finally{loading=null;}
 }
 function icon(id){
  const x=rows.get(id),state=x?.participation||'unknown',label={on:'ON（参加中）',off:'OFF（参加なし）',unknown:'未確認'}[state];
  const source=x?.source||'未確認',text='無限道場：'+label+'／確認元：'+source+(x?.updatedAt?'／更新：'+new Date(x.updatedAt).toLocaleString('ja-JP'):'');
  return '<button type="button" class="hr-learning-icon '+state+'" data-learning-id="'+esc(id)+'" aria-pressed="'+(state==='unknown'?'mixed':state==='on'?'true':'false')+'" aria-label="'+esc(text)+'" title="'+esc(text)+'"><span class="material-symbols-outlined" aria-hidden="true">school</span></button>';
 }
 async function toggle(button){
  const id=button.dataset.learningId;button.disabled=true;
  try{
   let x=rows.get(id);
   if(!x){const r=await API.api('/api/hr/learning?id='+encodeURIComponent(id));x=r.items?.[0];if(!x)throw Error('参加状況を取得できませんでした。');rows.set(id,x);}
   const r=await API.api('/api/hr/learning',{method:'POST',body:{applicantId:id,action:'participation',participation:x.participation!=='on',expectedVersion:x.version}});
   rows.set(id,r.item);button.outerHTML=icon(id);
   document.dispatchEvent(new CustomEvent('hr-learning-updated',{detail:r.item}));
  }catch(e){button.disabled=false;const region=document.getElementById('hr-learning-message');const msg=e.hint||e.message||'保存できませんでした。';if(region)region.textContent=msg;else alert(msg);}
 }
 document.addEventListener('click',e=>{const b=e.target.closest('[data-learning-id]');if(!b)return;e.stopPropagation();toggle(b);},true);
 window.HRLearning={rows,load,icon,toggle,esc};
})();
