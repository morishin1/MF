// /sales の画面が読む js・css の版（?v=）を、機械で見張る。
//
// ■ なぜ要るのか
//
//   /sales を出したとき、js/api-client.js に営業の API を足したのに、
//   /sales の画面は前と同じ ?v=20260916m のまま読んでいた。
//   ?v= 付きの js・css は1年間キャッシュさせている（vercel.json）ので、
//   本番のブラウザは古い api-client.js を使い続け、
//     「取得に失敗しました：API.listSalesCompanies is not a function」
//   になった。
//
//   ブラウザのテストでは気づけなかった。テストは毎回手元の最新の js を読むので、
//   キャッシュが古いまま、という状態が起きないため。
//
// ■ 守ること
//
//   1. /sales の全画面で、api-client.js・sales-layout.js の版がそろっている
//   2. 前の版（20260916m）が /sales に残っていない
//   3. /sales の画面と sales-layout.js が呼ぶ API.xxx が、api-client.js に実在する
//      （今回の症状そのもの。版を上げ忘れても、呼ぶ関数が無ければここで落ちる）
//
//   版を上げるのは「中身を変えたとき」。この組み合わせで、足した関数を使う画面の
//   版がそろって新しくなっていることまでを見る。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const pages = readdirSync(join(ROOT, "sales")).filter((f) => f.endsWith(".html")).sort();
check(pages.length === 7, `/sales の画面は7つ（いま ${pages.length}: ${pages.join(", ")}）`);

// ---- 1・2. 版 ----------------------------------------------------------------------
const verOf = (src, file) => {
  const m = src.match(new RegExp(`src="\\.\\./js/${file.replace(".", "\\.")}\\?v=([^"&]+)"`));
  return m ? m[1] : null;
};

console.log("\n— 版がそろっているか —");
for (const file of ["api-client.js", "sales-layout.js"]) {
  const vers = pages.map((p) => [p, verOf(read(`sales/${p}`), file)]);
  const missing = vers.filter(([, v]) => !v).map(([p]) => p);
  check(!missing.length, `${file} を ?v= 付きで読んでいる${missing.length ? `（無い: ${missing.join(", ")}）` : ""}`);
  const set = new Set(vers.map(([, v]) => v).filter(Boolean));
  check(set.size === 1, `${file} の版は全画面で1つ（いま ${[...set].join(" / ")}）`);
}

console.log("\n— 前の版が残っていないか —");
for (const p of pages) {
  check(!read(`sales/${p}`).includes("20260916m"), `sales/${p} に 20260916m が無い`);
}

// ---- 3. 呼んでいる API が実在するか ---------------------------------------------------
console.log("\n— 呼んでいる API.xxx が api-client.js にあるか —");
const sandbox = { window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: "", pathname: "/" }, fetch: async () => ({}), console };
vm.createContext(sandbox);
vm.runInContext(read("js/api-client.js"), sandbox, { filename: "js/api-client.js" });
const API = sandbox.window.API;
check(API && typeof API === "object", "api-client.js を読むと window.API ができる");

// 今回の Hotfix で名指しで確かめたもの
const REQUIRED = [
  "listSalesCompanies", "createSalesCompany", "importSalesCompanies", "getSalesCompany", "updateSalesCompany",
  "listSalesApproaches", "prepareSalesAttack", "markSalesAttackSent", "listSalesTemplates", "listSalesCampaigns",
];
for (const fn of REQUIRED) check(typeof API?.[fn] === "function", `API.${fn} がある`);

// 画面と sales-layout.js が実際に呼んでいるもの全部
const called = new Set();
for (const src of [...pages.map((p) => read(`sales/${p}`)), read("js/sales-layout.js")]) {
  for (const m of src.matchAll(/\bAPI\.([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
}
const missing = [...called].filter((fn) => typeof API?.[fn] !== "function").sort();
check(!missing.length, `/sales が呼ぶ ${called.size} 個の API が全部ある${missing.length ? `（無い: ${missing.join(", ")}）` : ""}`);

console.log(bad ? `\n${bad} 件 失敗` : "\n/sales の版と API はそろっています");
process.exit(bad ? 1 : 0);
