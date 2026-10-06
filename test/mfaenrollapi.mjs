// 二段階認証の登録（POST /api/mfa の enroll → verify、GET /api/mfa）。
//
// ■ 何を守るテストか
//   1. 登録の応答は { id, totp: { secret, uri } } だけ。GoTrue の qr_code（生の SVG）・想定外の項目は返さない
//      （生の SVG を <img src> に入れると画像欠落になる不具合の再発防止。QR は画面が uri から自分で作る）
//   2. uri は otpauth://totp/…（secret が手入力キーと一致・SHA1・6桁・30秒）。日本語・記号の issuer でも壊れない
//   3. 秘密の情報（secret・uri・QR）は、console にも監査ログにも入らない。エラーの応答にも入らない。URL にも載らない
//   4. 応答は端末・プロキシに残さない（Cache-Control: no-store）
//   5. 登録のたびに、新しい秘密鍵が発行される
//   6. 6桁が合えば登録できる（RFC 6238 の計算で確かめる）。合わなければ 400。登録後は「登録済み」
//   7. GoTrue の応答が欠けたら、中身を出さずに 502。MFA が無効なら 409
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { totp, parseOtpauth, makeFakeGoTrue, RAW_QR_MARKER } from "./fixtures/totp.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

process.env.SUPABASE_URL = "https://gotrue.test";
process.env.SUPABASE_ANON_KEY = "anon-key";

// ---- 模擬 ------------------------------------------------------------------------
const audit = [];
const deleted = [];
const chain = () => new Proxy({}, { get: (_, k) => (k === "then" ? (fn) => Promise.resolve({ data: [], error: null }).then(fn) : () => chain()) });
mock.module(atRoot("lib/supabase.js"), { namedExports: {
  admin: () => ({ from: () => chain(), auth: { admin: { mfa: { deleteFactor: async (a) => { deleted.push(a); return { error: null }; } } } } }),
  userClient: () => ({ from: () => chain() }),
} });
let userFactors = [];
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u1", email: "taro@example.co.jp", factors: userFactors }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { audit.push(e); } } });
const REAL_GW = await import(atRoot("lib/gw.js"));
const CTX = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: false, roles: [], employee: { id: "e1", display_name: "森田 太郎" } };
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => CTX } });

const { default: mfa } = await import(atRoot("api/mfa.js"));

// GoTrue（fetch の向こう）。送った URL・本文を記録する
let gotrue = makeFakeGoTrue();
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  assert.ok(u.startsWith("https://gotrue.test/auth/v1"), `想定外の通信先: ${u.slice(0, 60)}`);
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  sent.push({ url: u, method: opts.method || "GET", body });
  const r = gotrue.handle(opts.method || "GET", u.slice("https://gotrue.test/auth/v1".length), body);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
};

// console の出力を記録する（秘密の情報が出ていないことを見る）
const logs = [];
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
const say = process.stdout.write.bind(process.stdout);
const print = (...a) => say(a.join(" ") + "\n");

const jwt = (aal) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (method, body) => {
  const r = res();
  await mfa({ method, url: "/api/mfa", body, headers: { authorization: `Bearer ${jwt("aal1")}` } }, r);
  return r;
};
const enroll = () => call("POST", { action: "enroll" });
const verify = (factorId, code) => call("POST", { action: "verify", factorId, code });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  const b = { logs: logs.length, audit: audit.length };
  try { await fn(b); pass++; print("  ok", name); }
  catch (e) { fail++; print("  NG", name, "\n     ", e.message); }
};
const reset = () => { gotrue = makeFakeGoTrue(); sent.length = 0; audit.length = 0; logs.length = 0; deleted.length = 0; userFactors = []; };
const everything = () => JSON.stringify({ logs, audit });

print("\n=== 登録を始める（enroll）===\n");

await ok("応答は { id, totp: { secret, uri } } だけ。qr_code（生の SVG）・想定外の項目は返さない", async () => {
  reset();
  const r = await enroll();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body).sort(), ["id", "totp"]);
  assert.deepEqual(Object.keys(r.body.totp).sort(), ["secret", "uri"]);
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes(RAW_QR_MARKER) && !raw.includes("<svg") && !raw.includes("<?xml") && !raw.includes("qr_code"), "GoTrue の生の SVG を渡していない");
  assert.ok(!raw.includes("friendly_name") && !raw.includes("type"), "GoTrue の応答本文を、そのまま返していない");
});

