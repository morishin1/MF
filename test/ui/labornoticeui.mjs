// 労働条件通知書を、実際のブラウザで、最初から最後まで通す。
//   管理側（入社管理 admin-hr.html）でPDFをアップロード → プレビュー → 本人に公開
//   → 本人（/onboarding/）が書類を見て「確認しました」 → 管理側で確認済み・確認日時が分かる
//   → 差し替えると、新しい版は未確認。旧版は履歴に残る
//
// ■ どこまで本物か
//   画面は本物。通信は、本物のハンドラ（api/onboarding/notice.js・api/onboarding/start.js）につなぐ。
//   DB・Storage・ログインだけが偽物（test/_noticeharness.mjs）。別タブ（プレビュー・書類を見る）は、本物のポップアップで開く。
//
// ■ 守ること
//   ・本人の3つの状態（準備中 / 確認してください＋書類を見る・確認しました / 確認済み＋日付・もう一度見る）と、最上部の「次にやること」
//   ・別タブで開く。署名付きURLは、画面にも DB にも残らない（iframe にだけ入る）。他人の通知書は出ない
//   ・電子署名の依頼がある人には、確認の入口を出さない（電子署名のほうを優先する）
//   ・会計側の管理者（admin / staff。owner・hr のロールを持たない人）には、通知書の欄そのものを出さない。API は 403
//   ・経営ハブ（/keiei）は件数だけ。操作は入社管理（admin-hr.html）
//   ・スマホ幅（390px）で、横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import {
  db, storage, setPersona, adminApi, start, res as mkRes, ctxOf, OWNER, HR, HIRE, HIRE2, setup, agreeAll, pdf, everything,
} from "../_noticeharness.mjs";

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---- ログイン（人ごとにブラウザの文脈を分ける）----------------------------------------------------
const PERSONAS = {
  "tok-owner": { ctx: OWNER, user: { id: "u-own1", email: "owner@example.com" }, appRole: "owner" },
  "tok-hr": { ctx: HR, user: { id: "u-hr1", email: "hr1@example.com" }, appRole: "admin" },
  // 会計側の管理者（admin / staff）。社内ロール（owner・hr）は持たない
  "tok-admin": { ctx: ctxOf("adm1", [], { isAdmin: true }), user: { id: "u-adm1", email: "admin1@example.com" }, appRole: "admin" },
  "tok-e1": { ctx: HIRE, user: { id: "u-e1", email: "hire@example.com" }, appRole: "member" },
  "tok-e2": { ctx: HIRE2, user: { id: "u-e2", email: "e2@example.com" }, appRole: "member" },
};

// 入退社の一覧・1人ぶん（admin-hr.html が読む。通知書の欄は、この下に、本物のハンドラから出る）
const LIST = {
  tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
  onboarding: [{ id: "p1", kind: "onboarding", name: "山田 太郎", department: "営業", targetOn: "2026-10-01", days: 3, due: "入社まで3日",
    phase: "prep", phaseLabel: "入社準備", progress: { done: 3, total: 10 }, urgency: "soon", next: { title: "会社PCの準備", role: "IT・管理", who: "情報 次郎" } }],
  offboarding: [], done: [], people: [{ id: "e1", name: "山田 太郎", department: "営業" }], roles: [], today: "2026-10-01",
};
const ONE = { procedure: { ...LIST.onboarding[0], employeeId: "e1", mynumber: "not_submitted", targetOn: "2026-10-01",
  next: { title: "会社PCの準備", role: "IT・管理", who: "情報 次郎" }, groups: [
    { role: "hr", label: "人事", done: 1, total: 2, items: [
      { id: "i1", title: "労働条件・契約の確認", owner: "hr", ownerLabel: "人事", phase: "prep", done: true, assignee: { id: "e9", name: "事務 花子" }, href: null },
      { id: "i2", title: "必要書類の回収", owner: "hr", ownerLabel: "人事", phase: "prep", done: false, assignee: { id: "e9", name: "事務 花子" }, href: null }] }],
  drive: null }, roles: [], people: LIST.people };
