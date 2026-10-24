// 採用メール一括整理・スポット登録：個人情報を含まないモックDB。
import assert from "node:assert/strict";
import {mock} from "node:test";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {createMemDb} from "./_memdb.mjs";
const ROOT=dirname(dirname(fileURLToPath(import.meta.url))),at=p=>join(ROOT,p);
const read=p=>readFileSync(at(p),"utf8");
const sql=read("db/148_hr_inbox_bulk_spot.sql");
for(const fragment of ["gw_hr_inbox_bulk_apply","num_nonnulls(applicant_id,spot_talent_id)=1",
  "for update","raise exception 'stale_record'","service_role","deleted_at","spot_talent_id"])
 assert.ok(sql.includes(fragment),fragment);
assert.match(sql,/revoke all on function public.gw_hr_inbox_bulk_apply/);
const page=read("hr/inbox.html");
const inline=page.split("<script>").pop().split("</script>")[0];new Script(inline);
for(const marker of ["data-select-mail","bulkBar","bulkModal","bulkReason","data-bulk=",
 "spotFields","spotWorkedOn","spotSource","registerSpot","linkSpot"])
 assert.ok(page.includes(marker),marker);
const mem=createMemDb({schema:{
 gw_hr_inbound_mail:{unique:[["tenant_id","provider","provider_message_id"]],
  defaults:()=>({status:"new",applicant_id:null,spot_talent_id:null,deleted_at:null,
   created_at:"2026-10-25T00:00:00.000Z",updated_at:"2026-10-25T00:00:00.000Z"}),
  check:r=>((r.status==="linked")!==([r.applicant_id,r.spot_talent_id].filter(Boolean).length===1))?"link_guard":null},
 gw_hr_spot_talents:{defaults:()=>({deleted_at:null,applicant_id:null})},
 gw_hr_applicants:{defaults:()=>({status:"todo",stage:"applied"})},
 gw_hr_inbound_mail_reads:{unique:[["mail_id","user_id"]],noId:true},
 gw_hr_timeline:{},gw_employees:{}
}});
const db=mem.admin();
const tenant="11111111-1111-4111-8111-111111111111",userId="12345678-1234-4234-8234-000000000003";
const mailId=(n)=>"12345678-1234-4234-8234-0000000000"+String(n).padStart(2,"0");
db.rpc=async(name,args)=>{
 if(name!=="gw_hr_inbox_bulk_apply")return{data:null,error:{code:"42883",message:"RPC not found"}};
 const {p_tenant,p_items,p_action,p_reason,p_actor}=args;
 if(p_tenant!==tenant||p_actor!==userId||!Array.isArray(p_items)||p_items.length>50)
   return{data:null,error:{code:"42501",message:"invalid_bulk_request"}};
 const current=await db.from("gw_hr_inbound_mail").select("*").eq("tenant_id",tenant);
 const ids=new Set();let toUpdate=[];
 for(const item of p_items){
  if(ids.has(item.id))return{data:null,error:{code:"23514",message:"duplicate"}};
  ids.add(item.id);
  const row=current.data.find(r=>r.id===item.id);
  if(!row||row.updated_at!==item.updatedAt||row.status==="linked"||
   (p_action==="restore"?!row.deleted_at:!!row.deleted_at))
    return{data:null,error:{code:"P0001",message:"stale_record"}};
  toUpdate.push(row);
 }
 for(const row of toUpdate){
  const next={review_note:p_reason||row.review_note,reviewed_by:userId,reviewed_at:new Date().toISOString(),
   updated_at:new Date().toISOString()};
  if(p_action==="restore"){next.deleted_at=null;next.status="ignored";}
  else if(p_action==="archive"){next.deleted_at=new Date().toISOString();next.status="ignored";}
  else next.status=p_action;
  const out=await db.from("gw_hr_inbound_mail").update(next).eq("id",row.id);
  if(out.error)throw Error(JSON.stringify(out.error));
 }
 return{data:toUpdate.length,error:null};
};
let role="recruiter",whoTenant=tenant;
const audit=[];
mock.module(at("lib/supabase.js"),{namedExports:{admin:()=>db,userClient:()=>db}});
mock.module(at("lib/auth.js"),{namedExports:{requireUser:async()=>({id:userId}),getMemberships:async()=>[]}});
mock.module(at("lib/gw.js"),{namedExports:{gwContext:async()=>({tenantId:whoTenant,roles:[role],employee:{id:"e1"}}),
 canRecruit:c=>c.roles.includes("recruiter"),canSeeSalary:()=>false}});
