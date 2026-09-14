// extension-init.yml と、組み立て側の拡張まわりを、実際に走らせて確かめる。
//
// 「拡張が入らない」は画面に何も出ないまま起きる。
// 配ってから気づくと、全PCを回り直すことになるので、ここで潰す。
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const AG = join(ROOT, "agent");

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const dir = mkdtempSync(join(tmpdir(), "ex-"));
const ghEnv = join(dir, "env"), ghOut = join(dir, "out"), ghSum = join(dir, "sum");
for (const f of [ghEnv, ghOut, ghSum]) writeFileSync(f, "");

// ---- run: の取り出し ---------------------------------------------------------

function steps(file) {
  const lines = readFileSync(join(ROOT, ".github/workflows", file), "utf8").split("\n");
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^      - name: (.+)$/);
    if (name) { cur = { name: name[1], wd: ".", run: null }; out.push(cur); continue; }
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
  return out;
}

function run(step, env = {}, cwd) {
  const sh = join(dir, "s.sh");
  writeFileSync(sh, step.run);
  return execFileSync("bash", [sh], {
    cwd: cwd || join(ROOT, step.wd),
    env: { ...process.env, GITHUB_ENV: ghEnv, GITHUB_OUTPUT: ghOut,
           GITHUB_STEP_SUMMARY: ghSum, RUNNER_TEMP: dir, ...env },
    encoding: "utf8",
  });
}
const pass = (fn) => { try { fn(); return true; } catch { return false; } };

// ---- 初期化ワークフロー -------------------------------------------------------

const init = steps("extension-init.yml");
const byName = (l, n) => l.find((s) => s.name === n);

console.log("— 初期化: 押し間違いで鍵を替えない —");
{
  const st = byName(init, "本当に作ってよいか確かめる");
  check(!!st?.run, "取り出せた");
  // 確認の欄
  check(pass(() => run(st, { CONFIRM: "INIT", REPLACE: "false", CURRENT: "" })),
        "INIT なら通す");
  for (const c of ["", "init", "はい", "INIT ", "YES"]) {
    check(!pass(() => run(st, { CONFIRM: c, REPLACE: "false", CURRENT: "" })),
          `確認が ${JSON.stringify(c)} なら止める`);
  }
  // 既に ID があるのに作り直そうとしたら止める。
  // ここが緩いと、配った全PCで拡張が入れ直しになる
  check(!pass(() => run(st, { CONFIRM: "INIT", REPLACE: "false",
                              CURRENT: "lfhomglagbjlpkjmdpdcinkgmbmlmece" })),
        "既に ID があれば止める");
  check(pass(() => run(st, { CONFIRM: "INIT", REPLACE: "true",
                             CURRENT: "lfhomglagbjlpkjmdpdcinkgmbmlmece" })),
        "承知のうえなら通す");
  // 入力がそのままシェルとして動かないこと
  const canary = join(dir, "pwned-init");
  try { run(st, { CONFIRM: `INIT"; touch ${canary}; #`, REPLACE: "false", CURRENT: "" }); } catch {}
  check(!existsSync(canary), "入力がシェルとして動かない");
}

