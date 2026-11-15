// メンバー管理（admin-members.html）から、既存メンバーへ「ENGER営業エージェント」の役割を付ける画面の流れ。
// すべて架空のデータ。実アカウント・実DBは触らない（/api は page.route で差し替え）。
//
// ■ 守るもの（開発指示書 AC-07 / AC-08 / AC-09 / AC-12）
//   ・どの雇用区分の人でも、ログインがあれば詳細の窓に「ENGER営業の役割」が出る（部署名に依存しない）
//   ・押すと grant_role を1回だけ送り、新しいアカウント作成（POST）は送らない
//   ・付与後は停止中の設定画面が開き、契約・NDA・担当企業なしでは保存を送らない
//   ・パスワードは名簿共通の「ログイン・パスワード」の窓へ（エージェント専用の再発行を送らない）
//   ・ENGERのログインURL（使えない導線）を表示しない
//   ・スマホ幅で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const GW = await import("../../lib/gw.js");
const MA = await import("../../lib/member-access.js");
const ME = { email: "own@example.com", appRole: "owner", isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "e-own", display_name: "経営 太郎", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
  access: GW.accessOf({ isAdmin: false, isHr: true, roles: ["owner"] }) };
const emp = (id, name, extra = {}, roles = [], apps = []) => ({
  id, display_name: name, email: `${id}@example.com`, user_id: `u-${id}`, department: "開発", position: null,
  employment_type: "正社員", status: "active", employee_kind: "proper", partner_company_id: null, joined_on: "2026-04-01",
  roles, accounts: {}, ...MA.accessForMember(roles, `u-${id}`, new Map([[`u-${id}`, false]]), apps), ...extra,
});

async function open(width = 1280) {
  const employees = [
    emp("e-own", "経営 太郎", {}, ["owner"]),
    emp("e-full", "正社員 A"),
    emp("e-out", "委託 B", { employment_type: "業務委託", department: "営業" }),
    emp("e-nologin", "未ログイン C", { user_id: null, status: "invited" }),
  ];
  const agents = [];
  const calls = { agentPosts: [], agentPatches: [] };
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "own@example.com" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open"]) localStorage.removeItem(k);
  });
  page.on("dialog", (d) => d.accept());
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname === "/api/enger/agent-users") {
      if (req.method() === "GET") return send({ canManage: true, companyNames: {}, agents, loginStatus: "ENGERのエージェント用ホームは未公開です。役割と担当企業の設定までを行えます。" });
      const body = JSON.parse(req.postData() || "{}");
      if (req.method() === "POST") { calls.agentPosts.push(body); return send({ error: "unexpected" }, 500); }
      calls.agentPatches.push(body);
      if (body.action === "grant_role") {
        const e = employees.find((x) => x.id === body.employeeId);
        agents.push({ employeeId: e.id, name: e.display_name, email: e.email, employmentType: e.employment_type, hasLogin: true,
          roleAssigned: true, legacyOnly: false, enabled: false, companyIds: [], status: "active", hasConflict: false });
        return send({ ok: true, employeeId: e.id, roleAssigned: true, enabled: false });
      }
      return send({ error: "unexpected" }, 500);
    }
    if (url.pathname === "/api/employees" && req.method() === "GET")
      return send({ employees: JSON.parse(JSON.stringify(employees)), canManage: true, canGrantRoles: true, canGrantOwner: true, meEmployeeId: "e-own", appsState: "table", systems: {}, kindReady: true });
    if (/\/api\/partners\b/.test(url.pathname)) return send({ companies: [], canManage: true });
    if (/\/api\/me\b/.test(url.pathname)) return send(ME);
    if (/\/api\/notifications/.test(url.pathname)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url.pathname)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForSelector("#list table", { timeout: 10000 });
  Object.assign(page, { calls, errs, employees });
  return page;
}
const openDetail = async (page, id) => {
  await page.locator(`#list tr[data-employee="${id}"] [data-role="open-detail"]`).click();
  return page.locator(`#mb-member [data-employee="${id}"]`);
};

console.log("\n— 役割は雇用区分・部署と独立。ログインのある人に出る —");
{
  const page = await open();
  for (const id of ["e-full", "e-out"]) {
    const m = await openDetail(page, id);
    check(await m.locator("button", { hasText: "ENGER営業の役割" }).count() === 1, `${id}：詳細に「ENGER営業の役割」`);
    await page.keyboard.press("Escape");
  }
  const m = await openDetail(page, "e-nologin");
  check(await m.locator("button", { hasText: "ENGER営業の役割" }).count() === 0, "ログインの無い人には出さない（先にログインを作る）");
  await page.keyboard.press("Escape");
  check(page.errs.length === 0, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n— 正社員Aへ付与：新しいアカウントを作らない —");
{
  const page = await open();
  const m = await openDetail(page, "e-full");
  await m.locator("button", { hasText: "ENGER営業の役割" }).click();
  await page.waitForSelector("#ag-detail:not([hidden])", { timeout: 5000 });
  const grants = page.calls.agentPatches.filter((b) => b.action === "grant_role");
  check(grants.length === 1 && grants[0].employeeId === "e-full" && grants[0].confirm === true, "grant_role を1回だけ送る");
  check(page.calls.agentPosts.length === 0, "アカウント作成（POST）は送らない");
  check((await page.locator("#ag-detail-person").innerText()).includes("停止中"), "付与直後は停止中と表示");
  check(!(await page.locator("#ag-active").isChecked()), "閲覧スイッチはOFFのまま");
  check((await page.locator("#ag-rows").innerText()).includes("正社員"), "一覧の雇用・契約区分は正社員のまま");

  // 契約・NDA・担当企業なしでは送らない
  await page.locator("#ag-active").check();
  const before = page.calls.agentPatches.length;
  await page.locator("#ag-save").click();
  check(page.calls.agentPatches.length === before, "契約・NDA・担当企業がそろうまで保存を送らない");
  check((await page.locator("#ag-message").innerText()).includes("契約"), "理由を表示");

  // パスワードは名簿共通の窓へ
  await page.locator("#ag-password-reset").click();
  await page.waitForTimeout(300);
  check(await page.locator("#e-account").innerText().then((t) => t.includes("同じログイン")), "名簿共通の「ログイン」窓が開く（GW・無限道場・タイムカード共通の注意）");
  check(!page.calls.agentPatches.some((b) => b.action === "reset_password"), "エージェント専用の再発行は送らない");

  const html = await page.content();
  check(!html.includes("enger.jp/business/login"), "使えないENGERログインURLを案内しない");
  check(page.errs.length === 0, `画面のエラーなし（${page.errs.join(" / ")}）`);
  await page.close();
}

console.log("\n— スマホ幅 —");
{
  const page = await open(390);
  const m = await openDetail(page, "e-out");
  await m.locator("button", { hasText: "ENGER営業の役割" }).click();
  await page.waitForSelector("#ag-detail:not([hidden])", { timeout: 5000 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `390px で横にはみ出さない（${over}px）`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
