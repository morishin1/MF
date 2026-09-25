// 採用HR Stage 6・7：候補者向け公開ページ（hr-offer.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 有効なtokenで開くと、合格通知の内容（本人向けメッセージ含む）が表示される
//   2. 社員用のレイアウト（KPLayout/HRLayout・サイドバー・ヘッダー）は出ない
//   3. tokenが無い・開けない場合は、技術的なエラーではなく案内文が出る
//   4. 期限切れは、内容を出さず、期限切れの案内が出る
//   5. 承諾・辞退できる。すでに回答済みなら、ボタンではなく結果だけが出る
//   6. 採用担当へ連絡（mailto）のリンクが出る。連絡先が無ければ出さない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("\n=== 有効なURLで開くと、合格通知が表示される ===");
{
  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/hr\/offers\/public/.test(url)) {
      return send({
        tenantName: "株式会社エイト", candidateName: "山田 太郎", jobTitle: "エンジニア",
        employmentType: "正社員", contractType: "無期", contractEndDate: null, joinDate: "2026-11-01",
        probationMonths: 3, wageType: "月給", wageAmount: 400000, weeklyHours: 40, workLocation: "東京",
        messageToCandidate: "皆様とご一緒できることを楽しみにしています。", respondBy: "2026-10-15",
        responseStatus: "pending", recruiterName: "採用 花子", recruiterEmail: "recruit@example.com",
      });
    }
    return send({});
  });

  await page.goto(`${BASE}/hr-offer.html?token=abcdef1234567890abcdef1234567890`);
  await page.waitForTimeout(800);

  const text = await page.locator("#box").innerText();
  check(text.includes("株式会社エイト"), "会社名が出る");
  check(text.includes("山田 太郎"), "候補者名が出る");
  check(text.includes("エンジニア"), "職種が出る");
  check(text.includes("正社員"), "雇用形態が出る");
  check(text.includes("400,000円"), "給与が3桁区切りで出る");
  check(text.includes("週40時間"), "勤務時間が出る");
  check(text.includes("東京"), "勤務地が出る");
  check(text.includes("2026年10月15日"), "回答期限が日本語表記で出る");
  check(text.includes("皆様とご一緒できることを楽しみにしています。"), "本人向けメッセージが出る");

  check(!(await page.locator(".kp-sidebar").count()), "社員用サイドバーは出ない");
  check(!(await page.locator(".hr-nav").count()), "HR専用ナビは出ない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== tokenが無い・開けない場合は、案内文が出る（技術エラーは出さない） ===");
{
  const page = await br.newPage({ viewport: { width: 900, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.goto(`${BASE}/hr-offer.html`);
  await page.waitForTimeout(500);
  const text = await page.locator("#box").innerText();
  check(text.includes("URLが正しくありません"), "URLが無い場合の案内が出る");
  check(!text.includes("PGRST"), "内部エラーコードは出さない");
  await page.close();
}
{
  const page = await br.newPage({ viewport: { width: 900, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.route("**/api/**", (route) => route.fulfill({
    status: 404, contentType: "application/json",
    body: JSON.stringify({ error: "invalid_token", hint: "このURLは開けません。採用担当までお問い合わせください。" }),
  }));
  await page.goto(`${BASE}/hr-offer.html?token=invalidinvalidinvalidinvalidinvalid`);
  await page.waitForTimeout(500);
  const text = await page.locator("#box").innerText();
  check(text.includes("開けません"), "不正tokenの案内が出る");
  check(text.includes("採用担当"), "採用担当への問い合わせ案内が出る");
  await page.close();
}

console.log("\n=== 期限切れは、内容を出さず、期限切れの案内が出る ===");
{
  const page = await br.newPage({ viewport: { width: 900, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.route("**/api/**", (route) => route.fulfill({
    status: 410, contentType: "application/json",
    body: JSON.stringify({ error: "expired", hint: "このご案内の回答期限を過ぎています。恐れ入りますが、採用担当までお問い合わせください。" }),
  }));
  await page.goto(`${BASE}/hr-offer.html?token=expiredexpiredexpiredexpiredexpired`);
  await page.waitForTimeout(500);
  const text = await page.locator("#box").innerText();
  check(text.includes("回答期限を過ぎています"), "期限切れの案内が出る");
  check(!text.includes("400,000"), "合格通知の内容は出ない");
  await page.close();
}

console.log("\n=== 承諾する ===");
{
  const state = { responseStatus: "pending" };
  const posted = [];
  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  page.on("dialog", (d) => d.accept());
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/hr\/offers\/public/.test(url) && req.method() === "GET") {
      return send({
        tenantName: "株式会社エイト", candidateName: "山田 太郎", jobTitle: "エンジニア",
        joinDate: "2026-11-01", wageType: "月給", wageAmount: 400000, respondBy: "2026-10-15",
        responseStatus: state.responseStatus, recruiterEmail: "recruit@example.com",
      });
    }
    if (/\/api\/hr\/offers\/public/.test(url) && req.method() === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      state.responseStatus = b.action === "accept" ? "accepted" : "declined";
      return send({ ok: true, responseStatus: state.responseStatus });
    }
    return send({});
  });

  await page.goto(`${BASE}/hr-offer.html?token=abcdef1234567890abcdef1234567890`);
  await page.waitForTimeout(800);

  check(await page.locator("button", { hasText: "承諾する" }).count() === 1, "承諾するボタンが出る");
  check(await page.locator("button", { hasText: "辞退する" }).count() === 1, "辞退するボタンが出る");
  const mailHref = await page.locator("a", { hasText: "採用担当へ連絡" }).getAttribute("href");
  check(mailHref?.startsWith("mailto:recruit%40example.com"), "採用担当へのmailtoリンクが出る");

  await page.locator("button", { hasText: "承諾する" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "accept"), "承諾がサーバへ送られる");
  const text = await page.locator("#box").innerText();
  check(text.includes("承諾済み"), "承諾済みの案内に切り替わる");
  check(await page.locator("button", { hasText: "承諾する" }).count() === 0, "承諾ボタンは消える");
  await page.close();
}

console.log("\n=== 辞退する（理由つき） ===");
{
  const posted = [];
  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/hr\/offers\/public/.test(url) && req.method() === "GET") {
      return send({
        tenantName: "株式会社エイト", candidateName: "山田 太郎", respondBy: "2026-10-15",
        responseStatus: "pending", recruiterEmail: "recruit@example.com",
      });
    }
    if (/\/api\/hr\/offers\/public/.test(url) && req.method() === "POST") {
      posted.push(JSON.parse(req.postData() || "{}"));
      return send({ ok: true, responseStatus: "declined" });
    }
    return send({});
  });

  await page.goto(`${BASE}/hr-offer.html?token=abcdef1234567890abcdef1234567890`);
  await page.waitForTimeout(800);

  await page.locator("button", { hasText: "辞退する" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("#ho-reason").count() === 1, "辞退理由の入力欄が開く");
  await page.fill("#ho-reason", "他社の内定を承諾したため");
  await page.locator("button", { hasText: "この内容で辞退する" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "decline" && p.declineReason === "他社の内定を承諾したため"), "辞退理由つきで送られる");
  check((await page.locator("#box").innerText()).includes("辞退のご連絡"), "辞退の案内に切り替わる");
  await page.close();
}

console.log("\n=== すでに回答済みなら、ボタンではなく結果だけが出る ===");
{
  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.route("**/api/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      tenantName: "株式会社エイト", candidateName: "山田 太郎", respondBy: "2026-10-15",
      responseStatus: "accepted", recruiterEmail: "recruit@example.com",
    }),
  }));
  await page.goto(`${BASE}/hr-offer.html?token=abcdef1234567890abcdef1234567890`);
  await page.waitForTimeout(800);
  check((await page.locator("#box").innerText()).includes("承諾済み"), "承諾済みの案内が出る");
  check(await page.locator("button", { hasText: "承諾する" }).count() === 0, "承諾ボタンは出ない");
  check(await page.locator("button", { hasText: "辞退する" }).count() === 0, "辞退ボタンも出ない");
  await page.close();
}

console.log("\n=== 採用担当の連絡先が無ければ、連絡ボタンは出さない ===");
{
  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.route("**/api/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      tenantName: "株式会社エイト", candidateName: "山田 太郎", respondBy: "2026-10-15",
      responseStatus: "pending", recruiterEmail: null,
    }),
  }));
  await page.goto(`${BASE}/hr-offer.html?token=abcdef1234567890abcdef1234567890`);
  await page.waitForTimeout(800);
  check(await page.locator("a", { hasText: "採用担当へ連絡" }).count() === 0, "連絡先が無ければリンクを出さない");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
