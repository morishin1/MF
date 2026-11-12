// 旧内定（採用区分未設定）でも、既存の送付証跡を変えずにPDF本文を生成する。
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { offerTitleOf, noticeTitleOf, offerBody, buildOfferPdf } from "../lib/hr-offer-docs.js";

const old = {
 id: "00000000-0000-4000-8000-000000000002",
 version: 2, offer_type: null, employment_type: null,
 job_title: "無限道場講師", respond_by: "2026-11-19",
 join_date: null, formal_contract_required: false,
};
assert.equal(offerTitleOf(old),"内定通知書");
assert.equal(noticeTitleOf(old),null,"労働条件通知書を勝手に確定しない");
const text = offerBody(old,{candidateName:"テスト応募者",company:"株式会社サンプル"});
assert.match(text,/テスト応募者 様/);
assert.match(text,/内定をご案内/);
assert.match(text,/詳細な採用条件は、別途交付する労働条件通知書/);
assert.doesNotMatch(text,/別紙の「条件通知書」/,"存在しない添付PDFを案内しない");
assert.doesNotMatch(text,/正社員として採用/,"区分未設定を正社員扱いにしない");
const contractor={...old,employment_type:"業務委託"};
assert.equal(offerTitleOf(contractor),"参画決定通知書");
assert.match(offerBody(contractor,{candidateName:"テスト応募者",company:"株式会社サンプル"}),/ご参画をお願いしたく/);

const generated=await buildOfferPdf(old,{candidateName:"テスト応募者",company:"株式会社サンプル"});
assert.equal(generated.title,"内定通知書");
assert.equal(Buffer.from(generated.bytes).subarray(0,5).toString(),"%PDF-");
assert.ok((await PDFDocument.load(generated.bytes)).getPageCount()>0);
console.log("HR legacy offer PDF: no employment type, honest wording, valid pages PASS");
