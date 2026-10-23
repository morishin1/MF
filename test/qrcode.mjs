// 二段階認証の QR（js/qr.js ＋ 同梱の js/vendor/qrcode-generator.js）。
//
// ■ 何を守るのか
//   1. 作った QR を、実際のデコーダ（jsQR）で読み取ると、元の URI に戻る（画面に出す SVG の中身そのもので確かめる）
//   2. 日本語・記号を含む URI（issuer・アカウント名）でも壊れない（同梱ライブラリの既定は ISO-8859-1 で、日本語を壊す）
//   3. 作れないとき（長すぎる・空・ライブラリが無い）は、固定の短い例外。**URI・秘密の情報が、例外に入らない**
//   4. ログを出さない・外部へ通信しない（外部の QR 生成サービスへ秘密の情報を送らない）
//   5. SVG に、スクリプト・外部参照・画像を含まない（インラインで出しても安全）
//   6. 同梱ライブラリを、勝手に書き換えていない（SHA-256）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import jsQR from "jsqr";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR = readFileSync(join(ROOT, "js/vendor/qrcode-generator.js"), "utf8");
const WRAPPER = readFileSync(join(ROOT, "js/qr.js"), "utf8");

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

/** ブラウザと同じ読み込み順（vendor → qr.js）で、classic script として読む。console と通信の呼び出しを記録する */
function load({ withVendor = true } = {}) {
  const logs = [];
  const net = [];
  const sandbox = {
    console: Object.fromEntries(["log", "info", "warn", "error", "debug"].map((k) => [k, (...a) => logs.push([k, a])])),
    fetch: (...a) => { net.push(a); throw new Error("no network"); },
    XMLHttpRequest: function () { net.push(["xhr"]); throw new Error("no network"); },
    URLSearchParams,   // ブラウザには標準である（vm の空の環境には無い）
  };
  sandbox.window = sandbox;
  createContext(sandbox);
  if (withVendor) runInContext(VENDOR, sandbox);
  runInContext(WRAPPER, sandbox);
  return { KPQr: sandbox.KPQr, logs, net, sandbox };
}
const { KPQr, logs, net } = load();

/** SVG の path（M x yh w v1 h-w z）から、マスの並びを取り戻す（画面に出す SVG そのものを読む） */
function matrixFromSvg(svg) {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.ok(vb, "viewBox が無い");
  const total = Number(vb[1]);
  const d = /<path d="([^"]*)" fill="#000"\/>/.exec(svg)[1];
  const grid = Array.from({ length: total }, () => Array(total).fill(false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i++) grid[y][x + i] = true;
  }
  return { total, grid };
}

/** マスの並びを、白地に黒の画像（RGBA）にして jsQR で読む */
function decode({ total, grid }, scale = 8) {
  const w = total * scale;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < total; y++) for (let x = 0; x < total; x++) {
    if (!grid[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = ((y * scale + dy) * w + (x * scale + dx)) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  }
  return jsQR(data, w, w);
}
const roundTrip = (text) => {
  const svg = KPQr.svg(text);
  const r = decode(matrixFromSvg(svg));
  assert.ok(r, `読み取れない: ${text.slice(0, 40)}…`);
  return { svg, text: Buffer.from(r.binaryData).toString("utf8"), bytes: Buffer.from(r.binaryData) };
};

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URIS = {
  "GoTrue の形（issuer=サイトのホスト・アカウント=メール）":
    `otpauth://totp/gw.8grp.co.jp:s_morita%40gw.8grp.co.jp?algorithm=SHA1&digits=6&issuer=gw.8grp.co.jp&period=30&secret=${SECRET}`,
  "日本語の issuer・アカウント名（パーセントエンコード済み）":
    `otpauth://totp/%E3%82%A8%E3%82%A4%E3%83%88:%E6%A3%AE%E7%94%B0%20%E5%A4%AA%E9%83%8E?issuer=%E3%82%A8%E3%82%A4%E3%83%88&secret=${SECRET}&period=30`,
  "日本語そのまま（エンコードされていなくても、UTF-8 のまま読み取れる）":
    `otpauth://totp/エイト:森田 太郎?issuer=エイト&secret=${SECRET}`,
  "記号（+ & % @ = スペース）を含むアカウント名":
    `otpauth://totp/Ei%2Bght%26Co:a%2Bb%40c.jp?issuer=Ei%2Bght%26Co&secret=${SECRET}&digits=6`,
  "長いメール・長い issuer":
    `otpauth://totp/${"a".repeat(40)}.example.co.jp:${"very.long.mail.address.".repeat(3)}x%40${"sub.".repeat(6)}example.co.jp?issuer=${"a".repeat(40)}.example.co.jp&secret=${SECRET}&algorithm=SHA1&digits=6&period=30`,
  "最短": "otpauth://totp/a?secret=ABCDEFGH",
};

console.log("— 作った QR を、デコーダで読み取る（画面に出す SVG そのもの）—");
for (const [name, uri] of Object.entries(URIS)) {
  ok(`元の URI に戻る: ${name}`, () => {
    const r = roundTrip(uri);
    assert.equal(r.text, uri);
    assert.deepEqual([...r.bytes], [...Buffer.from(uri, "utf8")], "UTF-8 のバイト列そのまま（ISO-8859-1 に壊れていない）");
  });
}

ok("SVG の path から取り戻したマスと、ライブラリのマスが一致する（SVG の作りが正しい）", () => {
  const uri = URIS["GoTrue の形（issuer=サイトのホスト・アカウント=メール）"];
  const m = KPQr.matrix(uri);
  const g = matrixFromSvg(KPQr.svg(uri));
  const margin = (g.total - m.size) / 2;
  assert.equal(margin, 4, "周りの余白は 4 マス（QR の規格）");
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) assert.equal(g.grid[r + margin][c + margin], m.dark(r, c), `(${r},${c})`);
  // 余白は白
  assert.ok(g.grid[0].every((v) => !v) && g.grid.every((row) => !row[0]));
});

