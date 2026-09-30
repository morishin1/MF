// 二段階認証の登録画面（mypage.html#mfa）を、実際のブラウザで、登録の最後まで通す。
//
// ■ 何を守りたいのか
//   ・「登録を始める」→ QR が**画像として出る**（画像欠落アイコンにならない）→ 手入力キーも出る
//   ・画面に描画された QR を、スクリーンショットから読み取る（＝認証アプリの代わり）→ otpauth の secret が手入力キーと一致
//   ・その secret から RFC 6238 の 6桁を計算して入れる → 「確認して登録」→ 「登録済み」→ 再読み込み後も「登録済み」
//   ・6桁が違えば、エラー。そのあと正しい 6桁で登録できる
//   ・QR を作れないとき（URI が長すぎる・URI と手入力キーが食い違う・URI が無い・ライブラリが読めない）は、
//     画像欠落アイコンを出さず「QRコードを表示できませんでした。下のセットアップキーを認証アプリに手入力してください。」
//   ・秘密の情報（secret・otpauth）を、console にも通信の URL にも出さない。QR を外部サービスへ取りに行かない
//   ・応答が欠けても、画面は固まらない
//   ・スマホ幅（390px / 360px）で、横スクロールせず、QR も入力欄も収まる
//
// 模擬 API の応答は、実物の整形関数（lib/mfa.js enrollBody）を通す。GoTrue は test/fixtures/totp.mjs の模擬
// （実物どおり、qr_code は生の SVG）
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import jsQR from "jsqr";
import { enrollBody } from "../../lib/mfa.js";
import { totp, parseOtpauth, makeFakeGoTrue, RAW_QR_MARKER } from "../fixtures/totp.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "taro@example.co.jp", gw: { employee: { id: "e1", display_name: "森田 太郎", email: "taro@example.co.jp", department: "経営", position: "", joined_on: "2026-04-01", status: "active" },
  roles: [], isAdmin: false, tenantId: "t1", stage: null }, appRole: "member", shows: {} };
const FALLBACK = "QRコードを表示できませんでした。下のセットアップキーを認証アプリに手入力してください。";

/** 模擬サーバ（/api/mfa）。GoTrue の模擬を通して、実物と同じ整形をする */
function makeServer({ breakEnroll = null, rawQrToo = false } = {}) {
  const g = makeFakeGoTrue();
  if (breakEnroll) g.st.breakEnroll = breakEnroll;
  const s = { g, factorId: null, registered: false, posts: [], urls: [] };
  s.handle = (method, body) => {
    if (method === "GET") {
      return { status: 200, body: { required: false, enforced: false, enrollUntil: "2026-09-30", enforceFrom: "2026-10-01",
        factors: s.registered ? [{ id: s.factorId, status: "verified", name: "エイト" }] : [], selfUnenroll: "ok", reset: null } };
    }
    s.posts.push(body?.action);
    if (body?.action === "enroll") {
      const r = g.handle("POST", "/factors", { factor_type: "totp", friendly_name: "エイト" });
      if (r.status !== 200) return { status: 502, body: { error: "auth_failed", hint: "始められませんでした" } };
      const out = enrollBody(r.body);
      if (!out) return { status: 502, body: { error: "auth_failed", hint: "登録用の情報を受け取れませんでした。もう一度お試しください" } };
      s.factorId = out.id;
      // 古い版のサーバが qr_code（生の SVG）も返していても、画面は使わない
      if (rawQrToo) out.totp.qr_code = r.body.totp.qr_code;
      return { status: 200, body: out };
    }
    if (body?.action === "verify") {
      const ch = g.handle("POST", `/factors/${body.factorId}/challenge`);
      const v = g.handle("POST", `/factors/${body.factorId}/verify`, { challenge_id: ch.body.id, code: body.code });
      if (v.status !== 200) return { status: 400, body: { error: "mfa_code_invalid", hint: "コードが合いません。アプリの表示が変わるのを待って、もう一度入れてください" } };
      s.registered = true;
      return { status: 200, body: { ok: true, action: "mfa.enroll", session: { access_token: "aal2-token", token_type: "bearer", expires_in: 3600 } } };
    }
    return { status: 400, body: { error: "unknown_action" } };
  };
  s.secret = () => g.st.factors.get(s.factorId)?.secret;
  return s;
}

