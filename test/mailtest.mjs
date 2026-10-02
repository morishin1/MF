// メール送信の窓口（lib/mail/）。送信サービスを交換できること、未設定では実送信しないこと。
//
// ■ 何を守るのか
//   1. 送信元は環境変数（HR_ONBOARDING_FROM）から読む。コードに直接書かない
//   2. 何かが足りなければ「未設定」。実送信はせず、例外も投げず、理由を返す（案内URLをコピーして渡す）
//   3. MAIL_SEND_ENABLED=1 が無ければ、設定がそろっていても送らない（本番でも、明示するまで送らない）
//   4. 送信サービスは差し替えられる。窓口（sendMail）と、呼ぶ側は変わらない
//   5. 宛先・件名は検査する（形式・改行）。失敗は履歴に残せる形で返す（例外にしない）
//   6. Resend の呼び方（宛先・送信元・件名・本文・返信先・認証ヘッダー）
import assert from "node:assert/strict";
import { mailConfig, sendMail, isEmail, addressOf, ADAPTERS, SENDER_ENV } from "../lib/mail/index.js";
import * as resend from "../lib/mail/resend.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const FULL = { MAIL_PROVIDER: "resend", HR_ONBOARDING_FROM: "エイト 人事 <hr@example.com>", RESEND_API_KEY: "re_test", MAIL_SEND_ENABLED: "1" };
const MSG = { to: "taro@example.com", subject: "件名", text: "本文" };

console.log("— 設定 —");

await ok("送信元の環境変数は HR_ONBOARDING_FROM", async () => {
  assert.equal(SENDER_ENV.onboarding, "HR_ONBOARDING_FROM");
});

await ok("すべてそろえば「設定済み」。送信元は環境変数のとおり", async () => {
  const c = mailConfig("onboarding", FULL);
  assert.equal(c.configured, true);
  assert.equal(c.provider, "resend");
  assert.equal(c.from, "エイト 人事 <hr@example.com>");
  assert.equal(c.fromAddress, "hr@example.com");
  assert.equal(c.reason, null);
});

await ok("何も設定していなければ「未設定」。理由が出る", async () => {
  const c = mailConfig("onboarding", {});
  assert.equal(c.configured, false);
  assert.match(c.reason, /MAIL_PROVIDER/);
});

await ok("1つ欠けても未設定。欠けているものを理由に言う（提供元・送信元・鍵・有効化）", async () => {
  const cases = [
    [{ ...FULL, MAIL_PROVIDER: "" }, /MAIL_PROVIDER が設定されていません/],
    [{ ...FULL, MAIL_PROVIDER: "unknown" }, /対応する送信部品がありません/],
    [{ ...FULL, HR_ONBOARDING_FROM: "" }, /HR_ONBOARDING_FROM が設定されていません/],
    [{ ...FULL, HR_ONBOARDING_FROM: "not-an-address" }, /形式が正しくありません/],
    [{ ...FULL, RESEND_API_KEY: "" }, /RESEND_API_KEY/],
    [{ ...FULL, MAIL_SEND_ENABLED: "" }, /MAIL_SEND_ENABLED=1/],
    [{ ...FULL, MAIL_SEND_ENABLED: "true" }, /MAIL_SEND_ENABLED=1/],
  ];
  for (const [env, re] of cases) {
    const c = mailConfig("onboarding", env);
    assert.equal(c.configured, false, JSON.stringify(env));
    assert.match(c.reason, re);
  }
});

await ok("アドレスの取り出し・検査", async () => {
  assert.equal(addressOf("A <a@b.co>"), "a@b.co");
  assert.equal(addressOf("a@b.co"), "a@b.co");
  assert.equal(addressOf("A <bad>"), null);
  assert.equal(isEmail("a@b.co"), true);
  for (const bad of ["", "a", "a@b", "a b@c.co", "a@b.co, c@d.co", "<a@b.co>", null]) assert.equal(isEmail(bad), false, String(bad));
});

console.log("— 未設定では実送信しない —");

await ok("未設定: 呼ばれても fetch しない。例外を投げず skipped と理由を返す", async () => {
  let called = 0;
  const r = await sendMail(MSG, { env: {}, fetchImpl: async () => { called++; return { ok: true, json: async () => ({}) }; } });
  assert.equal(called, 0);
  assert.equal(r.status, "skipped");
  assert.equal(r.provider, "none");
  assert.match(r.error, /MAIL_PROVIDER/);
});

await ok("設定がそろっていても、MAIL_SEND_ENABLED が無ければ送らない（本番でも明示するまで止まっている）", async () => {
  let called = 0;
  const r = await sendMail(MSG, { env: { ...FULL, MAIL_SEND_ENABLED: "" }, fetchImpl: async () => { called++; return { ok: true, json: async () => ({}) }; } });
  assert.equal(called, 0);
  assert.equal(r.status, "skipped");
});

