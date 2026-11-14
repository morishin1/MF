// HRパートナー実証版：採算式、安全な既定値、ナビの退行チェック。
// 実データや本番APIは使わない。node test/hr-partner-pilot.mjs で実行。
import assert from "node:assert/strict";
import { readFileSync,readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname,join } from "node:path";
import { contributionYen,monthlyRecoveryTargetYen } from "../lib/hr-partner-finance.js";

const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const read=path=>readFileSync(join(ROOT,path),"utf8");
const test=(description,fn)=>{fn();console.log("OK",description);};

test("粗利益：ENGER仮例80万売上・原価65万・報酬3万・追加運用費2万",()=>{
  assert.equal(contributionYen(800000,670000,30000),100000);
});
test("投資回収：初期30万・月額5万・6か月",()=>{
  assert.equal(monthlyRecoveryTargetYen(300000,50000,6),100000);
});
test("投資回収：ゼロ初期費用なら月固定費のみ",()=>{
  assert.equal(monthlyRecoveryTargetYen(0,35000,6),35000);
});
test("投資回収：整数円に切り上げ",()=>{
  assert.equal(monthlyRecoveryTargetYen(300001,50000,6),100001);
});
test("採算：赤字・ゼロ貢献利益も表現できる",()=>{
  assert.equal(contributionYen(0,500,1000),-1500);
  assert.equal(contributionYen(1000,500,500),0);
});
test("採算：不正な金額を拒否する",()=>{
  for(const args of [[-1,0,0],[NaN,0,0],[undefined,0,0],[0,0,Infinity],[1.3,0,0]]) {
    assert.throws(()=>contributionYen(...args));
  }
  assert.throws(()=>monthlyRecoveryTargetYen(1,0,0));
});
test("独立した4テーブルにRLS・権限剥奪がある",()=>{
  const s=read("db/183_hr_external_partner_pilot.sql");
  for(const table of ["gw_hr_external_partners","gw_hr_partner_work","gw_hr_partner_pilot_budget","gw_hr_partner_audit_events"]){
    assert.match(s,new RegExp("create table if not exists public\\."+table+"\\s*\\("));
    assert.match(s,new RegExp("alter table public\\."+table+" enable row level security"));
    assert.match(s,new RegExp("revoke all on public\\."+table+" from public,anon,authenticated"));
  }
  assert.match(s,/foreign key \(partner_id,tenant_id\)/);
  assert.match(s,/constraint gw_hr_partner_active_contract_guard/);
  assert.doesNotMatch(s,/\bgrant\s+(?:all|select|insert|update|delete)\b[^;]*\bto\s+authenticated\b/i);
});
test("内部APIは認証・HR管理権限・MFA・テナントで守る",()=>{
  const s=read("api/hr/partner-program.js");
  for(const text of [
    "requireUser(req, res)","gwContext(user.id)","canRecruit(ctx)","ctx.isHr",
    'aalOf(req) !== "aal2"','eq("tenant_id",ctx.tenantId)',
    "owner_approval_required","partner_contract_required",
    "if(!isOwner(ctx))return json(res,403",
    'payoutEnabled:false',
    'contributionYen(revenue, cost, fee)'
  ])assert.ok(s.includes(text),"Missing "+text);
  assert.doesNotMatch(s,/sendMail|transferMoney|createAuthUser|inviteUser/i);
});
test("HRにパートナー画面が存在し、既存ナビから遷移できる",()=>{
  const nav=read("js/hr-nav-v2.js");
  const page=read("hr/partners.html");
  assert.match(nav,/key:"partners",href:"\/hr\/partners\.html"/);
  assert.match(nav,/partnerOnly:true/);
  assert.match(page,/HRLayout\.init\(\{active:"partners",verify:true\}\)/);
  assert.match(page,/data-panel="security"/);
  assert.match(page,/data-panel="finance"/);
  assert.doesNotMatch(page,/skillsheet|スキルシート原本.{0,50}<a href/i);
});
test("面談専用の新規表はRLS有効で直接アクセスできない",()=>{
  const sql=read("db/184_hr_partner_interviews.sql");
  assert.match(sql,/create table if not exists public\.gw_hr_partner_interviews/);
  assert.match(sql,/alter table public\.gw_hr_partner_interviews enable row level security/);
  assert.match(sql,/revoke all on public\.gw_hr_partner_interviews from public,anon,authenticated/);
  assert.match(sql,/foreign key \(partner_id,tenant_id\)/);
  assert.match(sql,/gw_hr_partner_interview_completion_guard/);
  assert.match(sql,/gw_hr_partner_interview_one_open/);
});
test("面談の認証・入力・最終審査・契約ゲート",()=>{
  const s=read("api/hr/partner-interviews.js");
  const parent=read("api/hr/partner-program.js");
  for(const text of ["requireUser(req,res)","ctx.isHr",'aalOf(req)!=="aal2"',
    ".eq(\"tenant_id\",ctx.tenantId)","checkedNotes","checkedDraft","security_understood",
    "compensation_understood", "decision_details_required","interview_incomplete",
    "gw_hr_partner_interviews"])assert.ok(s.includes(text),"Missing "+text);
  assert.match(parent,/partner_interview_required/);
  assert.match(parent,/interviews\[0\]\.decision!=="recommend"/);
  assert.match(parent,/if\(!isOwner\(ctx\)\)return json\(res,403,\{error:"owner_required"/);
  assert.doesNotMatch(s,/sendMail|transferMoney|createAuthUser|inviteUser/i);
});
test("採用面談とパートナー面談を分離し資料を提供する",()=>{
  const hiring=read("hr/interviews.html");
  const interview=read("hr/partner-interviews.html");
  const guide=read("hr/partner-guide.html");
  const partner=read("hr/partners.html");
  assert.match(hiring,/id="iv-partner-link"/);
  assert.match(hiring,/ctx\.me\?\.gw\?\.isHr/);
  assert.match(interview,/STEP/);
  assert.match(interview,/data-decision="recommend"/);
  assert.match(interview,/\/hr\/partner-guide\.html/);
  assert.match(guide,/data-topic="enger"/);
  assert.match(guide,/data-topic="aimachi"/);
  assert.match(guide,/報酬|収入/);
  assert.match(partner,/面談通過・契約待ち/);
  assert.match(partner,/partner-interviews\.html\?partnerId=/);
});
test("旧キャッシュ版のHR共通ナビを参照しない",()=>{
  for(const f of readdirSync(join(ROOT,"hr")).filter(x=>x.endsWith(".html"))){
    const s=read("hr/"+f);
    if(s.includes("js/hr-nav-v2.js?")){
      assert.ok(s.includes("js/hr-nav-v2.js?v=20261114partner1"),f);
      assert.doesNotMatch(s,/js\/hr-nav-v2\.js\?v=20261114integrated1/,f);
    }
  }
});
console.log("HR external partner pilot checks passed.");
