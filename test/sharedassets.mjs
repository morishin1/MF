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
//   4. 画面が呼ぶ API.xxx が「その画面が読んでいる版」に入っている（test/asset-versions.json）
//      PR #31 で API.focusSelect を足したのに、日報（nippo.html）は ?v=20260928h のままだった。
//      20260928h をキャッシュしているブラウザでは「API.focusSelect is not a function」になる。
//      3 は「いまのファイルにあるか」しか見ないので、これを見逃した。
//      本番に出た版ごとの関数一覧を test/asset-versions.json に残し、画面ごとに照らし合わせる
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


console.log("\n— 画面が呼ぶ API.xxx が、その画面の読んでいる版に入っているか（test/asset-versions.json） —");
{
  const reg = JSON.parse(read("test/asset-versions.json"))["api-client.js"];
  const current = new Set(Object.keys(API || {}).filter((k) => typeof API[k] === "function"));
  const re = /[/"]api-client\.js\?v=([^"&]+)"/;
  const stale = [];
  const unknown = new Set();
  for (const p of pages) {
    const src = read(p);
    const ver = (src.match(re) || [])[1];
    if (!ver) continue;
    const known = reg[ver];
    if (!known) { unknown.add(`${ver}（${p}）`); continue; }
    const have = new Set(known.functions);
    const uses = [...new Set([...src.matchAll(/\bAPI\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
    const missing = uses.filter((fn) => !have.has(fn));
    if (missing.length) stale.push(`${p}（?v=${ver}）: ${missing.join(", ")}`);
  }
  check(!unknown.size, `画面が読む api-client.js の版は、すべて test/asset-versions.json にある`
    + (unknown.size ? `（無い: ${[...unknown].join(", ")}。新しい版なら、その版の関数一覧を足してください）` : ""));
  check(!stale.length, `画面が呼ぶ API.xxx は、その画面が読んでいる版に入っている（古い版のキャッシュで is not a function にならない）`
    + (stale.length ? `\n     版の古い画面: ${stale.join(" / ")}\n     → その画面の ?v= を、関数を含む新しい版へ上げてください` : ""));
  // 一覧に書いた関数は、いまの api-client.js からも消えていない（消すと、その版の画面が壊れる）
  const gone = Object.entries(reg).flatMap(([v, x]) => x.functions.filter((fn) => !current.has(fn)).map((fn) => `${fn}（${v}）`));
  check(!gone.length, `記録した版の関数は、いまの api-client.js にも残っている${gone.length ? `（消えた: ${gone.slice(0, 10).join(", ")}）` : ""}`);
  // 最新の版の一覧は、いまの api-client.js と同じ（関数を足したのに一覧を足し忘れていない）
  const latest = Object.entries(reg).at(-1);
  const extra = [...current].filter((fn) => !latest[1].functions.includes(fn));
  check(!extra.length, `いちばん新しい版（${latest[0]}）の一覧が、いまの api-client.js と同じ`
    + (extra.length ? `（一覧に無い関数: ${extra.join(", ")}。新しい版を足して、使う画面の ?v= を上げてください）` : ""));
}

console.log(bad ? `\n${bad} 件 NG` : "\n共有ファイルの版と API はそろっています");
process.exit(bad ? 1 : 0);
