// HR採用画面の回帰テスト。テストでは実在の応募者・メール送信は使用しない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const applicants = readFileSync(new URL("../hr/applicants.html",import.meta.url),"utf8");
const pdfUi = readFileSync(new URL("../js/hr-pdf-flow-ui.js",import.meta.url),"utf8");
const stageStart = applicants.indexOf("const STAGES = [");
const stageEnd = applicants.indexOf("const MD_STAGES",stageStart);
assert.ok(stageStart>0 && stageEnd>stageStart);
assert.doesNotMatch(applicants.slice(stageStart,stageEnd),/ceo_recommend|社長推薦/,"一覧の社長推薦タブは不要");
assert.match(applicants,/id="hr-notice-action"/);
assert.match(applicants,/HRApplicantList\.pdfUploadTarget\(a\)/,'NEXT は本人に紐づくPDFアップロード');
assert.match(applicants,/hr-pdf-work-modal/,'選択した応募者のPDFモーダルを表示する');
assert.match(applicants,/id="hr-notice-upload" onclick="openCandidateDocuments\('offer'\)"/,'内定通知PDF登録を主操作とする');
assert.doesNotMatch(applicants,/id="hr-notice-create" onclick="startOfferPdf\(\)"/,'自動生成を主操作として戻さない');
assert.match(applicants,/発行済：/);
assert.match(applicants,/loadPdfNotice/);
assert.match(applicants,/id="so-respondby"/);
assert.match(applicants,/前回の回答期限を過ぎています/);
assert.match(applicants,/offerMailTemplate\(url, r\.offer\)/);
assert.match(pdfUi,/data-act="generate">PDFを作成・確認</,'既存PDF自動生成画面は互換性を維持（NEXTの主操作ではない）');
assert.match(pdfUi,/作成済みPDFをアップロードする/);
assert.match(pdfUi,/発行済：/);
assert.match(pdfUi,/call\('generateOffer'/);
assert.match(pdfUi,/type==='send'/,"送信処理はPDF発行と別操作");
console.log("HR notice: PDF upload is primary; legacy generation/send remains separate; no CEO recommendation tab PASS");
