// EIGHTグループウェア: HR/Sales共通デザインの段階導入を守る。
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const read=p=>readFileSync(join(root,p),"utf8");
const pages=["home.html","tasks.html","nippo.html","messages.html","menu.html",
  "timecard.html","career.html","mypage.html","notices.html","schedule.html"];
for(const p of pages){
  const c=read(p);
  assert(c.includes('<body class="gw-member-ui">'),p+" opts into the design");
  assert(c.includes('href="css/member-design.css?v=20261020-ui1"'),p+" loads the scoped CSS");
  assert(c.includes("Zen+Kaku+Gothic+New"),p+" uses HR/Sales font");
  assert(c.includes("Material+Symbols+Rounded"),p+" uses HR/Sales icon family");
  assert(c.indexOf("css/member-design.css")>c.indexOf("css/layout.css"),
    p+" loads scoped styles after shared layout");
  assert(c.includes("KPLayout.init("),p+" keeps existing auth/roles initialization");
}
const css=read("css/member-design.css");
assert(css.includes("body.gw-member-ui {"),"all design overrides scoped to opted-in pages");
assert(css.includes("font-family: 'Zen Kaku Gothic New'"),"HR/Sales typography token");
assert(css.includes("font-family: 'Material Symbols Rounded'"),"icon glyph family");
assert(css.includes("width: 1em")&&css.includes("overflow: hidden"),"icon names cannot stretch the header");
assert(css.includes("margin-left: 216px"),"desktop employee menu offset");
assert(css.includes("margin-left: 0"),"mobile employee menu offset");
assert(css.includes(".kp-tabbar"),"mobile bottom navigation has shared design");
const layout=read("js/layout.js");
assert(layout.includes("const MEMBER_SIDE_NAV = ["),"member menu stays defined in original layout");
assert(layout.includes("const MEMBER_NAV = ["),"mobile navigation stays defined in original layout");
const sales=read("sales/index.html"),hr=read("hr/index.html");
assert(sales.includes("Zen+Kaku+Gothic+New")&&hr.includes("Zen+Kaku+Gothic+New"),
  "design reference is the existing HR/Sales UI");
console.log("10画面の統一・アイコン・ナビゲーション・モバイル配置の静的テスト通過");
