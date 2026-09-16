// 名簿の「区分」（プロパー／BP）と、BP企業の名簿を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. BPを選ぶと、所属先（BP企業）を選ぶ欄が出る
//   2. 選んで追加すると、区分・所属先がそのままサーバへ送られる
//   3. 一覧に「BP（会社名）」まで出る
//   4. BP企業を、その場で追加できる
//   5. 075（BP）が未適用の環境では、区分の欄ごと出さない（これまでどおり動く）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ADMIN = { email: "hr@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {}, roles: [], memberships: [],
  gw: { employee: { id: "emp-hr", display_name: "事務 花子", status: "active" },
        roles: ["hr"], tenantId: "t1", stage: null } };

console.log("\n=== 名簿：BPを追加する（075適用済み） ===");
{
  const posted = [];
  let employees = [
    { id: "emp-1", display_name: "山田 太郎", email: "yamada@8grp.co.jp", department: "営業",
      employment_type: "正社員", status: "active", employee_kind: "proper", partner_company_id: null,
      roles: [], accounts: {} },
  ];
  let companies = [{ id: "co-1", company_name: "株式会社サンプル", invoice_registration_number: "T123" }];

  const page = await br.newPage({ viewport: { width: 1400, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/employees\/roles/.test(url)) return send({ ok: true });
    if (/\/api\/employees\/bulk/.test(url)) return send({ results: [] });
    if (/\/api\/employees\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        const made = { id: `emp-${employees.length + 1}`, ...b, roles: [], accounts: {} };
        employees = [...employees, made];
        return send({ employee: made, account: null });
      }
      return send({ employees, canManage: true, canGrantRoles: true, systems: {}, kindReady: true });
    }
    if (/\/api\/partners\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        const made = { id: `co-${companies.length + 1}`, ...b };
        companies = [...companies, made];
        return send({ company: made });
      }
      return send({ companies, canManage: true });
    }
    if (/\/api\/me\b/.test(url)) return send(ADMIN);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1200);

  console.log("— 区分の欄 —");
  check(await page.locator("#e-kind-wrap").isVisible(), "区分の欄が出る（075適用済みのため）");
  check(!(await page.locator("#e-partner-wrap").isVisible()), "既定（プロパー）では所属先は出さない");

  await page.locator("#e-kind").selectOption("bp");
  check(await page.locator("#e-partner-wrap").isVisible(), "BPを選ぶと所属先の欄が出る");

  console.log("— BPを選ばずに所属先未選択で追加すると止める —");
  await page.locator("#e-name").fill("BP 次郎");
  await page.locator("#e-save").click();
  await page.waitForTimeout(400);
  check(/所属先/.test(await page.locator("#e-msg").innerText()), "所属先を選ぶよう言われる");
  check(posted.filter((p) => p.display_name === "BP 次郎").length === 0, "まだ送られていない");

  console.log("— 所属先を選んで追加 —");
  await page.locator("#e-partner").selectOption("co-1");
  await page.locator("#e-save").click();
  await page.waitForTimeout(700);
  const sentBp = posted.find((p) => p.display_name === "BP 次郎");
  check(!!sentBp, "送られた");
  check(sentBp?.employee_kind === "bp" && sentBp?.partner_company_id === "co-1",
    "区分と所属先がそのまま送られる");

  console.log("— 一覧に会社名まで出る —");
  const listText = await page.locator("#list").innerText();
  check(/BP（株式会社サンプル）/.test(listText), "会社名まで出る");
  check(/プロパー/.test(listText), "既存の人はプロパーと出る");

  console.log("— BP企業をその場で追加 —");
  await page.locator("#partner-card button", { hasText: "開く" }).click();
  await page.locator("#p-name").fill("新しい会社");
  await page.locator("#partner-body button", { hasText: "追加" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.company_name === "新しい会社"), "会社を追加できる");
  check(/新しい会社/.test(await page.locator("#partner-list").innerText()), "一覧に出る");
  check((await page.locator("#e-partner option").allTextContents()).includes("新しい会社"),
    "名簿の所属先の選択肢にも増える");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 075が未適用でも、これまでどおり動く ===");
{
  const posted = [];
  const employees = [
    { id: "emp-1", display_name: "山田 太郎", email: "yamada@8grp.co.jp", department: "営業",
      employment_type: "正社員", status: "active", roles: [], accounts: {} },
  ];
  const page = await br.newPage({ viewport: { width: 1400, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/employees\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        return send({ employee: { id: "emp-2", ...b }, account: null });
      }
      // kindReady を返さない＝未適用環境
      return send({ employees, canManage: true, canGrantRoles: true, systems: {} });
    }
    if (/\/api\/partners\b/.test(url)) return send({ companies: [], notReady: true });
    if (/\/api\/me\b/.test(url)) return send(ADMIN);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1200);

  check(!(await page.locator("#e-kind-wrap").isVisible()), "区分の欄は出さない");
  check(!(await page.locator("#partner-card").isVisible()), "BP企業のカードも出さない");

  await page.locator("#e-name").fill("従来どおり");
  await page.locator("#e-save").click();
  await page.waitForTimeout(700);
  const sent = posted.find((p) => p.display_name === "従来どおり");
  check(!!sent, "これまでどおり追加できる");
  check(!("employee_kind" in sent), "区分の項目は送らない（未適用の環境を壊さない）");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