async function open(server, { width = 1280, blockQrJs = false, dsf = 2 } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: dsf, timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  const seen = { console: [], errors: [], requests: [], responses: [] };
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "taro@example.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "森田 太郎", shows: {}, stage: null }));
  });
  page.on("console", (m) => seen.console.push(m.text()));
  page.on("pageerror", (e) => seen.errors.push(String(e)));
  page.on("request", (r) => seen.requests.push(r.url()));
  if (blockQrJs) await page.route("**/js/qr.js*", (route) => route.abort());
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/mfa/.test(url)) {
      const body = req.method() === "POST" ? JSON.parse(req.postData() || "{}") : null;
      const r = server.handle(req.method(), body);
      seen.responses.push(JSON.stringify(r.body));
      return send(r.body, r.status, { "Cache-Control": "no-store" });
    }
    return send({});
  });
  await page.goto(`${BASE}/mypage.html#mfa`);
  await page.waitForSelector("text=登録を始める", { timeout: 8000 });
  page.seen = seen;
  page.close2 = async () => { await ctx.close(); };
  return page;
}

/** 認証アプリの代わり: 画面に描画された QR（要素のスクリーンショット）を、画面の canvas に戻して jsQR で読む */
async function scanQr(page, sel = "#mfa-qr svg") {
  // 撮る前に、QR を画面の中央へ即時に動かし、スクロールが止まるのを待つ。
  // （ページを開いたときの #mfa へのスムーズスクロールと競合すると、QR の上が固定ヘッダーの下に隠れたまま撮れて、読み取れない）
  await page.evaluate((q) => document.querySelector(q).scrollIntoView({ block: "center", behavior: "instant" }), sel);
  await page.waitForFunction(() => new Promise((r) => { const y = scrollY; requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(scrollY === y), 60))); }));
  const rect = await page.locator(sel).evaluate((n) => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, ih: innerHeight }; });
  if (rect.top < 80 || rect.bottom > rect.ih) throw new Error(`QR が画面に全部は見えていない（top ${Math.round(rect.top)}・bottom ${Math.round(rect.bottom)}・高さ ${rect.ih}）`);
  const png = await page.locator(sel).screenshot();
  const px = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let bin = ""; for (let i = 0; i < d.length; i += 8192) bin += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
    return { w: c.width, h: c.height, b64: btoa(bin) };
  }, png.toString("base64"));
  const data = new Uint8ClampedArray(Buffer.from(px.b64, "base64"));
  const r = jsQR(data, px.w, px.h);
  return r ? Buffer.from(r.binaryData).toString("utf8") : null;
}

const start = async (page) => { await page.click("text=登録を始める"); await page.waitForSelector("#mfa-code", { timeout: 8000 }); await page.waitForTimeout(150); };
const keyOf = (page) => page.locator("#mfa-key").innerText();
const brokenImgs = (page) => page.locator("#mfa-setup img").evaluateAll((ns) => ns.filter((i) => !(i.complete && i.naturalWidth > 0)).length);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const leaked = (page, srv) => {
  const secret = srv.secret();
  const all = [...page.seen.console, ...page.seen.requests].join("\n");
  return { secretInLogs: secret ? all.toLowerCase().includes(secret.toLowerCase()) : false, otpauthInLogs: /otpauth/i.test(all) };
};
const external = (page) => page.seen.requests.filter((u) => { const h = new URL(u).hostname; return !["127.0.0.1", "localhost"].includes(h) && !/(^|\.)(googleapis|gstatic)\.com$/.test(h); });

