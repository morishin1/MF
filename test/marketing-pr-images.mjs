import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createMemDb} from './_memdb.mjs';
import * as I from '../lib/marketing-pr-images.js';
const at=p=>fileURLToPath(new URL('../'+p,import.meta.url));
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:U})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:T}),accessOf:()=>({marketing:true})}});
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>sb}});
const {createHandler}=await import('../api/marketing/pr-images.js');
const T='a0000000-0000-4000-8000-000000000001',U='a0000000-0000-4000-8000-000000000002',D='a0000000-0000-4000-8000-000000000003',ID='a0000000-0000-4000-8000-000000000004';
const mem=createMemDb(),sb=mem.admin();mem.rows.gw_marketing_pr_drafts=[{id:D,tenant_id:T,created_by:U,status:'draft',version:1,payload:{draft:{images:[]}}}];mem.rows.gw_marketing_pr_images=[];
let calls=0,quota=false,finishConflict=false;
sb.rpc=async(name,a)=>{
 calls++;if(quota)return {error:{message:'image_quota'}};
 let row=mem.rows.gw_marketing_pr_images.find(x=>x.id===a.p_id);
 if(name.endsWith('reserve')){if(!row){row={id:ID,draft_id:D,tenant_id:T,created_by:U,state:'pending',name:a.p_name,source_hash:a.p_hash,source_size:a.p_size};mem.rows.gw_marketing_pr_images.push(row);}return {data:row};}
 if(finishConflict)return {error:{message:'draft_conflict'}};
 Object.assign(row,{state:'ready',size_bytes:a.p_size,sha256:a.p_hash});return {data:row};
};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=','base64');
const body={action:'upload',draftId:D,version:1,imageId:ID,name:'image.png',base64:png.toString('base64')};
const handler=createHandler({canonicalImage:async()=>png});
async function invoke(method,body,url='/api/marketing/pr-images',h=handler){const r={setHeader(){},end(x){this.body=JSON.parse(x);}};await h({method,body,url,headers:{}},r);return r;}
let n=0;async function test(label,fn){await fn();console.log('ok',++n,label);}
await test('no marketing permission => no DB/storage',async()=>{const before=calls;const h=createHandler({accessOf:()=>({marketing:false})});assert.equal((await invoke('POST',body,undefined,h)).statusCode,403);assert.equal(calls,before);});
await test('wrong tenant/user draft =>404',async()=>{const h=createHandler({requireUser:async()=>({id:'other'})});assert.equal((await invoke('POST',body,undefined,h)).statusCode,404);});
await test('malformed ID and SVG blocked',async()=>{assert.equal((await invoke('POST',{...body,imageId:'../other'})).statusCode,400);assert.equal((await invoke('POST',{...body,base64:Buffer.from('<svg/>').toString('base64')})).statusCode,400);});
await test('oversized body rejected before processing',async()=>assert.equal((await invoke('POST',{...body,base64:'a'.repeat(4*1024*1024)})).statusCode,413));
await test('quota reserve stops storage',async()=>{quota=true;assert.equal((await invoke('POST',body)).statusCode,409);quota=false;});
await test('verified bytes persist immutable key and ready metadata',async()=>{const r=await invoke('POST',body);assert.equal(r.statusCode,200);assert.equal(r.body.imageId,ID);assert.equal(mem.rows.gw_marketing_pr_images[0].state,'ready');});
await test('unreferenced uploads cannot mint view URL',async()=>assert.equal((await invoke('GET',null,`/api/marketing/pr-images?draftId=${D}&imageId=${ID}`)).statusCode,404));
await test('saved own ready reference receives short signed URL',async()=>{mem.rows.gw_marketing_pr_drafts[0].payload.draft.images=[{imageId:ID}];const r=await invoke('GET',null,`/api/marketing/pr-images?draftId=${D}&imageId=${ID}`);assert.equal(r.statusCode,200);assert.equal(r.body.expiresIn,60);});
await test('removal from payload stops future image access',async()=>{mem.rows.gw_marketing_pr_drafts[0].payload.draft.images=[];assert.equal((await invoke('GET',null,`/api/marketing/pr-images?draftId=${D}&imageId=${ID}`)).statusCode,404);});
await test('registered original rejects new upload',async()=>{mem.rows.gw_marketing_pr_drafts[0].status='registered';assert.equal((await invoke('POST',body)).statusCode,409);mem.rows.gw_marketing_pr_drafts[0].status='draft';});
await test('stale version rejects before reservation',async()=>assert.equal((await invoke('POST',{...body,version:2})).statusCode,409));
await test('references require exact owner/tenant/draft ready record',async()=>{assert.equal(await I.verifyImageRefs(sb,T,U,D,[{imageId:ID}]),true);assert.equal(await I.verifyImageRefs(sb,T,'other',D,[{imageId:ID}]),false);assert.equal(await I.verifyImageRefs(sb,T,U,D,[{imageId:ID},{imageId:ID}]),false);assert.equal(await I.verifyImageRefs(sb,T,U,D,[{name:'legacy'}]),true);});
await test('retry of ready upload is idempotent without decoding again',async()=>{const h=createHandler({canonicalImage:async()=>{throw Error('must not decode');}});assert.equal((await invoke('POST',body,undefined,h)).statusCode,200);});
await test('finish conflict does not mark pending image ready',async()=>{const row=mem.rows.gw_marketing_pr_images[0];row.state='pending';finishConflict=true;assert.equal((await invoke('POST',body)).statusCode,409);assert.equal(row.state,'pending');finishConflict=false;});
await test('missing RPC setup is reported, never simulated success',async()=>{const original=sb.rpc;sb.rpc=async()=>({error:{code:'42883'}});assert.equal((await invoke('POST',body)).statusCode,503);sb.rpc=original;});
await test('storage failure does not complete reservation',async()=>{const original=sb.storage;sb.storage={from:()=>({upload:async()=>({error:{}}),download:async()=>({error:{}})})};assert.equal((await invoke('POST',body)).statusCode,503);assert.equal(mem.rows.gw_marketing_pr_images[0].state,'pending');sb.storage=original;});
await test('uncertain upload verified by bytes before finalizing',async()=>{const original=sb.storage;sb.storage={from:()=>({upload:async()=>({error:{}}),download:async()=>({data:new Blob([png])})})};assert.equal((await invoke('POST',body)).statusCode,200);sb.storage=original;});
await test('signed URL service failure remains unavailable',async()=>{const original=sb.storage;mem.rows.gw_marketing_pr_drafts[0].payload.draft.images=[{imageId:ID}];sb.storage={from:()=>({createSignedUrl:async()=>({error:{}})})};assert.equal((await invoke('GET',null,`/api/marketing/pr-images?draftId=${D}&imageId=${ID}`)).statusCode,503);sb.storage=original;});
// Real decoder tests (not mocked).
const {default:sharp}=await import('sharp');const valid=await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer();
await test('actual sharp decoding/re-encode bounds',async()=>{const bytes=await I.canonicalImage(valid);assert.ok(bytes.length<2097152);assert.equal((await sharp(bytes).metadata()).format,'png');});
await test('truncated bytes rejected by actual decoder',async()=>assert.rejects(()=>I.canonicalImage(valid.subarray(0,24)),/invalid_image/));
await test('oversized pixel dimensions rejected',async()=>{const huge=await sharp({create:{width:8001,height:1,channels:3,background:'#fff'}}).png().toBuffer();await assert.rejects(()=>I.canonicalImage(huge),/unsupported_image/);});
console.log('PR private images',n,'checks PASS; SQL/RLS concurrency requires operator DB verification.');
