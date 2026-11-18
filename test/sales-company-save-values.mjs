// Real detail/save handlers, isolated memory DB. No production access.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createMemDb} from './_memdb.mjs';
const at=p=>new URL('../'+p,import.meta.url).pathname;
const tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222';
const fields={name:'name',contactName:'contact_name',contactEmail:'contact_email',phone:'phone',address:'address',industry:'industry',website:'website',formUrl:'contact_form_url',status:'status',note:'note',isFavorite:'is_favorite',isEndClient:'is_end_client'};
const mem=createMemDb();
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{const db=mem.admin();return {...db,schema:()=>db,rpc:async(name,args)=>{
 assert.equal(name,'gw_sales_company_profile_batch_save');
 // Match db/165's IS DISTINCT FROM comparison before applying any fields.
 const row=mem.rows.companies[0];
 for(const key of Object.keys(args.p_patch)) if((row[fields[key]]??null)!==args.p_expected[key])return {error:{code:'P0001'}};
 for(const [key,value] of Object.entries(args.p_patch))row[fields[key]]=value;
 return {data:{id:actor},error:null};
}};}}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async()=>({id:actor})}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId:tenant,sell:true}),canSell:c=>c.sell}});
const detail=(await import('../api/sales/enger-company-detail.js')).default;
const save=(await import('../api/sales/company-workbench.js')).default;
async function run(handler,method='GET',body={}){const res={setHeader(){},end(v){this.body=JSON.parse(v);}};await handler({method,url:'/api/test?id='+id,body},res);return res;}
for(const value of ['',null,'existing']){
 mem.reset();mem.rows.dx2_sales_company_directory_for_tenant=[{id,tenant_id:tenant}];
 const source={id,deleted_at:null};for(const col of Object.values(fields))source[col]=value;
 source.name='検証企業';source.is_favorite=null;source.is_end_client=false;
 mem.rows.companies=[source];
 const d=await run(detail);assert.equal(d.statusCode,200);
 for(const [key,col] of Object.entries(fields))assert.equal(d.body.company.editSource[key],source[col],`${key} preserves ${JSON.stringify(source[col])}`);
 const patch={website:'https://example.test',phone:'03-1234-5678',isFavorite:true};
 const expected=Object.fromEntries(Object.keys(patch).map(k=>[k,d.body.company.editSource[k]]));
 const body={id,operation:'profile_batch',patch,expected,requestKey:actor};
 assert.equal((await run(save,'PATCH',body)).statusCode,200);
 const reread=(await run(detail)).body.company;assert.equal(reread.website,patch.website);assert.equal(reread.phone,patch.phone);assert.equal(reread.isFavorite,true);
 assert.equal((await run(save,'PATCH',{...body,patch:{website:'https://stale.test'},expected:{website:value}})).statusCode,409,'actual concurrent changes still rejected');
 assert.equal((await run(detail)).body.company.website,patch.website);
}
console.log('PASS exact source values, empty/null/existing save-readback, nullable flags, stale write rejection');