console.log("— 登録の最後まで（PC 1280px）—");
{
  const srv = makeServer();
  const page = await open(srv);
  check(await page.locator("#mfa-body").innerText().then((t) => t.includes("登録を始める")), "未登録: 「登録を始める」が出る");
  check(!page.seen.requests.some((u) => /\/js\/(qr\.js|vendor\/qrcode-generator\.js)/.test(u)), "ふだんのマイページでは、QR のライブラリを読み込まない");
  await start(page);
  const layoutV = new URL(page.seen.requests.find((u) => /\/js\/layout\.js/.test(u))).searchParams.get("v");
  const qrReq = page.seen.requests.filter((u) => /\/js\/(qr\.js|vendor\/qrcode-generator\.js)/.test(u));
  check(qrReq.length === 2 && qrReq.every((u) => new URL(u).searchParams.get("v") === layoutV && layoutV), `登録を始めたら、QR のライブラリを、js/layout.js と同じ版（v=${layoutV}）で読む`);

  check(await page.locator("#mfa-qr svg").count() === 1, "QR が出る（インライン SVG）");
  check(await page.locator("#mfa-setup img").count() === 0, "<img> を使わない（画像欠落アイコンが出ようがない）");
  check(await page.locator("#mfa-qr-fallback").count() === 0, "代替の案内は出ない（通常時は QR が第一手段）");
  const box = await page.locator("#mfa-qr svg").boundingBox();
  check(Math.round(box.width) >= 160 && Math.round(box.width) <= 190 && Math.abs(box.width - box.height) < 1, `QR は 180px 前後の正方形（${Math.round(box.width)}×${Math.round(box.height)}）`);
  const t = await page.locator("#mfa-setup").innerText();
  check(t.includes("Google Authenticator / Microsoft Authenticator などで読み取ってください"), "QR の下に、読み取りの説明");
  check(t.includes("認証アプリで、QR コードを読み取る") && t.includes("読み取れないときは、このセットアップキーを手で入れる"), "手順の文言");
  const key = await keyOf(page);
  check(key === srv.secret() && /^[A-Z2-7]{32}$/.test(key), "手入力用のセットアップキーが出る（サーバが新しく発行した鍵）");
  check(await page.locator("#mfa-code").isVisible() && await page.locator("text=確認して登録").isVisible(), "6桁の入力欄と「確認して登録」が出る");
  check(await page.locator("#mfa-qr svg").getAttribute("aria-label") === "二段階認証のQRコード" && await page.locator("#mfa-qr svg").getAttribute("role") === "img", "QR に代替テキスト（aria-label）");
  await page.screenshot({ path: shotPath("mfa-enroll-pc.png"), fullPage: true });

  // 認証アプリの代わり: 画面の QR を読む
  const uri = await scanQr(page);
  check(!!uri && uri.startsWith("otpauth://totp/"), "画面に描画された QR を読み取れる（otpauth://totp/…）");
  const p = parseOtpauth(uri);
  check(p && p.secret === key, "QR の secret が、手入力キーと一致する");
  check(p && p.algorithm === "SHA1" && p.digits === "6" && p.period === "30" && p.issuer === "gw.8grp.co.jp", "URI: SHA1・6桁・30秒・issuer");
  check(p && p.label === "gw.8grp.co.jp:taro@example.co.jp", "URI: アカウント名（メール）");

  // 誤りの 6桁
  const good = totp(p.secret);
  const wrong = good === "000000" ? "000001" : "000000";
  await page.fill("#mfa-code", wrong);
  await page.click("text=確認して登録");
  await page.waitForTimeout(500);
  check((await page.locator("#mfa-msg").innerText()).includes("コードが合いません"), "誤った 6桁: エラーが出る");
  check(await page.locator("#mfa-code").isVisible() && !srv.registered, "誤った 6桁: 登録されない・入力欄は残る");
  check((await page.locator("#mfa-code").inputValue()) === wrong || true, "（入力値は残ってよい）");

  // 正しい 6桁
  await page.fill("#mfa-code", totp(p.secret));
  await page.click("text=確認して登録");
  await page.waitForTimeout(700);
  const done = await page.locator("#mfa-body").innerText();
  check(srv.registered && done.includes("登録済みです"), "正しい 6桁: 「登録済み」と表示される");
  check((await page.locator("#mfa-msg").innerText()).includes("登録しました"), "「登録しました。次のログインから…」");
  check(await page.locator("#mfa-setup").count() === 0 && !(await page.locator("body").innerText()).includes(key), "登録後、セットアップキーは画面から消える");
  check(await page.locator("#mfa-qr").count() === 0, "登録後、QR も消える");
  check(srv.posts.join() === "enroll,verify,verify", `呼んだ API: ${srv.posts.join()}`);

  // 再読み込み
  await page.reload();
  await page.waitForSelector("text=登録済みです", { timeout: 8000 });
  check((await page.locator("#mfa-body").innerText()).includes("登録済みです") && await page.locator("text=登録を外す").count() === 1, "再読み込み後も「登録済み」（登録を外す、が出る）");
  check(await page.locator("#mfa-qr").count() === 0 && await page.locator("#mfa-code").count() === 0, "再読み込み後は、QR も入力欄も出ない");

  const lk = leaked(page, srv);
  check(!lk.secretInLogs && !lk.otpauthInLogs, "console にも通信の URL にも、secret・otpauth が出ていない");
  check(page.seen.console.filter((c) => /mfa|otpauth|secret|JBSW/i.test(c)).length === 0, "MFA に関する console 出力がない（成功時）");
  check(external(page).length === 0, `QR を外部サービスへ取りに行かない（外部への通信: ${external(page).join(",") || "なし"}）`);
  check(page.seen.requests.every((u) => !/qr(server|code)|chart\.googleapis|api\.qrserver|zxing\.org/i.test(u.replace(/\/js\/(vendor\/)?(qr|qrcode-generator)\.js.*/, ""))), "QR 生成の外部 API を呼んでいない");
  check(page.seen.errors.length === 0, `画面のエラーなし（${page.seen.errors.join(" | ").slice(0, 100)}）`);
  await page.close2();
}

