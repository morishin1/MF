// js/layout.js と js/layout-marketing.js が、役割ごとの入口判定で食い違わないか。
//
// ■ 何を守るテストか
//   2つは同じ共通ヘッダー・権限確認の複製で、画面ごとにどちらかを読む（ホーム・Office ホーム・月次業務などは
//   layout-marketing.js）。片方だけ直すと、同じ人が画面によって入れたり送り返されたりする。
//   2026-10-29：税理士（tax_advisor）の扱いが layout.js にしか無く、layout-marketing.js の画面（Office ホーム・ホーム）を
//   開くと home.html へ送られ、ホームも税理士を受け付けないので home.html を読み直し続けていた。
//
//   ・送り返し先（homeFor）・画面に入れるか（hasAccess）・ヘッダーとメニューに出すもの（showsFor）・
//     ヘッダーの Office の行き先（toolHref）が、マーケティング以外で一致する
//   ・税理士・社労士は専門家タスク（と社労士の手続き画面）だけ。ほかの Office・管理の画面には入れない
//   ・どの役割も、サーバの判定（lib/gw.js accessOf）より広くは入れない
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { accessOf, isHrOf } from "../lib/gw.js";
import { appsFromRoles } from "../lib/app-grants.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
function load(file) {
  const src = read(file);
  const hook = "  window.KPLayout = {";
  assert.ok(src.includes(hook), `${file}: 差し込み位置がある`);
  const ctx = { window: {}, location: { pathname: "/home.html", hash: "", search: "" }, console };
  vm.createContext(ctx);
  vm.runInContext(src.replace(hook, "window.__t = { homeFor, hasAccess, showsFor, toolHref, TOOLS };\n" + hook), ctx);
  return ctx.window.__t;
}
const A = load("js/layout.js");
const B = load("js/layout-marketing.js");

const who = (name, roles, extra = {}) => {
  const apps = extra.apps || appsFromRoles(roles);
  const isAdmin = Boolean(extra.isAdmin);
  const appRole = roles.includes("labor_advisor") ? "sr" : roles.includes("tax_advisor") ? "tax_advisor"
    : roles.includes("owner") ? "owner" : isAdmin ? "admin" : "member";
  const isHr = isHrOf({ roles, apps });
  return { name, me: { appRole, isAdmin, gw: { roles, apps, isHr, stage: null }, access: accessOf({ isAdmin, isHr, roles, apps }) } };
};
const PEOPLE = [
  who("経営者", ["owner"]), who("管理者", [], { isAdmin: true }), who("責任者", ["manager"]), who("人事", ["hr"]),
  who("経理", ["finance"]), who("採用担当", ["recruiter"]), who("営業", ["sales"]), who("IT", ["it"]), who("一般", []),
  who("マーケだけ", [], { apps: ["marketing"] }), who("社労士", ["labor_advisor"]), who("税理士", ["tax_advisor"]),
  who("税理士＋経理", ["tax_advisor", "finance"]), who("税理士＋マーケ", ["tax_advisor"], { apps: ["marketing"] }),
];
const KEYS = ["officeHr", "officeFinance", "office", "officeApp", "officeProfessionals", "recruit", "sell", "keiei", "marketing", "aiInquiries"];
const officeTool = (t) => t.TOOLS.find((x) => x.key === "office");

let n = 0;
for (const { name, me } of PEOPLE) {
  assert.equal(B.homeFor(me.appRole, null), A.homeFor(me.appRole, null), `${name}: 送り返し先が同じ`);
  for (const k of KEYS) {
    if (k === "marketing") continue; // マーケティングの入口は layout-marketing.js だけが持つ
    assert.equal(B.hasAccess(me, k), A.hasAccess(me, k), `${name}: ${k} に入れるかが同じ`);
  }
  const sa = A.showsFor(me), sb = B.showsFor(me);
  for (const k of Object.keys(sa)) assert.deepEqual(sb[k], sa[k], `${name}: showsFor.${k} が同じ`);
  assert.equal(B.toolHref(officeTool(B), sb), A.toolHref(officeTool(A), sa), `${name}: ヘッダーの Office の行き先が同じ`);
  // サーバより広く入れない（画面で入れる → サーバも入れる）
  for (const k of KEYS) if (B.hasAccess(me, k)) assert.ok(me.access[k], `${name}: ${k} はサーバも許している`);
  n++;
}

// 税理士：専門家タスクだけ。ホームへ送らない（送ったホームも受け付けないので、読み直しが止まらなくなる）
for (const name of ["税理士", "税理士＋経理", "税理士＋マーケ"]) {
  const { me } = PEOPLE.find((p) => p.name === name);
  assert.equal(B.homeFor(me.appRole, null), "/office/professionals.html?tab=tax", `${name}: 行き先は税理士タスク`);
  assert.equal(B.hasAccess(me, "officeProfessionals"), true, `${name}: 専門家タスクに入れる`);
  for (const k of ["officeHr", "officeFinance", "office", "officeApp", "recruit", "sell", "keiei", "marketing"]) {
    assert.equal(B.hasAccess(me, k), false, `${name}: ${k} には入れない`);
  }
  const s = B.showsFor(me);
  assert.equal(s.officeEntry, true, `${name}: ヘッダーに Office が出る`);
  assert.equal(s.marketing, false, `${name}: マーケティングは出さない`);
  assert.equal(s.officeHr || s.officeFinance, false, `${name}: Office の人事・経理の中身は出さない`);
}
{
  const { me } = PEOPLE.find((p) => p.name === "税理士");
  assert.equal(B.toolHref(officeTool(B), B.showsFor(me)), "/office/professionals.html", "税理士：ヘッダーの Office は専門家タスクへ");
}
// 社労士：手続き画面へ。Office の業務画面には入れない
{
  const { me } = PEOPLE.find((p) => p.name === "社労士");
  assert.equal(B.homeFor(me.appRole, null), "advisor.html");
  for (const k of ["officeHr", "officeFinance", "office", "officeApp", "marketing"]) assert.equal(B.hasAccess(me, k), false, `社労士: ${k} には入れない`);
}
console.log(`layout.js と layout-marketing.js の入口判定：${n}通りの役割で一致・税理士/社労士は専門家タスクだけ PASS`);
