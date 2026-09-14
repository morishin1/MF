// 「配れる状態にする」ところを、通しで走らせて確かめる。
//
// ■ curl は差し替える
//
//   このサンドボックスでは、curl が同じ機械の中へも出られない。
//   そこで curl の代わりを PATH の先に置き、サーバのふりをさせる。
//   手順そのもの（シェル・JSONの取り出し・止めかた・順番）は
//   1文字も変えずに走る。本物のHTTPだけが、curl の仕事として抜ける。
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const EXE = join(ROOT, "agent/dist/EIGHT-Agent-Setup.exe");

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

if (!existsSync(EXE)) { console.log("NG: 先に agent/build.sh で EXE を作ってください"); process.exit(1); }
const exeBytes = readFileSync(EXE);
const SHA = crypto.createHash("sha256").update(exeBytes).digest("hex");
const SIZE = exeBytes.length;

const dir = mkdtempSync(join(tmpdir(), "rel-"));
const ghOut = join(dir, "out"), ghSum = join(dir, "sum"), ghEnv = join(dir, "env");
for (const f of [ghEnv, ghOut, ghSum]) writeFileSync(f, "");

// ---- 本物の keygen で更新鍵を作る ---------------------------------------------
const keyPath = join(dir, "update.key");
const kg = JSON.parse(execFileSync("go",
  ["run", "./cmd/eight-agent-keygen", "-new", "-out", keyPath, "-json"],
  { cwd: join(ROOT, "agent"), encoding: "utf8" }));
const PUB = kg.public_key, KID = kg.key_id;
const privLine = readFileSync(keyPath, "utf8").trim();

// ---- curl の代わり -------------------------------------------------------------
//
// 受け取った引数を1件ずつ記録して、決めた返事を返す。
// 状態は JSON ファイルでやりとりする（別プロセスなので）
const binDir = join(dir, "bin");
mkdirSync(binDir);
const logFile = join(dir, "calls.jsonl");
const stateFile = join(dir, "state.json");
const store = join(dir, "store");
mkdirSync(store);

writeFileSync(join(binDir, "curl"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
const has = (f) => args.includes(f);
const url = args.find((a) => /^https?:\\/\\//.test(a)) || "";
const st = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const hdrs = args.filter((a, i) => args[i - 1] === "-H");
let body = get("-d");
const df = get("--data-binary");
if (df && df.startsWith("@")) body = fs.readFileSync(df.slice(1));
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
  url, method: get("-X") || (body ? "POST" : "GET"),
  hdrs, body: Buffer.isBuffer(body) ? "<bin:" + body.length + ">" : body,
  out: get("-o"), sha: Buffer.isBuffer(body)
    ? require("node:crypto").createHash("sha256").update(body).digest("hex") : null,
}) + "\\n");

const write = (code, obj, raw) => {
  const o = get("-o");
  const data = raw !== undefined ? raw : JSON.stringify(obj);
  if (o) fs.writeFileSync(o, data); else process.stdout.write(String(data));
  if (has("-w")) process.stdout.write(String(code));
  process.exit(0);
};

