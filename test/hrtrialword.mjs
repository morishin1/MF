// Synthetic-only checks for the trial-period Word notice. Never writes candidate data or sends mail.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import * as W from "../lib/hr-trial-word.js";
import {attachmentProblem} from "../lib/mail/index.js";
import {createHandler} from "../api/hr/trial-notice.js";
const values=Object.fromEntries(W.FIELDS.map(([key,label])=>[key,label+"：合意確認済みのテスト条件"]));
assert.equal(W.FIELDS.length,19);
assert.deepEqual(W.previewRows({}).map(x=>x.value),Array(19).fill(""));
assert.throws(()=>W.validateNotice({unknown:"x"}),/unknown_notice_field/);
assert.throws(()=>W.validateNotice({startDate:""} ,{complete:true}),/required_startDate/);
assert.throws(()=>W.validateNotice({pay:"A".repeat(1601)}),/invalid_pay/);
const doc=W.createTrialDocx({applicantName:"合成テスト応募者",companyName:"テスト株式会社",
  issuedOn:"2026-11-13",values});
assert.match(doc.filename,/トライアル労働条件通知書/);
assert.equal(doc.sha256.length,64);
assert.equal(doc.bytes.readUInt32LE(0),0x04034b50);
assert.ok(doc.bytes.length>2000&&doc.bytes.length<5*1024*1024);
// Parse ZIP local store entries, check the Word document and required OOXML components.
const zipEntries=new Map();let off=0;
while(off<doc.bytes.length&&doc.bytes.readUInt32LE(off)===0x04034b50){
 const method=doc.bytes.readUInt16LE(off+8),len=doc.bytes.readUInt32LE(off+18);
 const nameLen=doc.bytes.readUInt16LE(off+26),extra=doc.bytes.readUInt16LE(off+28);
 const name=doc.bytes.subarray(off+30,off+30+nameLen).toString("utf8");
 assert.equal(method,0,"No hidden compressor dependency");
 const begin=off+30+nameLen+extra;zipEntries.set(name,doc.bytes.subarray(begin,begin+len));
 off=begin+len;
}
assert.ok(zipEntries.has("[Content_Types].xml"));
assert.ok(zipEntries.has("_rels/.rels"));
assert.ok(zipEntries.has("word/document.xml"));
assert.equal(doc.bytes.readUInt32LE(off),0x02014b50,"ZIP central directory follows contents");
const xml=zipEntries.get("word/document.xml").toString("utf8");
assert.match(xml,/<w:document/);assert.match(xml,/労働条件通知書/);
assert.equal((xml.match(/<w:tr>/g)||[]).length,19);
assert.ok(W.FIELDS.every(([,label])=>xml.includes(label.replace(/&/g,"&amp;"))));
assert.ok(!xml.includes("署名対応がなされない場合は"));
assert.ok(!xml.includes("異議申し立ては原則受け付けない"));
assert.ok(xml.includes("合成テスト応募者")&&xml.includes("テスト株式会社"));
assert.equal(W.createTrialDocx({applicantName:"合成テスト応募者",companyName:"テスト株式会社",issuedOn:"2026-11-13",values}).sha256,doc.sha256,"bytes deterministic for a version");
assert.throws(()=>W.createTrialDocx({applicantName:"A",companyName:"B",issuedOn:"2026-11-13",values:{}}),/required_startDate/);
const dtypes="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const att=[{filename:"conditions.docx",content:doc.bytes,contentType:dtypes}];
assert.equal(attachmentProblem(att,"recruiting"),null);
assert.ok(attachmentProblem(att,"portal"),"DOCX rejected outside recruiting");
assert.ok(attachmentProblem([{...att[0],filename:"conditions.exe"}],"recruiting"));
const html=readFileSync(new URL("../hr/trial-notice.html",import.meta.url),"utf8");
assert.ok(html.includes("trial-save")&&html.includes("trial-export")&&html.includes("trial-prepare-send"));
assert.ok(html.includes("professionalReviewed:true")&&html.includes("confirmDigest:confirmData.digest"));
assert.ok(html.includes("Wordの作成と送信は別操作"));
assert.ok(html.includes('API.api("/api/hr/trial-notice"'));
const old=process.env.HR_TRIAL_NOTICE_ENABLED;
try{
 process.env.HR_TRIAL_NOTICE_ENABLED="0";
 let called=0,body="";
 const h=createHandler({
   requireUser:async()=>({id:"99999999-9999-4999-8999-999999999999"}),
   gwContext:async()=>({tenantId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",isAdmin:true,roles:["owner"],apps:["hr"]}),
   admin:()=>{called++;throw Error("should not call DB when disabled");}
 });
 const res={setHeader(){},end(x){body=x;},statusCode:200};
 await h({method:"GET",url:"/?applicantId=11111111-1111-4111-8111-111111111111",headers:{}},res);
 assert.equal(called,0);assert.match(String(body),/"enabled":false/);
}finally{if(old===undefined)delete process.env.HR_TRIAL_NOTICE_ENABLED;else process.env.HR_TRIAL_NOTICE_ENABLED=old;}
console.log("HR trial DOCX shape, deterministic ZIP, editable completeness, MIME protection and disabled-mode authorization PASS");