await ok("uri は otpauth://totp/… で、secret が手入力キーと一致する（SHA1・6桁・30秒）", async () => {
  reset();
  const b = (await enroll()).body;
  const p = parseOtpauth(b.totp.uri);
  assert.ok(p, "otpauth://totp/ の形");
  assert.equal(p.secret, b.totp.secret, "QR の中身と手入力キーが同じ");
  assert.match(b.totp.secret, /^[A-Z2-7]{32}$/, "base32・160bit");
  assert.deepEqual([p.algorithm, p.digits, p.period, p.issuer], ["SHA1", "6", "30", "gw.8grp.co.jp"]);
  assert.equal(p.label, "gw.8grp.co.jp:taro@example.co.jp");
  assert.ok(!/[ \n\t]/.test(b.totp.uri), "空白・改行を含まない（パーセントエンコード済み）");
});

await ok("日本語・記号の issuer / アカウント名でも、uri は壊れない（GoTrue のエンコードをそのまま通す）", async () => {
  reset();
  gotrue = makeFakeGoTrue({ issuer: "エイト & Co+", account: "森田 太郎+test@例え.jp" });
  const b = (await enroll()).body;
  assert.match(b.totp.uri, /^otpauth:\/\/totp\/%E3%82%A8%E3%82%A4%E3%83%88/);
  const p = parseOtpauth(b.totp.uri);
  assert.equal(p.issuer, "エイト & Co+");
  assert.equal(p.label, "エイト & Co+:森田 太郎+test@例え.jp");
  assert.equal(p.secret, b.totp.secret);
});

await ok("登録のたびに、新しい秘密鍵が発行される（使い回さない）", async () => {
  reset();
  const seen = new Set();
  for (let i = 0; i < 5; i++) seen.add((await enroll()).body.totp.secret);
  assert.equal(seen.size, 5);
});

await ok("応答は端末・プロキシに残さない（Cache-Control: no-store）", async () => {
  reset();
  assert.equal((await enroll()).headers["cache-control"], "no-store");
});

await ok("途中でやめた未確認の登録は、先に片付ける。登録済みのものは消さない", async () => {
  reset();
  userFactors = [{ id: "old-unverified", status: "unverified", factor_type: "totp" }, { id: "keep", status: "verified", factor_type: "totp" }];
  await enroll();
  assert.deepEqual(deleted.map((d) => d.id), ["old-unverified"]);
});

await ok("uri が無くても、secret があれば手入力で登録できる（uri は null）", async () => {
  reset();
  gotrue.st.breakEnroll = (full) => { delete full.totp.uri; return full; };
  const r = await enroll();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.totp.uri, null);
  assert.ok(r.body.totp.secret);
});

print("\n=== 欠けた応答・失敗（中身を出さない）===\n");

await ok("totp や secret が欠けた応答: 502。GoTrue の本文は返さない（画面は固まらず、やり直せる）", async () => {
  for (const [label, brk] of [["totp なし", (f) => { delete f.totp; return f; }], ["secret なし", (f) => { delete f.totp.secret; return f; }],
    ["id なし", (f) => { delete f.id; return f; }], ["totp が null", (f) => ({ ...f, totp: null })]]) {
    reset();
    gotrue.st.breakEnroll = brk;
    const r = await enroll();
    assert.equal(r.statusCode, 502, label);
    assert.equal(r.body.error, "auth_failed", label);
    assert.equal(r.body.hint, "登録用の情報を受け取れませんでした。もう一度お試しください", label);
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("otpauth") && !raw.includes(RAW_QR_MARKER) && !/[A-Z2-7]{32}/.test(raw), `${label}: 秘密の情報が入っている`);
    assert.equal(audit.filter((a) => a.action === "mfa.enroll_start").length, 0, `${label}: 始まっていないので記録しない`);
  }
});