// 合言葉を見る。無ければ 401
if (url.includes("/api/devices/release")) {
  if (!hdrs.some((h) => h === "Authorization: Bearer " + st.token)) return write(401, { error: "unauthorized" });
  const b = JSON.parse(String(body || "{}"));
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ action: b.action, sent: b }) + "\\n");
  if (b.action === "begin") {
    if (st.duplicate) return write(409, { error: "version_exists", where: "storage",
      hint: "版 " + b.version + " は既にあります" });
    return write(200, { ok: true, bucket: "agent",
      objectPath: b.version + "/EIGHT-Agent-Setup.exe",
      uploadUrl: "http://x/upload/" + b.version, token: "upl" });
  }
  if (b.action === "verify") {
    const p = ${JSON.stringify(store)} + "/" + b.version;
    if (!fs.existsSync(p)) return write(404, { error: "not_uploaded" });
    const n = fs.statSync(p).size;
    if (b.size_bytes && b.size_bytes !== n) return write(409, { error: "size_mismatch", uploaded: n });
    return write(200, { ok: true, size: n, url: "http://x/read/" + b.version });
  }
  if (b.action === "publish") {
    fs.writeFileSync(${JSON.stringify(dir)} + "/published.json", JSON.stringify(b));
    return write(200, { ok: true, id: "r-1", version: b.version });
  }
  if (b.action === "ext") {
    return write(200, { ok: true, bucket: "agent", objectPath: "ext/" + b.file,
      uploadUrl: "http://x/extupload/" + b.file, token: "upl",
      contentType: b.file.endsWith(".crx") ? "application/x-chrome-extension" : "application/xml" });
  }
  return write(400, { error: "unknown_action" });
}
if (url.includes("/upload/")) {
  fs.writeFileSync(${JSON.stringify(store)} + "/" + url.split("/upload/")[1], body);
  return write(200, { Key: "ok" });
}
if (url.includes("/extupload/")) {
  fs.writeFileSync(${JSON.stringify(store)} + "/ext-" + url.split("/extupload/")[1], body);
  return write(200, { Key: "ok" });
}
if (url.includes("/read/")) {
  const v = url.split("/read/")[1];
  const p = ${JSON.stringify(store)} + "/" + v;
  const raw = st.corrupt ? Buffer.from("bad") : (fs.existsSync(p) ? fs.readFileSync(p) : null);
  if (raw === null) return write(404, "", "no");
  return write(200, null, raw);
}
write(404, { error: "not_found" });
`);
chmodSync(join(binDir, "curl"), 0o755);

const setState = (o) => writeFileSync(stateFile, JSON.stringify({ token: TOKEN, ...o }));
const calls = () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

// ---- run: の取り出し ------------------------------------------------------------
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
const all = steps("agent-build.yml");
const byName = (n) => all.find((s) => s.name === n);

let lastErr = null;
function run(step, env = {}) {
  const sh = join(dir, "s.sh");
  writeFileSync(sh, step.run);
  return execFileSync("bash", [sh], {
    cwd: join(ROOT, step.wd),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`,
           GITHUB_ENV: ghEnv, GITHUB_OUTPUT: ghOut, GITHUB_STEP_SUMMARY: ghSum,
           RUNNER_TEMP: dir, ...env },
    encoding: "utf8", maxBuffer: 64 << 20,
  });
}
const ok = (fn) => { try { fn(); return true; } catch (e) { lastErr = e; return false; } };

const TOKEN = "release-token-0123456789abcdef";
const ENV = { BASE_URL: "https://mf.8grp.co.jp", TOKEN, VERSION: "0.3.1",
              SHA, SIZE: String(SIZE), UPDATE_KEY_PRIV: privLine };

const fresh = () => { writeFileSync(logFile, ""); setState({}); };

// =============================================================================
console.log("— 配る支度ができているか —");
{
  fresh();
  const st = byName("配る支度ができているか見る");
  const go = () => readFileSync(ghOut, "utf8").match(/go=(\d)/)?.[1];
  const t = (env, want, msg) => { writeFileSync(ghOut, ""); run(st, env); check(go() === want, msg); };
  t({ RELEASE_TOKEN: TOKEN, UPDATE_KEY_PRIV: privLine, WANT: "true" }, "1", "そろっていれば進む");
  t({ RELEASE_TOKEN: "", UPDATE_KEY_PRIV: privLine, WANT: "true" }, "0", "合言葉が無ければ止める");
  t({ RELEASE_TOKEN: TOKEN, UPDATE_KEY_PRIV: "", WANT: "true" }, "0", "更新鍵が無ければ止める");
  t({ RELEASE_TOKEN: TOKEN, UPDATE_KEY_PRIV: privLine, WANT: "false" }, "0", "外せば止める");
}

