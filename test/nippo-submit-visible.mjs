// 日報提出ボタンが、翌営業日の予定未登録／確認失敗によって「消えた」ように見える回帰を防ぐ。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "nippo.html"), "utf8");
for (const id of ["np-submit-entry", "np-submit-top", "np-submit-status", "np-submit-recheck", "np-schedule-gate",
  "submit-btn", "write-card", "np-gate-msg"]) {
  assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1, id + " must be unique");
}
assert.ok(html.indexOf('id="np-submit-top"') < html.indexOf('id="np-schedule-gate"'),
  "提出ボタンは予定ゲートより前にある");
assert.ok(html.indexOf('id="pane-mine"') < html.indexOf('id="np-submit-top"')
  && html.indexOf('id="np-submit-top"') < html.indexOf('id="pane-feed"'),
  "提出ボタンは自分の日報タブ内にあり、みんなの日報には出さない");
assert.ok(html.indexOf('id="np-submit-top"') < html.indexOf('id="write-card"'),
  "提出ボタンは日報入力欄の隠す領域の外にある");
assert.ok(html.includes('onclick="submitFromHeader(this)"'), "上部の提出ボタンは実際の提出処理につながる");
assert.ok(html.includes('aria-describedby="np-submit-status"'), "提出できない理由を読み上げられる");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
for (const [i, s] of scripts.entries()) {
  if (s[1].trim()) new Script(s[1], { filename: "nippo.html script " + i });
}
const js = scripts.at(-1)[1];
assert.ok(js.includes('el("write-card").classList.remove("hidden")'), "予定不足でも入力済み本文を隠さない");
assert.ok(!js.includes('el("write-card").classList.toggle("hidden",locked)'), "予定ゲートで本文を非表示にしない");
assert.ok(js.includes('el("np-submit-top").dataset.canSubmit=String(!locked)'), "提出可能かをボタンに反映");
assert.ok(js.includes('if(!data || !nextScheduleReady)'), "予定未登録・取得失敗時は送信しない");
assert.ok(js.includes('await submit(btn)'), "予定登録済みなら元の日報送信処理へ");
assert.ok(js.includes('el("np-submit-top").innerHTML = submitLabel'), "提出済みの日報は上部ボタンも保存に変わる");
assert.ok(js.includes('"#evening": "np-submit-entry"'), "終業通知は非表示のボタンではなく提出入口へ移動");
assert.ok(html.includes('<details class="card" id="np-schedule-gate"'), "予定登録の詳細案内は必要なときだけ開く");
assert.ok(html.includes('js/action-feedback.js?v=20261020cal1'), "共通のアラート部品を読み込む");
assert.ok(js.includes('function showSubmitBlockNotice()'), "提出ができない理由をクリック時に通知する");
assert.ok(js.includes('KPActionFeedback.show({title:"今日の成果が未入力です"'), "未入力項目も理由を提示する");
assert.ok(js.includes('actionHref:el("np-gate-calendar").getAttribute("href")'), "予定未入力ならカレンダーの登録画面へ誘導する");
console.log("PASS: member Nippo always offers submission and actionable blocked-step dialogs");