await ok("MFA が無効（GoTrue 422）: 409 mfa_not_enabled。GoTrue のそれ以外の失敗: 502。どちらも秘密の情報なし", async () => {
  reset();
  gotrue.st.notEnabled = true;
  const r = await enroll();
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "mfa_not_enabled");
  assert.ok(!JSON.stringify(r.body).includes("otpauth"));
  // それ以外の失敗（GoTrue の 500）: 502。GoTrue のメッセージだけを返し、ほかは返さない
  reset();
  gotrue.handle = () => ({ status: 500, body: { code: 500, msg: "upstream boom", totp: { secret: "LEAKCHECKLEAKCHECKLEAKCHECK2222", uri: "otpauth://totp/x?secret=LEAKCHECK" } } });
  const r2 = await enroll();
  assert.equal(r2.statusCode, 502);
  assert.deepEqual(r2.body, { error: "auth_failed", hint: "upstream boom" });
  assert.ok(!JSON.stringify(r2.body).includes("LEAKCHECK"), "失敗の応答に、GoTrue の本文の秘密の情報を含めない");
});

print("\n=== 6桁で確かめて登録する（verify）===\n");

await ok("6桁が合えば登録できる。aal2 のセッションが返る。監査は mfa.enroll（要素の ID だけ）", async () => {
  reset();
  const e = (await enroll()).body;
  const code = totp(parseOtpauth(e.totp.uri).secret);      // QR から取り出した secret で、認証アプリの代わりに計算する
  const r = await verify(e.id, code);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, "mfa.enroll");
  assert.equal(r.body.session.access_token, "aal2-token");
  assert.deepEqual(gotrue.verified(), [e.id]);
  const a = audit.find((x) => x.action === "mfa.enroll");
  assert.deepEqual(a.detail, { factorId: e.id, afterReset: false });
  assert.ok(!JSON.stringify(r.body).includes(e.totp.secret), "確認の応答に、秘密の情報を含めない");
});

await ok("手入力キー（secret）で計算した 6桁でも、同じ結果（QR で読んでも手入力でも、同じ鍵）", async () => {
  reset();
  const e = (await enroll()).body;
  assert.equal(totp(e.totp.secret), totp(parseOtpauth(e.totp.uri).secret));
  assert.equal((await verify(e.id, totp(e.totp.secret))).statusCode, 200);
});

await ok("6桁が合わなければ 400 mfa_code_invalid。登録されない・記録されない。入れた 6桁も返さない", async () => {
  reset();
  const e = (await enroll()).body;
  const good = totp(e.totp.secret);
  const bad = good === "000000" ? "000001" : "000000";
  const r = await verify(e.id, bad);
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "mfa_code_invalid");
  assert.ok(!JSON.stringify(r.body).includes(bad) && !JSON.stringify(r.body).includes(e.totp.secret));
  assert.deepEqual(gotrue.verified(), []);
  assert.equal(audit.filter((x) => x.action === "mfa.enroll" || x.action === "mfa.reenroll").length, 0);
  // 間違えたあとでも、正しい 6桁で登録できる
  assert.equal((await verify(e.id, good)).statusCode, 200);
});

await ok("形が違う入力（5桁・英字・空・factorId なし）は 400 bad_request。GoTrue へ送らない", async () => {
  reset();
  const e = (await enroll()).body;
  const before = sent.length;
  for (const code of ["12345", "1234567", "abcdef", "", "12 345"]) assert.equal((await verify(e.id, code)).body.error, "bad_request", code);
  assert.equal((await verify("", "123456")).body.error, "bad_request");
  assert.equal(sent.length, before, "GoTrue を呼んでいない");
});

await ok("登録後は「登録済み」: GET /api/mfa が verified の要素を返す。未登録のときは空", async () => {
  reset();
  assert.deepEqual((await call("GET")).body.factors, []);
  const e = (await enroll()).body;
  await verify(e.id, totp(e.totp.secret));
  userFactors = [{ id: e.id, status: "verified", factor_type: "totp", friendly_name: "エイト" }];   // 次の要求では、Supabase の user に載る
  const st = (await call("GET")).body;
  assert.deepEqual(st.factors, [{ id: e.id, status: "verified", name: "エイト" }]);
  assert.ok(!JSON.stringify(st).includes(e.totp.secret), "状態の応答に、秘密の情報を含めない");
});