console.log("— 通しで（版を入れて押してから、配れるまで）—");
{
  fresh();
  check(ok(() => run(byName("Storage に置く場所をもらう"), ENV)), "置き場所をもらえる");
  const begun = JSON.parse(readFileSync(join(dir, "begin.json"), "utf8"));
  check(begun.objectPath === "0.3.1/EIGHT-Agent-Setup.exe", "上げ先が版つきのパス");

  check(ok(() => run(byName("Storage へ上げる"), ENV)), "上げられる");
  const up = calls().find((c) => c.url?.includes("/upload/"));
  check(up?.sha === SHA, "上げたのは、組み立てた EXE そのもの");
  check(up?.method === "PUT", "PUT で上げる");
  check(up?.hdrs?.some((h) => /x-upsert: false/i.test(h)), "上書きしない指定を付ける");

  check(ok(() => run(byName("上げたものを読み直して確かめる"), ENV)), "読み直して突き合わせる");

  check(ok(() => run(byName("更新の署名を作る"), ENV)), "署名できる");
  const sig = JSON.parse(readFileSync(join(dir, "sig.json"), "utf8"));
  check(sig.sha256 === SHA, "署名の sha256 が EXE のもの");
  check(sig.size_bytes === SIZE, "署名の大きさが EXE のもの");
  check(sig.object_path === "0.3.1/EIGHT-Agent-Setup.exe", "署名の対象は置き場所");
  check(sig.key_id === KID, `鍵の目印が合う（${sig.key_id}）`);
  check(!existsSync(join(dir, "update.key")), "秘密鍵のファイルを消している");

  // エージェントが焼き込んだ公開鍵でやるのと、同じことをする
  const signed = ["0.3.1", "0.3.1/EIGHT-Agent-Setup.exe", SHA, String(SIZE)].join("\n");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"),
                              Buffer.from(PUB, "base64url")]);
  check(crypto.verify(null, Buffer.from(signed),
    crypto.createPublicKey({ key: spki, format: "der", type: "spki" }),
    Buffer.from(sig.signature, "base64url")), "署名が、その鍵で確かめられる");

  check(ok(() => run(byName("配れる状態にする"), ENV)), "表に入れられる");
  const p = JSON.parse(readFileSync(join(dir, "published.json"), "utf8"));
  check(p.version === "0.3.1" && p.sha256 === SHA && p.size_bytes === SIZE,
        "版・ハッシュ・大きさが渡る");
  check(p.signature === sig.signature && p.key_id === KID, "署名と鍵の目印が渡る");

  check(ok(() => run(byName("ブラウザ拡張を置く"), ENV)), "拡張を置ける");
  const exts = calls().filter((c) => c.url?.includes("/extupload/"));
  check(exts.length === 2, `crx と updates.xml の2つ（${exts.length}）`);
}

console.log("— 止まってほしいところで止まるか —");
{
  fresh(); setState({ duplicate: true });
  check(!ok(() => run(byName("Storage に置く場所をもらう"), ENV)), "同じ版があれば止まる");
  check(/既にあります/.test(String(lastErr?.stdout || "")), "何が起きたか出る");

  fresh();
  run(byName("Storage に置く場所をもらう"), ENV);
  run(byName("Storage へ上げる"), ENV);
  setState({ corrupt: true });
  check(!ok(() => run(byName("上げたものを読み直して確かめる"), ENV)),
        "読み直して中身が違えば止まる");
  check(/中身が違います/.test(String(lastErr?.stdout || "")), "何が起きたか出る");

  fresh();
  check(!ok(() => run(byName("更新の署名を作る"), { ...ENV, UPDATE_KEY_PRIV: "こわれた鍵" })),
        "鍵が読めなければ、署名せずに止まる");
}

console.log("— できあがりの出し方 —");
{
  const st = byName("できあがりを出す");
  writeFileSync(ghSum, "");
  run(st, { ...ENV, CRXID: "l".repeat(32), KID, EXTDONE: "1", RESULT: "success" });
  let sum = readFileSync(ghSum, "utf8");
  for (const [re, label] of [
    [/✅ EXE を作った/, "EXE を作った"],
    [/✅ Chrome . Edge 拡張を作った/, "Chrome / Edge 拡張を作った"],
    [/✅ Storage へ上げた/, "Storage へ上げた"],
    [/✅ 更新の署名を付けた/, "更新の署名を付けた"],
    [/✅ gw_device_releases に登録した/, "gw_device_releases に登録した"],
    [/✅ 拡張を \S+\/ext\/ に置いた/, "拡張を /ext/ に置いた"],
  ]) {
    check(re.test(sum), `✅ ${label}`);
  }
  check(/配れる状態にしました/.test(sum), "配れると書いてある");
  check(/手でやることはもうありません/.test(sum), "手作業が残っていないと書いてある");
  check(!sum.includes(TOKEN) && !sum.includes(privLine), "合言葉も秘密鍵も出ていない");

  writeFileSync(ghSum, "");
  run(st, { ...ENV, CRXID: "", KID: "", EXTDONE: "", RESULT: "failure" });
  sum = readFileSync(ghSum, "utf8");
  check(/配れる状態になっていません/.test(sum), "落ちたときは、できたと言わない");
  check(/⬜/.test(sum), "できていないところに印が付く");
}

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
