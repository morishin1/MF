import assert from "node:assert/strict";
import { MEMBER_DOC_TYPES, forbiddenMemberFilename, requiredDocuments, summarizeMemberDocuments } from "../lib/member-documents.js";

const person=(employment_type,employee_kind="proper")=>({
  id:"e1",display_name:"試験メンバー",status:"active",employment_type,employee_kind,
});
const item=(key,status="todo")=>({id:key,item_key:key,title:key,category:"document",required:true,status});
const stored=(kind,opt={})=>({
  id:kind,kind,source:opt.source||"manual",storagePath:opt.path===false?null:kind+".pdf",
  createdAt:"2026-11-01T00:00:00Z",verified:Boolean(opt.verified),signed:Boolean(opt.signed),
  status:opt.status||"登録済",
});
function test(name,fn){fn();console.log("✓ "+name);}
test("正社員は入社既定の契約・履歴書・扶養書類3つ（マイナンバーは集計対象外）",()=>{
  const a=requiredDocuments(person("正社員"),[],[]);
  assert.equal(a.configured,true);
  assert.deepEqual(a.items.map(x=>x.key),["doc_resume","doc_dependents","doc_contract"]);
});
test("業務委託は雇用者向け税務書類を必須にしない",()=>{
  const a=requiredDocuments(person("業務委託"));
  assert.deepEqual(a.items.map(x=>x.key),["doc_contract_gyomu"]);
});
test("雇用区分不明は0/0完備と誤表示しない",()=>{
  const a=summarizeMemberDocuments(person(null));
  assert.equal(a.requiredConfigured,false);
  assert.equal(a.documentStatus,"必要書類の基準未設定");
});
test("チェックリストで対象外の項目は不足にしない",()=>{
  const a=requiredDocuments(person("正社員"),[item("doc_contract"),item("doc_resume","na"),item("doc_mynumber")]);
  assert.deepEqual(a.items.map(x=>x.key),["doc_contract"]);
});
test("アップロードだけでは契約締結済みにならない",()=>{
  const a=summarizeMemberDocuments(person("契約社員"),[],[]);
  const b=summarizeMemberDocuments(person("契約社員"),[stored("employment_contract",{verified:true})]);
  assert.equal(a.contractStatus,"契約書未確認");
  assert.equal(b.contractStatus,"契約書あり・署名未確認");
  assert.equal(b.completeCount,0);
  assert.equal(b.reviewCount,1);
});
test("証跡がある署名済PDFだけ締結済み",()=>{
  const a=summarizeMemberDocuments(person("契約社員"),[stored("employment_contract",{signed:true,source:"sign"})]);
  assert.equal(a.contractStatus,"締結済");
  assert.equal(a.completeCount,1);
});
test("提出記録だけでファイルがない状態は不足とは区別",()=>{
  const a=requiredDocuments(person("正社員"),[item("doc_resume","done")],[]);
  assert.equal(a.items[0].state,"record_only");
});
test("未確認のPDFは受領済み・確認待ちとしてカウント",()=>{
  const a=summarizeMemberDocuments(person("正社員"),[stored("resume")],[]);
  assert.equal(a.receivedCount,1);
  assert.equal(a.reviewCount,1);
  assert.equal(a.missingCount,2);
});
test("社員の在籍ステータスは書類の状態と独立",()=>{
  const a=summarizeMemberDocuments({...person("正社員"),status:"leaving"});
  assert.equal(a.employmentStatus,"退職手続き中");
});
test("ファイル名でマイナンバーを受け取らない",()=>{
  assert.equal(forbiddenMemberFilename("マイナンバー.pdf"),true);
  assert.equal(forbiddenMemberFilename("職務経歴書.pdf"),false);
});
assert.ok(MEMBER_DOC_TYPES.some(x=>x.key==="labor_notice"));
console.log("member-document rules: all tests passed");
