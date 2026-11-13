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
assert.match(applicants,/内定通知書PDFを作成・確認/);
assert.match(applicants,/発行済：/);
assert.match(applicants,/loadPdfNotice/);
assert.match(applicants,/id="so-respondby"/);
assert.match(applicants,/response_deadline_expired|前回の回答期限を過ぎています/);
assert.match(applicants,/offerMailTemplate\(url, r\.offer\)/);
assert.match(pdfUi,/data-act="generate"/);
assert.match(pdfUi,/内定通知書を自動発行/);
assert.match(pdfUi,/発行済：/);
assert.match(pdfUi,/call\('generateOffer'/);
assert.match(pdfUi,/type==='send'/,"送信処理はPDF発行と別操作");
console.log("HR offer notice UI: actions, issued timestamp, no CEO recommendation tab PASS");