mock.module(at("lib/gw-audit.js"),{namedExports:{gwLog:async x=>audit.push(x)}});
mock.module(at("lib/notify.js"),{namedExports:{notify:async()=>({created:0})}});
const {default:handler}=await import(at("api/hr/inbox.js"));
const res=()=>({statusCode:0,body:null,setHeader(){},end(t){this.body=JSON.parse(t);}});
async function act(body={},method="POST",url="/api/hr/inbox"){
 const r=res();await handler({body,method,url},r);return r;
}
const add=async(n,name)=>{
 const id=mailId(n);
 await db.from("gw_hr_inbound_mail").insert({id,tenant_id:tenant,provider:"manual",provider_message_id:"m"+n,
  recipient:"saiyou@8grp.co.jp",received_at:"2026-10-25T00:00:00Z",subject:"架空のメール"+n,
  sender_address:"notice@example.test",candidate_name_guess:name});
 return id;
};
const one=await add(1,"架空 A"),two=await add(2,"架空 B"),three=await add(3,"架空 C");
const row=async id=>(await db.from("gw_hr_inbound_mail").select("*").eq("id",id).maybeSingle()).data;
let r=await act({action:"bulk",bulkAction:"archive",
 items:[{id:one,updatedAt:(await row(one)).updated_at},{id:two,updatedAt:(await row(two)).updated_at}],
 reason:"営業・広告",note:"合成データ"});
assert.equal(r.statusCode,200,JSON.stringify(r.body));
assert.equal(r.body.changed,2);
assert.ok((await row(one)).deleted_at);
r=await act({},"GET","/api/hr/inbox?count=1");
assert.equal(r.body.openCount,1,"アーカイブした2件は未対応件数から除く");
r=await act({action:"bulk",bulkAction:"restore",
 items:[{id:one,updatedAt:(await row(one)).updated_at},{id:two,updatedAt:(await row(two)).updated_at}]});
assert.equal(r.statusCode,200,JSON.stringify(r.body));
assert.equal((await row(one)).deleted_at,null);
assert.equal((await row(one)).status,"ignored","復元しても新着とは扱わない");
r=await act({action:"bulk",bulkAction:"ignored",
 items:[{id:three,updatedAt:(await row(three)).updated_at}],reason:""});
assert.equal(r.statusCode,400,"理由なし対象外は拒否");
r=await act({action:"bulk",bulkAction:"ignored",
 items:[{id:three,updatedAt:(await row(three)).updated_at}],reason:"配信エラー"});
assert.equal(r.statusCode,200);
assert.equal((await row(three)).review_note,"配信エラー");
const four=await add(4,"架空スポット");
let curr=await row(four);
r=await act({action:"registerSpot",id:four,expectUpdatedAt:curr.updated_at,
 spot:{name:"架空スポット",source:"タイミー",workedOn:"2026-10-28",workNote:"現地で案内"}});
assert.equal(r.statusCode,200,JSON.stringify(r.body));
const spotId=r.body.spotId;
assert.equal((await row(four)).status,"linked");
assert.equal((await row(four)).spot_talent_id,spotId);
assert.equal((await row(four)).applicant_id,null);
assert.equal((await db.from("gw_hr_spot_talents").select("*").eq("tenant_id",tenant)).data.length,1);
r=await act({action:"registerSpot",id:four,expectUpdatedAt:curr.updated_at,
 spot:{name:"架空スポット",source:"タイミー",workedOn:"2026-10-28"}});
assert.equal(r.statusCode,409,"登録済みメールでの二重作成を拒否");
const five=await add(5,"架空スポット");
curr=await row(five);
r=await act({action:"registerSpot",id:five,expectUpdatedAt:curr.updated_at,
 spot:{name:"架空スポット",source:"タイミー",workedOn:"2026-10-28"}});
assert.equal(r.statusCode,409);
assert.equal(r.body.error,"existing_spot");
assert.equal(r.body.spotId,spotId);
r=await act({action:"linkSpot",id:five,spotId});
assert.equal(r.statusCode,200);
assert.equal((await row(five)).spot_talent_id,spotId);
r=await act({action:"bulk",bulkAction:"archive",
 items:[{id:five,updatedAt:(await row(five)).updated_at}],reason:"応募対象外"});
assert.equal(r.statusCode,409,"スポット登録済みメールは削除させない");
whoTenant="22222222-2222-4222-8222-222222222222";
r=await act({action:"linkSpot",id:two,spotId});
assert.equal(r.statusCode,404,"他テナントでメールは開けない");
whoTenant=tenant;role="sales";
r=await act({action:"bulk",bulkAction:"archive",items:[{id:one,updatedAt:(await row(one)).updated_at}],reason:"その他"});
assert.equal(r.statusCode,403,"採用権限なしの一括操作は拒否");
assert.equal((await db.from("gw_hr_inbound_mail").select("*").eq("tenant_id",tenant)).data.length,5,"物理削除は一切しない");
console.log("HR新着の一括編集/復元可能削除/スポット登録・重複/権限テスト PASS");
