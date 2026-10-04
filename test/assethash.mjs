// 共有の js・css の「中身」を変えたのに、版（?v=）を上げ忘れていないか、を機械で見張る。
//
// ■ なぜ要るのか
//
//   ?v= 付きの js・css は、1年間・immutable でキャッシュさせている（vercel.json）。
//   中身を変えても ?v= が同じなら、一度でも開いたブラウザは、古いファイルを使い続ける。
//   PR #60（ナビ再設計）は layout.js・layout.css・app.css を変えたのに、?v=20261001b のまま出した。
//   test/speedcheck.mjs は「全画面の ?v= が /api/health の版と同じ」しか見ないので、通ってしまった。
//
// ■ どう見るのか
//
//   test/asset-hashes.json に、「この版（version）のとき、各ファイルの中身はこれ」を残す。
//   いまの版（api/health.js の assetVersion）と同じ版の記録があるのに、中身が違えば、
//   版を上げ忘れている。版を上げたら、記録を作り直す。
//
//     node test/assethash.mjs --update     … 版を上げたあとに、記録を作り直す
//       （同じ版の記録があり、中身が違うときは書き換えない。版を上げずに黙らせるのを防ぐ）
//
//   見るのは、その版で読んでいるファイル（HTML の ?v= が、いまの版のもの）だけ。
//   /sales のように、別の版で読んでいるものは、ここでは見ない（test/salesassets.mjs が見る）。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, posix } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, "test/asset-hashes.json");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const VER = read("api/health.js").match(/assetVersion:\s*"([^"]+)"/)?.[1];

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "test", "_archive", "backup", "data"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** いまの版で読まれている js・css（リポジトリのルートからのパス）→ 中身の hash */
function current() {
  const files = new Set();
  for (const f of htmlFiles(ROOT)) {
    const html = readFileSync(f, "utf8");
    for (const m of html.matchAll(/(?:src|href)="([^"]*?(?:js|css)\/[^"?]+)\?v=([^"&]+)"/g)) {
      if (m[2] !== VER) continue;
      // 相対（../js/x.js・js/x.js）も、絶対（/js/x.js・/keiei/x.js）も、ルートからのパスにする
      const ref = m[1].startsWith("/") ? m[1].slice(1) : posix.normalize(posix.join(relative(ROOT, dirname(f)).split("\\").join("/"), m[1]));
      files.add(ref);
    }
  }
  const out = {};
  for (const ref of [...files].sort()) {
    if (!existsSync(join(ROOT, ref))) continue;
    out[ref] = createHash("sha256").update(readFileSync(join(ROOT, ref))).digest("hex").slice(0, 16);
  }
  return out;
}

if (process.argv.includes("--update")) {
  // 同じ版のまま記録を書き換えると、この見張りが黙ってしまう（PR #75 で実際に起きた：
  // layout.js を変えたのに ?v=20261003ux1 のまま --update し、Preview で古い layout.js が残って /office/ が止まった）。
  // 記録を作り直してよいのは、版を上げたときだけ。同じ版で書き換えたいときは、版を上げる
  const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  const next = current();
  if (prev && prev.version === VER && JSON.stringify(prev.files) !== JSON.stringify(next) && !process.argv.includes("--force")) {
    const changed = Object.keys(next).filter((f) => prev.files[f] !== next[f]);
    console.log(`版 ${VER} の記録は、もうあります。中身を変えたなら、版を上げてから --update してください（変えたファイル: ${changed.join(", ")}）`);
    process.exit(1);
  }
  writeFileSync(MANIFEST, JSON.stringify({ version: VER, files: next }, null, 2) + "\n");
  console.log(`記録を作り直しました（版 ${VER}）`);
  process.exit(0);
}

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

check(Boolean(VER), "/api/health に版がある");
const rec = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
check(Boolean(rec), "test/asset-hashes.json がある（無ければ node test/assethash.mjs --update）");

if (rec && VER) {
  if (rec.version !== VER) {
    // 版を上げたのに、記録が古い。作り直してもらう（この版の中身を、ここから見張る）
    check(false, `版を上げたので、記録を作り直してください: node test/assethash.mjs --update（記録 ${rec.version} → いま ${VER}）`);
  } else {
    const now = current();
    const changed = Object.keys(rec.files).filter((f) => now[f] !== rec.files[f]);
    check(changed.length === 0,
      `版 ${VER} のまま、中身を変えたファイルがあります（1年キャッシュなので、古いまま残ります。api/health.js の assetVersion と HTML の ?v= を上げ、node test/assethash.mjs --update）: ${changed.join(", ")}`);
  }
}

console.log(bad ? `${bad} 件 失敗` : "共有ファイルの中身と版は、そろっています");
process.exit(bad ? 1 : 0);
