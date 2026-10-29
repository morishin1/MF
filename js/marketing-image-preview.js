// Session-local previews only. No upload, storage, fetch, or persisted blob URLs.
(function(){
 "use strict";
 const byImage=new WeakMap(),saved=new Map(),urls=new Set();let active=[];
 const usable=file=>file&&['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)&&file.size<=10*1024*1024&&file.size>=0;
 function collect(){
  const keep=new Set(active.map(x=>byImage.get(x)).filter(Boolean));
  for(const rows of saved.values())for(const row of rows)if(row.url)keep.add(row.url);
  for(const url of urls)if(!keep.has(url)){URL.revokeObjectURL(url);urls.delete(url);}
 }
 function attach(image,file){
  if(!usable(file)||!URL.createObjectURL)return false;
  try{const url=URL.createObjectURL(file);urls.add(url);byImage.set(image,url);return true;}catch{return false;}
 }
 function current(images){active=images||[];collect();}
 function remember(id,images){
  if(!id)return;
  saved.set(id,(images||[]).map(image=>({name:image.name,size:image.size,url:byImage.get(image)||null})));
  current(images);
 }
 function restore(id,images){
  const rows=saved.get(id)||[];
  (images||[]).forEach((image,i)=>{const row=rows[i];if(row&&row.name===image.name&&row.size===image.size&&urls.has(row.url))byImage.set(image,row.url);});
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
  }else{
   const note=document.createElement('p');note.className='mpr-hint';
   note.textContent=first&&registered?'登録済み原稿の画像本体は保存されていないため復元できません。元画像の再選択は、新しいPR原稿の作成時に行ってください。':first?'画像情報は保存されていますが、画像本体は保存されていません。「5.画像・仕上げ」でトップ画像を再選択すると表示できます。':'トップ画像は未選択です。「5.画像・仕上げ」で選択できます。';box.append(note);
  }
  root.append(box);
 }
 window.addEventListener?.('pagehide',event=>{if(event.persisted)return;for(const url of urls)URL.revokeObjectURL(url);urls.clear();saved.clear();active=[];});
 window.MarketingImagePreview={attach,current,remember,restore,render};
})();
