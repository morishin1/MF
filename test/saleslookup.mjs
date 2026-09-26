// 企業サイトの URL から企業名・フォームURLを拾う（lib/sales-lookup.js）。
//
// ■ 何を守るテストか
//
//   1. 社内・ループバック・リンクローカル等のアドレスには、名前解決の結果でもリダイレクト先でも行かない（SSRF）
//   2. http/https・80/443 以外、ユーザー名入りの URL は受け付けない
//   3. タイトルや og:site_name から、宣伝文句を除いて企業名を選ぶ
//   4. 問い合わせフォームのリンクは同じサイト内から選ぶ
//   5. Shift_JIS・EUC-JP のページも文字化けせずに読む
//   6. 取れなくても投げずに ok:false で返す（登録を止めない）
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const L = await import(join(ROOT, "lib/sales-lookup.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const page = (html, { status = 200, type = "text/html; charset=utf-8", location = null, bytes = null } = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => ({ "content-type": type, location }[k.toLowerCase()] ?? null) },
  body: null,
  arrayBuffer: async () => (bytes || new TextEncoder().encode(html)).buffer,
});
const publicDns = async () => ["93.184.216.34"];

console.log("\n=== 行ってはいけないアドレス ===\n");

await ok("社内・ループバック・リンクローカル・メタデータ等は private", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(L.isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(L.isPrivateAddress(ip), false, ip);
  }
});

await ok("URL の形：https を補う・ポートやユーザー名入りは断る", () => {
  assert.equal(L.normalizeSiteUrl("example.co.jp"), "https://example.co.jp/");
  assert.equal(L.normalizeSiteUrl("http://example.co.jp/a#x"), "http://example.co.jp/a");
  for (const bad of ["", "javascript:alert(1)", "ftp://example.jp", "https://example.jp:8080/", "https://u:p@example.jp/", "localhost", "file:///etc/passwd"]) {
    assert.equal(L.normalizeSiteUrl(bad), null, bad);
  }
});

