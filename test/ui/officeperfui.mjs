// Office の管理画面の表示速度の作り（2026-10-04）を、実際のブラウザで確かめる。
//
// ■ 何を守りたいのか
//   ・名簿（admin-members.html）は、BP企業の一覧を初回に取らない（閉じた欄のために待たせない）。
//     名簿にBPの人がいる・BP企業の欄を開いた・区分でBPを選んだ、ときだけ取る
//   ・2回目からは、枠（/api/me の確認）を待たずに名簿を取りにいき始める（/api/me と並んで出る）
//   ・権限を1つ変えただけで、名簿を全件取り直さない
//   ・覚えている身元では入れても、確かめた身元（/api/me）で入れなければ、ホームへ送り返す（権限の判定は変えない）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const { accessOf } = await import("../../lib/gw.js");
const LAG = 250;

const emp = (i, extra = {}) => ({ id: `e${i}`, display_name: `社員 ${i}`, email: `e${i}@x.jp`, department: "開発", position: "",
  employment_type: "正社員", status: "active", roles: [], employee_kind: "proper", partner_company_id: null, systems: {}, ...extra });

/**
 * @param {{ roles?: string[], bp?: boolean, freshRoles?: string[] }} o
 *   roles      … 覚えている身元（kp_me）と、/api/me の社内権限
 *   freshRoles … /api/me だけ別の権限にする（権限が外れた直後を再現）
 */
async function open(path, o = {}) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  const roles = o.roles || ["hr"];
  const meOf = (r) => ({ email: "a@b.c", appRole: "member", isAdmin: false, roles: [],
    gw: { employee: { id: "me", display_name: "人事 花子", status: "active" }, roles: r, tenantId: "t1", stage: null },
    access: accessOf({ isAdmin: false, roles: r }) });
  await page.addInitScript((me) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "h.eyJzdWIiOiJ1LTEifQ.s", email: "a@b.c" }));
    // 一度ほかの画面を開いたあと（覚えている身元・枠がある）を再現する
    localStorage.setItem("kp_me", JSON.stringify({ at: Date.now(), email: "a@b.c", me }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "人事 花子", shows: {}, stage: null }));
  }, meOf(roles));
  const calls = [];
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    const method = route.request().method();
    calls.push({ path: u.pathname, method, at: Date.now() });
    await new Promise((r) => setTimeout(r, LAG));
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send(meOf(o.freshRoles || roles));
    if (u.pathname === "/api/employees" && method === "GET") {
      const list = [emp(1), emp(2), ...(o.bp ? [emp(3, { employee_kind: "bp", partner_company_id: "p1" })] : [])];
      return send({ employees: list, canGrantRoles: true, canGrantOwner: false, canManage: true, kindReady: true });
    }
    if (u.pathname === "/api/partners") return send({ companies: [{ id: "p1", company_name: "BP株式会社" }] });
    if (u.pathname === "/api/employees/roles") return send({ ok: true });
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    if (u.pathname === "/api/badges") return send({ badges: {} });
    return send({});
  });
  const t0 = Date.now();
  await page.goto(`${BASE}/${path}`);
  return { page, ctx, calls, t0 };
}
const n = (calls, p, method = "GET") => calls.filter((c) => c.path === p && c.method === method).length;

console.log("— 名簿：BP企業の一覧は、要るときだけ取る —");
{
  const { page, ctx, calls } = await open("admin-members.html");
  await page.waitForSelector("#list table", { timeout: 8000 });
  await page.waitForTimeout(LAG * 2);
  check(n(calls, "/api/partners") === 0, `BPの人がいない名簿では、BP企業の一覧を取らない（${n(calls, "/api/partners")}回）`);
  check(await page.locator("#partner-card").isVisible(), "BP企業の欄そのもの（見出し）は出ている");
  await page.locator('#partner-card button:has-text("開く")').click();
  await page.waitForTimeout(LAG * 2);
  check(n(calls, "/api/partners") === 1, "BP企業の欄を開くと、そのとき取る（1回）");
  check((await page.locator("#partner-body").innerText()).includes("BP株式会社"), "開いた欄に一覧が出る");
  await ctx.close();
}
{
  const { page, ctx, calls } = await open("admin-members.html", { bp: true });
  await page.waitForSelector("#list table", { timeout: 8000 });
  await page.waitForTimeout(LAG * 3);
  check(n(calls, "/api/partners") === 1, "名簿にBPの人がいれば、会社名のために取る（1回）");
  check((await page.locator("#list").innerText()).includes("BP（BP株式会社）"), "BPの人の行に所属先の会社名が出る");
  await ctx.close();
}
{
  const { page, ctx, calls } = await open("admin-members.html");
  await page.waitForSelector("#list table", { timeout: 8000 });
  await page.selectOption("#e-kind", "bp");
  await page.waitForTimeout(LAG * 2);
  check(n(calls, "/api/partners") === 1, "区分でBPを選ぶと、所属先の選択肢のために取る");
  check((await page.locator("#e-partner option").allInnerTexts()).includes("BP株式会社"), "所属先の選択肢に会社が並ぶ");
  await ctx.close();
}

console.log("\n— 2回目からは、枠の確認を待たずに名簿を取りにいく —");
{
  const { page, ctx, calls } = await open("admin-members.html");
  await page.waitForSelector("#list table", { timeout: 8000 });
  const me = calls.find((c) => c.path === "/api/me");
  const list = calls.find((c) => c.path === "/api/employees");
  check(me && list && list.at - me.at < LAG, `名簿の取得は /api/me の応答を待たずに出る（差 ${list && me ? list.at - me.at : "?"}ms・1本 ${LAG}ms）`);
  check(n(calls, "/api/employees") === 1, "名簿は1回だけ取る（先読みと本体で2本出さない）");

  console.log("\n— 権限を1つ変えても、名簿を全件取り直さない —");
  const before = n(calls, "/api/employees");
  const box = page.locator('#list input[type="checkbox"][data-role]:not([disabled])').first();
  await box.check();
  await page.waitForTimeout(LAG * 2);
  check(n(calls, "/api/employees/roles", "POST") === 1, "権限の変更を送る");
  check(n(calls, "/api/employees") === before, `名簿は取り直さない（GET /api/employees ${before}→${n(calls, "/api/employees")}回）`);
  check(await box.isChecked(), "画面の印はそのまま");
  await ctx.close();
}

console.log("\n— 覚えている身元では入れても、確かめた身元で入れなければ送り返す —");
{
  const { page, ctx } = await open("admin-members.html", { roles: ["hr"], freshRoles: ["sales"] });
  await page.waitForURL(/home\.html/, { timeout: 8000 }).catch(() => {});
  check(/home\.html/.test(page.url()), `人事・労務の権限が外れていれば、ホームへ送り返す（いま ${new URL(page.url()).pathname}）`);
  await ctx.close();
}
{
  // 覚えている身元が「入れない」なら、先に描かず、名簿も先に取りにいかない
  const { page, ctx, calls } = await open("admin-members.html", { roles: ["sales"] });
  await page.waitForURL(/home\.html/, { timeout: 8000 }).catch(() => {});
  check(n(calls, "/api/employees") === 0, "入れない人のためには、名簿を1回も取りにいかない");
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