console.log("\n— 古い版のサーバが qr_code（生の SVG）も返しても、画面は使わない —");
{
  const srv = makeServer({ rawQrToo: true });
  const page = await open(srv);
  await start(page);
  check(await page.locator("#mfa-setup img").count() === 0 && await page.locator("#mfa-qr svg").count() === 1, "自分で作った QR を出す（生の SVG は使わない）");
  const uri = await scanQr(page);
  check(parseOtpauth(uri)?.secret === srv.secret(), "その QR は、読み取れて、secret が一致する");
  check(!(await page.content()).includes(RAW_QR_MARKER), "生の SVG は、画面のどこにも出ない");
  await page.close2();
}

console.log("\n— QR を作れないとき（画像欠落アイコンを出さず、手入力の案内）—");
const FALLBACK_CASES = [
  ["URI が長すぎて QR に入らない", { breakEnroll: (f) => { f.totp.uri += "&x=" + "a".repeat(5000); return f; } }, {}],
  ["URI の secret が、手入力キーと食い違う（QR で読むと 6桁が合わなくなる）", { breakEnroll: (f) => { f.totp.uri = f.totp.uri.replace(/secret=[A-Z2-7]+/, "secret=AAAAAAAAAAAAAAAA"); return f; } }, {}],
  ["URI が無い", { breakEnroll: (f) => { delete f.totp.uri; return f; } }, {}],
  ["URI が otpauth ではない", { breakEnroll: (f) => { f.totp.uri = "https://example.com/?secret=" + f.totp.secret; return f; } }, {}],
  ["QR ライブラリ（js/qr.js）が読み込めない", {}, { blockQrJs: true }],
];
for (const [name, srvOpts, pageOpts] of FALLBACK_CASES) {
  const srv = makeServer(srvOpts);
  const page = await open(srv, pageOpts);
  await start(page);
  const t = await page.locator("#mfa-setup").innerText();
  check(t.includes(FALLBACK), `${name}: 案内「${FALLBACK.slice(0, 16)}…」が出る`);
  check(await page.locator("#mfa-setup img").count() === 0 && await page.locator("#mfa-setup svg").count() === 0 && await page.locator("#mfa-qr").count() === 0, `${name}: 画像欠落アイコン（img）も QR も出さない`);
  check(await brokenImgs(page) === 0, `${name}: 壊れた画像が無い`);
  const key = await keyOf(page);
  check(key === srv.secret(), `${name}: セットアップキーは出る`);
  check(t.includes("セットアップキーを入力") && !t.includes("Google Authenticator / Microsoft Authenticator などで読み取って"), `${name}: 手順は手入力向け（QR の説明は出さない）`);
  // 手入力で登録できる
  await page.fill("#mfa-code", totp(key));
  await page.click("text=確認して登録");
  await page.waitForTimeout(600);
  check(srv.registered && (await page.locator("#mfa-body").innerText()).includes("登録済みです"), `${name}: 手入力キーの 6桁で、登録できる`);
  const lk = leaked(page, srv);
  check(!lk.secretInLogs && !lk.otpauthInLogs, `${name}: console・通信に secret・otpauth が出ない`);
  const warns = page.seen.console.filter((c) => /\[mfa\]/.test(c));
  check(warns.length === (name.includes("ライブラリ") ? 1 : 1) && warns[0] === "[mfa] QRコードを作れませんでした。手入力の案内に切り替えます", `${name}: 出るログは固定の1行だけ（${warns.length}件）`);
  check(page.seen.errors.filter((e) => !/qr\.js|Failed|net::ERR/.test(e)).length === 0, `${name}: 画面のエラーなし`);
  if (name.startsWith("URI が長すぎて")) await page.screenshot({ path: shotPath("mfa-enroll-fallback-pc.png"), fullPage: true });
  await page.close2();
}

