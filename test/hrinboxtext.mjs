// 採用メール新着受付の画面用の道具（js/hr-inbox-text.js・js/hr-inbox-count.js）を、ブラウザなしで確かめる。
//   本文の安全なリンク化 / 通知元と本人の区別 / 候補の取り出し（取れなければ未取得）/ 重複候補 / 件数バッジ
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const w = {};
runInNewContext(read("js/hr-inbox-text.js"), { window: w, URL });
runInNewContext(read("js/hr-inbox-count.js"), { window: w });
const T = w.HrInboxText, C = w.HrInboxCount;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ---- リンク化：http(s) だけ。ほかはすべて文字のまま（エスケープ） ----
let h = T.linkify("詳細：https://www.wantedly.com/projects/1?a=1&b=2。").html;
ok(h.includes('<a href="https://www.wantedly.com/projects/1?a=1&amp;b=2"'), "https はリンクになる（& はエスケープ）");
ok(h.endsWith("</a>。"), "全角の句点はURLに含めない");
ok(h.includes('rel="noopener noreferrer nofollow"') && h.includes('target="_blank"'), "新しいタブ・参照元を渡さない");
h = T.linkify("javascript:alert(1) data:text/html,<b>x</b> vbscript:x").html;
ok(!h.includes("<a ") && h.includes("&lt;b&gt;"), "javascript:/data: はリンクにしない・タグは実行されない");
h = T.linkify('<img src=x onerror=alert(1)> https://a.example/p"onmouseover="x').html;
ok(!/<img/.test(h) && h.includes('href="https://a.example/p"') && h.includes("&quot;onmouseover"), "属性を壊すURLも安全");
h = T.linkify("(https://ex.com/a) と https://ex.com/b_(c)").html;
ok(h.includes('href="https://ex.com/a"') && h.includes('href="https://ex.com/b_(c)"'), "括弧の対応を見て末尾だけ外す");
ok(T.linkify("https://user:pw@evil.example/").links === 0, "ユーザー名入りのURLはリンクにしない");
ok(T.linkify("http://").links === 0, "ホストの無いURLはリンクにしない");
ok(T.linkify("x".repeat(10) + " https://a.example/1".repeat(60), { max: 50 }).links === 50, "リンクの数に上限");

// ---- 差出人の見分け ----
ok(T.classifyAddress("no-reply@wantedly.com").kind === "notification", "媒体の通知アドレス");
ok(T.classifyAddress("no-reply@wantedly.com").media === "Wantedly", "媒体名");
ok(T.classifyAddress("noreply@example.co.jp").kind === "notification", "no-reply は本人ではない");
ok(T.classifyAddress("taro@gmail.com").kind === "person", "フリーメールは本人の可能性");
ok(T.classifyAddress("hr@8grp.co.jp").kind === "internal", "社内は本人扱いしない");
ok(T.classifyAddress("someone@company.example").kind === "unknown", "判断できないものは未確認");

// ---- 候補の取り出し ----
let x = T.extract({ subject: "【Wantedly】架空 太郎さんから応募がありました", sender_address: "no-reply@wantedly.com",
  body_text: "氏名：架空 太郎 様\nメールアドレス：taro@example.com\n電話番号：０９０－１２３４－５６７８\n応募職種：営業" });
ok(x.name.value === "架空 太郎" && x.name.from === "本文", "本文の氏名（様を外す）");
ok(x.email.value === "taro@example.com" && x.email.from === "本文", "本文のメール");
ok(x.phone.value === "090-1234-5678", "全角の電話番号を半角に");
ok(x.jobTitle.value === "営業" && x.source.value === "Wantedly", "職種・媒体");
x = T.extract({ subject: "【Wantedly】架空 花子さんから応募がありました", sender_address: "no-reply@wantedly.com", body_text: "ログインして確認してください" });
ok(x.name.value === "架空 花子" && x.name.from === "件名", "件名から氏名");
ok(x.email.value === "" && x.email.from === null, "通知元アドレスを本人のメールにしない（未取得）");
ok(x.phone.value === "" && x.phone.from === null, "電話は未取得");
x = T.extract({ subject: "応募", sender_address: "no-reply@wantedly.com", reply_to: "hanako@example.com", body_text: "" });
ok(x.email.value === "hanako@example.com" && x.email.from === "返信先", "返信先は本人の候補");
x = T.extract({ subject: "応募", sender_address: "no-reply@wantedly.com", reply_to: "no-reply@wantedly.com", body_text: "" });
ok(x.email.value === "", "返信先も通知アドレスなら未取得");
x = T.extract({ subject: "求人を見ました", sender_address: "jiro@gmail.com", body_text: "よろしくお願いします" });
ok(x.email.value === "jiro@gmail.com" && x.email.from === "差出人", "個人の差出人は本人の候補");
x = T.extract({ subject: "x", sender_address: "a@b.example", body_text: "お名前: https://evil.example/" });
ok(x.name.value === "", "URLを氏名にしない");
x = T.extract({ body_text: "電話：12" });
ok(x.phone.value === "", "桁の足りない番号は未取得");

// ---- 重複候補 ----
const people = [{ id: "1", name: "架空 太郎", email: "x@example.com" }, { id: "2", name: "佐藤", email: "TARO@example.com" },
  { id: "3", name: "架空太郎丸", email: "" }, { id: "4", name: "別人", email: "" }];
const d = T.duplicates({ name: "架空太郎", email: "taro@example.com" }, people);
ok(d.length === 3 && d.every((y) => y.applicant.id !== "4"), "同名・同メール・似た名前を出す");
ok(d[0].strong && d.find((y) => y.applicant.id === "3").strong === false, "似た名前は弱い候補");
ok(T.duplicates({ name: "", email: "" }, people).length === 0, "空の下書きでは出さない");

// ---- 状態とボタンの説明がそろっている ----
ok(["new", "review", "linked", "ignored"].every((k) => T.STATES[k]?.help), "状態の説明");
ok(["register", "link", "review", "ignored", "new"].every((k) => T.ACTIONS.some((a) => a.key === k && a.help)), "ボタンの説明");
ok(["active", "contractor", "mugendojo", "spot", "closed"].every((k) => T.DESTINATIONS.some((a) => a.key === k)), "登録先（選考中・業務委託・無限道場・スポット・終了）");
ok(T.DESTINATIONS.find((a) => a.key === "spot").register === true, "メール詳細から別台帳のスポット人材を登録できる");

// ---- 件数バッジ：失敗を0件にしない ----
let v = C.view(null);
ok(v.label === "件数を取得できません" && !/0件/.test(v.html), "取得失敗は0件と出さない");
v = C.view({ openCount: 3, unreadCount: 2, readsReady: true });
ok(v.html.includes("新着あり") && v.html.includes("未対応 3件") && v.html.includes("未読 2件"), "新着マーク・未対応・未読");
v = C.view({ openCount: 0, unreadCount: null, readsReady: false });
ok(!v.html.includes("新着あり") && v.html.includes("未読は確認できません"), "既読表なしは確認できない");
v = C.view({ openCount: 1000, unreadCount: 5, readsReady: true, capped: true });
ok(v.html.includes("1000+件"), "上限に達したら+を付ける");
console.log(`HR新着受付の画面部品：リンク化・差出人・候補・重複・件数 ${n}ケース PASS`);
