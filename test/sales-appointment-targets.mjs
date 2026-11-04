import assert from "node:assert/strict";
import {selectAppointmentTargets} from "../lib/sales-appointment-targets.js";
const make=(n,patch={})=>({
  id:`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`,
  name:`株式会社テスト${n}`,status:"untouched",hidden_at:null,ng_reason:null,
  phone:"",site_url:"https://example.test",form_url:null,domain:null,
  click_count:0,last_click_at:null,followed_at:null,last_sent_at:null,
  next_action_on:null,owner_id:null,...patch
});
const now=new Date("2026-11-04T04:00:00.000Z");
const rows=[
  make(1,{status:"replied"}),
  make(2,{status:"clicked",click_count:1,last_click_at:"2026-11-03T03:00:00Z"}),
  make(3,{status:"attacked",last_sent_at:"2026-10-29T03:00:00Z"}),
  make(4,{status:"untouched",phone:"03-0000-0000"}),
  make(5,{status:"replied",ng_reason:"unsubscribed"}),
  make(6,{status:"clicked",hidden_at:"2026-11-02T00:00:00Z"}),
  make(7,{status:"replied"}),
  make(8,{status:"replied"}),
  make(9,{status:"replied"}),
  make(10,{status:"replied"}),
  make(11,{status:"attacked",next_action_on:"2026-11-01",last_sent_at:"2026-11-02T02:00:00Z"}),
  make(12,{status:"clicked",click_count:10,last_click_at:"2026-10-28T00:00:00Z",followed_at:"2026-11-01T00:00:00Z"}),
  make(13,{status:"untouched",site_url:null}),
  make(14,{status:"replied",enger_company_id:"11111111-1111-4111-8111-111111111111"}),
  make(15,{status:"attacked",last_sent_at:null}),
  make(16,{status:"untouched"}),
];
const stops=[
  {name_normalized:"株式会社テスト8",matched_company_id:null},
  {name_normalized:"一致しない",matched_company_id:"11111111-1111-4111-8111-111111111111"}
];
const proposals=[
  {company_id:rows[8].id,contact_stop:true,status:"call_wait"},
  {company_id:rows[9].id,contact_stop:false,status:"stopped"},
  {company_id:rows[12].id,contact_stop:false,status:"meeting_adjust",sent_at:"2026-11-02T01:00:00Z"},
];
const meetings=[{company_id:rows[6].id,status:"scheduled"}];
const result=selectAppointmentTargets({companies:rows,proposals,meetings,legacyStops:stops,now,limit:50});
assert.equal(result.rows.some(r=>r.companyId===rows[4].id),false,"NG excluded");
assert.equal(result.rows.some(r=>r.companyId===rows[5].id),false,"hidden excluded");
assert.equal(result.rows.some(r=>r.companyId===rows[6].id),false,"scheduled meeting excluded");
assert.equal(result.rows.some(r=>r.companyId===rows[7].id),false,"legacy name stop excluded");
assert.equal(result.rows.some(r=>r.companyId===rows[8].id),false,"proposal contact stop excluded");
assert.equal(result.rows.some(r=>r.companyId===rows[13].id),false,"legacy linked ID stop excluded");
assert.equal(result.rows[0].companyId,rows[0].id,"replied first");
assert.equal(result.rows[1].companyId,rows[1].id,"clicked second");
assert.equal(result.rows.some(r=>r.companyId===rows[10].id&&r.category==="期限到来"),true);
assert.equal(result.rows.some(r=>r.companyId===rows[2].id&&r.category==="追客"),true);
assert.equal(result.rows.some(r=>r.companyId===rows[12].id),false,"no website and no response excluded");
assert.equal(result.rows.some(r=>r.companyId===rows[11].id),false,"followed click is not a fresh reaction");
assert.equal(result.rows.some(r=>r.companyId===rows[3].id&&r.category==="新規調査"),true);
assert.equal(result.rows.some(r=>r.companyId===rows[15].id),true);
assert.equal(result.rows.some(r=>r.companyId===rows[9].id),false,"stopped proposal excluded");
const short=selectAppointmentTargets({companies:rows,proposals,meetings,legacyStops:stops,now,limit:1});
assert.equal(short.rows.length,1);
assert.equal(short.total,result.total);
assert.equal(short.rows[0].category,"反応あり");
assert.match(result.note,/アポイント取得確率ではなく/);
console.log("PASS sales appointment shortlist (19 conditions)");