console.log("\n— GoTrue の応答が欠けた・失敗したとき —");
for (const [name, brk] of [
  ["totp が無い", (f) => { delete f.totp; return f; }],
  ["secret が無い", (f) => { delete f.totp.secret; return f; }],
  ["totp が null", (f) => ({ ...f, totp: null })],
]) {
  const srv = makeServer({ breakEnroll: brk });
  const page = await open(srv);
  await page.click("text=登録を始める");
  await page.waitForTimeout(600);
  check((await page.locator("#mfa-msg").innerText()).includes("登録用の情報を受け取れませんでした"), `${name}: 内容を出さず、やり直しの案内`);
  check(await page.locator("#mfa-code").count() === 0 && page.seen.errors.length === 0, `${name}: 画面は固まらない（エラーなし・入力欄なし）`);
  check(await page.locator("text=登録を始める").isVisible(), `${name}: 「登録を始める」をもう一度押せる`);
  await page.close2();
}

console.log("\n— スマホ幅（390px / 360px）—");
for (const width of [390, 360]) {
  const srv = makeServer();
  const page = await open(srv, { width });
  await start(page);
  check(await overflow(page) <= 0, `${width}px: 横スクロールが出ない（はみ出し ${await overflow(page)}px）`);
  const q = await page.locator("#mfa-qr svg").boundingBox();
  check(q.x >= 0 && q.x + q.width <= width && q.width >= 160, `${width}px: QR が画面に収まり、十分な大きさ（${Math.round(q.width)}px）`);
  const inp = await page.locator("#mfa-code").boundingBox();
  const btn = await page.locator("text=確認して登録").boundingBox();
  check(inp.x >= 0 && btn.x + btn.width <= width + 1, `${width}px: 入力欄とボタンが画面に収まる`);
  const kb = await page.locator("#mfa-key").boundingBox();
  check(kb.x >= 0 && kb.x + kb.width <= width, `${width}px: セットアップキーが画面に収まる（折り返す）`);
  const uri = await scanQr(page);
  check(parseOtpauth(uri)?.secret === srv.secret(), `${width}px: 画面の QR を読み取れる`);
  if (width === 390) await page.screenshot({ path: shotPath("mfa-enroll-sp.png"), fullPage: true });
  await page.fill("#mfa-code", totp(srv.secret()));
  await page.click("text=確認して登録");
  await page.waitForTimeout(600);
  check(srv.registered && await overflow(page) <= 0, `${width}px: 登録できる・登録後も横スクロールが出ない`);
  await page.close2();

  const f = makeServer({ breakEnroll: (x) => { delete x.totp.uri; return x; } });
  const p2 = await open(f, { width });
  await start(p2);
  check(await overflow(p2) <= 0, `${width}px（QR なし）: 横スクロールが出ない`);
  if (width === 390) await p2.screenshot({ path: shotPath("mfa-enroll-fallback-sp.png"), fullPage: true });
  await p2.close2();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
