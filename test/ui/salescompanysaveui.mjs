// Real workbench + detail/save API handlers; synthetic DB only, external requests blocked.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {launch} from '../_browser.mjs';
import {shotPath} from '../_shot.mjs';
import {createMemDb} from '../_memdb.mjs';
const root=new URL('../../',import.meta.url),at=p=>new URL(p,root).pathname;
const tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
const fields={website:'website',phone:'phone',isFavorite:'is_favorite'};
const mem=createMemDb();let failure=null;
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{const db=mem.admin();return {...db,schema:()=>db,rpc:async(name,args)=>{
 assert.equal(name,'gw_sales_company_profile_batch_save');
 if(failure==='empty')return {data:null,error:null};
 if(failure==='error')return {data:null,error:{code:'XX000'}};
 const row=mem.rows.companies[0];
 for(const key of Object.keys(args.p_patch))if((row[fields[key]]??null)!==args.p_expected[key])return {error:{code:'P0001'}};
 for(const [key,value] of Object.entries(args.p_patch))row[fields[key]]=value;
 return {data:{id:actor},error:null};
}};}}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:actor})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:tenant,sell:true}),canSell:c=>c.sell}});
const detail=(await import('../../api/sales/enger-company-detail.js')).default;
const save=(await import('../../api/sales/company-workbench.js')).default;
async function run(handler,method,body){const res={setHeader(){},end(v){this.body=v;}};await handler({method,url:'/api/test?id='+id,body},res);return res;}
const server=createServer(async(req,res)=>{
 try{const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/test-workbench'){
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><link rel="stylesheet" href="/css/sales-company-segments.css"><button id="open">企業を開く</button><dialog id="lc-dialog"><button id="lc-close" onclick="document.querySelector('dialog').close()">閉じる</button><h2 id="lc-detail-title"></h2><div id="lc-detail"></div></dialog><script type="module">
 window.API={api:async(url,options={})=>{const response=await fetch(url,{...options,headers:{'content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});const value=await response.json();if(!response.ok)throw value;return value;}};
 const {createCompanyWorkbench}=await import('/js/sales-company-workbench.js');
 const bench=createCompanyWorkbench({draft:new Map(),onChange:()=>{},viewer:()=> '検証担当'});
 document.querySelector('#open').onclick=()=>bench.open({id:'${id}',companyId:'${id}',name:'合成検証企業',proposals:[],candidateIds:[]});
 </script></html>`);return;}
 const file=new URL('.'+path,root);if(!file.pathname.startsWith(root.pathname))throw Error('path');
 res.setHeader('content-type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/plain');res.end(await readFile(file));
 }catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await launch();const page=await browser.newPage({viewport:{width:1360,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());if(u.origin!==base)return route.abort();
 if(!u.pathname.startsWith('/api/'))return route.continue();
 const body=req.postDataJSON();let result;
 if(u.pathname==='/api/sales/enger-company-detail')result=await run(detail,'GET',{});
 else if(u.pathname==='/api/sales/company-workbench'&&req.method()==='PATCH')result=await run(save,'PATCH',body);
 else result={statusCode:200,body:JSON.stringify({activities:[],override:{},templates:[],people:[],items:[],history:[],configured:false})};
 await route.fulfill({status:result.statusCode,contentType:'application/json',body:result.body});
 });
 async function open(){await page.click('#open');await page.waitForSelector('#lc-profile-edit');}
 async function edit(url){await page.click('#lc-profile-edit');await page.fill('[data-profile-key="website"]',url);}
 async function saved(){await page.click('#lc-profile-save');await page.waitForFunction(()=>document.querySelector('#lc-work-status')?.textContent==='企業情報を保存しました。');}
 for(const initial of ['',null,'https://existing.example.test']){
 mem.reset();failure=null;mem.rows.dx2_sales_company_directory_for_tenant=[{id,tenant_id:tenant}];
 mem.rows.companies=[{id,name:'合成検証企業',website:initial,phone:initial?'03-0000-0000':initial,is_favorite:null,is_end_client:false,deleted_at:null}];
 await page.goto(base+'/test-workbench');await open();
 assert.equal(await page.isDisabled('[data-channel="form"]'),!initial);
 await edit('https://saved.example.test');
 await page.fill('[data-profile-key="phone"]','03-1234-5678');
 await page.locator('#lc-profile-form details').evaluate(el=>el.open=true);
 await page.selectOption('[data-profile-key="isFavorite"]','true');await saved();
 await page.click('#lc-close');await open();
 assert.match(await page.textContent('#lc-profile-view'),/https:\/\/saved.example.test/);
 assert.match(await page.textContent('#lc-profile-view'),/03-1234-5678/);
 assert.equal(await page.isDisabled('[data-channel="form"]'),false);
 await page.click('[data-channel="form"]');assert.equal(await page.isVisible('#lc-form-panel'),true);
 assert.equal(await page.getAttribute('#lc-form-link a','href'),'https://saved.example.test');
 // Never open the external form or record a sent message.
 for(const mode of ['error','empty','conflict']){
 failure=mode;await edit('https://retry.example.test');
 if(mode==='conflict')mem.rows.companies[0].website='https://concurrent.example.test';
 await page.click('#lc-profile-save');await page.waitForFunction(()=>document.querySelector('#lc-profile-save-status')?.textContent.includes('再'));
 assert.doesNotMatch(await page.textContent('#lc-profile-save-status'),/保存しました/);
 assert.equal(await page.inputValue('[data-profile-key="website"]'),'https://retry.example.test');
 await page.click('#lc-close');await open();
 assert.equal(mem.rows.companies[0].website,mode==='conflict'?'https://concurrent.example.test':'https://saved.example.test');
 }
 failure=null;await edit('https://retry.example.test');await saved();
 await page.click('#lc-close');await open();assert.match(await page.textContent('#lc-profile-view'),/https:\/\/retry.example.test/);
 }
 await page.screenshot({path:shotPath('sales-company-save-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:shotPath('sales-company-save-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS browser: empty/null/existing HP + phone + nullable flag save, reopen, form action, failed/empty/conflicting save, input retention and retry; no external send');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
