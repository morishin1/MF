// Optional structured additions; old PR payloads remain valid without them.
const KEY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sanitizePRSections(value,images=[]){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>20)return null;
 const keys=new Set(images.map(i=>i.key).filter(Boolean));let total=0;
 const result=[];
 for(const x of value){
  if(!x||typeof x!=='object'||Array.isArray(x)||typeof x.title!=='string'||x.title.length>120||typeof x.body!=='string'||x.body.length>6000)return null;
  const imageKey=x.imageKey??'';
  if(typeof imageKey!=='string'||(imageKey&&(!KEY.test(imageKey)||!keys.has(imageKey))))return null;
  total+=x.title.length+x.body.length;if(total>20000)return null;
  result.push({title:x.title,body:x.body,imageKey});
 }
 return result;
}
export function validPRImageKeys(images){
 const keys=images.filter(x=>x.key!==undefined).map(x=>x.key);
 return keys.every(k=>typeof k==='string'&&KEY.test(k))&&new Set(keys).size===keys.length;
}

export function prSectionsText(sections,images=[]){
 return (sections||[]).map(s=>[s.title&&"■ "+s.title,s.body,s.imageKey&&images.find(i=>i.key===s.imageKey)?.caption].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
}
