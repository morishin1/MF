// お知らせの一覧は短く、本文は明示的に開いたときだけ。既読は確認ボタンでのみ。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("js/notice-ui.js", root), "utf8");
const html = readFileSync(new URL("notices.html", root), "utf8");
const home = readFileSync(new URL("home.html", root), "utf8");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;",
}[c]));
const globals = { window: {}, KPLayout: { esc } };
runInNewContext(source, globals);
const ui = globals.window.NoticeUI;
assert.ok(ui, "共有描画部品が読み込まれる");

const notice = (id, props = {}) => ({
  id, title:"社内連絡" + id, body:"1行目\n2行目", category:"general",
  publish_at:"2026-10-23T08:00:00+09:00", read:false, pinned:false, ...props,
});

const ordered = ui.sort([
  notice("old",{read:true,pinned:true}),
  notice("unread"),
  notice("important",{category:"important"}),
  notice("pin",{pinned:true}),
]).map((n) => n.id);
assert.equal(Array.from(ordered).join(","),"important,pin,unread,old","未読重要を先に表示");

const items = Array.from({length:7}, (_,i)=>notice(String(i)));
const preview = ui.preview(items);
assert.equal((preview.match(/<a class="notice-item/g)||[]).length,3,"ホームの表示は最大3件");
assert.ok(preview.includes("notices.html?id="),"ホームから詳細への導線");
assert.ok(!preview.includes("1行目\n2行目"),"ホームは長文を展開しない");

const dangerous = notice('evil', {
  title:'<script>alert("x")</script>',
  body:'<img src=x onerror="bad()">',
});
const row = ui.item(dangerous,false);
const detail = ui.detail(dangerous);
assert.ok(row.includes("&lt;script&gt;"),"一覧のタイトルはHTMLエスケープ");
assert.ok(detail.includes("&lt;img"),"本文のHTMLは無効化する");
assert.ok(!detail.includes("<img"),"本文をタグとして出力しない");
assert.ok(detail.includes("確認して既読にする"),"未読の詳細には確認操作");
assert.ok(!ui.detail(notice("done",{read:true})).includes("data-ack"),"既読の詳細では再確認不要");

assert.ok(home.includes('NoticeUI.preview(notices)'),"ホームで共通の短い一覧を使う");
assert.ok(html.includes('type="search"'),"お知らせの検索");
assert.ok(html.includes('data-filter="read"'),"確認済みの絞り込み");
assert.ok(html.includes('API.markNoticeRead(current.id)'),"確認ボタンで既存の既読APIを呼ぶ");
assert.ok(html.includes('dialog.showModal()'),"詳細はモーダルで表示");

console.log("ok: notices UI preview, priority, escape, modal and read wiring");
