// HR / Office / KEIEI に、進めない理由と修正先を表示する回帰テスト。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
// 版は api/health.js の assetVersion（いまの共有ファイルの版）と比べる。版を上げるたびにテストを書き換えなくてよいように
const CUR_VERSION = (readFileSync(new URL("../api/health.js", import.meta.url), "utf8").match(/assetVersion: "([^"]+)"/) || [])[1];
const files = {
  hr: read("hr/ceo-review.html"),
  office: read("office/recurring.html"),
  keiei: read("keiei/index.html"),
  onboard: read("keiei/onboarding.js"),
};
for (const page of ["hr","office","keiei"]) {
  assert.ok(files[page].includes(`../css/action-feedback.css?v=${CUR_VERSION}`), page + " shared alert CSS");
  assert.ok(files[page].includes(`../js/action-feedback.js?v=${CUR_VERSION}`), page + " shared alert JS");
}
for (const [name,s] of Object.entries(files)) {
  if (name === "onboard") {
    new Script(s, {filename:"keiei/onboarding.js"});
    continue;
  }
  for (const [i,m] of [...s.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
    if (m[1].trim()) new Script(m[1], {filename:name+" inline script "+i});
  }
}
assert.ok(files.hr.includes('function hrBlocked(title,message,fieldId)'),"HR alert helper");
assert.ok(files.hr.includes('if(!when){hrBlocked("面談日時が未入力です"'), "HR requires CEO interview date");
assert.ok(files.hr.includes('hrBlocked("面談URLの形式を確認してください"'), "HR interview URL");
assert.ok(files.hr.includes('hrBlocked("次に確認することが未入力です"'), "HR hold next step");
assert.ok(files.hr.includes('hrApiBlocked(e,decideKind==="hold"'), "HR error dialog");

assert.ok(files.office.includes('function officeBlocked(title,message,field)'),"Office alert helper");
assert.ok(files.office.includes('officeBlocked("業務名が未入力です"'),"Office recurring title");
assert.ok(files.office.includes('officeBlocked("繰り返す曜日が未選択です"'),"Office weekly weekday");
assert.ok(files.office.includes('officeBlocked("実施日が未入力です"'),"Office single date");
assert.ok(files.office.includes('officeBlocked("開始日と終了日を確認してください"'),"Office date order");
assert.ok(files.office.includes('officeBlocked("Excelファイルが未選択です"'),"Office Excel file");
assert.ok(files.office.includes('officeBlocked("登録する行が選ばれていません"'),"Office import selection");
assert.ok(files.office.includes('officeApiBlocked(e,"e-title")'),"Office API failure");

assert.ok(files.onboard.includes('window.KPActionFeedback?.show({'),"KEIEI API alert");
assert.ok(files.onboard.includes('title:"案内に変更点がありません"'),"KEIEI unchanged notice");
assert.ok(files.onboard.includes('title:"テスト送信の準備が必要です"'),"KEIEI test email config");
assert.ok(files.onboard.includes('title:"メール送信の準備が必要です"'),"KEIEI sender or recipient");
assert.ok(files.onboard.includes('title="変更点がないため再発行できません。クリックすると理由を表示します"'),
  "KEIEI issue button remains clickable");
assert.ok(files.onboard.includes('title="宛先・送信設定を確認してください。クリックすると理由を表示します"'),
  "KEIEI send button remains clickable");
console.log("PASS cross-service actionable feedback: HR / Office / KEIEI");
