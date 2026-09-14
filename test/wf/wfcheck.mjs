// ワークフローの run: を、実際に走らせて確かめる。
//
// GitHub 上でしか動かないもの（uses:）は飛ばし、
// シェルで書いたところだけを取り出して回す。
// 「push してから気づく」を減らすため。
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const yml = readFileSync(atRoot(".github/workflows/agent-build.yml"), "utf8");

// run: | のブロックを、名前つきで取り出す
const steps = [];
{
  const lines = yml.split("\n");
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^      - name: (.+)$/);
    if (name) { cur = { name: name[1], env: {}, run: null }; steps.push(cur); continue; }
    if (!cur) continue;
    const e = lines[i].match(/^        env:$/);
    if (e) {
      for (let j = i + 1; j < lines.length && /^          \S/.test(lines[j]); j++) {
        const kv = lines[j].match(/^          (\w+): (.*)$/);
        if (kv) cur.env[kv[1]] = kv[2];
      }
    }
    if (/^        run: \|$/.test(lines[i])) {
      const body = [];
      for (let j = i + 1; j < lines.length && (lines[j] === "" || /^          /.test(lines[j])); j++) {
        body.push(lines[j].replace(/^          /, ""));
      }
      cur.run = body.join("\n");
    }
  }
}

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const dir = mkdtempSync(join(tmpdir(), "wf-"));
const ghEnv = join(dir, "env");
const ghOut = join(dir, "out");
const ghSum = join(dir, "sum");
for (const f of [ghEnv, ghOut, ghSum]) writeFileSync(f, "");

function run(step, env = {}, cwd = ROOT) {
  const sh = join(dir, "s.sh");
  writeFileSync(sh, step.run);
  return execFileSync("bash", [sh], {
    cwd,
    env: { ...process.env, GITHUB_ENV: ghEnv, GITHUB_OUTPUT: ghOut,
           GITHUB_STEP_SUMMARY: ghSum, ...env },
    encoding: "utf8",
  });
}

const byName = (n) => steps.find((s) => s.name === n);

console.log("— 版の形を確かめる —");
{
  const st = byName("版の形を確かめる");
  check(st && st.run, "取り出せた");
  for (const ok of ["0.3.0", "1.0.0", "0.3.0-rc1", "10.20.30"]) {
    let passed = true;
    try { run(st, { IN_VERSION: ok }); } catch { passed = false; }
    check(passed, `通す: ${ok}`);
  }
  // 変な字が混ざったまま先へ進めない。
  // 版はファイル名・Storage のパス・DBの一意キーになる
  for (const ng of ["0.3", "v0.3.0", "0.3.0; rm -rf /", "../../etc", "0.3.0 0.4.0",
                    "$(whoami)", "'; echo pwned; '", "0.3.0/../../x", ""]) {
    let passed = true;
    try { run(st, { IN_VERSION: ng }); } catch { passed = false; }
    check(!passed, `弾く: ${JSON.stringify(ng)}`);
  }
  // 打ち込んだ文字が、そのままシェルとして動いてしまわないこと
  writeFileSync(ghEnv, "");
  try { run(st, { IN_VERSION: "0.3.0\"; touch " + join(dir, "pwned") + "; #" }); } catch {}
  let pwned = false;
  try { readFileSync(join(dir, "pwned")); pwned = true; } catch {}
  check(!pwned, "入力がシェルとして動かない");
}

console.log("— 足りないものを知らせる —");
{
  const st = byName("足りないものを知らせる");
  const out1 = run(st, { EXT_ID: "", EXT_KEY: "", UPDATE_KEY: "" });
  check(/拡張のIDも鍵も無い/.test(out1), "拡張が無いなら言う");
  check(/公開鍵が空/.test(out1), "公開鍵が空なら言う");
  const out2 = run(st, { EXT_ID: "a".repeat(32), EXT_KEY: "/tmp/k.pem", UPDATE_KEY: "k" });
  check(!/::warning/.test(out2), "そろっていれば黙る");
}

console.log("— 中身を確かめて、登録に要る値を出す —");
{
  const st = byName("中身を確かめて、登録に要る値を出す");
  writeFileSync(ghOut, ""); writeFileSync(ghSum, "");
  const bare = mkdtempSync(join(tmpdir(), "bare-"));
  execFileSync("mkdir", ["-p", join(bare, "dist")]);
  execFileSync("bash", ["-c",
    `cp /home/user/MF/agent/dist/EIGHT-Agent-Setup.exe "${bare}/dist/"`]);
  const out = run(st, { VERSION: "0.3.0", EXT_ID: "", UPDATE_KEY: "", BASE_URL: "https://mf.8grp.co.jp" }, bare);
  const got = readFileSync(ghOut, "utf8");
  check(/^sha=[0-9a-f]{64}$/m.test(got), "SHA-256 を出す");
  check(/^size=\d+$/m.test(got), "大きさを出す");

  const sum = readFileSync(ghSum, "utf8");
  check(sum.includes("EIGHT-Agent-Setup.exe ができました"), "要約が出る");
  check(sum.includes("0.3.0/EIGHT-Agent-Setup.exe"), "どこに上げるか書いてある");
  check(sum.includes("（未設定。ブラウザ連携は入りません）"), "足りないものを要約にも書く");
  check(sum.includes("まだ人がやります"), "まだ自動でないことを書いてある");
}

console.log("— 小さすぎる EXE は弾く —");
{
  const st = byName("中身を確かめて、登録に要る値を出す");
  const fake = mkdtempSync(join(tmpdir(), "fake-"));
  execFileSync("mkdir", ["-p", join(fake, "dist")]);
  writeFileSync(join(fake, "dist/EIGHT-Agent-Setup.exe"), "MZ");
  let passed = true;
  try { run(st, { VERSION: "0.3.0", EXT_ID: "", UPDATE_KEY: "", BASE_URL: "https://mf.8grp.co.jp" }, fake); } catch { passed = false; }
  check(!passed, "途中で終わった組み立てを配らない");
}

console.log("— ハッシュも一緒に置く —");
{
  const st = byName("ハッシュも一緒に置く");
  const work = mkdtempSync(join(tmpdir(), "out-"));
  run(st, { VERSION: "0.3.0", SHA: "a".repeat(64), SIZE: "20941312", CRXID: "" }, work);
  const rel = readFileSync(join(work, "out/release.txt"), "utf8");
  check(rel.includes("object_path=0.3.0/EIGHT-Agent-Setup.exe"), "置き場所が入る");
  check(rel.includes("bucket=agent"), "バケットが入る");
  check(rel.includes("size_bytes=20941312"), "大きさが入る");
  const sha = readFileSync(join(work, "out/EIGHT-Agent-Setup.exe.sha256"), "utf8");
  check(/^a{64}  EIGHT-Agent-Setup\.exe$/m.test(sha), "sha256sum -c で照合できる形");
}

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
