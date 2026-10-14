// Office の見た目が、採用HR・Sales の「実際の値」とずれていないかを、CSS の文字どおりに照らし合わせる。
//
// ■ なぜ要るのか
//   PR #75 で「Sales・HR に合わせる」を、GW の共通の色（#e2e8f0・青・22px）で似せただけで出してしまった。
//   見比べないと気づかないので、HR・Sales の CSS（js/hr-layout.js・js/sales-layout.js・hr/index.html）から
//   値を読み、Office 側（css/layout.css・js/office-layout.js）が同じ値かを機械で見る。
//   HR・Sales の値を変えたら、ここで Office との違いが出る（片方だけ変わって、またずれるのを防ぐ）。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let bad = 0;
const ok = (name, fn) => {
  try { fn(); console.log(`  ok ${name}`); } catch (e) { bad++; console.log(`NG ${name}\n   ${e.message.split("\n").join("\n   ")}`); }
};

/** CSS の中から、セレクタ（文字どおり）の宣言を { 名前: 値 } で取る */
function rule(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const m = src.match(new RegExp(`(?:^|[}\\s,])${esc}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(m, `${selector} が見つからない`);
  return Object.fromEntries(m[1].split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(":");
    return [d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, " ")];
  }));
}
// js/office-layout.js の色の名前（var(--of-…)）を、値に戻す
const OL = read("js/office-layout.js");
const TOKENS = rule(OL, "body.of-app");
const resolve = (v) => v.replace(/var\((--of-[a-z0-9]+)\)/g, (_, k) => TOKENS[k] || _);
const pick = (r, keys) => Object.fromEntries(keys.map((k) => [k, r[k] === undefined ? undefined : resolve(r[k])]));
const same = (office, ref, keys, label) => {
  const a = pick(office, keys), b = pick(ref, keys);
  assert.deepEqual(a, b, `${label}\n   Office: ${JSON.stringify(a)}\n   基準:   ${JSON.stringify(b)}`);
};

const HR = read("js/hr-layout.js");
const SL = read("js/sales-layout.js");
const HRI = read("hr/index.html");
const SLI = read("sales/index.html");
const LAY = read("css/layout.css");

console.log("— ヘッダー・タブ（採用HR の .hr-bar / .hr-nav、Sales の .sl-tabs-pill）—");
ok("背景は採用HR・Sales と同じ（body.hr-app・body.sl-app）", () => {
  same(rule(LAY, "body.kp-has-officenav"), rule(HR, "body.hr-app"), ["background"], "Office の背景");
  same(rule(LAY, "body.kp-has-officenav"), rule(SL, "body.sl-app"), ["background"], "Office の背景（Sales）");
});
ok("ヘッダーの帯：白・下線 1px #e2e2dc・左右20px（.hr-bar）", () => {
  const o = rule(LAY, "body.kp-has-officenav .topbar"), h = rule(HR, ".hr-bar");
  same(o, h, ["background", "border-bottom"], "ヘッダー");
  assert.equal(o.padding, h.padding, "ヘッダーの左右の余白");
  assert.equal(o["min-height"], h.height, "ヘッダーの高さ（56px）");
});
ok("カテゴリのタブは .hr-nav a と同じ（13px・500・#4a5068・下線3px・左右12px）", () => {
  same(rule(LAY, ".kp-otab"), rule(HR, ".hr-nav a"), ["padding", "color", "font-size", "font-weight", "border-bottom", "gap"], "カテゴリのタブ");
  same(rule(LAY, ".kp-otab.on"), rule(HR, ".hr-nav a.on"), ["color", "font-weight", "border-bottom-color"], "選んでいるカテゴリ");
});
ok("画面のタブは Sales の .sl-tabs-pill と同じ（丸いタブ・選択中は #1b2440）", () => {
  same(rule(LAY, ".kp-ostab"), rule(SL, ".sl-tabs-pill button"), ["border", "background", "border-radius", "padding", "font-size", "font-weight", "color"], "画面のタブ");
  same(rule(LAY, ".kp-ostab.on"), rule(SL, ".sl-tabs-pill button.on"), ["background", "border-color", "color", "font-weight"], "選んでいる画面のタブ");
});
ok("見出しの右の主ボタン（メンバー追加など）は .hr-add と同じ", () => {
  same(rule(LAY, "body.kp-has-officenav .kp-add"), rule(HR, ".hr-add"), ["background", "color", "border-radius", "padding", "font-size", "font-weight"], "主ボタン");
});

console.log("\n— 本文（幅・見出し・カード・表）—");
ok("本文の幅と余白は .hr-wrap・.sl-wrap と同じ（1200px・24px 16px 60px）", () => {
  same(rule(LAY, "body.kp-has-officenav .wrap"), rule(HR, ".hr-wrap"), ["max-width", "padding"], "本文の幅");
  same(rule(SL, ".sl-wrap"), rule(HR, ".hr-wrap"), ["max-width", "padding"], "（HR と Sales も同じ）");
});
ok("見出しは h1.hr-title と同じ（24px・700・#1b2440）", () => {
  same(rule(LAY, "body.kp-has-officenav .kp-greet"), rule(HRI, "h1.hr-title"), ["font-size", "font-weight", "color", "margin"], "管理画面の見出し");
  same(rule(OL, "h1.of-title"), rule(HRI, "h1.hr-title"), ["font-size", "font-weight", "color", "margin"], "/office/ の見出し");
  same(rule(OL, ".of-sub"), rule(SL, ".sl-sub"), ["color", "font-size", "margin"], "見出しの下の説明");
  same(rule(OL, ".of-sec-h"), rule(HRI, ".hr-sec-h"), ["font-size", "font-weight", "color", "margin"], "区切りの見出し");
});
ok("「今日やること」は .hr-today-row（Sales の .sl-row）と同じカード", () => {
  const keys = ["background", "border", "border-left", "border-radius", "padding", "display", "align-items", "gap"];
  same(rule(OL, ".of-row"), rule(HRI, ".hr-today-row"), keys, "今日やることの1件");
  same(rule(OL, ".of-row.overdue"), rule(HRI, ".hr-today-row.overdue"), ["border-left-color"], "期限超過の左端");
  same(rule(OL, ".of-row.hot"), rule(SL, ".sl-row.hot"), ["border-left-color"], "急ぎの左端");
  same(rule(OL, ".of-rows"), rule(HRI, ".hr-today"), ["display", "gap"], "並べ方（間隔8px）");
  same(rule(OL, ".of-row .now"), rule(HRI, ".hr-today-row .now"), ["color", "font-size", "margin-top"], "今の状態の行");
  same(rule(OL, ".of-row .n"), rule(HRI, ".hr-today-row .n"), ["color", "font-size", "margin-top", "font-weight"], "次の行");
});
ok("件数のカードは Sales ダッシュボードの .db-sum a と同じ", () => {
  same(rule(OL, ".of-tile"), rule(SLI, ".db-sum a"), ["background", "border", "border-radius", "padding"], "件数のカード");
  same(rule(OL, ".of-tile .lb"), rule(SLI, ".db-sum .lb"), ["font-size", "color", "font-weight"], "件数のカードのラベル");
  same(rule(OL, ".of-tile .val"), rule(SLI, ".db-sum .v"), ["font-size", "font-weight", "color"], "件数のカードの数字");
});
ok("表は Sales の .sl-table と同じ", () => {
  same(rule(OL, ".of-table"), rule(SL, ".sl-table"), ["background", "border", "border-radius"], "表");
  same(rule(OL, ".of-table th"), rule(SL, ".sl-table th"), ["font-size", "color", "font-weight", "padding", "background", "border-bottom"], "表の見出し");
  same(rule(OL, ".of-table td"), rule(SL, ".sl-table td"), ["padding", "border-bottom", "font-size"], "表のセル");
});
ok("絞り込み（件数つき）は Sales の .sl-tabs-pill と同じ", () => {
  same(rule(OL, ".of-chip"), rule(SL, ".sl-tabs-pill button"), ["background", "border-radius", "padding", "font-size", "font-weight", "color"], "絞り込み");
  same(rule(OL, ".of-chip.on"), rule(SL, ".sl-tabs-pill button.on"), ["background", "border-color", "color", "font-weight"], "選んでいる絞り込み");
});

console.log("\n— 字（Zen Kaku Gothic New・Material Symbols Rounded）—");
ok("Office の画面は、採用HR・Sales と同じ字を読み、同じ指定をしている", () => {
  const hrLinks = HRI.match(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/g);
  const pages = [
    ...readdirSync(join(ROOT, "office")).filter((f) => f.endsWith(".html")).map((f) => `office/${f}`),
    ..."autonomy career closing contracts docs esign expenses growth hr members month-start notices onboard probation requests site-news timecard"
      .split(" ").map((k) => `admin-${k}.html`),
  ];
  const miss = pages.filter((p) => {
    const s = read(p);
    return !hrLinks.every((l) => s.includes(l))
      || !s.includes("body { font-family:'Zen Kaku Gothic New', sans-serif; } .material-symbols-outlined { font-family:'Material Symbols Rounded'; }");
  });
  assert.equal(miss.length, 0, `採用HRと同じ字になっていない：${miss.join(", ")}`);
});

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
