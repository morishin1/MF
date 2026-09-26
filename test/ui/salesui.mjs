// 営業アタック管理（/sales）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 営業担当としてログインすると、専用ヘッダー（EIGHT/SALES・5ナビ）が出る
//   2. ダッシュボードの「今やること」に、未対応クリックが件数つきで出る
//   3. 企業一覧 → 右ドロワー → フォームアタック → 本文に専用URLが入る →
//      「送信完了」で本文つきの記録が送られる
//   4. 直近30日以内にアタック済みなら、警告が出て送れない（営業担当には押し切りボタンを出さない）
//   5. 権限の無い人は home.html へ送り返される
//   6. スマホ幅でも横にはみ出さない
import { launch, BASE, jstToday } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const SALES = { id: "emp-s1", display_name: "営業 一郎", status: "active" };
const TODAY = jstToday();
const NOW = new Date().toISOString();

function company(over) {
  return {
    id: "c1", name: "株式会社サンプル", domain: "sample.co.jp", siteUrl: "https://sample.co.jp/",
    formUrl: "https://sample.co.jp/contact", industry: "製造", region: "東京都", service: "AI / DX",
    ownerId: "emp-s1", ownerName: "営業 一郎", status: "untouched", statusLabel: "未アタック",
    ngReason: null, ngLabel: null, attackCount: 0, lastSentAt: null, clickCount: 0, firstClickAt: null,
    lastClickAt: null, unhandledClick: false, next: "フォームアタック", nextKey: "attack", nextDue: null,
    overdue: false, campaignId: null, campaignName: null, ...over,
  };
}

async function openAs({ roles = ["sales"], isAdmin = false, recent = null } = {}) {
  const calls = [];
  const companies = [
    company({}),
    company({ id: "c2", name: "反応商事", domain: "hannou.jp", status: "clicked", statusLabel: "クリックあり",
      attackCount: 1, lastSentAt: NOW, clickCount: 2, firstClickAt: NOW, lastClickAt: NOW, unhandledClick: true,
      next: "クリックあり → フォロー", nextKey: "follow_click", nextDue: TODAY }),
  ];
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "sales@8grp.co.jp", appRole: isAdmin ? "admin" : "member", isAdmin, shows: {},
        gw: { employee: SALES, roles, isAdmin, tenantId: "t1", stage: null } });
    }
    if (/\/api\/sales\/companies\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id");
      const c = companies.find((x) => x.id === id);
      return send({
        today: TODAY, company: c, approaches: [], recent,
        timeline: c.lastSentAt ? [{ at: c.lastSentAt, kind: "attack", label: "フォーム送信" },
          { at: c.lastClickAt, kind: "click", label: "リンククリック" }] : [],
        canForce: isAdmin, members: [{ id: "emp-s1", display_name: "営業 一郎" }], campaigns: [],
        statuses: [{ key: "untouched", label: "未アタック" }, { key: "attacked", label: "アタック済" }],
        ngReasons: [{ key: "no_sales", label: "営業禁止" }],
        eventKinds: [{ key: "follow", label: "フォロー" }, { key: "reply", label: "返信あり" }],
      });
    }
    if (/\/api\/sales\/companies\b/.test(url)) {
      return send({ today: TODAY, me: "emp-s1", members: [{ id: "emp-s1", display_name: "営業 一郎" }], companies });
    }
    if (/\/api\/sales\/templates\b/.test(url)) {
      return send({ services: [], templates: [{ id: "t1", name: "DX基本", service: "AI / DX", subject: null,
        body: "{{company}}\nご担当者様\n\n{{sender}}です。\n詳細はこちら\n{{url}}", destinationUrl: "https://8grp.co.jp/service/dx",
        archived: false, uses: 0 }] });
    }
    if (/\/api\/sales\/approaches\b/.test(url)) {
      if (req.method() === "POST") {
        calls.push({ kind: "prepare", body: body() });
        if (recent && !body().force) return send({ error: "recent_attack", recent, canForce: isAdmin, hint: "直近30日以内にアタックされています" }, 409);
        return send({ approach: { id: "ap1", trackingToken: "X7K92PABCD", sentAt: null },
          trackingUrl: "https://gw.8grp.co.jp/r/X7K92PABCD" });
      }
      if (req.method() === "PATCH") {
        calls.push({ kind: "act", body: body() });
        return send({ approach: { id: "ap1", sentAt: NOW } });
      }
      return send({ approaches: [] });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  return { page, calls, errs };
}