await ok("登録し直し（すでに登録済みの人）は mfa.reenroll", async () => {
  reset();
  userFactors = [{ id: "was", status: "verified", factor_type: "totp" }];
  const e = (await enroll()).body;
  const r = await verify(e.id, totp(e.totp.secret));
  assert.equal(r.body.action, "mfa.reenroll");
});

print("\n=== 秘密の情報を、ログ・監査・URL・エラーに出さない ===\n");

await ok("登録（成功・失敗・欠けた応答）を通しても、console にも監査ログにも、secret・uri・QR・6桁が入らない", async () => {
  reset();
  const secrets = [];
  const codes = [];
  // 成功
  let e = (await enroll()).body; secrets.push(e.totp.secret, e.totp.uri);
  let c = totp(e.totp.secret); codes.push(c);
  await verify(e.id, c);
  // 失敗（6桁の誤り）
  e = (await enroll()).body; secrets.push(e.totp.secret, e.totp.uri);
  const good = totp(e.totp.secret); const bad = good === "111111" ? "222222" : "111111"; codes.push(bad);
  await verify(e.id, bad);
  // 欠けた応答
  gotrue.st.breakEnroll = (f) => { delete f.totp.secret; return f; };
  await enroll();
  gotrue.st.breakEnroll = null;
  // MFA が無効
  gotrue.st.notEnabled = true; await enroll(); gotrue.st.notEnabled = false;
  const dump = everything();
  for (const s of secrets) assert.ok(!dump.includes(s), "秘密の情報がログ・監査に入っている");
  for (const s of secrets.filter((x) => !x.startsWith("otpauth"))) assert.ok(!dump.toLowerCase().includes(s.toLowerCase()), "大文字小文字を変えても入っていない");
  for (const k of codes) assert.ok(!dump.includes(`"${k}"`) && !new RegExp(`(^|[^0-9])${k}([^0-9]|$)`).test(dump), `6桁 ${k} が入っている`);
  assert.ok(!/otpauth|qr_code|<svg|secret/i.test(dump), "otpauth・qr_code・svg・secret の語が、ログ・監査に入っていない");
  assert.equal(logs.length, 0, `console に出ている: ${logs.join(" | ").slice(0, 120)}`);
});

await ok("監査ログの mfa.enroll_start は、要素の ID だけ（detail のキーが factorId のみ）", async () => {
  reset();
  await enroll();
  const a = audit.filter((x) => x.action === "mfa.enroll_start");
  assert.equal(a.length, 1);
  assert.deepEqual(Object.keys(a[0].detail), ["factorId"]);
  assert.equal(a[0].target, "user:u1");
});

await ok("GoTrue への通信の URL に、秘密の情報・6桁を載せない（本文だけ）。通信先は GoTrue だけ", async () => {
  reset();
  const e = (await enroll()).body;
  const c = totp(e.totp.secret);
  await verify(e.id, c);
  for (const s of sent) {
    assert.ok(!s.url.includes(e.totp.secret) && !s.url.includes(c) && !s.url.includes("otpauth") && !s.url.includes("?"), s.url);
    assert.ok(s.url.startsWith("https://gotrue.test/auth/v1/"), "外部の QR 生成サービスなどへ送っていない");
  }
  assert.deepEqual(sent.map((s) => s.url.replace("https://gotrue.test/auth/v1", "").replace(/factor-\d+/, "F").replace(/challenge-\d+/, "C")),
    ["/factors", "/factors/F/challenge", "/factors/F/verify"]);
});

await ok("api/mfa.js に、console・外部 URL・qr_code の受け渡しが無い（静的に確認）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(atRoot("api/mfa.js"), "utf8").replace(/(^|[ \t])\/\/.*$/gm, "");
  assert.ok(!/console\./.test(src), "console を使っている");
  assert.ok(!/qr_code|qrserver|chart\.googleapis/i.test(src), "qr_code を扱っている");
  assert.deepEqual([...src.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]), []);
});

print(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
