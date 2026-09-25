// 採用HR Stage 6：候補者向け公開ページ（hr-offer.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 有効なtokenで開くと、合格通知の内容（本人向けメッセージ含む）が表示される
//   2. 社員用のレイアウト（KPLayout/HRLayout・サイドバー・ヘッダー）は出ない
//   3. tokenが無い・開けない場合は、技術的なエラーではなく案内文が出る
//   4. 期限切れは、内容を出さず、期限切れの案内が出る
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

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