ok("並びの再現: 別の大きさ（scale 3 と 12）でも読み取れる（読み取りアプリの解像度が違っても大丈夫）", () => {
  const uri = URIS["日本語の issuer・アカウント名（パーセントエンコード済み）"];
  const g = matrixFromSvg(KPQr.svg(uri));
  for (const scale of [4, 12]) assert.equal(Buffer.from(decode(g, scale).binaryData).toString("utf8"), uri);
});

ok("大きさは、URI の長さに合わせて自動で決まる（長い URI のほうが大きい）", () => {
  const a = KPQr.matrix(URIS["最短"]).size, b = KPQr.matrix(URIS["長いメール・長い issuer"]).size;
  assert.ok(b > a, `${a} < ${b}`);
  assert.ok(a >= 21 && (a - 17) % 4 === 0, "QR の規格の大きさ（21, 25, …）");
});

console.log("\n— SVG の安全性 —");

ok("SVG は、path と rect だけ。スクリプト・外部参照・画像・イベント属性・xml 宣言を含まない", () => {
  const svg = KPQr.svg(URIS["日本語の issuer・アカウント名（パーセントエンコード済み）"], { label: "二段階認証のQRコード" });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.ok(!/<\?xml|<script|<image|<foreignObject|<use|<a[ >]|xlink|javascript:|\son\w+=/i.test(svg), svg.slice(0, 200));
  assert.deepEqual([...svg.matchAll(/<(\w+)/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), ["path", "rect", "svg"]);
  assert.equal([...svg.matchAll(/https?:\/\//g)].length, 1, "http(s):// は xmlns の1つだけ（外部の参照はない）");
  assert.match(svg, /aria-label="二段階認証のQRコード"/);
  assert.match(svg, /role="img"/);
});

ok("label の記号は、属性の中で無害化される", () => {
  const svg = KPQr.svg(URIS["最短"], { label: `x" onload="alert(1)` });
  assert.ok(!/onload="alert/.test(svg));
  assert.match(svg, /aria-label="x&quot; onload=&quot;alert\(1\)"/);
});

ok("URI の文字は、SVG のどこにも入らない（数字と path だけで組み立てる）", () => {
  const marker = "SECRETMARKER7788";
  const svg = KPQr.svg(`otpauth://totp/a?secret=${marker}`);
  assert.ok(!svg.includes(marker) && !svg.includes("otpauth"));
});

console.log("\n— 作れないとき：固定の短い例外。秘密の情報を入れない —");

const messageOf = (fn) => { try { fn(); } catch (e) { return String(e && e.message); } return null; };
ok("長すぎる（QR に入らない）: 例外。メッセージに、入力の文字が入らない", () => {
  const marker = "SECRETMARKER9911";
  const m = messageOf(() => KPQr.svg(`otpauth://totp/a?secret=${marker}` + "x".repeat(5000)));
  assert.ok(m, "例外になる");
  assert.ok(!m.includes(marker) && !m.includes("otpauth") && !m.includes("xxxx"), m);
});
ok("空・文字列でない: qr_empty", () => {
  for (const v of ["", null, undefined, 123, {}]) assert.equal(messageOf(() => KPQr.svg(v)), "qr_empty", String(v));
});
ok("ライブラリが読み込めていない: qr_lib_missing（画面は手入力の案内に切り替える）", () => {
  const { KPQr: K } = load({ withVendor: false });
  assert.equal(messageOf(() => K.svg(URIS["最短"])), "qr_lib_missing");
});

console.log("\n— otpauthSecret（QR の中身と手入力キーが同じか）—");

ok("secret を取り出す。小文字・空白は正規化。日本語の issuer でも取れる", () => {
  assert.equal(KPQr.otpauthSecret(URIS["GoTrue の形（issuer=サイトのホスト・アカウント=メール）"]), SECRET);
  assert.equal(KPQr.otpauthSecret(URIS["日本語の issuer・アカウント名（パーセントエンコード済み）"]), SECRET);
  assert.equal(KPQr.otpauthSecret(URIS["日本語そのまま（エンコードされていなくても、UTF-8 のまま読み取れる）"]), SECRET);
  assert.equal(KPQr.otpauthSecret("otpauth://totp/a?secret=abcd%20efgh"), "ABCDEFGH");
  assert.equal(KPQr.otpauthSecret("OTPAUTH://TOTP/a?issuer=x&secret=ABCDEFGH&period=30"), "ABCDEFGH");
});
ok("形が違えば null（otpauth でない・hotp・secret なし・クエリなし・文字列でない）", () => {
  for (const v of [null, undefined, "", 5, "https://example.com/?secret=ABCD", "otpauth://hotp/a?secret=ABCD", "otpauth://totp/a?issuer=x", "otpauth://totp/a", "otpauth://totp/a?secret="]) {
    assert.equal(KPQr.otpauthSecret(v), null, String(v));
  }
});

console.log("\n— ログ・通信・ファイルの中身 —");

ok("QR を作っても、console にも通信にも何も出さない（成功時も失敗時も）", () => {
  for (const u of Object.values(URIS)) KPQr.svg(u);
  messageOf(() => KPQr.svg("x".repeat(9000)));
  messageOf(() => KPQr.svg(""));
  assert.deepEqual(logs, [], JSON.stringify(logs));
  assert.deepEqual(net, []);
});

ok("js/qr.js は、fetch・XMLHttpRequest・Image・外部 URL・console・eval を使わない（外部へ秘密の情報を送らない）", () => {
  // コメントを除く。行末の // は「空白の直後」だけ（文字列の中の http:// を消さない）
  const code = WRAPPER.replace(/(^|[ \t])\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const w of ["fetch(", "XMLHttpRequest", "new Image", "sendBeacon", "WebSocket", "console.", "eval(", "new Function", "document.", "localStorage", "chart.googleapis", "qrserver"]) {
    assert.ok(!code.includes(w), `${w} を使っている`);
  }
  assert.deepEqual([...code.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]), ["http://www.w3.org/2000/svg"]);
});

ok("同梱ライブラリは、配布物のまま（SHA-256 が README と一致・MIT の表示がある）", () => {
  const sha = createHash("sha256").update(readFileSync(join(ROOT, "js/vendor/qrcode-generator.js"))).digest("hex");
  assert.equal(sha, "79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c");
  const readme = readFileSync(join(ROOT, "js/vendor/README.md"), "utf8");
  assert.ok(readme.includes(sha) && readme.includes("MIT") && readme.includes("Kazuhiko Arase") && readme.includes("2.0.4"));
  assert.match(VENDOR, /Licensed under the MIT license/);
});

ok("画面（mypage.html）は、QR のライブラリを、登録を始めたときだけ読む。版は、同じページの js/layout.js と同じ（版の文字列を新たに持たない）", () => {
  const html = readFileSync(join(ROOT, "mypage.html"), "utf8");
  assert.ok(!/<script[^>]*src="[^"]*(qr\.js|qrcode-generator)/.test(html), "ふだんのマイページで、静的に読み込まない");
  const load = html.indexOf("async function loadQr()"), start = html.indexOf("async function mfaStart");
  assert.ok(load > 0 && start > load, "loadQr が mfaStart より前にある");
  const body = html.slice(load, start);
  assert.ok(body.includes("js/vendor/qrcode-generator.js") && body.includes("js/qr.js"), "2つのファイルを読む");
  assert.ok(body.indexOf("qrcode-generator.js") < body.indexOf("js/qr.js"), "ライブラリ → js/qr.js の順");
  assert.ok(body.includes('script[src*="js/layout.js"]') && body.includes('searchParams.get("v")'), "版は js/layout.js から取る");
  assert.ok(!/\?v=\d/.test(html.slice(load, start + 3000)), "QR まわりに、版の数字を書いていない（サイト全体の版と食い違わない）");
  assert.match(html.slice(start, start + 2500), /const qrReady = loadQr\(\)/, "登録の要求と並行して読み込む");
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
