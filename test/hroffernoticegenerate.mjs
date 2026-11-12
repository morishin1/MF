// 内定通知書PDF：架空の応募者だけで生成を検証する。本人へのメール送信や実DB更新はしない。
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { offerNoticeText, generateOfferNoticePdf } from "../lib/hr-pdf-flow-offer.js";

const applicant = {
 name: "テスト 花子", offer_type: "part_time", job_title: "広報担当",
 join_date: "2026-12-01", stage: "offer", decision: "hired",
};
const opts = {
 company: "株式会社サンプル", issuerName: "採用担当",
 contactEmail: "recruit@example.test",
 flowId: "00000000-0000-4000-8000-000000000001",
};
const body = offerNoticeText(applicant, opts);
assert.match(body, /テスト 花子 様/);
assert.match(body, /パート・アルバイト/);
assert.match(body, /2026年12月1日/);
assert.match(body, /株式会社サンプル/);
assert.match(body, /労働条件通知書/);
assert.doesNotMatch(body, /給与：|内定を承諾しました|本人専用URL=https:/);
assert.throws(() => offerNoticeText({...applicant,name:""},opts), /identity_required/);
assert.match(offerNoticeText({...applicant, offer_type:"executive_employee"},opts), /採用区分：正社員/);
for (const offer_type of [null, "", "contractor", "spot", "unknown"]) {
  assert.throws(() => offerNoticeText({...applicant, offer_type},opts), /offer_notice_type_required/, "区分未設定・対象外を正社員扱いしない");
}
const generated = await generateOfferNoticePdf(applicant, opts);
assert.equal(generated.filename, "内定通知書_第1版.pdf");
assert.equal(generated.bytes.subarray(0,5).toString(), "%PDF-");
const pdf = await PDFDocument.load(generated.bytes,{ignoreEncryption:false});
assert.ok(pdf.getPageCount()>0,"PDFには1ページ以上必要");
assert.ok(generated.bytes.length<5*1024*1024,"添付サイズ上限の範囲");
console.log("HR offer notice PDF generation: text, name, pages, max size PASS");
