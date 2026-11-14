(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const icon=s=>`<span class="material-symbols-outlined" aria-hidden="true">${s}</span>`;
 const date=s=>s?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric'}).format(new Date(s)):'';
 function mount({element}){
  let rows=[],objectUrl=null;const dispose=()=>{if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}};
  const fold=(rows,render)=>rows.slice(0,5).map(render).join('')+(rows.length>5?`<details class="my-document-details"><summary>ほか${rows.length-5}件を見る</summary>${rows.slice(5).map(render).join('')}</details>`:'');
  const fileRow=d=>{const index=rows.push(d)-1;return `<div class="hr-upload-row"><div>${icon('description')}<b>${esc(d.title||d.filename)}</b><small>${esc(d.filename)}${d.version?' ・ 第'+d.version+'版':''}${d.createdAt?' ・ '+date(d.createdAt):''}</small></div><span class="hr-upload-state ${d.status==='確認待ち'?'wait':'ok'}">${esc(d.status==='確認待ち'?'提出済み・確認待ち':d.status||'公開中')}</span><div class="hr-upload-actions"><button class="btn btn-secondary btn-sm" data-my-open="${index}">${icon('visibility')}見る</button><button class="btn btn-secondary btn-sm" data-my-save="${index}">${icon('download')}保存</button></div></div>`;};
  async function load(){
   element.textContent='自分の書類を読み込み中…';
   const [self,candidate]=await Promise.allSettled([API.api('/api/my-documents'),API.api('/api/hr/candidate-documents?scope=me')]);if(!element.isConnected)return;
   const own=self.status==='fulfilled'?self.value:null,shared=candidate.status==='fulfilled'?candidate.value:null;
   const checklist=own?.checklist||[],required=checklist.filter(d=>d.required&&d.status!=='対象外'),missing=required.filter(d=>d.status==='未提出'),pending=required.filter(d=>d.status==='確認待ち');
   const checklistReady=own&&!own.notReady?.some(k=>['手続き','提出状況'].includes(k));
   const uploadsReady=own&&!own.notReady?.some(k=>['手続き','提出ファイル','アップロード書類'].includes(k));
   rows=[];const received=[...(shared?.documents||[]).map(d=>({...d,source:'candidate',status:'公開中',createdAt:d.publishedAt})),...(own?.received||[])],uploads=own?.uploads||[];
   const card=(title,iconName,html)=>`<section class="card"><h2>${icon(iconName)}${title}</h2>${html}</section>`;
   const item=d=>`<div class="hr-upload-row"><div><b>${esc(d.title)}</b><small>${d.required?'必要な書類':'任意'}${d.dueOn?' ・ 期限 '+esc(d.dueOn):''}</small></div><span class="hr-upload-state ${d.status==='未提出'?'missing':d.status==='確認待ち'?'wait':'ok'}">${esc(d.status==='確認待ち'?'提出済み・確認待ち':d.status)}</span>${d.status==='未提出'?`<a class="btn btn-primary btn-sm" href="${esc(d.href)}">${icon('upload_file')}提出する</a>`:''}</div>`;
   element.innerHTML=`<div class="my-document-counts" aria-label="提出状況"><span>未提出 <b>${checklistReady?missing.length:'—'}</b></span><span>確認待ち <b>${checklistReady?pending.length:'—'}</b></span><span>自分のアップロード <b>${uploadsReady?uploads.length:'—'}</b></span></div>
    ${self.status==='rejected'||own?.notReady?.length?'<p role="alert" class="muted">一部の書類・提出状況を取得できていません。未提出とは判定せず、再読み込みして確認してください。</p>':''}
    ${candidate.status==='rejected'?'<p class="muted">採用書類の公開状況を取得できません。登録済みの契約・提出書類は下で確認できます。</p>':''}
    ${card('提出が必要なもの','task_alt',!checklistReady?'<p class="muted">提出状況を取得できません。再読み込みしてください。</p>':required.length?fold([...missing,...pending,...required.filter(d=>!['未提出','確認待ち'].includes(d.status))],item):'<p class="muted">現在、会社から指定されている提出書類はありません。</p>')}
    ${checklist.some(d=>!d.required||d.status==='対象外')?`<details class="my-document-details card"><summary>任意・対象外の書類</summary>${checklist.filter(d=>!d.required||d.status==='対象外').map(item).join('')}</details>`:''}
    ${card('会社から届いた書類','inbox',received.length?fold(received,fileRow):candidate.status==='rejected'||own?.notReady?.some(k=>['労働条件通知書','契約の控え'].includes(k))?'<p class="muted">公開書類の取得が完了していません。再読み込みしてください。</p>':'<p class="muted">公開中の書類はありません。</p>')}
    ${card('自分がアップロードした書類','upload_file',uploads.length?fold(uploads,fileRow):!uploadsReady?'<p class="muted">アップロード一覧を取得できません。再読み込みしてください。</p>':'<p class="muted">アップロードした書類はまだありません。</p>')}
    <p class="muted">書類を見たり保存したりしても、合意・契約完了にはなりません。署名が必要な場合は、会社からの署名依頼でお手続きください。</p>
    <p data-my-message role="status"></p><dialog data-my-view aria-label="書類のプレビュー"><h2 data-my-title></h2><iframe title="書類PDF" style="width:100%;height:65vh;border:0"></iframe><button class="btn btn-secondary" data-my-close>閉じる</button></dialog>`;
   const dialog=element.querySelector('[data-my-view]');dialog.style.cssText='width:min(900px,92vw);max-height:90vh;border:0;border-radius:12px;padding:20px';
   dialog.addEventListener('close',()=>{dialog.querySelector('iframe').removeAttribute('src');dispose();});
  }
  element.addEventListener('click',async e=>{
   if(e.target.closest('[data-my-close]')){element.querySelector('[data-my-view]').close();return;}
   const button=e.target.closest('[data-my-open],[data-my-save]');if(!button)return;
   const download=button.hasAttribute('data-my-save'),d=rows[Number(button.dataset.myOpen??button.dataset.mySave)];if(!d)return;
   button.disabled=true;const msg=element.querySelector('[data-my-message]');msg.textContent='';
   try{
    let url,mime=d.mimeType||'application/pdf';
    if(d.source==='candidate'){
     const blob=await HRCandidateDocuments.pdf({scope:'me',action:'file',documentId:d.id,download});if(!element.isConnected||element.hidden)return;dispose();url=objectUrl=URL.createObjectURL(blob);
    }else{const r=await API.api(`/api/my-documents?file=1&source=${encodeURIComponent(d.source)}&id=${encodeURIComponent(d.id)}${download?'&download=1':''}`);if(!element.isConnected||element.hidden)return;url=r.url;mime=r.mimeType||mime;}
    if(download||!['application/pdf','image/jpeg','image/png'].includes(mime)){const a=document.createElement('a');a.href=url;a.download=d.filename;a.rel='noopener';a.click();}
    else{const dialog=element.querySelector('[data-my-view]');dialog.querySelector('[data-my-title]').textContent=d.title||d.filename;dialog.querySelector('iframe').src=url;dialog.showModal();}
   }catch(e){if(msg.isConnected)msg.textContent=e.hint||e.message||'書類を開けませんでした。';}finally{if(button.isConnected)button.disabled=false;}
  });
  root.addEventListener('pagehide',dispose);load();return {reload:load};
 }
 root.MyDocumentsUI={mount};
})(globalThis);