const RETENTION = { today: "2026-10-01", rules: [], schedule: [], expired: 0, log: [] };
const ORIENTATION = { items: [], kinds: [], done: true };

// 通信は直列に（偽の認証が「いま誰か」を1つしか持てないので、同時に走らせない）
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const viewerHits = [];           // 署名付きURLを、ブラウザが実際に開いた記録
const dialogs = [];

async function callHandler(handler, route, persona) {
  const req = route.request();
  const u = new URL(req.url());
  return serial(async () => {
    setPersona(persona.ctx, persona.user);
    const r = mkRes();
    await handler({ method: req.method(), url: u.pathname + u.search, headers: { ...req.headers(), host: "gw.example.com" },
      body: req.postData() ? JSON.parse(req.postData()) : undefined }, r);
    return route.fulfill({ status: r.statusCode || 200, contentType: "application/json", body: JSON.stringify(r.body ?? {}) });
  });
}

async function session(token, { width = 1100, height = 900 } = {}) {
  const persona = PERSONAS[token];
  const ctx = await br.newContext({ viewport: { width, height }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(([t, email, role]) => {
    // PDF ビューアの枠（別のオリジン）では localStorage に触れない。画面のほうだけに入れる
    try {
      localStorage.setItem("kp_session", JSON.stringify({ access_token: t, email }));
      localStorage.setItem("kp_layout", JSON.stringify({ appRole: role, name: "x", shows: {}, stage: null }));
      localStorage.removeItem("kp_me");
    } catch { /* 枠の中では何もしない */ }
  }, [token, persona.user.email, persona.appRole]);

  await ctx.route("**/api/**", (route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (path === "/api/onboarding/notice") return callHandler(adminApi, route, persona);
    if (path === "/api/onboarding/start") return callHandler(start, route, persona);
    if (/\/api\/hr\/retention/.test(path)) return send(RETENTION);
    if (/\/api\/onboarding\/orientation/.test(path)) return send(ORIENTATION);
    if (path === "/api/hr") return send(url.includes("id=") ? ONE : LIST);
    if (/\/api\/me\b/.test(path)) {
      return send({ email: persona.user.email, appRole: persona.appRole, shows: {}, isAdmin: persona.ctx.isAdmin || persona.appRole === "admin",
        gw: { employee: { id: persona.ctx.employee.id, display_name: persona.ctx.employee.display_name, status: "active" },
          roles: persona.ctx.roles, isAdmin: persona.appRole === "admin", tenantId: "t1", stage: null } });
    }
    if (/\/api\/notifications/.test(path)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(path)) return send({ badges: {} });
    return send({});
  });
  // 偽の Storage: アップロード先（PUT）と、閲覧用（GET。PDF を返す）
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "*" };
  await ctx.route("https://storage.test/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const m = new URL(req.url()).pathname.match(/^\/(upload|sign)\/hr\/(.+)$/);
    const path = m ? decodeURIComponent(m[2]) : "";
    if (req.method() === "PUT" && m?.[1] === "upload") {
      storage.objects.set(path, req.postDataBuffer());
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: "{}" });
    }
    if (req.method() === "GET" && m?.[1] === "sign") {
      viewerHits.push(path);
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/pdf", body: storage.objects.get(path) || Buffer.from("%PDF-1.4") });
    }
    return route.fulfill({ status: 404, headers: CORS });
  });
  ctx.on("page", (p) => {
    p.on("pageerror", (e) => errs.push(String(e)));
    p.on("console", (m) => m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.test|PDF/i.test(m.text()) && errs.push(m.text()));
    p.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

const todayJst = () => {
  const j = new Date(Date.now() + 9 * 3600000);
  return `${j.getUTCFullYear()}/${String(j.getUTCMonth() + 1).padStart(2, "0")}/${String(j.getUTCDate()).padStart(2, "0")}`;
};
const text = (page, sel) => page.locator(sel).first().innerText();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const PDF_FILE = (n, name = "山田太郎_労働条件通知書.pdf") => ({ name, mimeType: "application/pdf", buffer: pdf(n) });

setup();
agreeAll("e1");                                  // 誓約書などの同意は済み（これまでの決まり）。通知書の確認で STEP2 が終わる

// =================================================================================================
console.log("\n=== 管理側（人事）：入社管理で、アップロード → プレビュー → 公開 ===");
const hr = await session("tok-hr");
{
  const page = hr.page;
  await page.goto(`${BASE}/admin-hr.html?id=p1#labor-notice`);
  await page.waitForSelector('#labor-notice [data-role="ln-status"]');
  check((await text(page, '[data-role="ln-status"]')).trim() === "未登録", "最初は「未登録」");
  check((await text(page, "#labor-notice")).includes("電子署名ではありません"), "電子署名ではなく、見て確認してもらう書類、と書いてある");
  check(await page.locator("#labor-notice [data-role='ln-publish']").count() === 0, "まだ公開ボタンは出ない");
  check((await text(page, '[data-role="ln-upload"]')).trim() === "PDFをアップロード", "「PDFをアップロード」");
  check(await page.locator("#labor-notice").evaluate((n) => n.closest("#hr-detail") !== null), "入社管理（入退社の1人ぶん）の中にある");

  // PDF以外は、置き場所を出す前に断る
  await page.setInputFiles("#ln-file", { name: "メモ.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.click('[data-role="ln-upload"]');
  check((await text(page, '[data-role="ln-err"]')).includes("PDFのみ"), "PDF以外は断る");
  check(db.rows.gw_labor_notices.length === 0 && storage.objects.size === 0, "何も置いていない・行も作っていない");

  // 本物のPDFをアップロード
  await page.setInputFiles("#ln-file", PDF_FILE(1));
  await page.click('[data-role="ln-upload"]');
  await page.waitForSelector('[data-role="ln-status"][data-status="draft"]');
  check((await text(page, '[data-role="ln-status"]')).trim() === "未公開", "アップロードしただけでは「未公開」");
  const pending = page.locator('[data-role="ln-pending"]');
  check((await pending.innerText()).includes("第1版") && (await pending.innerText()).includes("山田太郎_労働条件通知書.pdf"), "第1版・ファイル名が出る");
  check((await pending.innerText()).includes("まだ本人には見えません"), "本人にはまだ見えない、と分かる");
  check(db.rows.gw_labor_notices.length === 1 && db.rows.gw_labor_notices[0].published_at === null, "DB には下書きとして入っている");
  check([...storage.objects.keys()].every((k) => /^t1\/labor-notice\/e1\/[0-9a-f-]{36}\.pdf$/.test(k)), "ファイルは、この会社・この人の専用の場所（非公開バケット）");

  // 本人の画面には、まだ何も出ない
  const peek = await session("tok-e1");
  await peek.page.goto(`${BASE}/onboarding/`);
  await peek.page.waitForSelector('[data-role="notice"]');
  check((await text(peek.page, '[data-role="notice-state"]')).trim() === "会社が準備中です", "公開前、本人には『会社が準備中です』");
  check(await peek.page.locator('[data-role="notice"] button, [data-role="notice"] a').count() === 0, "公開前は、操作のボタンを出さない");
  await peek.page.screenshot({ path: shotPath("labor-notice-self-none.png"), fullPage: true });
  await peek.ctx.close();

  // プレビュー（別タブ）
  const [pop] = await Promise.all([page.waitForEvent("popup"), page.click('[data-role="ln-pending"] a:has-text("プレビュー")')]);
  await pop.waitForSelector("iframe[src]");
  check(/\/onboarding\/notice\.html\?file=/.test(pop.url()), "プレビューは別タブで開く");
  check((await text(pop, "#nv-sub")).includes("第1版"), "別タブに、第1版・ファイル名が出る");
  const src = await pop.locator("iframe").getAttribute("src");
  check(src.startsWith("https://storage.test/sign/hr/t1/labor-notice/e1/"), "PDFは、署名付きURLで iframe に入る");
  await pop.waitForTimeout(400);
  check(viewerHits.length >= 1, "ブラウザが、署名付きURLを実際に開いた");
  check(db.rows.gw_sensitive_access_log.some((l) => l.actor_id === "u-hr1" && l.subject_id === "e1" && l.action === "view"), "誰が・誰の通知書を開いたか、が残る");
  check(!everything().includes("SECRET"), "署名付きURLのトークンは、DB・監査ログ・通知のどこにも残っていない");
  await pop.close();

  // 公開
  await page.click('[data-role="ln-publish"]');
  await page.waitForSelector('[data-role="ln-status"][data-status="unconfirmed"]');
  check(dialogs.some((d) => d.includes("山田 太郎") && d.includes("公開します")), "公開の前に、誰に公開するかを確かめる");
  check((await text(page, '[data-role="ln-status"]')).trim() === "本人未確認", "公開すると「本人未確認」");
  check((await text(page, '[data-role="ln-current"]')).includes("本人未確認"), "本人に公開している版に、未確認と出る");
  check(db.rows.gw_labor_notices[0].published_at !== null && db.rows.gw_labor_notices[0].published_by === "u-hr1", "人事が公開した、が残る");
  await page.screenshot({ path: shotPath("labor-notice-admin-unconfirmed.png"), fullPage: true });
}

// =================================================================================================
console.log("\n=== 本人（/onboarding/）：書類を見る → 確認しました ===");
const hire = await session("tok-e1");
{
  const page = hire.page;
  await page.goto(`${BASE}/onboarding/`);
  await page.waitForSelector('[data-role="notice"]');
  const card = page.locator('[data-role="notice"]');
  check((await card.getAttribute("data-state")) === "unconfirmed", "状態は『確認してください』");
  check((await text(page, '[data-role="notice-state"]')).trim() === "労働条件通知書を確認してください", "「労働条件通知書を確認してください」");
  check((await card.locator("a").first().innerText()).trim() === "書類を見る" && (await card.locator("button").first().innerText()).trim() === "確認しました", "ボタンは「書類を見る」「確認しました」の2つ");
  const view = card.locator('[data-role="notice-view"]');
  check((await view.getAttribute("target")) === "_blank" && (await view.getAttribute("rel")).includes("noopener"), "別タブで開く（noopener）");
  check(!(await view.getAttribute("href")).includes("storage.test"), "リンクに署名付きURLは入っていない");

  // 最上部の「次にやること」と、STEP2
  const next = page.locator('[data-role="next"]');
  check((await next.innerText()).includes("労働条件通知書の確認"), "最上部の「次にやること」が、通知書の確認");
  check((await next.innerText()).includes("あなたの操作が必要です"), "あなたの番、と出る");
  const st2 = page.locator('[data-step="contract"]');
  check((await st2.getAttribute("data-state")) === "current" && (await st2.innerText()).includes("労働条件通知書を確認してください"), "STEP2 が、確認してください");
  check((await st2.innerText()).includes("あなたの番です"), "STEP2 に「あなたの番です」");
  await page.screenshot({ path: shotPath("labor-notice-self-unconfirmed.png"), fullPage: true });

  // 書類を見る（別タブ）
  const [pop] = await Promise.all([page.waitForEvent("popup"), view.click()]);
  await pop.waitForSelector("iframe[src]");
  check(/\/onboarding\/notice\.html\?v=1$/.test(pop.url()), "別タブ（版つき）で開く");
  check((await text(pop, "#nv-sub")).includes("第1版"), "第1版");
  check((await pop.locator("iframe").getAttribute("src")).startsWith("https://storage.test/sign/hr/t1/labor-notice/e1/"), "署名付きURLで表示");
  check((await pop.locator("iframe").getAttribute("referrerpolicy")) === "no-referrer", "URL を外へ渡さない（no-referrer）");
  check((await text(pop, "#nv-note")).includes("数分で切れます"), "リンクは数分で切れる、と書いてある");
  await pop.close();
  check(!(await page.content()).includes("storage.test"), "本人の画面（/onboarding/）に、署名付きURLは出ていない");

  // 確認しました
  await page.click("#confirm-notice");
  await page.waitForSelector('[data-role="notice"][data-state="confirmed"]');
  check((await text(page, '[data-role="notice-state"]')).includes(`確認済み　${todayJst()}`), `「確認済み　${todayJst()}」`);
  check((await card.locator("a").first().innerText()).trim() === "もう一度見る" && await card.locator("button").count() === 0, "「もう一度見る」だけ（確認ボタンは消える）");
  check(await page.locator('[data-step="contract"]').getAttribute("data-state") === "done", "STEP2 が完了");
  check((await next.innerText()).includes("入社情報の入力"), "次にやること が、入社情報の入力に進む");
  const row = db.rows.gw_labor_notices[0];
  check(row.confirmed_at !== null && row.confirmed_by === "u-e1", "確認した日時・確認した人（本人）が残る");
  await page.screenshot({ path: shotPath("labor-notice-self-confirmed.png"), fullPage: true });

  // もう一度見る
  const [pop2] = await Promise.all([page.waitForEvent("popup"), card.locator('[data-role="notice-view"]').click()]);
  await pop2.waitForSelector("iframe[src]");
  check((await text(pop2, "#nv-sub")).includes("第1版"), "確認したあとも、もう一度見られる");
  await pop2.close();
}

// =================================================================================================
console.log("\n=== 他人には見えない ===");
{
  const other = await session("tok-e2");
  await other.page.goto(`${BASE}/onboarding/`);
  await other.page.waitForSelector("#main h1");
  await other.page.waitForTimeout(500);
  const body = await other.page.locator("body").innerText();
  check(!body.includes("山田") && !body.includes("確認済み　"), "別の入社予定者に、山田さんの通知書・確認は出ない");
  const direct = await other.page.evaluate(async () => {
    const t = JSON.parse(localStorage.getItem("kp_session")).access_token;
    const r = await fetch("/api/onboarding/start", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ action: "view_notice", version: 1, employeeId: "e1" }) });
    return r.status;
  });
  check(direct === 404 || direct === 403, `他人の通知書を直接開こうとしても、開けない（${direct}）`);
  // 本人の入口からは、管理側の API も使えない
  const adminTry = await other.page.evaluate(async () => {
    const t = JSON.parse(localStorage.getItem("kp_session")).access_token;
    const r = await fetch("/api/onboarding/notice?employeeId=e1", { headers: { Authorization: `Bearer ${t}` } });
    return r.status;
  });
  check(adminTry === 403, `一般の社員は、管理側の API を使えない（${adminTry}）`);
  await other.ctx.close();
}

// =================================================================================================
console.log("\n=== 管理側：確認済み・確認日時 → 差し替えると、新しい版は未確認 ===");
{
  const page = hr.page;
  await page.reload();
  await page.waitForSelector('[data-role="ln-status"][data-status="confirmed"]');
  const cur = page.locator('[data-role="ln-current"]');
  check((await text(page, '[data-role="ln-status"]')).trim() === "確認済み", "管理側に「確認済み」");
  check((await cur.innerText()).includes("確認済み（") && (await cur.innerText()).includes(todayJst()), "確認日時が分かる");

  // 差し替え（新しい版を足す）
  check((await text(page, '[data-role="ln-upload"]')).includes("差し替える"), "ボタンは「差し替える（新しい版を足す）」");
  await page.setInputFiles("#ln-file", PDF_FILE(2, "山田太郎_労働条件通知書_改定.pdf"));
  await page.click('[data-role="ln-upload"]');
  await page.waitForSelector('[data-role="ln-pending"]');
  check((await text(page, '[data-role="ln-pending"]')).includes("第2版"), "第2版（未公開）が出る");
  check((await text(page, "#labor-notice")).includes("差し替えの版（未公開）"), "差し替えの途中、と分かる");
  check((await text(page, '[data-role="ln-current"]')).includes("第1版") && (await text(page, '[data-role="ln-status"]')).trim() === "確認済み", "公開するまでは、第1版（確認済み）のまま");
  check(db.rows.gw_labor_notices.length === 2 && db.rows.gw_labor_notices[0].version === 1, "旧版の行は残っている");
  check(storage.objects.size === 2, "旧版のファイルも残っている（消さない）");

  const peek = await session("tok-e1");
  await peek.page.goto(`${BASE}/onboarding/`);
  await peek.page.waitForSelector('[data-role="notice"]');
  check((await peek.page.locator('[data-role="notice"]').getAttribute("data-state")) === "confirmed", "公開するまで、本人は確認済みのまま");
  await peek.ctx.close();

  dialogs.length = 0;
  await page.click('[data-role="ln-publish"]');
  await page.waitForSelector('[data-role="ln-status"][data-status="unconfirmed"]');
  check(dialogs.some((d) => d.includes("確認し直します")), "公開の前に、「本人は確認し直します」と知らせる");
  check((await text(page, '[data-role="ln-current"]')).includes("第2版") && (await text(page, '[data-role="ln-status"]')).trim() === "本人未確認", "差し替えると、第2版が「本人未確認」");
  await page.locator("#labor-notice details summary").click();
  const hist = await page.locator('[data-role="ln-history"] tbody tr').allInnerTexts();
  check(hist.length === 2 && hist[0].includes("第2版（公開中）") && hist[0].includes("未確認"), "履歴: 第2版（公開中）・未確認");
  check(hist[1].includes("第1版") && hist[1].includes(todayJst()), "履歴: 第1版の確認日時が残っている（旧版は消えない）");
  await page.screenshot({ path: shotPath("labor-notice-admin-replaced.png"), fullPage: true });
}
{
  const page = hire.page;
  await page.reload();
  await page.waitForSelector('[data-role="notice"]');
  check((await page.locator('[data-role="notice"]').getAttribute("data-state")) === "unconfirmed", "本人: 確認済み → 未確認に戻る");
  check((await text(page, '[data-role="next"]')).includes("労働条件通知書の確認"), "次にやること も、通知書の確認に戻る");
  const [pop] = await Promise.all([page.waitForEvent("popup"), page.locator('[data-role="notice-view"]').click()]);
  await pop.waitForSelector("iframe[src]");
  check((await text(pop, "#nv-sub")).includes("第2版"), "開くのは、新しい版（第2版）");
  await pop.close();
  // 古い版のまま開いていた別タブは、読み直しになる
  const stale = await hire.ctx.newPage();
  await stale.goto(`${BASE}/onboarding/notice.html?v=1`);
  await stale.waitForSelector(".nv-ban.err");
  check((await text(stale, ".nv-ban.err")).includes("更新されました"), "古い版を開いていた人には、「更新されました」と出る");
  await stale.close();
  // 古い版を確認しようとしても、確認にならない
  const stale2 = await page.evaluate(async () => {
    const t = JSON.parse(localStorage.getItem("kp_session")).access_token;
    const r = await fetch("/api/onboarding/start", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` }, body: JSON.stringify({ action: "confirm_notice", version: 1 }) });
    return r.status;
  });
  check(stale2 === 409 && db.rows.gw_labor_notices.find((r) => r.version === 2).confirmed_at === null, "古い版（第1版）の確認は、断られる（409）");
  await page.click("#confirm-notice");
  await page.waitForSelector('[data-role="notice"][data-state="confirmed"]');
  check(db.rows.gw_labor_notices.find((r) => r.version === 2).confirmed_at !== null && db.rows.gw_labor_notices.find((r) => r.version === 1).confirmed_at !== null, "第2版を確認。第1版の確認も残っている");
}

// =================================================================================================
console.log("\n=== 電子署名の依頼がある人：確認の入口を出さない ===");
{
  // 電子署名の依頼は、社労士への作成依頼（gw_doc_orders）から送られる。実際の並びに合わせる
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e1", title: "労働条件通知書", doc_kind: "employment", status: "sent", sent_at: new Date().toISOString() });
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e1", doc_kind: "employment", status: "sent" });
  const before = JSON.stringify(db.rows.gw_sign_requests);
  const page = hire.page;
  await page.reload();
  await page.waitForSelector('[data-step="contract"]');
  check(await page.locator('[data-role="notice"]').count() === 0, "通知書の確認の欄は出ない（電子署名を優先する）");
  check((await text(page, '[data-step="contract"]')).includes("締結してください"), "STEP2 は、これまでどおり『締結』");
  check((await page.locator('[data-role="next"]').innerText()).includes("労働条件通知書の締結"), "次にやること は、締結");
  check(JSON.stringify(db.rows.gw_sign_requests) === before, "電子署名の依頼（gw_sign_requests）は、書き換わっていない");

  const admin = hr.page;
  await admin.reload();
  await admin.waitForSelector('[data-role="ln-warning"]');
  check((await text(admin, '[data-role="ln-warning"]')).includes("電子署名"), "管理側には、「電子署名の依頼があります」と出る");
  db.rows.gw_sign_requests = [];
  db.rows.gw_doc_orders = [];
}

// =================================================================================================
console.log("\n=== 会計側の管理者（admin / staff）：通知書の欄そのものを出さない（API は 403）===");
{
  const noticeId = db.rows.gw_labor_notices[0].id;     // 通知書は、いま DB にある（見えないことの確認）
  const a = await session("tok-admin");
  const calls = [];
  a.page.on("response", (r) => { if (r.url().includes("/api/onboarding/notice")) calls.push([r.request().method(), r.status()]); });
  await a.page.goto(`${BASE}/admin-hr.html?id=p1#labor-notice`);
  await a.page.waitForSelector("#hr-date", { state: "attached" });
  await a.page.waitForTimeout(900);
  check(await a.page.locator("#labor-notice").count() === 0, "労働条件通知書の欄そのものが無い");
  check(!(await a.page.locator("body").innerText()).includes("労働条件通知書"), "画面のどこにも、「労働条件通知書」の文字が出ない");
  check(await a.page.locator('[data-role="ln-upload"], #ln-file, [data-role="ln-publish"]').count() === 0, "アップロード・公開の操作も無い");
  check(await a.page.locator("text=会社PCの準備").count() > 0, "ほかの入社管理の表示は、これまでどおり出る");
  check(calls.length >= 1 && calls.every(([, st]) => st === 403), `API は 403（いま ${JSON.stringify(calls)}）`);
  await a.page.screenshot({ path: shotPath("labor-notice-admin-denied.png"), fullPage: true });

  // 画面を通さず、プレビューの URL を直接開いても、中身は出ない
  const hits = viewerHits.length;
  const p2 = await a.ctx.newPage();
  await p2.goto(`${BASE}/onboarding/notice.html?file=${noticeId}`);
  await p2.waitForTimeout(900);
  check(await p2.locator("iframe").count() === 0, "プレビューを直接開いても、PDF は出ない");
  check(viewerHits.length === hits, "署名付きURLは、作られても開かれてもいない");
  check(!(await p2.locator("body").innerText()).includes("山田太郎_労働条件通知書"), "ファイル名も出ない");
  await a.ctx.close();

  // 同じ画面を owner・hr の人が開けば、欄は出る（権限で分かれている）
  const h = await session("tok-hr");
  await h.page.goto(`${BASE}/admin-hr.html?id=p1#labor-notice`);
  await h.page.waitForSelector('#labor-notice [data-role="ln-status"]');
  check(await h.page.locator("#labor-notice").isVisible(), "hr には、通知書の欄が出る");
  await h.ctx.close();
}

// =================================================================================================
console.log("\n=== スマホ幅（390px）===");
for (const [label, token, path] of [["本人 /onboarding/", "tok-e1", "/onboarding/"], ["別タブのビューア", "tok-e1", "/onboarding/notice.html?v=2"], ["入社管理", "tok-hr", "/admin-hr.html?id=p1#labor-notice"]]) {
  const s = await session(token, { width: 390, height: 800 });
  await s.page.goto(`${BASE}${path}`);
  await s.page.waitForTimeout(900);
  const of = await overflow(s.page);
  check(of <= 0, `${label}: 横にはみ出さない（はみ出し ${of}px）`);
  if (label === "本人 /onboarding/") await s.page.screenshot({ path: shotPath("labor-notice-self-sp.png"), fullPage: true });
  if (label === "入社管理") await s.page.screenshot({ path: shotPath("labor-notice-admin-sp.png"), fullPage: true });
  await s.ctx.close();
}

check(errs.length === 0, `ブラウザのエラーが無い ${errs.slice(0, 3).join(" / ")}`);
await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
