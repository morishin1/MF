import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createMemDb} from './_memdb.mjs';
import {salesMailConfig,mailInput} from '../lib/sales-mail.js';
const tenant='4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac',id='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',key='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
const at=p=>new URL('../'+p,import.meta.url).pathname;
mock.module(at('lib/supabase.js'),{namedExports:{admin:()=>{throw Error('real DB forbidden');}}});
mock.module(at('lib/auth.js'),{namedExports:{requireUser:()=>{throw Error('real auth forbidden');}}});
mock.module(at('lib/gw.js'),{namedExports:{gwContext:()=>{},canSell:()=>false}});
const {createHandler}=await import('../api/sales/company-mail.js');
const mem=createMemDb({schema:{gw_sales_company_mail:{unique:[['tenant_id','request_key']]}}});
let auth=true,ctx,configured=true,sends=0,outcome='accepted',failUpdate=false;
const db=()=>{const base=mem.admin();return {...base,schema:()=>base,from:n=>{const q=base.from(n);if(failUpdate&&n==='gw_sales_company_mail')q.update=()=>{throw Error('audit offline');};return q;}};};
const handler=createHandler({requireUser:async(_req,res)=>{if(auth)return{id:actor};res.statusCode=401;res.end('{}');},gwContext:async()=>ctx,canSell:c=>c.sell,admin:db,
 salesMailConfig:()=>({configured,from:'Sales <sales@example.test>',hint:'status',smtpEnv:{SMTP_PASS:'must-never-leak'}}),
 deliverSalesMail:async()=>{sends++;return{status:outcome,providerMessageId:'mock-message'};}});
const payload=()=>({id,requestKey:key,to:'buyer@example.test',subject:'ご提案',text:'本文の確定版',expectedFrom:'Sales <sales@example.test>'});
function reset(){mem.reset();ctx={tenantId:tenant,sell:true,employee:{display_name:'担当テスト'}};auth=true;configured=true;sends=0;outcome='accepted';failUpdate=false;
 mem.rows.dx2_sales_company_directory_for_tenant=[{id,tenant_id:tenant}];mem.rows.companies=[{id,contact_email:'buyer@example.test',website:null,deleted_at:null}];}
async function run(method='POST',body=payload(),query=id){const res={setHeader(){},end(v){this.body=JSON.parse(v);}};await handler({method,url:'/api/sales/company-mail?id='+query,body},res);return res;}
reset();let r=await run();assert.equal(r.statusCode,200);assert.equal(sends,1);assert.equal(r.body.message.status,'accepted');assert.equal(r.body.message.body_text,'本文の確定版');assert.equal(r.body.message.actor_id,actor);
r=await run();assert.equal(sends,1);assert(r.body.replayed);
r=await run('POST',{...payload(),subject:'changed'});assert.equal(r.statusCode,409);assert.equal(sends,1);
r=await run('GET');assert.equal(r.body.messages.length,1);assert(!JSON.stringify(r.body).includes('must-never-leak'));
reset();const pair=await Promise.all([run(),run()]);assert(pair.every(r=>r.statusCode===200));assert.equal(sends,1,'atomic duplicate reservation');
for(const change of [()=>auth=false,()=>ctx.sell=false,()=>ctx.tenantId=other]){reset();change();r=await run();assert([401,403].includes(r.statusCode));assert.equal(sends,0);}
reset();assert.equal((await run('POST',{...payload(),id:other})).statusCode,404);assert.equal(sends,0);
reset();configured=false;assert.equal((await run()).statusCode,409);assert.equal(sends,0);assert.equal(mem.state.log.length,0);
reset();assert.equal((await run('POST',{...payload(),to:'other@example.test'})).statusCode,409);assert.equal(sends,0);
reset();assert.equal((await run('POST',{...payload(),expectedFrom:'changed'})).statusCode,409);assert.equal(sends,0);
for(const field of ['needs_contact_review','directory_hidden_at']){reset();mem.rows.dx2_sales_company_directory_for_tenant[0][field]=true;assert.equal((await run()).statusCode,409);assert.equal(sends,0);}
reset();mem.rows.gw_sales_company_links=[{tenant_id:tenant,source_system:'enger',source_company_id:id,company_id:other}];mem.rows.gw_sales_companies=[{id:other,tenant_id:tenant,emails:['buyer@example.test'],ng_reason:'stop'}];assert.equal((await run()).statusCode,409);assert.equal(sends,0);
reset();mem.rows.companies[0].website='https://example.test';mem.rows.gw_sales_companies=[{id:other,tenant_id:tenant,domain:'example.test',ng_reason:'stop'}];assert.equal((await run()).statusCode,409);assert.equal(sends,0);
reset();mem.state.missing='gw_sales_company_mail';assert.equal((await run()).statusCode,503);assert.equal(sends,0);
reset();outcome='unknown';r=await run();assert.equal(r.body.message.status,'unknown');await run();assert.equal(sends,1,'transport uncertainty never retries');
reset();failUpdate=true;r=await run();assert.equal(r.body.message.status,'unknown');assert.equal(mem.rows.gw_sales_company_mail[0].status,'sending');await run();assert.equal(sends,1,'audit failure never retries');
reset();mem.rows.gw_sales_company_mail=[{tenant_id:other,company_id:id,request_key:key,subject:'private'}];r=await run('GET');assert.equal(r.body.messages.length,0);
reset();r=await run('DELETE');assert.equal(r.statusCode,405);
for(const bad of [{subject:'x\r\nBcc:x@example.test'},{to:'x@example.test,y@example.test'},{text:'{{company}}'},{text:''}])assert.throws(()=>mailInput({...payload(),...bad}));
const hrEnv={MAIL_PROVIDER:'smtp',MAIL_SEND_ENABLED:'1',SMTP_HOST:'smtp.example.test',SMTP_USER:'hr@example.test',SMTP_PASS:'secret',HR_RECRUITING_FROM:'hr@example.test'};
assert.equal(salesMailConfig(hrEnv).configured,false,'never inherit HR credentials');
assert.equal(salesMailConfig({...hrEnv,SALES_MAIL_FROM:'sales@example.test',SALES_MAIL_ENABLED:'1'}).configured,false);
assert.equal(salesMailConfig({SALES_MAIL_FROM:'sales@example.test',SALES_MAIL_ENABLED:'1',SALES_SMTP_HOST:'smtp.example.test',SALES_SMTP_USER:'sales@example.test',SALES_SMTP_PASS:'test'}).configured,true);
console.log('PASS sales mail: exact audit, concurrent dedup, replay conflicts, auth/tenant/recipient/sender/opt-outs, no send without audit, transport/audit uncertainty, configuration isolation');