console.log("— 交換できる —");

await ok("別の送信サービスの部品を差し込める。窓口と呼び方は同じ", async () => {
  const sent = [];
  const fake = {
    name: "fake",
    ready: (env) => (env.FAKE_KEY ? { ok: true } : { ok: false, reason: "FAKE_KEY が設定されていません" }),
    send: async (m) => { sent.push(m); return { id: "fake-1" }; },
  };
  const env = { MAIL_PROVIDER: "fake", HR_ONBOARDING_FROM: "hr@example.com", FAKE_KEY: "k", MAIL_SEND_ENABLED: "1" };
  // 窓口の ADAPTERS を差し替えるのではなく、同じ形の部品を渡す
  const c = mailConfig("onboarding", env);
  assert.equal(c.configured, false, "登録されていない提供元は、使えない（勝手に送らない）");
  ADAPTERS.fake = fake;
  try {
    assert.equal(mailConfig("onboarding", env).configured, true);
    const r = await sendMail(MSG, { env });
    assert.equal(r.status, "sent");
    assert.equal(r.provider, "fake");
    assert.equal(r.providerMessageId, "fake-1");
    assert.deepEqual(sent, [{ from: "hr@example.com", to: "taro@example.com", subject: "件名", text: "本文", replyTo: undefined }]);
  } finally { delete ADAPTERS.fake; }
});

console.log("— 検査・失敗 —");

await ok("宛先の形式が違う・改行がある・本文が空は、送らずに failed（例外にしない）", async () => {
  let called = 0;
  const f = async () => { called++; return { ok: true, json: async () => ({ id: "x" }) }; };
  for (const bad of [
    { ...MSG, to: "not-an-address" }, { ...MSG, to: "a@b.co\nBcc: x@y.co" },
    { ...MSG, subject: "件名\r\nBcc: x@y.co" }, { ...MSG, text: "  " },
  ]) {
    const r = await sendMail(bad, { env: FULL, fetchImpl: f });
    assert.equal(r.status, "failed", JSON.stringify(bad));
    assert.ok(r.error);
  }
  assert.equal(called, 0);
});

await ok("送信サービスが断った・落ちた・時間切れ: failed。理由は短く、鍵を含めない", async () => {
  const r1 = await sendMail(MSG, { env: FULL, fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: "Invalid `to` field" }) }) });
  assert.equal(r1.status, "failed");
  assert.match(r1.error, /422/);
  assert.match(r1.error, /Invalid `to` field/);
  const r2 = await sendMail(MSG, { env: FULL, fetchImpl: async () => { throw new Error("network down"); } });
  assert.equal(r2.status, "failed");
  assert.match(r2.error, /network down/);
  const r3 = await sendMail(MSG, { env: FULL, fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
  assert.match(r3.error, /時間切れ/);
  for (const r of [r1, r2, r3]) assert.ok(!JSON.stringify(r).includes("re_test"), "鍵が漏れている");
});

console.log("— Resend の呼び方 —");

await ok("宛先・送信元・件名・本文・返信先・認証。自動の再試行はしない（二重送信を避ける）", async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ id: "re-123" }) }; };
  const r = await sendMail({ ...MSG, replyTo: "reply@example.com" }, { env: FULL, fetchImpl: f });
  assert.equal(r.status, "sent");
  assert.equal(r.providerMessageId, "re-123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer re_test");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: "エイト 人事 <hr@example.com>", to: ["taro@example.com"], subject: "件名", text: "本文", reply_to: "reply@example.com",
  });
});

await ok("返信先は、指定が無ければ MAIL_REPLY_TO", async () => {
  const calls = [];
  const f = async (_u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  await sendMail(MSG, { env: { ...FULL, MAIL_REPLY_TO: "hr-desk@example.com" }, fetchImpl: f });
  assert.equal(calls[0].reply_to, "hr-desk@example.com");
});

await ok("resend.ready は鍵の有無だけを見る", async () => {
  assert.equal(resend.ready({ RESEND_API_KEY: "k" }).ok, true);
  assert.equal(resend.ready({}).ok, false);
});

console.log("— 送信元をコードに書いていない —");

await ok("ソースに、実在のアドレス・送信元を直接書いていない（環境変数だけ）", async () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(ROOT, "lib/mail"));
  files.push(join(ROOT, "lib/onboard-guide.js"), join(ROOT, "api/keiei/onboarding.js"));
  for (const f of files) {
    let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const hit = code.match(/[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    assert.ok(!hit, `${f}: ${hit && hit[0]}`);
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