console.log("\n=== 営業担当：ダッシュボード ===");
{
  const { page, errs } = await openAs();
  await page.goto(`${BASE}/sales/index.html`);
  await page.waitForTimeout(1000);

  check((await page.locator(".sl-logo").innerText()).includes("SALES"), "EIGHT/SALES のロゴが出る");
  const nav = await page.locator(".sl-nav a").allInnerTexts();
  check(nav.length === 5, `ナビは5つ（いま ${nav.length}: ${nav.join(" / ")}）`);
  check(["ダッシュボード", "企業", "アタック", "反応", "分析"].every((l) => nav.some((t) => t.includes(l))),
    "ダッシュボード／企業／アタック／反応／分析");
  check((await page.locator(".sl-nav a.on").innerText()).includes("ダッシュボード"), "いま見ているタブが選ばれている");

  const todo = await page.locator("#todo").innerText();
  check(/クリックあり・未対応\s*1\s*社/.test(todo), `未対応クリックが1社（${todo.replace(/\s+/g, " ")}）`);
  check(/今日アタック\s*1\s*社/.test(todo), "今日アタックが1社");
  const list = await page.locator("#todo-list").innerText();
  check(list.includes("反応商事"), "未対応クリックがあれば、最初はその一覧を開く");
  check((await page.locator("#hot").innerText()).includes("反応商事"), "反応があった企業に出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 営業担当：企業 → フォームアタック → 送信完了 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.waitForTimeout(1000);

  check((await page.locator("#rows tr").count()) === 2, "一覧に2社");
  await page.locator("#rows tr", { hasText: "株式会社サンプル" }).click();
  await page.waitForTimeout(500);
  check(await page.locator(".sl-detail").isVisible(), "右ドロワーで詳細が開く");
  check((await page.locator(".sl-next h3").innerText()).includes("フォームアタック"), "NEXTはフォームアタック");

  await page.locator(".sl-next button", { hasText: "フォームアタック" }).click();
  await page.waitForTimeout(800);
  check(await page.locator(".atk").isVisible(), "フォームアタック画面が開く");
  const text = await page.locator("#at-body").inputValue();
  check(text.startsWith("株式会社サンプル"), "企業名が差し込まれる");
  check(text.includes("営業 一郎"), "送る人の名前が差し込まれる");
  check(text.includes("https://gw.8grp.co.jp/r/X7K92PABCD"), "専用URLが本文に入る");
  check(calls.some((c) => c.kind === "prepare" && c.body.companyId === "c1" && c.body.templateId === "t1"),
    "開いた時点で専用URLを発行している（テンプレートつき）");
  check(await page.locator(".atk a", { hasText: "問い合わせフォームを開く" }).count() === 1, "フォームを開くボタンがある");

  await page.locator("button", { hasText: "送信完了" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent && sent.body.action === "sent" && sent.body.id === "ap1", "送信完了を記録した");
  check(sent && sent.body.body.includes("/r/X7K92PABCD"), "送った本文（専用URLつき）を残す");
  check(sent && sent.body.service === "AI / DX", "提案サービスも残す");
  check(!(await page.locator(".atk").count()), "送信完了で閉じる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 直近30日以内：警告して送らせない ===");
{
  const recent = { sentAt: NOW, employeeName: "営業 二郎", service: "PCレンタル", days: 30 };
  const { page, errs } = await openAs({ recent });
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.waitForTimeout(1000);
  check((await page.locator(".sl-detail").innerText()).includes("営業 二郎さんがアタック済み"), "企業ページに「〇〇さんがアタック済み」");

  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.waitForTimeout(1000);
  const t = await page.locator(".atk").innerText();
  check(t.includes("直近30日以内にアタックされています"), "警告が出る");
  check(t.includes("営業 二郎") && t.includes("PCレンタル"), "前回の担当・サービスが出る");
  check(!(await page.locator("#at-body").count()), "営業文は出さない");
  check(!(await page.locator("button", { hasText: "それでもアタックする" }).count()), "営業担当には押し切りボタンを出さない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  const admin = await openAs({ recent, isAdmin: true, roles: [] });
  await admin.page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await admin.page.waitForTimeout(1000);
  check(await admin.page.locator("button", { hasText: "それでもアタックする" }).count() === 1, "管理者には押し切りボタンが出る");
  await admin.page.locator("button", { hasText: "それでもアタックする" }).click();
  await admin.page.waitForTimeout(800);
  check(admin.calls.some((c) => c.kind === "prepare" && c.body.force === true), "押し切りは force つきで頼む");
  check(await admin.page.locator("#at-body").count() === 1, "押し切ると営業文が出る");
  await admin.page.close();
}

console.log("\n=== 権限の無い人 ===");
{
  const { page } = await openAs({ roles: [] });
  await page.goto(`${BASE}/sales/index.html`);
  await page.waitForTimeout(1000);
  check(/home\.html/.test(page.url()), `home.html へ送り返す（いま ${page.url()}）`);
  await page.close();
}

console.log("\n=== スマホ幅 ===");
{
  const { page, errs } = await openAs();
  await page.setViewportSize({ width: 375, height: 800 });
  for (const p of ["index", "companies", "attack", "clicks", "analytics", "templates", "campaigns"]) {
    await page.goto(`${BASE}/sales/${p}.html`);
    await page.waitForTimeout(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 1, `${p}.html 横にはみ出さない（${over}px）`);
  }
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通りました");
process.exit(bad ? 1 : 0);
