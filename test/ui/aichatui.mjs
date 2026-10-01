// 社内AI（messages.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 質問すると、回答・出典・担当者に相談するボタンが出る
//   2. 回答を評価できる（役に立った／違っている）
//   3. よくある質問をクリックすると、その場で送信される
//   4. 「担当者に相談する」を押すと、要約を引き継いで問い合わせ画面に移る
//   5. 「AIを使わずに直接問い合わせる」からも送れる
//   6. スマホ幅でも崩れない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { id: "emp-1", display_name: "現場 太郎", department: "制作部", status: "active" };

function mockRoutes(page, { posted }) {
  const askCount = { n: 0 };
  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(req.postData() || "{}"); } catch { return {}; } };

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "genba@8grp.co.jp", appRole: "member", shows: {},
        gw: { employee: ME, roles: [], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/ai\/ask/.test(url) && req.method() === "POST") {
      const b = body();
      posted.push({ url: "ask", body: b });
      askCount.n++;
      const threadId = b.threadId || "th-1";
      return send({
        threadId, title: b.question.slice(0, 20), category: "hr",
        userMessage: { id: `u${askCount.n}`, role: "user", content: b.question, created_at: new Date().toISOString() },
        assistantMessage: {
          id: `a${askCount.n}`, role: "assistant", content: `回答: ${b.question}`,
          created_at: new Date().toISOString(), confident: true,
          sources: [{ id: "src1", title: "有給休暇の申請方法", link_url: "requests.html", link_label: "休暇・申請を開く" }],
        },
      });
    }
    if (/\/api\/ai\/threads\b/.test(url)) return send({ threads: [] });
    if (/\/api\/ai\/inquiries\b/.test(url)) {
      if (req.method() === "POST") {
        const b = body();
        posted.push({ url: "inquiries", body: b });
        return send({ inquiry: { id: "iq-1", category: "hr", subject: b.threadId ? "AIへの相談" : (b.note || "").slice(0, 20), status: "new" } });
      }
      return send({ inquiries: [] });
    }
    if (/\/api\/ai\/inquiry\b/.test(url)) {
      if (req.method() === "GET") {
        return send({
          inquiry: { id: "iq-1", subject: "AIへの相談", status: "new" },
          messages: [{ id: "m0", sender_type: "system", content: "【相談内容】有給休暇はどう申請しますか\n\n【AIが回答した内容】回答: 有給休暇はどう申請しますか", created_at: new Date().toISOString() }],
        });
      }
      const b = body();
      posted.push({ url: "inquiry-reply", body: b });
      return send({ message: { id: "m1", sender_type: "employee", content: b.content, created_at: new Date().toISOString() } });
    }
    if (/\/api\/ai\/feedback/.test(url)) {
      posted.push({ url: "feedback", body: body() });
      return send({ ok: true });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
}

console.log("\n=== 質問して回答・出典・評価・エスカレーション ===");
{
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1000, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "genba@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "現場 太郎", shows: {}, stage: null }));
  });
  await mockRoutes(page, { posted });

  await page.goto(`${BASE}/messages.html`);
  await page.waitForTimeout(1000);

  console.log("— 質問すると回答・出典・相談ボタンが出る —");
  await page.locator("#ask-input").fill("有給休暇はどう申請しますか");
  await page.locator("#ask-send").click();
  await page.waitForTimeout(900);
  check(await page.locator("#view-thread").isVisible(), "相談画面に切り替わる");
  check((await page.locator("#th-messages").textContent()).includes("回答: 有給休暇はどう申請しますか"), "回答が出る");
  check(await page.locator(".ai-src a").count() === 1, "出典リンクが出る");
  check(await page.locator("button", { hasText: "担当者に相談する" }).count() === 1, "担当者に相談するボタンが出る");

  console.log("— 評価できる —");
  await page.locator(".ai-fb button", { hasText: "役に立った" }).first().click();
  await page.waitForTimeout(400);
  check(posted.some((p) => p.url === "feedback" && p.body.rating === "up"), "評価が送られる");
  check(await page.locator(".ai-fb button.on", { hasText: "役に立った" }).count() === 1, "押した側がonになる");

  console.log("— 担当者に相談すると、要約を引き継いで問い合わせ画面に移る —");
  await page.locator("button", { hasText: "担当者に相談する" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.url === "inquiries" && p.body.threadId), "threadIdを渡してエスカレーションする");
  check(await page.locator("#view-inquiry").isVisible(), "問い合わせ画面に切り替わる");
  check((await page.locator("#iq-messages").textContent()).includes("相談内容"), "要約が表示される");

  console.log("— 問い合わせに返信できる —");
  await page.locator("#iq-input").fill("早めにお願いします");
  await page.locator("#iq-send").click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.url === "inquiry-reply" && p.body.content === "早めにお願いします"), "返信が送られる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== よくある質問・直接問い合わせ ===");
{
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1000, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "genba@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "現場 太郎", shows: {}, stage: null }));
  });
  await mockRoutes(page, { posted });

  await page.goto(`${BASE}/messages.html`);
  await page.waitForTimeout(1000);

  console.log("— よくある質問を押すと、その場で送信される —");
  const faqBtn = page.locator("#faq button").first();
  const faqText = await faqBtn.textContent();
  await faqBtn.click();
  await page.waitForTimeout(900);
  check(posted.some((p) => p.url === "ask" && p.body.question === faqText), "よくある質問の文言がそのまま送られる");

  console.log("— AIを使わず直接問い合わせできる —");
  await page.locator('#view-thread button[title="一覧へ戻る"]').click();
  await page.waitForTimeout(300);
  await page.locator("button", { hasText: "AIを使わずに直接問い合わせる" }).click();
  await page.locator("#direct-input").fill("至急、PCを紛失しました");
  await page.locator("button", { hasText: "送信する" }).click();
  await page.waitForTimeout(600);
  check(posted.some((p) => p.url === "inquiries" && p.body.note === "至急、PCを紛失しました"), "note付きで送られる（threadId無し）");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== スマホ幅でも崩れない ===");
{
  const page = await br.newPage({ viewport: { width: 390, height: 844 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "genba@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "現場 太郎", shows: {}, stage: null }));
  });
  await mockRoutes(page, { posted: [] });
  await page.goto(`${BASE}/messages.html`);
  await page.waitForTimeout(1000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `横スクロールが出ない（はみ出し ${overflow}px）`);
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
