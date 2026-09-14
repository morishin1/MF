// テストを、まとめて回す。
//
//   node test/run.mjs          … ブラウザの要らないものだけ（速い）
//   node test/run.mjs ui       … ブラウザのもの（静的サーバが要る）
//   node test/run.mjs wf       … GitHub Actions の手順を、その場で走らせるもの
//   node test/run.mjs all      … 全部
//
// ■ なぜ1本にまとめるのか
//
//   テストが作業用の一時領域にしか無く、セッションが終われば消えていた。
//   「壊れたら気づく」ための仕掛けが、いちばん消えやすい場所にあった。
//   ここに置いて、GitHub Actions から毎回まわす。
import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// 道具であってテストではないもの
const SKIP = new Set(["run.mjs", "_browser.mjs", "tcdata.mjs"]);

const groups = {
  // ブラウザの要らないもの。ハンドラを直に呼ぶものと、静的な検査
  node: { dir: HERE, node: ["--experimental-test-module-mocks"], timeout: 300 },
  // 実際の画面を開くもの。先に静的サーバを上げておくこと
  ui: { dir: join(HERE, "ui"), node: [], timeout: 400 },
  // GitHub Actions の手順を、その場で走らせるもの。Go が要る
  wf: { dir: join(HERE, "wf"), node: [], timeout: 900 },
};

const want = (process.argv[2] || "node").toLowerCase();
const picked = want === "all" ? ["node", "ui", "wf"] : [want];
for (const g of picked) {
  if (!groups[g]) {
    console.error(`知らない組です: ${g}（node / ui / wf / all）`);
    process.exit(2);
  }
}

function run(file, g) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [...g.node, file], {
      cwd: dirname(HERE), stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    const kill = setTimeout(() => p.kill("SIGKILL"), g.timeout * 1000);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, out }); });
  });
}

let failed = 0;
let ran = 0;

for (const g of picked) {
  const grp = groups[g];
  if (!existsSync(grp.dir)) continue;
  const files = readdirSync(grp.dir).filter((f) => f.endsWith(".mjs") && !SKIP.has(f)).sort();
  if (!files.length) continue;

  console.log(`\n===== ${g}（${files.length} 本）=====`);
  for (const f of files) {
    const { code, out } = await run(join(grp.dir, f), grp);
    ran++;
    const name = f.replace(/\.mjs$/, "");
    if (code === 0) {
      const last = out.trim().split("\n").filter(Boolean).pop() || "";
      console.log(`  ok   ${name.padEnd(14)} ${last.slice(0, 44)}`);
    } else {
      failed++;
      console.log(`  NG   ${name}`);
      // 落ちたところだけ出す。全部出すと、どこで落ちたのか分からなくなる
      const lines = out.split("\n").filter((l) => /^\s*NG|Error|Timeout/.test(l));
      for (const l of lines.slice(0, 6)) console.log(`         ${l.trim().slice(0, 110)}`);
    }
  }
}

console.log(`\n${ran} 本中 ${ran - failed} 本 通過`);
process.exit(failed ? 1 : 0);
