// Regression: Sales can provision a real company-number login without requiring
// contact data. This must not emit mail, alter another company's account or
// expose an initial password from a later GET.
import assert from "node:assert/strict";
import {mock} from "node:test";
import {createMemDb} from "./_memdb.mjs";
import {companyIdOnlyEmail,isCompanyIdOnlyEmail,isReservedCompanyLoginEmail} from "../lib/sales-company-portal.js";
const at=p=>new URL("../"+p,import.meta.url).pathname;
const TENANT="4c19bc4d-ad43-4e6a-9d93-9e6091d0dbac";
const OTHER="99999999-9999-4999-8999-999999999999";
const CO_A="cccccccc-0000-4000-8000-00000000000a";
const CO_B="cccccccc-0000-4000-8000-00000000000b";
const OUT="cccccccc-0000-4000-8000-0000000000ff";
const STAFF="22222222-2222-4222-8222-222222222222";
const mem=createMemDb({schema:{dx2_company_portal_members:{unique:[["email"]]}}});
mem.rows.dx2_sales_company_directory_for_tenant=[
 {id:CO_A,tenant_id:TENANT,name:"企業A"},
 {id:CO_B,tenant_id:TENANT,name:"企業B"},
];
mem.rows.companies=[
 {id:CO_A,company_no:18854,contact_name:null,contact_email:null,website:null},
 {id:CO_B,company_no:18855,contact_name:null,contact_email:null,website:null,caution:true},
];
mem.rows.gw_sales_company_links=[];
mem.rows.gw_sales_companies=[];
mem.rows.gw_employees=[{id:"emp",user_id:STAFF,email:"sales@8grp.example"}];
mem.rows.app_users=[];
const authUsers=new Map();
const creates=[], mails=[], logs=[];
mock.module(at("lib/supabase.js"),{namedExports:{admin:()=>{
 const db=mem.admin();
 return {...db,schema:()=>db,auth:{admin:{
  createUser:async body=>{
   creates.push(body);
   if(authUsers.has(body.email))return {error:{message:"duplicate"},data:{user:null}};
   const user={id:"auth-id-"+creates.length,email:body.email,app_metadata:body.app_metadata};
   authUsers.set(user.email,user);
   return {error:null,data:{user}};
  },
  deleteUser:async id=>{for(const [email,user] of authUsers)if(user.id===id)authUsers.delete(email);return {error:null}},
  getUserById:async id=>({error:null,data:{user:[...authUsers.values()].find(x=>x.id===id)||null}}),
  updateUserById:async(id,patch)=>{
   const u=[...authUsers.values()].find(x=>x.id===id);
   if(!u)return {error:{message:"not found"}};
   Object.assign(u,patch);return {error:null,data:{user:u}};
  },
 }}};}}});
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async()=>({id:STAFF})}});
let ctx={tenantId:TENANT,sell:true,isAdmin:false,roles:["sales"],employee:{display_name:"営業担当"}};
mock.module(at("lib/gw.js"),{namedExports:{gwContext:async()=>ctx,canSell:c=>c.sell}});
mock.module(at("lib/gw-audit.js"),{namedExports:{gwLog:async e=>{logs.push(e)}}});
mock.module(at("lib/mail/index.js"),{namedExports:{
 mailConfig:()=>({configured:false,reason:"not configured"}),
 sendMail:async mail=>{mails.push(mail);return {status:"sent"}},
}});
const portal=(await import("../api/sales/company-portal.js")).default;
async function call(method,companyId,extra={}){
 const res={statusCode:200,setHeader(){},end(x){this.body=x?JSON.parse(x):null;}};
 await portal({method,url:"/api/sales/company-portal?companyId="+companyId,body:{companyId,...extra}},res);
 return res;
}
assert.equal(companyIdOnlyEmail("invalid"),null);
const alias=companyIdOnlyEmail(CO_A);
assert.equal(alias,"company-"+CO_A+"@accounts.enger.jp");
assert.equal(isCompanyIdOnlyEmail(alias),true);
assert.equal(isCompanyIdOnlyEmail("staff@8grp.co.jp"),false);
assert.equal(isReservedCompanyLoginEmail("random@accounts.enger.jp"),true);

const before=await call("GET",CO_A);
assert.equal(before.statusCode,200,JSON.stringify(before.body));
assert.equal(before.body.contactReady,false);
assert.equal(before.body.canIssue,true);
assert.equal(before.body.portal.displayId,"18854");
assert.equal(before.body.members.length,0);
assert.equal((await call("POST",CO_A,{action:"ensure_meeting_account",confirmed:false})).statusCode,400);
const invalidScope=await call("POST",OUT,{action:"ensure_meeting_account",confirmed:true});
assert.equal(invalidScope.statusCode,404);
const blocked=await call("POST",CO_B,{action:"ensure_meeting_account",confirmed:true});
assert.equal(blocked.statusCode,409);
assert.equal(creates.length,0);

const issued=await call("POST",CO_A,{action:"ensure_meeting_account",confirmed:true});
assert.equal(issued.statusCode,200,JSON.stringify(issued.body));
assert.equal(issued.body.companyIdOnly,true);
assert.equal(issued.body.previewOnly,undefined);
assert.equal(issued.body.oneTime,true);
assert.equal(issued.body.temporaryPassword.length,8);
assert.equal(issued.body.loginUrl,"https://enger.jp/business/login");
assert.equal(issued.body.member.idOnly,true);
assert.equal(creates.length,1);
assert.equal(creates[0].email,alias);
assert.equal(creates[0].email_confirm,true);
assert.deepEqual(creates[0].app_metadata.apps,["business"]);
assert.equal(creates[0].app_metadata.company_login_company_id,CO_A);
assert.equal(mails.length,0,"company-number-only creation never sends email");
assert.equal(mem.rows.dx2_company_portal_members.length,1);
assert.equal(mem.rows.dx2_company_portal_members[0].company_id,CO_A);
assert.equal(mem.rows.dx2_company_portal_members[0].role,"admin");
assert.ok(logs.some(x=>x.action==="sales.portal_company_number_issued"));
assert.ok(!JSON.stringify(mem.rows).includes(issued.body.temporaryPassword),"plaintext must not enter DB");

const read=await call("GET",CO_A);
assert.equal(read.body.members.length,1);
assert.equal(read.body.members[0].idOnly,true);
assert.equal(read.body.members[0].status,"active");
assert.ok(!JSON.stringify(read.body).includes(issued.body.temporaryPassword));
const again=await call("POST",CO_A,{action:"ensure_meeting_account",confirmed:true});
assert.equal(again.statusCode,200);
assert.equal(again.body.existing,true);
assert.equal(again.body.temporaryPassword,undefined);
assert.equal(creates.length,1,"existing business accounts may not be replaced");
const noMail=await call("POST",CO_A,{action:"login_link",memberId:issued.body.member.id,confirmed:true});
assert.equal(noMail.statusCode,409);
assert.equal(noMail.body.error,"id_only_no_email");
assert.equal(mails.length,0);
const reserved1=await call("POST",CO_A,{action:"issue_account",confirmed:true,email:alias,displayName:"偽名"});
const reserved2=await call("POST",CO_A,{action:"invite",email:alias,displayName:"偽名"});
assert.equal(reserved1.body.error,"reserved_login_email");
assert.equal(reserved2.body.error,"reserved_login_email");
ctx={...ctx,tenantId:OTHER};
const cross=await call("GET",CO_A);
assert.equal(cross.statusCode,403);
console.log("PASS Sales company-ID-only provisioning, anti-duplicate, no-mail, tenant isolation and secret handling");