console.log("— 初期化: 鍵と ID —");
{
  const mk = byName(init, "鍵を作る");
  const again = byName(init, "同じ ID が出るか確かめる");
  check(!!mk?.run && !!again?.run, "取り出せた");

  const work = join(dir, "w");
  mkdirSync(join(work, "agent"), { recursive: true });
  // agent/ を丸ごと使う（go run するため）
  execFileSync("bash", ["-c", `cp -r "${AG}/." "${join(work, "agent")}/"`]);
  rmSync(join(work, "agent/dist"), { recursive: true, force: true });

  writeFileSync(ghOut, "");
  const out = run(mk, {}, join(work, "agent"));
  check(existsSync(join(work, "out/eight-ext.pem")), "秘密鍵ができる");
  check(existsSync(join(work, "out/extension-id.txt")), "ID の控えができる");

  const id = readFileSync(join(work, "out/extension-id.txt"), "utf8").trim();
  check(/^[a-p]{32}$/.test(id), `ID が a〜p の32文字（${id}）`);
  check(readFileSync(ghOut, "utf8").includes(`id=${id}`), "次の手順へ ID を渡す");

  // 秘密鍵が画面に出ていないこと。ログは消せない場所に残る
  check(!out.includes("PRIVATE KEY"), "秘密鍵を画面に出さない");
  const pem = readFileSync(join(work, "out/eight-ext.pem"), "utf8");
  check(pem.includes("BEGIN PRIVATE KEY"), "秘密鍵の形になっている");
  check(!out.includes(pem.split("\n")[1]), "秘密鍵の中身が漏れていない");

  // 同じ鍵から同じ ID が出て、固めるところまで通ること
  check(pass(() => run(again, { WANT: id }, join(work, "agent"))), "もう一度出しても同じ ID");
  check(!pass(() => run(again, { WANT: "a".repeat(32) }, join(work, "agent"))),
        "違う ID を渡したら止まる");

  // 貼りかたの書き置きに ID が入っていること
  const readme = byName(init, "貼りかたを書いておく");
  run(readme, { EXT_ID: id }, work);
  const txt = readFileSync(join(work, "out/README.txt"), "utf8");
  check(txt.includes(id), "書き置きに ID が入る");
  check(txt.includes("AGENT_EXT_ID") && txt.includes("AGENT_EXT_KEY"), "貼る先が2つとも書いてある");
  check(/消して/.test(txt), "消してくださいと書いてある");

  // 要約
  writeFileSync(ghSum, "");
  run(byName(init, "次にやることを出す"), { EXT_ID: id }, work);
  const sum = readFileSync(ghSum, "utf8");
  check(sum.includes(id), "要約に ID が出る");
  check(sum.includes("AGENT_EXT_ID") && sum.includes("AGENT_EXT_KEY"), "要約に貼る先が出る");
  check(!sum.includes("PRIVATE KEY-----\nMII"), "要約に秘密鍵が出ない");

  globalThis.__id = id;
  globalThis.__pem = join(work, "out/eight-ext.pem");
}

// ---- 組み立て側 --------------------------------------------------------------

const build = steps("agent-build.yml");

console.log("— 組み立て: 鍵の受け取り —");
{
  const st = byName(build, "拡張の鍵を用意する");
  check(!!st?.run, "取り出せた");

  writeFileSync(ghOut, "");
  run(st, { EXT_KEY: "" });
  check(/have=\s*$/m.test(readFileSync(ghOut, "utf8")), "鍵が無ければ空で先へ進む");

  // 形になっていないものを黙って受けない
  check(!pass(() => run(st, { EXT_KEY: "これは鍵ではありません" })), "鍵でない文字列を弾く");
  check(!pass(() => run(st, { EXT_KEY: "-----BEGIN PUBLIC KEY-----\nAA\n-----END PUBLIC KEY-----" })),
        "公開鍵を渡したら弾く");

  writeFileSync(ghOut, "");
  const pem = readFileSync(globalThis.__pem, "utf8");
  const out = run(st, { EXT_KEY: pem });
  const got = readFileSync(ghOut, "utf8").match(/have=(.+)/)?.[1];
  check(!!got && existsSync(got), "鍵をファイルに置く");
  check(!out.includes("MII"), "置くときに中身を出さない");
  // 作業場所の外に置くこと。Artifacts に混ざると鍵が配られる
  check(!!got && !got.startsWith(ROOT), "リポジトリの外に置く");
  const mode = execFileSync("stat", ["-c", "%a", got], { encoding: "utf8" }).trim();
  check(mode === "600", `ほかの人が読めない（${mode}）`);
}