await ok("名前解決の結果が社内アドレスなら、取りにいかない", async () => {
  let fetched = false;
  const r = await L.lookupCompany("https://intranet.example.jp", {
    resolve: async () => ["10.0.0.5"], fetchImpl: async () => { fetched = true; return page("<title>x</title>"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "blocked");
  assert.equal(fetched, false);
});

await ok("リダイレクト先が社内アドレスなら、そこへは行かない", async () => {
  const hits = [];
  const r = await L.lookupCompany("https://public.example.jp", {
    resolve: async (h) => (h === "public.example.jp" ? ["93.184.216.34"] : ["169.254.169.254"]),
    fetchImpl: async (u) => { hits.push(u); return page("", { status: 302, location: "http://metadata.internal/latest" }); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "blocked");
  assert.deepEqual(hits, ["https://public.example.jp/"]);
});

await ok("IP 直書きの社内アドレスも断る", async () => {
  const r = await L.lookupCompany("http://127.0.0.1/", { resolve: publicDns, fetchImpl: async () => page("") });
  assert.equal(r.reason, "blocked");
});

await ok("リダイレクトは3回まで", async () => {
  const r = await L.lookupCompany("https://loop.example.jp", {
    resolve: publicDns, fetchImpl: async (u) => page("", { status: 301, location: `${u}x` }),
  });
  assert.equal(r.reason, "redirects");
});

console.log("\n=== 読む ===\n");

await ok("企業名：宣伝文句や「トップ」を除いて、法人名を選ぶ", () => {
  assert.equal(L.pickCompanyName({ title: "トップ | 株式会社サンプル" }), "株式会社サンプル");
  assert.equal(L.pickCompanyName({ title: "AI開発なら株式会社エイト｜福岡のシステム会社" }), "株式会社エイト");
  assert.equal(L.pickCompanyName({ title: "サンプル商事株式会社 - 公式サイト" }), "サンプル商事株式会社");
  assert.equal(L.pickCompanyName({ title: "Home - ACME", siteName: "ACME Inc." }), "ACME Inc.");
  assert.equal(L.pickCompanyName({ title: "サンプルクリニック｜渋谷の内科" }), "サンプルクリニック");
  assert.equal(L.pickCompanyName({ title: "" }), null);
});

await ok("問い合わせフォーム：同じサイト内の「お問い合わせ」を選ぶ。外部・mailto は選ばない", () => {
  const html = `
    <a href="mailto:info@x.jp">お問い合わせ（メール）</a>
    <a href="https://other.example.com/contact">外部の問い合わせ</a>
    <a href="/company/">会社概要</a>
    <a href="/form/entry">採用エントリーフォーム</a>
    <a href="/contact/">お問い合わせ</a>`;
  assert.equal(L.pickContactUrl(html, "https://www.sample.co.jp/"), "https://www.sample.co.jp/contact/");
  assert.equal(L.pickContactUrl("<a href='/about'>会社概要</a>", "https://sample.co.jp/"), null);
});

await ok("電話番号・所在地", () => {
  assert.equal(L.pickPhone(`<a href="tel:03-1234-5678">電話</a>`), "03-1234-5678");
  assert.equal(L.pickPhone(`<p>TEL：092−123−4567</p>`.replace("−", "-").replace("−", "-")), "092-123-4567");
  assert.match(L.pickAddress(`<p>〒810-0001 福岡県福岡市中央区天神1-1-1</p>`), /^〒810-0001 福岡県福岡市中央区天神1-1-1/);
});

await ok("Shift_JIS のページも読める（企業名が文字化けしない）", async () => {
  const enc = new TextEncoder();
  // Node の TextEncoder は UTF-8 しか作れないので、Shift_JIS のバイト列は手で用意する
  // 「株式会社」= 8A 94 8E AE 89 EF 8E D0
  const head = enc.encode('<html><head><meta charset="Shift_JIS"><title>');
  const body = Uint8Array.from([0x8a, 0x94, 0x8e, 0xae, 0x89, 0xef, 0x8e, 0xd0, 0x41, 0x42, 0x43]);
  const tail = enc.encode("</title></head></html>");
  const bytes = new Uint8Array([...head, ...body, ...tail]);
  const r = await L.lookupCompany("https://sjis.example.jp", {
    resolve: publicDns, fetchImpl: async () => page("", { type: "text/html", bytes }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.name, "株式会社ABC");
});

await ok("まとめて：取りにいって読む（リダイレクト先を基準にフォームURLを作る）", async () => {
  const r = await L.lookupCompany("sample.co.jp", {
    resolve: publicDns,
    fetchImpl: async (u) => (u === "https://sample.co.jp/"
      ? page("", { status: 301, location: "https://www.sample.co.jp/" })
      : page(`<title>株式会社サンプル｜トップ</title><meta name="description" content="福岡のIT企業です">
              <a href="contact.html">お問い合わせはこちら</a><a href="tel:0921234567">電話</a>`)),
  });
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, "https://www.sample.co.jp/");
  assert.equal(r.name, "株式会社サンプル");
  assert.equal(r.formUrl, "https://www.sample.co.jp/contact.html");
  assert.equal(r.phone, "0921234567");
  assert.equal(r.description, "福岡のIT企業です");
});

await ok("HTML 以外・エラーは ok:false で返す（投げない）", async () => {
  const pdf = await L.lookupCompany("https://a.example.jp", { resolve: publicDns, fetchImpl: async () => page("", { type: "application/pdf" }) });
  assert.deepEqual([pdf.ok, pdf.reason], [false, "not_html"]);
  const e404 = await L.lookupCompany("https://a.example.jp", { resolve: publicDns, fetchImpl: async () => page("", { status: 404 }) });
  assert.deepEqual([e404.ok, e404.reason], [false, "http"]);
  const down = await L.lookupCompany("https://a.example.jp", { resolve: publicDns, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(down.ok, false);
  const bad = await L.lookupCompany("not a url", {});
  assert.deepEqual([bad.ok, bad.reason], [false, "bad_url"]);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
