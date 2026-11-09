import assert from 'node:assert/strict';
import {mock} from 'node:test';
const at=p=>new URL('../'+p,import.meta.url).pathname;
const companyId='11111111-1111-4111-8111-111111111111',tenantId='22222222-2222-4222-8222-222222222222',personId='33333333-3333-4333-8333-333333333333';
let logged=true,salesAllowed=true,scopeFound=true,dbCalls=0;
const saved=[],lastFilters=[];
mock.module(at('lib/http.js'),{namedExports:{
 json:(res,status,body)=>{res.statusCode=status;res.body=body;return body;},
 readJson:async req=>req.body||{},
 methodNotAllowed:(res)=>{res.statusCode=405;res.body={error:'method_not_allowed'};},
}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:async(_req,res)=>logged?{id:'actor'}:(res.statusCode=401,null)}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:async()=>({tenantId,sales:salesAllowed}),canSell:ctx=>ctx.sales}});
mock.module(at('lib/sales-enger-scope.js'),{namedExports:{canAccessEightEngerDirectory:ctx=>ctx.sales}});
function query(table){
 dbCalls++;
 const filters=[],q={};
 q.select=()=>q;
 q.eq=(key,value)=>{filters.push([key,value]);lastFilters.push([key,value]);return q;};
 q.is=()=>q;q.order=()=>q;q.limit=()=>q;
 q.insert=value=>{q.insertValue=value;return q;};
 q.update=value=>{q.updateValue=value;return q;};
 q.maybeSingle=async()=>{
  if(table==='scope')return{data:scopeFound?{id:companyId}:null,error:null};
  const row=saved.find(p=>filters.every(([key,val])=>p[key]===val));
  if(row&&q.updateValue)Object.assign(row,q.updateValue);
  return{data:row||null,error:null};
 };
 q.single=async()=>{
  if(q.insertValue){const person={id:personId,...q.insertValue};saved.push(person);return{data:person,error:null};}
  return{data:null,error:null};
 };
 q.then=(resolve,reject)=>Promise.resolve({data:saved.filter(p=>filters.every(([key,val])=>p[key]===val)),error:null}).then(resolve,reject);
 return q;
}
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>({schema:()=>({from:()=>query('scope')}),from:()=>query('people')})}});
const {personInput,default:handler}=await import('../api/sales/company-people.js');
assert.equal(personInput({name:' 田中 太郎 ',source:'business_card'}).name,'田中 太郎');
for(const input of [{name:'',source:'business_card'},{name:'名前',source:'guess'},{name:'名前',source:'inquiry',email:'invalid'}]){
 assert.throws(()=>personInput(input));
}
assert.equal(personInput({name:'名前',source:'event',metOn:'2026-11-09'}).met_on,'2026-11-09');
const req=async(method='GET',body={},querystr='?companyId='+companyId)=>{
 const response={setHeader(name,value){this[name]=value}};
 await handler({method,url:'/api/sales/company-people'+querystr,body},response);
 return response;
};
logged=false;assert.equal((await req()).statusCode,401);logged=true;
salesAllowed=false;assert.equal((await req()).statusCode,403);salesAllowed=true;
const before=dbCalls;assert.equal((await req('GET',{},'?companyId=bad')).statusCode,400);assert.equal(dbCalls,before);
scopeFound=false;assert.equal((await req()).statusCode,404);scopeFound=true;
const added=await req('POST',{companyId,name:'名刺交換した相手',source:'business_card',metOn:'2026-11-09',email:'contact@example.test'});
assert.equal(added.statusCode,201);assert.equal(added.body.person.company_id,companyId);
assert.equal(added.body.person.tenant_id,tenantId);
assert.deepEqual(lastFilters.slice(-2),[['tenant_id',tenantId],['id',companyId]],'scope is tenant and company scoped');
const viewed=await req();assert.equal(viewed.statusCode,200);assert.equal(viewed.body.people.length,1);
const edited=await req('PATCH',{companyId,id:personId,name:'編集後',source:'business_card'});
assert.equal(edited.statusCode,200);assert.equal(edited.body.person.name,'編集後');
assert.equal(saved.length,1,'editing should never duplicate people');
assert.equal((await req('POST',{companyId,name:'入力なし',source:'guess'})).statusCode,400);
console.log('PASS people: explicit source validation, Sales permission, scope checks, tenant binding, create/list/update');
