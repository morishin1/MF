// 本番 /sales の E2E（テスト用データだけで完結させる）。CI では回さない（本番を触るので手で流す）
//
//   NODE_USE_ENV_PROXY=1 node scripts/e2e/sales-prod.mjs
//
//   E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD … 管理者 or owner（必須）
//   E2E_SALES_EMAIL / E2E_SALES_PASSWORD … 営業担当ロールだけの人（任意。無ければ手順7の営業担当側は飛ばす）
//   E2E_BASE（既定 https://gw.8grp.co.jp）
//
// 生のクリックログ（無効クリックを含む）は画面・APIに出さないので、最後に出す SQL で確かめる。
//
// やらないこと：実在企業へのフォーム送信・既存企業の変更・営業禁止の変更・「それでもアタックする」の実行。
// 作るもの：テスト企業1社・テンプレート1件・アタック1件（送信完了はシステム上だけ）。
import { addBizDays, todayJst } from "../../lib/sales.js";

const BASE = (process.env.E2E_BASE || "https://gw.8grp.co.jp").replace(/\/+$/, "");
const RUN = new Date(Date.now() + 9 * 3600000).toISOString().replace(/[-:T]/g, "").slice(0, 12);
const COMPANY = `株式会社エイト【SALES E2E】${RUN}`;
const DEST = `https://8grp.co.jp/?sales_e2e=${RUN}`;
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const results = [];
const step = (no, name, ok, note = "") => { results.push({ no, name, ok, note }); console.log(`${ok ? "OK" : "NG"}  ${no} ${name}${note ? `　— ${note}` : ""}`); };
const need = (k) => { if (!process.env[k]) { console.error(`環境変数 ${k} がありません`); process.exit(2); } return process.env[k]; };

// このサンドボックスは HTTPS_PROXY 経由でしか外へ出られない。Chromium にも同じプロキシを渡す
// （プロキシのCAは ~/.pki/nssdb に登録済み。証明書の検証は止めない）
const pw = await import("playwright").catch(() => import("/opt/node22/lib/node_modules/playwright/index.mjs"));
const { globSync } = await import("node:fs");
const br = await pw.chromium.launch({
  executablePath: globSync("/opt/pw-browsers/chromium-*/chrome-linux/chrome").pop(),
  ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {}),
});

