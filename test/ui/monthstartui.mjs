// 月初業務D1（外部提出フォーム）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 管理画面：今月の対象者が一覧に出て、開くと窓口の発行・URLコピーができる
//   2. 発行直後だけURLが見える（guest-invite・admin-contactと同じ考え方）
//   3. 外部会社：URLを開くと本人名・現場が見え、ファイルを送ると成功が分かる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("\n=== 管理画面：月初作業管理 ===");
{
  const posted = [];
  let nextToken = 1;
  let linkStatus = "none";

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務 花子", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  const ROW = () => ({
    employeeId: "emp-1", employeeName: "現場 太郎", department: "常駐部",
    siteContractId: "sc-1", engagementKind: "bp", siteCompany: "顧客A社", primeCompany: null,
    timesheetReceived: false, invoiceReceived: false, billingProgressId: null,
    linkStatus, submissions: linkStatus === "active" ? [
      { id: "sub-1", kind: "timesheet", fileName: "202609.pdf", submittedAt: "2026-09-03T01:00:00Z" },
    ] : [],
  });

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "hr@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {},
        gw: { employee: { id: "emp-hr", display_name: "事務 花子" }, roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null } });
    }
    if (/\/api\/billing-submission\/file/.test(url)) return send({ url: "https://example.com/file.pdf", filename: "202609.pdf" });
    if (/\/api\/billing-submission\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        linkStatus = "active";
        return send({ token: `tok-${nextToken++}`, expiresAt: "2027-09-01T00:00:00Z" });
      }
      return send({ rows: [ROW()], month: "2026-09" });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-month-start.html`);
  await page.waitForTimeout(1000);

  console.log("— 一覧に対象者が出る —");
  check((await page.locator("#ms-rows").innerText()).includes("現場 太郎"), "氏名が出る");
  check((await page.locator("#ms-rows").innerText()).includes("未提出"), "未提出と分かる");

  console.log("— 開いて窓口を発行する —");
  await page.locator("#ms-rows tr.click").first().click();
  await page.waitForTimeout(400);
  check(await page.locator("#ms-detail").isVisible(), "詳細が開く");
  await page.locator("button", { hasText: "窓口を発行" }).click();
  await page.waitForTimeout(600);

  check(posted.some((p) => p.employeeId === "emp-1"), "発行が送られる");
  const detailBox = await page.locator("#ms-detail input[readonly]").inputValue();
  check(/billing-submit\.html\?token=tok-1/.test(detailBox), "発行直後だけURLが見える");
  check(await page.locator("button", { hasText: "URLをコピー" }).count() === 1, "URLコピーのボタンがある");

  console.log("— 届いたファイルを見る —");
  check((await page.locator("#ms-detail").innerText()).includes("202609.pdf"), "届いたファイルが出る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 外部会社：勤務表・請求書を送る ===");
{
  const submitted = [];
  let putCalled = false;

  const page = await br.newPage({ viewport: { width: 480, height: 900 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/billing-submission/public**", (route) => {
    const req = route.request();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (req.method() === "GET") {
      return send({
        displayName: "現場 太郎", tenantName: "株式会社エイト",
        contracts: [{ id: "sc-1", siteCompany: "顧客A社", primeCompany: null, engagementKind: "bp", active: true }],
      });
    }
    const b = JSON.parse(req.postData() || "{}");
    submitted.push(b);
    return send({ submissionId: "sub-1", uploadUrl: "https://example.com/upload", token: "up-1" });
  });
  await page.route("https://example.com/upload", (route) => {
    putCalled = true;
    route.fulfill({ status: 200, body: "" });
  });

  await page.goto(`${BASE}/billing-submit.html?token=faketoken1234567890123456789012`);
  await page.waitForTimeout(900);

  console.log("— 本人名・現場が見える —");
  const box = await page.locator("#box").innerText();
  check(/現場 太郎/.test(box), "氏名が出る");
  check(/株式会社エイト/.test(box), "宛先が出る");

  console.log("— ファイルを選んで送る —");
  await page.locator("#s-month").fill("2026-09");
  await page.setInputFiles("#s-file", {
    name: "202609.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake"),
  });
  await page.locator("#go").click();
  await page.waitForTimeout(900);

  check(submitted.length === 1, "送信が届く");
  check(submitted[0].targetMonth === "2026-09" && submitted[0].kind === "timesheet", "対象年月・区分が正しく送られる");
  check(putCalled, "ファイルそのものもアップロードされる");
  check((await page.locator("#msg").innerText()).includes("送信しました"), "成功が分かる");
  check(await page.locator("#hist-card").isVisible(), "送った記録が残る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
