(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const icon=s=>`<span class="material-symbols-outlined" aria-hidden="true">${s}</span>`;
 const date=s=>s&&!Number.isNaN(Date.parse(s))?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'numeric',day:'numeric'}).format(new Date(s)):'';
 const accept='.pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx,.xls,.xlsx';
 const missing=d=>['未提出','要再提出'].includes(d.status);
 function mount({element,view='submissions'}){
  let rows=[],items=[],objectUrl=null,revision=0,disposed=false,uploading=false;
  const disposeUrl=()=>{if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}};
  const fileButton=(d,label='書類を見る')=>{const index=rows.push(d)-1;return `<button class="btn btn-secondary btn-sm" data-my-open="${index}" aria-label="${esc(d.title||d.filename)}を見る">${icon('visibility')}${label}</button>`;};
  const fileLine=d=>`<div class="my-file"><span>${esc(d.filename)}${d.createdAt?' ・ '+date(d.createdAt):''}</span>${fileButton(d)}<button class="btn btn-secondary btn-sm" data-my-save="${rows.length-1}">${icon('download')}保存</button></div>`;
  const uploadButton=(d,index,replace=false)=>`<button class="btn ${replace?'btn-secondary':'btn-primary'} btn-sm" data-my-upload-start="${index}" aria-label="${esc(d.title)}を${replace?'差し替える':'アップロード'}">${icon('upload_file')}${replace?'差し替える':d.status==='要再提出'?'再アップロード':'アップロード'}</button><input type="file" accept="${accept}" data-my-upload="${index}" hidden aria-label="${esc(d.title)}のファイル">`;
  const itemRow=(d,index,uploads)=>{
   const files=uploads.filter(f=>f.itemId===d.id).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
   const outstanding=missing(d),label=outstanding?d.status:'提出済み',canUpload=d.canUpload!==false&&!['確認済み','対象外'].includes(d.status);
   return `<article class="my-submission-row" data-submission-id="${esc(d.id)}"><div class="my-submission-info"><b>${esc(d.title)}</b><small>${d.required?'必須':'任意'}${d.dueOn?' ・ 期限 '+esc(d.dueOn):''}</small>${d.reviewNote?`<p class="my-return-note">${esc(d.reviewNote)}</p>`:''}</div><div class="my-submission-status"><span class="hr-upload-state ${outstanding?'missing':'ok'}">${esc(label)}</span>${!outstanding?`<small>${d.status==='確認済み'?'会社で確認済み':'会社で確認中'}${d.submittedAt?' ・ '+date(d.submittedAt):''}</small>`:''}</div><div class="my-submission-action">${outstanding&&canUpload?uploadButton(d,index):files.length?fileButton(files[0]):''}</div>${files.length?`<details class="my-submission-detail"><summary>提出内容${canUpload&&!outstanding?'・差し替え':''}</summary>${files.map(fileLine).join('')}${outstanding?'':canUpload?uploadButton(d,index,true):'<p class="muted">確認済み書類の差し替えは、会社の担当者にご連絡ください。</p>'}</details>`:''}</article>`;
  };
  const retry=message=>`<div class="banner warn" role="alert"><div>${message}<br><button class="btn btn-secondary btn-sm" data-my-retry>再読み込み</button></div></div>`;
  function renderContracts(own,shared,selfFailed,candidateFailed){
   const received=[...(shared?.documents||[]).map(d=>({...d,source:'candidate',status:'公開中',createdAt:d.publishedAt})),...(own?.received||[])];
   const unavailable=selfFailed||candidateFailed||shared?.ready===false||own?.notReady?.some(k=>['労働条件通知書','契約の控え'].includes(k));
   return `<section class="card"><h2>${icon('description')}会社から届いた契約書・通知書</h2>${unavailable?retry('会社から届いた書類を一部取得できませんでした。'):''}${received.map(d=>`<article class="hr-upload-row"><div><b>${esc(d.title||d.filename)}</b><small>${esc(d.filename)}${d.version?' ・ 第'+d.version+'版':''}${d.createdAt?' ・ '+date(d.createdAt):''}</small></div>${fileButton(d)}</article>`).join('')}${!received.length&&!unavailable?'<p class="muted">会社から届いている契約書・通知書はありません。</p>':''}<p class="muted my-document-note">閲覧・保存だけでは署名や合意は完了しません。署名が必要な契約書は、下の署名依頼からお手続きください。</p></section>`;
  }
  function renderSubmissions(own,selfFailed){
   items=(own?.checklist||[]).filter(d=>d.status!=='対象外');
   const uploads=own?.uploads||[],required=items.filter(d=>d.required),optional=items.filter(d=>!d.required);
   const unavailable=selfFailed||own?.checklistState==='unavailable'||own?.notReady?.some(k=>['手続き','提出状況','提出ファイル','確認結果'].includes(k));
   const unconfigured=!unavailable&&(own?.checklistState==='unconfigured'||!items.length),left=required.filter(missing).length;
   const summary=unavailable?'提出状況を確認できません':unconfigured?'提出する書類は、会社側で確認・設定中です。':left?`提出完了まで、あと${left}件`:required.length?'必要書類はすべて提出済みです。':'必須の提出書類はありません。';
   const ordered=[...required].sort((a,b)=>Number(missing(b))-Number(missing(a))),linked=new Set(items.map(d=>d.id)),older=uploads.filter(f=>!linked.has(f.itemId));
   return `<section class="card"><div class="my-submission-heading"><h2>${icon('task_alt')}提出する書類</h2><p class="my-document-progress" data-my-progress>${summary}</p></div>${unavailable?retry('提出状況を取得できませんでした。未提出・提出完了とは判定していません。'):''}${!unavailable&&!unconfigured?`<p class="muted my-document-note">書類ごとのボタンから提出してください。PDF・画像・Word・Excel、1ファイル10MBまで。</p>${ordered.map(d=>itemRow(d,items.indexOf(d),uploads)).join('')}${optional.length?`<details class="my-document-details"><summary>任意の書類（${optional.length}件）</summary>${optional.map(d=>itemRow(d,items.indexOf(d),uploads)).join('')}</details>`:''}`:''}${older.length?`<details class="my-document-details"><summary>これまでに提出した書類（${older.length}件）</summary>${older.map(fileLine).join('')}</details>`:''}${own?.notReady?.includes('アップロード書類')?retry('過去のアップロード一覧を取得できませんでした。'):''}</section>`;
  }
  async function load(message='',expected=null){
   const request=++revision;disposeUrl();element.textContent=view==='contracts'?'契約書を読み込み中…':'提出状況を読み込み中…';
   const results=await Promise.allSettled([API.api('/api/my-documents'),...(view==='contracts'?[API.api('/api/hr/candidate-documents?scope=me')]:[])]);
   if(disposed||request!==revision||!element.isConnected)return;
   const own=results[0].status==='fulfilled'?results[0].value:null,shared=results[1]?.status==='fulfilled'?results[1].value:null;
   if(expected){const item=own?.checklist?.find(i=>i.id===expected.itemId);const confirmed=item&&!missing(item)&&own?.uploads?.some(f=>f.id===expected.fileId&&f.itemId===expected.itemId);if(!confirmed)message='提出の確定を確認できませんでした。再読み込みして提出状況をご確認ください。';}
   rows=[];element.innerHTML=(view==='contracts'?renderContracts(own,shared,!own,results[1]?.status==='rejected'):renderSubmissions(own,!own))+`<p data-my-message role="status" tabindex="-1">${esc(message)}</p><dialog data-my-view aria-label="書類のプレビュー"><h2 data-my-title></h2><iframe title="書類PDF"></iframe><button class="btn btn-secondary" data-my-view-save hidden>保存</button><button class="btn btn-secondary" data-my-close>閉じる</button></dialog>`;
   const dialog=element.querySelector('[data-my-view]');dialog.addEventListener('close',()=>{dialog.querySelector('iframe').removeAttribute('src');disposeUrl();});if(message)element.querySelector('[data-my-message]').focus();
  }
  async function openFile(button){
   const d=rows[Number(button.dataset.myOpen??button.dataset.mySave)],download=button.hasAttribute('data-my-save'),request=revision;if(!d)return;
   button.disabled=true;const msg=element.querySelector('[data-my-message]');msg.textContent='';
   try{
    let url,mime=d.mimeType||'application/pdf';
    if(d.source==='candidate'){const blob=await HRCandidateDocuments.pdf({scope:'me',action:'file',documentId:d.id,download});if(disposed||request!==revision||!element.isConnected||element.hidden)return;disposeUrl();url=objectUrl=URL.createObjectURL(blob);}
    else{const r=await API.api(`/api/my-documents?file=1&source=${encodeURIComponent(d.source)}&id=${encodeURIComponent(d.id)}${download?'&download=1':''}`);if(disposed||request!==revision||!element.isConnected||element.hidden)return;url=r.url;mime=r.mimeType||mime;}
    if(download||!['application/pdf','image/jpeg','image/png'].includes(mime)){const a=document.createElement('a');a.href=url;a.download=d.filename;a.rel='noopener';a.click();}
    else{const dialog=element.querySelector('[data-my-view]');dialog.querySelector('[data-my-title]').textContent=d.title||d.filename;dialog.querySelector('iframe').src=url;const save=dialog.querySelector('[data-my-view-save]');save.hidden=false;save.dataset.mySave=button.dataset.myOpen;dialog.showModal();}
   }catch(e){if(msg.isConnected)msg.textContent=e.hint||e.message||'書類を開けませんでした。';}finally{if(button.isConnected)button.disabled=false;}
  }
  async function upload(input){
   const file=input.files?.[0],item=items[Number(input.dataset.myUpload)];if(!file||!item||uploading)return;
   const msg=element.querySelector('[data-my-message]');if(!file.size||file.size>10*1024*1024){msg.textContent='空のファイル、または10MBを超えるファイルは提出できません。';input.value='';return;}
   const row=input.closest('[data-submission-id]');uploading=true;row.setAttribute('aria-busy','true');element.querySelectorAll('[data-my-upload-start],[data-my-retry]').forEach(b=>b.disabled=true);msg.textContent=`${item.title}をアップロードしています…`;
   try{
    const result=await API.uploadProcedureFile(item.id,file,stage=>{if(msg.isConnected)msg.textContent=stage==='saving'?'提出を確定しています…':`${item.title}をアップロードしています…`;});
    if(!result?.ok)throw new Error('提出を確定できませんでした。提出状況をご確認ください。');
    if(!disposed)await load(`${item.title}を提出しました。会社の確認をお待ちください。`,{itemId:item.id,fileId:result.fileId});
   }catch(e){if(msg.isConnected){msg.textContent=e.hint||e.message||'提出できませんでした。再度アップロードしてください。';msg.focus();}}
   finally{uploading=false;row.removeAttribute('aria-busy');element.querySelectorAll('[data-my-upload-start],[data-my-retry]').forEach(b=>b.disabled=false);input.value='';}
  }
  function click(e){
   if(e.target.closest('[data-my-close]'))return element.querySelector('[data-my-view]').close();
   if(e.target.closest('[data-my-retry]')){if(!uploading)load();return;}
   const start=e.target.closest('[data-my-upload-start]');if(start){element.querySelector(`[data-my-upload="${start.dataset.myUploadStart}"]`).click();return;}
   const button=e.target.closest('[data-my-open],[data-my-save]');if(button)openFile(button);
  }
  const change=e=>{if(e.target.matches('[data-my-upload]'))upload(e.target);};
  element.addEventListener('click',click);element.addEventListener('change',change);root.addEventListener('pagehide',disposeUrl);load();
  return {reload:load,dispose(){disposed=true;revision++;disposeUrl();element.removeEventListener('click',click);element.removeEventListener('change',change);root.removeEventListener('pagehide',disposeUrl);}};
 }
 root.MyDocumentsUI={mount};
})(globalThis);
