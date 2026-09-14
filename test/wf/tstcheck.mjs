// agent-test.yml の run: を、実際に走らせて確かめる。
//
// 「確かめるためのワークフロー」自体が壊れていると、
// 壊れていることに気づけない。ここで一度回しておく。
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const yml = readFileSync(join(ROOT, ".github/workflows/agent-test.yml"), "utf8");

// run: | のブロックを、名前と working-directory つきで取り出す
const steps = [];
{
  const lines = yml.split("\n");
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^      - name: (.+)$/);
    if (name) { cur = { name: name[1], wd: ".", run: null }; steps.push(cur); continue; }
    if (!cur) continue;
    const wd = lines[i].match(/^        working-directory: (.+)$/);
    if (wd) cur.wd = wd[1];
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

const dir = mkdtempSync(join(tmpdir(), "tw-"));
const sh = join(dir, "s.sh");

function run(step) {
  writeFileSync(sh, step.run);
  return execFileSync("bash", [sh], {
    cwd: join(ROOT, step.wd),
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const byName = (n) => steps.find((s) => s.name === n);

console.log("— 取り出せているか —");
check(steps.length === 2, `run のある手順は2つ（${steps.length}）`);
check(byName("テストと見直し")?.wd === "agent", "テストは agent で走る");
check(byName("書き方の揃い")?.wd === "agent", "gofmt は agent で走る");

console.log("— setup-go が指すファイルが実在するか —");
// go-version-file / cache-dependency-path が無いと、Actions 側で落ちる
for (const m of yml.matchAll(/^\s+(?:go-version-file|cache-dependency-path): (.+)$/gm)) {
  check(existsSync(join(ROOT, m[1].trim())), `${m[1].trim()} がある`);
}

console.log("— いつ動くか —");
check(/paths:[\s\S]*?- "agent\/\*\*"/.test(yml), "agent を直したら動く");
check(/workflow_dispatch:/.test(yml), "手でも回せる");
check(/^permissions:\n  contents: read$/m.test(yml), "読むだけの権限");

console.log("— テストと見直し —");
{
  const st = byName("テストと見直し");
  let out = "";
  let passed = true;
  try { out = run(st); } catch (e) { passed = false; out = String(e.stdout) + String(e.stderr); }
  check(passed, "いまの木で通る");
  // build.sh test が本当に go test まで行っているか。
  // 「何もせず 0 で返る」ものを通過と数えない
  check(/ok\s+github\.com\/8grp\/eight-agent/.test(out), "単体テストが走っている");
  check(/vet|見直/.test(out), "Windows 向けの見直しも走っている");
}

console.log("— 書き方の揃い —");
{
  const st = byName("書き方の揃い");
  let passed = true;
  try { run(st); } catch { passed = false; }
  check(passed, "いまの木で通る");

  // 崩したものを置いたら落ちること。落ちないなら見ていない
  const junk = join(ROOT, "agent/internal/release/zz_fmtcheck.go");
  writeFileSync(junk, "package release\n\nfunc zzFmtCheck( ) int {\nreturn   1\n}\n");
  let failed = false;
  let msg = "";
  try { run(st); } catch (e) { failed = true; msg = String(e.stdout) + String(e.stderr); }
  rmSync(junk);
  check(failed, "崩した書き方を見つけて落ちる");
  check(/zz_fmtcheck\.go/.test(msg), "どのファイルか出る");
}

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
