// GW 全体で共有している js・css の版（?v=）を、機械で見張る。
//
// ■ なぜ要るのか
//
//   ?v= 付きの js・css は1年間キャッシュさせている（vercel.json）。
//   中身を変えたのに ?v= を上げないと、ブラウザは古いファイルを使い続ける。
//   /sales では、api-client.js に関数を足したのに版が古いままで
//     「API.listSalesCompanies is not a function」
//   になった（test/salesassets.mjs）。同じことが GW 全体の共有ファイルでも起きうる。
//
// ■ 守ること
//
//   1. api-client.js・layout.js・layout.css は、読んでいる全画面で版が1つ
//      （同じ共有ファイルを、画面ごとに別の版で読まない）
//      例外：api-client.js だけは、/sales の画面が先に新しい版へ進んでよい（最大2つ：/sales とそれ以外）。
//        Sales の変更で api-client.js に関数を足したとき、Sales と関係のない画面の ?v= まで
//        書き換えないため（PR の差分を Sales に閉じる）。足すだけの変更なので、古い版を
//        キャッシュしている Sales 以外の画面は、いままでの関数だけを使い続けて問題ない。
//        それでも /sales の中・/sales 以外の中では、それぞれ版は1つ。
//   2. 前の版（20260916m）で読んでいる画面が残っていない
//      （評価・キャリア・印鑑でこの3つの中身を変えたため、版を上げた）
//   3. 画面が呼ぶ API.xxx が api-client.js に実在する
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// 画面（.html）を集める。node_modules・テスト・退避は見ない
function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "test", "_archive", "backup", "data"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(relative(ROOT, p));
  }
  return out;
}
const pages = htmlFiles(ROOT);

// sales-layout.js・hr-layout.js は別ファイル。前に文字が続かない layout.js だけを見る
const SHARED = [
  ["api-client.js", /[/"]api-client\.js\?v=([^"&]+)"/],
  ["layout.js", /\/layout\.js\?v=([^"&]+)"/],
  ["layout.css", /\/layout\.css\?v=([^"&]+)"/],
];

console.log("\n— 共有ファイルの版は、全画面で1つ —");
for (const [file, re] of SHARED) {
  const vers = pages.map((p) => [p, (read(p).match(re) || [])[1]]).filter(([, v]) => v);
  const set = new Set(vers.map(([, v]) => v));
  check(vers.length > 0, `${file} を ?v= 付きで読んでいる画面がある（${vers.length}画面）`);
  const byVer = [...set].map((v) => `${v}: ${vers.filter(([, x]) => x === v).length}画面`).join(" / ");
  if (file === "api-client.js") {
    const inSales = (p) => p.startsWith("sales/");
    const sales = new Set(vers.filter(([p]) => inSales(p)).map(([, v]) => v));
    const rest = new Set(vers.filter(([p]) => !inSales(p)).map(([, v]) => v));
    check(sales.size <= 1 && rest.size === 1, `${file} の版は /sales で1つ・それ以外で1つ（いま ${byVer}）`);
  } else {
    check(set.size === 1, `${file} の版は1つ（いま ${byVer}）`);
  }
  const old = vers.filter(([, v]) => v === "20260916m").map(([p]) => p);
  check(!old.length, `${file} を前の版 20260916m で読んでいる画面が無い${old.length ? `（${old.join(", ")}）` : ""}`);
}

console.log("\n— 画面が呼ぶ API.xxx が api-client.js にあるか —");
const sandbox = { window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: "", pathname: "/" }, fetch: async () => ({}), console };
vm.createContext(sandbox);
vm.runInContext(read("js/api-client.js"), sandbox, { filename: "js/api-client.js" });
const API = sandbox.window.API;
check(API && typeof API === "object", "api-client.js を読むと window.API ができる");
// 評価・キャリア・印鑑で足した関数（名指し）
for (const fn of ["myCareer", "myCareerAct", "careerList", "careerDetail", "careerAct", "seals", "sealAct"]) {
  check(typeof API?.[fn] === "function", `API.${fn} がある`);
}
const called = new Map();
for (const p of pages) {
  const src = read(p);
  if (!/api-client\.js/.test(src)) continue;
  for (const m of src.matchAll(/\bAPI\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!called.has(m[1])) called.set(m[1], p);
  }
}
const missing = [...called].filter(([fn]) => typeof API?.[fn] !== "function").map(([fn, p]) => `${fn}（${p}）`);
check(!missing.length, `画面が呼ぶ ${called.size} 個の API が全部ある${missing.length ? `（無い: ${missing.join(", ")}）` : ""}`);

console.log(bad ? `\n${bad} 件 NG` : "\n共有ファイルの版と API はそろっています");
process.exit(bad ? 1 : 0);
