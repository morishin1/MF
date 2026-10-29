// Local previews and private server image references. File bytes/URLs never enter draft JSON.
(function(){
 "use strict";
 const byImage=new WeakMap(),files=new WeakMap(),requests=new WeakMap(),saved=new Map(),urls=new Set();let active=[],draftId=null;
 const usable=file=>file&&['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)&&file.size<=10*1024*1024&&file.size>=0;
 function collect(){
  const keep=new Set(active.map(x=>byImage.get(x)).filter(Boolean));
  for(const rows of saved.values())for(const row of rows)if(row.url)keep.add(row.url);
  for(const url of urls)if(!keep.has(url)){URL.revokeObjectURL(url);urls.delete(url);}
 }
 function attach(image,file){
  if(!usable(file)||!URL.createObjectURL)return false;
  try{const url=URL.createObjectURL(file);urls.add(url);byImage.set(image,url);files.set(image,file);return true;}catch{return false;}
 }
 function current(images){active=images||[];collect();}
 function remember(id,images){
  draftId=id;
  if(!id)return;
  saved.set(id,(images||[]).map(image=>({name:image.name,size:image.size,imageId:image.imageId,url:byImage.get(image)||null,file:files.get(image)||null})));
  current(images);
 }
 function restore(id,images){
  draftId=id;
  const rows=saved.get(id)||[];
  (images||[]).forEach((image,i)=>{const row=rows[i];if(row&&row.name===image.name&&row.size===image.size&&row.imageId===image.imageId&&urls.has(row.url)){byImage.set(image,row.url);if(row.file)files.set(image,row.file);}});
  current(images);
 }
 function render(root,images,registered=false){
  const first=images?.[0],url=first&&byImage.get(first);
  const box=document.createElement('figure');box.className='mpr-thumbnail';box.style.margin='0 0 20px';
  if(url&&urls.has(url)){
   const img=document.createElement('img');img.src=url;img.alt=first.caption||first.name||'トップ画像';
   img.style.width='100%';img.style.maxHeight='360px';img.style.objectFit='contain';img.style.borderRadius='12px';
   img.onerror=()=>{const note=document.createElement('p');note.className='mpr-hint';note.textContent='画像を表示できません。「5.画像・仕上げ」で別の画像を選び直してください。';box.replaceChildren(note);};
   const cap=document.createElement('figcaption');cap.textContent=first.caption||first.name;
   box.append(img,cap);
  }else if(first?.imageId&&draftId&&window.API?.api){
   const note=document.createElement('p');note.className='mpr-hint';note.textContent='保存された画像を読み込んでいます。';box.append(note);
   const requestedDraft=draftId;
   API.api('/api/marketing/pr-images?draftId='+encodeURIComponent(requestedDraft)+'&imageId='+encodeURIComponent(first.imageId)).then(data=>{
    if(!data?.url||!/^https:\/\//.test(data.url))throw Error('invalid_url');
    const img=document.createElement('img');img.src=data.url;img.alt=first.caption||first.name||'画像';img.style.width='100%';img.style.maxHeight='360px';img.style.objectFit='contain';
    const cap=document.createElement('figcaption');cap.textContent=first.caption||first.name;box.replaceChildren(img,cap);
    img.onerror=()=>{note.textContent='保存画像を表示できません。プレビューを開き直してください。';box.replaceChildren(note);};
   }).catch(()=>{note.textContent='保存画像を取得できません。接続・権限を確認してプレビューを開き直してください。';box.replaceChildren(note);});
  }else{
   const note=document.createElement('p');note.className='mpr-hint';
   note.textContent=first&&registered?'登録済み原稿の画像本体は保存されていないため復元できません。元画像の再選択は、新しいPR原稿の作成時に行ってください。':first?'画像情報は保存されていますが、画像本体は保存されていません。「5.画像・仕上げ」でトップ画像を再選択すると表示できます。':'トップ画像は未選択です。「5.画像・仕上げ」で選択できます。';box.append(note);
  }
  root.append(box);
 }
 window.addEventListener?.('pagehide',event=>{if(event.persisted)return;for(const url of urls)URL.revokeObjectURL(url);urls.clear();saved.clear();active=[];});
 async function persist(id,version,images){
  const result=[];
  for(const image of images){
   if(image.imageId){result.push({imageId:image.imageId,size:image.size});continue;}
   const file=files.get(image);if(!file){result.push(null);continue;}
   if(!['image/jpeg','image/png'].includes(file.type)||file.size>2*1024*1024)throw Error('画像保存はPNG/JPEG・各2MB以下です。画像を差し替えてください。');
   let requestId=requests.get(image);if(!requestId){requestId=crypto.randomUUID();requests.set(image,requestId);}
   const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   const data=await API.api('/api/marketing/pr-images',{method:'POST',body:{action:'upload',draftId:id,version,imageId:requestId,name:image.name,base64:btoa(binary)}});
   if(!data?.imageId)throw Error('画像保存を確認できませんでした。');
   result.push({imageId:data.imageId,size:data.size});
  }
  return result;
 }
 const hasPending=images=>images.some(image=>!image.imageId&&files.has(image));
 window.MarketingImagePreview={attach,current,remember,restore,render,persist,hasPending};
})();
