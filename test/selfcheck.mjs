// テストそのものを確かめる。
//
// ■ なぜ要るのか
//
//   テストを作業用の一時領域からリポジトリへ移したとき、5本が
//   一時領域のパスを指したままだった。手元にはそのフォルダがあるので
//   全部通り、CI ではじめて「そんなフォルダはありません」で落ちた。
//
//   同じことは、これからも起きる。
//     ・手元にしか無い場所を指す
//     ・ブラウザを使うのに、ブラウザの要らない組に置く
//     ・画面写真を、書けない場所へ出す
//
//   どれも「手元では通る」ので、人のレビューでは見つけにくい。
//   だから機械で見る。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const SKIP = new Set(["run.mjs", "_browser.mjs", "_shot.mjs", "selfcheck.mjs", "tcdata.mjs"]);

const groups = [
  { name: "node", dir: HERE, browser: false },
  { name: "ui", dir: join(HERE, "ui"), browser: true },
  { name: "wf", dir: join(HERE, "wf"), browser: null }, // どちらでもよい
];

const files = [];
for (const g of groups) {
  if (!existsSync(g.dir)) continue;
  for (const f of readdirSync(g.dir)) {
    if (!f.endsWith(".mjs") || SKIP.has(f)) continue;
    files.push({ g, f, path: join(g.dir, f), src: readFileSync(join(g.dir, f), "utf8") });
  }
}

console.log(`— ${files.length} 本を見る —`);
check(files.length > 30, `本数（${files.length}）`);

console.log("\n— そもそも読み込めるか —");
{
  // 書き換えで壊した構文は、走らせるまで分からない。
  // 実際に path: path: という形を作ってしまい、8本が CI で落ちた。
  // 読めるかどうかだけなら一瞬で見られる
  const { execFileSync } = await import("node:child_process");
  for (const x of files) {
    let ok = true;
    let why = "";
    try {
      execFileSync(process.execPath, ["--check", x.path], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      ok = false;
      why = String(e.stderr || e.message).split("\n").find((l) => /Error/.test(l)) || "";
    }
    check(ok, `${x.g.name}/${x.f}${ok ? "" : "  ← " + why.trim().slice(0, 60)}`);
  }
}

console.log("\n— この機械にしか無い場所を指していないか —");
{
  // 作業用の一時領域・誰かのホーム・絶対パスの決め打ち
  const re = /["'`](\/tmp\/claude-|\/home\/[a-z]+\/|\/Users\/)/;
  for (const x of files) {
    const hit = x.src.split("\n").find((l) => re.test(l) && !l.trim().startsWith("//"));
    check(!hit, `${x.g.name}/${x.f}${hit ? `  ← ${hit.trim().slice(0, 70)}` : ""}`);
  }
}

console.log("\n— ブラウザを使うものが、正しい組にいるか —");
{
  for (const x of files) {
    if (x.g.browser === null) continue;
    const uses = /_browser\.mjs|from "playwright"/.test(x.src);
    if (x.g.browser) continue; // ui 側は、使っていなくても困らない
    check(!uses, `${x.g.name}/${x.f}${uses ? "  ← ブラウザを使うなら test/ui へ" : ""}`);
  }
}

console.log("\n— 画面写真を、書ける場所へ出しているか —");
{
  for (const x of files) {
    if (!/screenshot\(/.test(x.src)) continue;
    const ok = /shotPath\(/.test(x.src);
    check(ok, `${x.g.name}/${x.f}${ok ? "" : "  ← _shot.mjs の shotPath を使うこと"}`);
  }
}

console.log("\n— 読む材料が、リポジトリの中にあるか —");
{
  for (const x of files) {
    for (const m of x.src.matchAll(/atRoot\("([^"]+)"\)/g)) {
      // 画面や lib は当然ある。ここで見たいのは、テスト用に置いた材料
      if (!m[1].startsWith("test/")) continue;
      check(existsSync(join(ROOT, m[1])), `${x.f} が読む ${m[1]}`);
    }
  }
}

console.log("\n— 走らせる口から、全部拾えているか —");
{
  const runner = readFileSync(join(HERE, "run.mjs"), "utf8");
  for (const g of ["node", "ui", "wf"]) {
    check(runner.includes(`${g}:`), `${g} の組がある`);
  }
  // 落ちたら落ちたと分かること
  check(/process\.exit\(failed \? 1 : 0\)/.test(runner), "1本でも落ちたら、全体も落ちる");
}

console.log(bad ? `\n${bad} 件 NG` : "\nテストの置き方に問題はありません");
process.exit(bad ? 1 : 0);