async function login(email, password) {
  const ctx = await br.newContext({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/index.html`);
  await page.fill("#email", email);
  await page.fill("#pw", password);
  await page.click("#go");
  await page.waitForFunction(() => !!localStorage.getItem("kp_session"), null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { ctx, page, errs };
}
const call = (page, fn, ...args) => page.evaluate(async ([f, a]) => {
  try { return { ok: true, v: await API[f](...a) }; }
  catch (e) { return { ok: false, status: e.status, code: e.code, body: e.body, msg: e.message }; }
}, [fn, args]);
const bannerErr = (page) => page.locator(".banner.err, .banner.warn").allInnerTexts();

const admin = await login(need("E2E_ADMIN_EMAIL"), need("E2E_ADMIN_PASSWORD"));
const A = admin.page;
const me = (await call(A, "me")).v;
const sender = me?.gw?.employee?.display_name || "";

// ---- 1. /sales と5画面 ----------------------------------------------------------
{
  const bad = [];
  for (const [p, label] of [["/sales", "ダッシュボード"], ["/sales/companies", "企業"], ["/sales/attack", "アタック"],
    ["/sales/clicks", "反応"], ["/sales/analytics", "分析"]]) {
    await A.goto(`${BASE}${p}`);
    await A.waitForTimeout(2000);
    const b = await bannerErr(A);
    if (b.length) bad.push(`${label}: ${b.join(" / ").slice(0, 120)}`);
    if (!(await A.locator(".sl-nav a.on").count())) bad.push(`${label}: ヘッダーが出ない`);
  }
  step(1, "/sales と 企業・アタック・反応・分析 が開く（準備中・エラーなし）", !bad.length && !admin.errs.length,
    [...bad, ...admin.errs].join(" / "));
}

// ---- 2. テスト企業 ----------------------------------------------------------------
const cr = await call(A, "createSalesCompany", {
  name: COMPANY, siteUrl: `https://sales-e2e-${RUN}.example.com/`, formUrl: `https://sales-e2e-${RUN}.example.com/contact`,
  industry: "その他", region: "E2E", service: "AI / DX", note: "本番E2E用のテスト企業。実在企業ではありません。",
});
const companyId = cr.v?.company?.id;
step(2, `テスト企業を作成（${COMPANY}）`, Boolean(companyId), cr.ok ? "" : cr.msg);
if (!companyId) { await br.close(); process.exit(1); }

// ---- 3. テンプレート ----------------------------------------------------------------
const tr = await call(A, "createSalesTemplate", {
  name: `SALES E2E ${RUN}`, service: "AI / DX",
  body: "{{company}}\nご担当者様\n\n株式会社エイトの{{sender}}です（E2Eテスト）。\n{{service}}のご案内です。\n詳細はこちら\n{{url}}",
  destinationUrl: DEST,
});
const templateId = tr.v?.template?.id;
step(3, "E2E用テンプレートを作成", Boolean(templateId), tr.ok ? "" : tr.msg);

// ---- 4. フォームアタック → 送信完了（システム上だけ） -------------------------------
let trackingUrl = "";
{
  await A.goto(`${BASE}/sales/companies.html?attack=${companyId}`);
  await A.waitForTimeout(2500);
  if (templateId) { await A.selectOption("#at-template", templateId); await A.waitForTimeout(2000); }
  const body = await A.locator("#at-body").inputValue();
  trackingUrl = (await A.locator(".atk-url").innerText()).trim();
  const tokOk = new RegExp(`^${BASE.replace(/[.]/g, "\\.")}/r/[2-9A-HJ-NP-Z]{10}$`).test(trackingUrl);
  step("4a", "専用URLが発行される", tokOk, trackingUrl);
  const subst = body.startsWith(COMPANY) && body.includes(sender) && body.includes("AI / DX") && body.includes(trackingUrl)
    && !/\{\{/.test(body);
  step("4b", "{{company}} {{sender}} {{service}} {{url}} が差し込まれる", subst, subst ? "" : body.slice(0, 200));

  await A.locator("button", { hasText: "送信完了" }).click();
  await A.waitForTimeout(2500);
  const d = (await call(A, "getSalesCompany", companyId)).v;
  const ap = d?.approaches?.[0];
  step("4c", "営業履歴が残る", (d?.timeline || []).some((t) => t.label === "フォーム送信"));
  step("4d", "本文が保存される", Boolean(ap?.body && ap.body.includes(trackingUrl)));
  step("4e", "送信日時が入る", Boolean(ap?.sentAt), ap?.sentAt || "");
  const due = addBizDays(todayJst(), 3);
  step("4f", "NEXT が「反応確認」・3営業日後", d?.company?.next === "反応確認" && d?.company?.nextDue === due,
    `${d?.company?.next} ${d?.company?.nextDue}（期待 ${due}）`);
}

// ---- 5. クリック（通常のスマホUA・1回） ------------------------------------------------
const hit = async () => {
  const r = await fetch(trackingUrl, { redirect: "manual", headers: { "user-agent": IPHONE, accept: "text/html" } });
  return { status: r.status, location: r.headers.get("location") };
};
{
  const r = await hit();
  step("5a", "本来のリンク先へリダイレクト", r.status === 302 && r.location === DEST, `${r.status} ${r.location}`);
  await A.waitForTimeout(3000);
  const d = (await call(A, "getSalesCompany", companyId)).v;
  const c = d?.company;
  step("5b", "有効クリック1回（click_count = 1）", c?.clickCount === 1, `clickCount=${c?.clickCount}`);
  step("5c", "企業が「クリックあり」", c?.status === "clicked", c?.status);
  step("5d", "NEXT が「クリックあり・要フォロー」", c?.next === "クリックあり・要フォロー", `${c?.next} ${c?.nextDue}`);
  await A.goto(`${BASE}/sales`);
  await A.waitForTimeout(2500);
  step("5e", "ダッシュボード最上部「クリックあり・未対応」に出る",
    (await A.locator("#list-click").innerText()).includes(COMPANY)
    && (await A.locator(".db-sec").first().getAttribute("id")) === "sec-click");
  const n = (await call(A, "listNotifications")).v;
  const list = n?.notifications || n || [];
  step("5f", "GW通知が届く", Array.isArray(list) && list.some((x) => String(x.title || "").includes(COMPANY)),
    "送った人（このアカウント）宛て");
}

// ---- 6. 30秒以内の再クリック ---------------------------------------------------------
{
  const r = await hit();
  await A.waitForTimeout(3000);
  const d = (await call(A, "getSalesCompany", companyId)).v;
  step("6", "30秒以内の再クリックは重複として数えない", r.status === 302 && d?.company?.clickCount === 1,
    `clickCount=${d?.company?.clickCount}（raw ログは SQL で確認）`);
}

// ---- 7. 30日重複営業防止 --------------------------------------------------------------
{
  const p = await call(A, "prepareSalesAttack", { companyId });
  step("7a", "再アタックはサーバが止める（管理者でも force なしなら 409）", !p.ok && p.status === 409 && p.code === "recent_attack",
    `${p.status} ${p.code}`);
  await A.goto(`${BASE}/sales/companies.html?attack=${companyId}`);
  await A.waitForTimeout(2500);
  const t = await A.locator(".atk").innerText();
  step("7b", "「直近30日以内にアタックされています」が出る", t.includes("直近30日以内にアタックされています"));
  step("7c", "管理者には「それでもアタックする」が出る（押さない）",
    (await A.locator("button", { hasText: "それでもアタックする" }).count()) === 1);

  if (process.env.E2E_SALES_EMAIL) {
    const s = await login(process.env.E2E_SALES_EMAIL, process.env.E2E_SALES_PASSWORD || "");
    const sp = await call(s.page, "prepareSalesAttack", { companyId });
    const sf = await call(s.page, "prepareSalesAttack", { companyId, force: true });
    await s.page.goto(`${BASE}/sales/companies.html?attack=${companyId}`);
    await s.page.waitForTimeout(2500);
    step("7d", "営業担当は送れない（409）・押し切りも不可（403）・ボタンも出ない",
      sp.status === 409 && sf.status === 403
      && !(await s.page.locator("button", { hasText: "それでもアタックする" }).count()),
      `通常 ${sp.status} / force ${sf.status}`);
    await s.ctx.close();
  } else {
    step("7d", "営業担当は送れない", null, "E2E_SALES_EMAIL 未設定のため未実施");
  }
}

// ---- 8. 既存機能 ------------------------------------------------------------------------
{
  const bad = [];
  for (const p of ["/hr", "/home.html", "/admin-dashboard.html", "/admin-members.html"]) {
    const before = admin.errs.length;
    await A.goto(`${BASE}${p}`);
    await A.waitForTimeout(2500);
    const b = (await A.locator(".banner.err").allInnerTexts()).join(" / ");
    if (b || admin.errs.length > before) bad.push(`${p}: ${b || admin.errs.slice(before).join(" / ")}`.slice(0, 160));
    if (/index\.html/.test(A.url())) bad.push(`${p}: ログイン画面に戻された`);
  }
  const n = await call(A, "listNotifications");
  if (!n.ok) bad.push(`通知API: ${n.status} ${n.msg}`);
  step(8, "/hr・ホーム・管理ダッシュボード・メンバー管理・通知 が開く", !bad.length, bad.join(" / "));
}

await br.close();
console.log(`\ncompanyId=${companyId}\ntemplateId=${templateId}\ntrackingUrl=${trackingUrl}\nRUN=${RUN}`);
console.log(`\n-- 生のクリックログ（Supabase SQL Editor で。有効1件＋重複1件になるはず）
select clicked_at, method, is_valid, excluded_reason, click_no, left(user_agent, 40) as ua
  from public.gw_sales_click_events where company_id = '${companyId}' order by clicked_at;`);
const ng = results.filter((r) => r.ok === false).length;
console.log(`\n${results.length} 項目中 NG ${ng}`);
process.exit(ng ? 1 : 0);
