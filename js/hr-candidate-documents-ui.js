// Upload, review, explicitly publish. Original PDF bytes are never regenerated.
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const kinds={terms:'労働条件通知書',offer:'内定通知書',employment_contract:'雇用契約書',contractor_contract:'業務委託契約書'};
 const states={draft:'未公開',published:'本人に公開中',superseded:'差替え済み',withdrawn:'公開停止'};
 const icon=s=>`<span class="material-symbols-outlined" aria-hidden="true">${s}</span>`;
 async function pdf(body){const token=await API.getToken(),r=await fetch('/api/hr/candidate-documents',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});if(!r.ok){let e={};try{e=await r.json();}catch{}throw Error(e.hint||'PDFを開けませんでした。');}return r.blob();}
 function mount({element,applicantId,kind='terms',showPdf,onChanged=()=>{}}){
  let data=null,selected=kind,busy=false,confirmation=null;
  const call=(action,b={})=>API.api('/api/hr/candidate-documents',{method:'POST',body:{action,applicantId,...b}});
  const msg=text=>{const n=element.querySelector('[data-message]');if(n)n.textContent=text;};
  const list=()=>data.documents.filter(d=>!['superseded','withdrawn'].includes(d.status));
  function render(){if(!element.isConnected)return;
   element.innerHTML=`<p class="muted">パソコンで作成したPDFを、そのまま登録します。アップロードだけでは本人に公開されません。</p>
    <div class="hr-upload-panel"><label>書類の種類<select data-kind>${Object.entries(kinds).map(([key,label])=>`<option value="${key}" ${selected===key?'selected':''}>${label}</option>`).join('')}</select></label><label class="hr-upload-pick">${icon('upload_file')}<span>PDFを選ぶ（5MBまで）</span><input data-file type="file" accept=".pdf,application/pdf"></label><button class="btn btn-primary" data-action="upload" ${!data.canUpload?'disabled':''}>${icon('upload_file')}PDFをアップロード</button></div>
    <p data-message role="status"></p><div data-publish></div>
    <div class="hr-upload-list">${list().map(d=>`<div class="hr-upload-row"><div>${icon('picture_as_pdf')}<b>${esc(d.title)}</b><small>${esc(d.filename)} ・ 第${d.version}版</small></div><span class="hr-upload-state ${d.status}">${states[d.status]}</span><div class="hr-upload-actions"><button class="btn btn-secondary btn-sm" data-action="preview" data-id="${d.id}">PDFを見る</button>${d.status==='draft'?`<button class="btn btn-primary btn-sm" data-action="review" data-id="${d.id}" ${!data.canPublish?'disabled':''}>本人に公開する</button>`:`<button class="btn btn-secondary btn-sm" data-action="withdraw" data-id="${d.id}">公開を停止する</button>`}</div></div>`).join('')||'<p class="muted">まだPDFは登録されていません。</p>'}</div>
    ${!data.canPublish?'<p class="muted">公開するには、代表の採用判断と本人のメールアドレスの登録が必要です。</p>':''}
    <p class="muted">本人は <b>契約・書類</b> から閲覧・保存できます。公開・閲覧だけで合意や契約完了にはなりません。</p>`;
  }
  async function load(){try{data=await API.api('/api/hr/candidate-documents?applicantId='+encodeURIComponent(applicantId));render();}catch(e){if(element.isConnected)element.innerHTML=`<p role="alert">${esc(e.hint||e.message||'書類を取得できません。')}</p><p class="muted">現在の書類は「書類・契約」から確認できます。</p>`;}}
  element.addEventListener('change',e=>{if(e.target.matches('[data-kind]'))selected=e.target.value;});
  element.addEventListener('click',async e=>{
   const button=e.target.closest('[data-action]');if(!button||busy||!data)return;busy=true;button.disabled=true;
   try{
    const action=button.dataset.action,d=data.documents.find(d=>d.id===button.dataset.id);
    if(action==='upload'){
     const file=element.querySelector('[data-file]').files[0];if(!file||file.size<=5||file.size>5*1024*1024||!/\.pdf$/i.test(file.name))throw Error('5MB以下のPDFを選んでください。');
     const input={kind:selected,fileName:file.name,sizeBytes:file.size},signed=await call('prepare',input);
     const sent=await fetch(signed.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/pdf','x-upsert':'false'},body:file});if(!sent.ok)throw Error('アップロードできませんでした。もう一度お試しください。');
     await call('attach',{...input,path:signed.path});if(!element.isConnected)return;await load();msg(file.name+' を登録しました。PDFを確認してから本人に公開してください。');onChanged();
    }else if(action==='preview'){
     const blob=await pdf({action:'file',applicantId,documentId:d.id});if(!element.isConnected)return;showPdf({title:d.title,url:URL.createObjectURL(blob),filename:d.filename,ownsUrl:true});
    }else if(action==='review'){
     const r=await call('previewPublish',{documentId:d.id});if(!element.isConnected)return;confirmation=r.confirmation;
     element.querySelector('[data-publish]').innerHTML=`<div class="hr-publication-review"><b>公開する本人とPDFを確認してください</b><p>${esc(confirmation.name)} 様<br>${esc(confirmation.email)}<br>${esc(confirmation.filename)} ・ 第${confirmation.version}版</p><p>このメールアドレスのアカウントでログインすると、「契約・書類」に表示されます。メールは送信されません。</p><button class="btn btn-primary" data-action="publish">このPDFを本人に公開する</button> <button class="btn btn-secondary" data-action="cancel">やめる</button></div>`;
    }else if(action==='publish'){
     if(!confirmation)throw Error('公開する内容を確認してください。');await call('publish',{documentId:confirmation.id,confirmDigest:confirmation.digest,confirmed:true});confirmation=null;if(!element.isConnected)return;await load();msg('本人に公開しました。登録済みのアカウントでログインすると確認できます。');onChanged();
    }else if(action==='cancel'){confirmation=null;element.querySelector('[data-publish]').innerHTML='';}
    else if(action==='withdraw'){
     element.querySelector('[data-publish]').innerHTML=`<div class="hr-publication-review"><p>${esc(d.filename)} の公開を停止します。保存済みの本人の控えは削除されません。</p><button class="btn btn-primary" data-action="confirm-withdraw" data-id="${d.id}">公開を停止する</button> <button class="btn btn-secondary" data-action="cancel">やめる</button></div>`;
    }else if(action==='confirm-withdraw'){await call('withdraw',{documentId:d.id,confirmed:true});if(!element.isConnected)return;await load();msg('公開を停止しました。');onChanged();}
   }catch(e){msg(e.hint||e.message||'保存できませんでした。');}finally{busy=false;if(button.isConnected)button.disabled=false;}
  });
  element.textContent='書類を読み込み中…';load();
 }
 root.HRCandidateDocuments={mount,pdf};
})(globalThis);