console.log("— 組み立て: 足りないものを知らせる —");
{
  const st = byName(build, "足りないものを知らせる");
  const w = (env) => run(st, env);
  check(/初期化/.test(w({ EXT_ID: "", EXT_KEY: "", UPDATE_KEY: "" })),
        "どちらも無ければ、初期化をまわすよう言う");
  check(/crx を作れません/.test(w({ EXT_ID: globalThis.__id, EXT_KEY: "", UPDATE_KEY: "k" })),
        "ID だけなら、crx が作れないと言う");
  check(w({ EXT_ID: globalThis.__id, EXT_KEY: "/tmp/x.pem", UPDATE_KEY: "k" }).trim() === "",
        "そろっていれば黙る");
}

console.log("— 組み立て: 要約に拡張のことが出るか —");
{
  const st = byName(build, "中身を確かめて、登録に要る値を出す");
  const fake = join(dir, "fake");
  mkdirSync(join(fake, "dist"), { recursive: true });
  execFileSync("bash", ["-c",
    `head -c 6000000 /dev/zero > "${fake}/dist/EIGHT-Agent-Setup.exe"`]);

  // crx 無し
  writeFileSync(ghSum, ""); writeFileSync(ghOut, "");
  run(st, { VERSION: "0.3.0", EXT_ID: "", UPDATE_KEY: "", BASE_URL: "https://x" }, fake);
  let sum = readFileSync(ghSum, "utf8");
  check(/ブラウザ連携（WEB利用）は、まだ入りません/.test(sum), "拡張が無いと、はっきり書く");
  check(/初期化/.test(sum), "何をすればよいか書いてある");

  // crx あり
  writeFileSync(join(fake, "dist/eight-ext.crx"), "x");
  writeFileSync(join(fake, "dist/updates.xml"),
    `<gupdate><app appid='${globalThis.__id}'><updatecheck/></app></gupdate>`);
  writeFileSync(ghSum, ""); writeFileSync(ghOut, "");
  run(st, { VERSION: "0.3.0", EXT_ID: globalThis.__id, UPDATE_KEY: "k",
            BASE_URL: "https://mf.8grp.co.jp" }, fake);
  sum = readFileSync(ghSum, "utf8");
  check(sum.includes(globalThis.__id), "要約に拡張の ID が出る");
  check(/鍵から決まったもの/.test(sum), "ID の出どころが書いてある");
  check(/mf\.8grp\.co\.jp\/ext\/`? *に置く/.test(sum), "crx の置き場所が書いてある");
  check(readFileSync(ghOut, "utf8").includes(`crxid=${globalThis.__id}`), "次の手順へ ID を渡す");
}

console.log("— 組み立て: 落とせるものに拡張が入るか —");
{
  const yml = readFileSync(join(ROOT, ".github/workflows/agent-build.yml"), "utf8");
  check(/agent\/dist\/eight-ext\.crx/.test(yml), "crx を落とせる");
  check(/agent\/dist\/updates\.xml/.test(yml), "updates.xml を落とせる");
  // 秘密鍵が混ざっていないこと
  check(!/path:[\s\S]{0,200}\.pem/.test(yml), "秘密鍵は落とせない");
  check(/extension_id=/.test(yml), "release.txt に拡張の ID が入る");
}

console.log("— どの run にも ${{ }} を直書きしていない —");
for (const f of ["agent-build.yml", "agent-test.yml", "extension-init.yml"]) {
  const yml = readFileSync(join(ROOT, ".github/workflows", f), "utf8");
  const inRun = [];
  let on = false;
  for (const line of yml.split("\n")) {
    if (/^\s+run: \|/.test(line)) { on = true; continue; }
    if (on && !/^\s*$/.test(line) && !/^ {10}/.test(line)) on = false;
    if (on && /\$\{\{/.test(line)) inRun.push(line.trim());
  }
  check(inRun.length === 0, `${f}${inRun.length ? ": " + inRun.join(" / ") : ""}`);
}

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
