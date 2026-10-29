import crypto from 'node:crypto';
export const TABLE='gw_marketing_pr_images',BUCKET='marketing-pr-images',LIMIT=2*1024*1024;
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
export const objectPath=row=>`${row.tenant_id}/${row.created_by}/${row.draft_id}/${row.id}.png`;
export const fail=(status,error)=>{throw Object.assign(Error(error),{status});};
export async function boundedJson(req,max=3*1024*1024){
 if(req.body&&typeof req.body==='object'){if(Buffer.byteLength(JSON.stringify(req.body))>max)fail(413,'image_too_large');return req.body;}
 let length=0;const chunks=[];
 for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>max)fail(413,'image_too_large');chunks.push(b);}
 try{return JSON.parse(Buffer.concat(chunks).toString());}catch{fail(400,'invalid_json');}
}
export function imageBytes(value){
 if(typeof value!=='string'||value.length>Math.ceil(LIMIT/3)*4||!value.length||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail(400,'invalid_image');
 const bytes=Buffer.from(value,'base64');if(!bytes.length||bytes.length>LIMIT)fail(413,'image_too_large');
 const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!png&&!jpg)fail(400,'unsupported_image');return bytes;
}
export async function canonicalImage(bytes){
 const {default:sharp}=await import('sharp');
 try{
  const options={failOn:'warning',limitInputPixels:16000000,animated:false};
  const info=await sharp(bytes,options).metadata();
  if(!['png','jpeg'].includes(info.format)||!info.width||!info.height||info.width>8000||info.height>8000||(info.pages||1)>1)fail(400,'unsupported_image');
  const result=await sharp(bytes,options).rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).png({compressionLevel:9}).toBuffer();
  if(result.length>LIMIT)fail(413,'image_too_large');return result;
 }catch(e){if(e.status)throw e;fail(400,'invalid_image');}
}
export async function ownedDraft(sb,tenant,user,id){
 if(!UUID.test(id||''))fail(400,'invalid_draft');
 const {data,error}=await sb.from('gw_marketing_pr_drafts').select('id,status,version,payload').eq('tenant_id',tenant).eq('created_by',user).eq('id',id).maybeSingle();
 if(error)fail(503,'not_ready');if(!data)fail(404,'not_found');return data;
}
export async function verifyImageRefs(sb,tenant,user,draftId,images){
 const ids=images.filter(i=>i.imageId!==undefined).map(i=>i.imageId);
 if(!ids.length)return true;
 if(!UUID.test(draftId||'')||ids.some(id=>!UUID.test(id||''))||new Set(ids).size!==ids.length)return false;
 const {data,error}=await sb.from(TABLE).select('id,name,size_bytes').eq('tenant_id',tenant).eq('created_by',user).eq('draft_id',draftId).eq('state','ready').in('id',ids);
 if(error)fail(503,'not_ready');
 return ids.every(id=>data?.some(row=>row.id===id));
}
