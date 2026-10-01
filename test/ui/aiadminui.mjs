// AIナレッジ管理（admin-ai.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. ナレッジを追加できる
//   2. 既存ナレッジを編集・無効化できる
//   3. 問い合わせの一覧から開いて、返信・状態変更・担当者アサインができる
//   4. 一般メンバーは入れない（home.html へ送り返される）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ADMIN = { id: "emp-admin", display_name: "管理 花子", department: "管理部", status: "active" };

console.log("\n=== 管理者：ナレッジの追加・編集、問い合わせ対応 ===");
{
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1100, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "admin@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "管理 花子", shows: {}, stage: null }));
  });

  let knowledge = [
    { id: "k1", title: "有給休暇の申請方法", category: "hr", content: "勤怠・申請から", access_scope: "all", is_active: true, updated_at: new Date().toISOString() },
  ];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(req.postData() || "{}"); } catch { return {}; } };

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "admin@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {},
        access: { recruit: true, sell: true, office: true, keiei: true, aiInquiries: true },
        gw: { employee: ADMIN, roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null } });
    }
    if (/\/api\/ai\/knowledge-item/.test(url)) {
      const b = body();
      posted.push({ url: "knowledge-update", body: b });
      const id = new URL(url).searchParams.get("id");
      const row = knowledge.find((k) => k.id === id);
      if (row) Object.assign(row, { ...(b.isActive !== undefined ? { is_active: b.isActive } : {}),
        ...(b.title !== undefined ? { title: b.title } : {}) });
      return send({ ok: true });
    }
    if (/\/api\/ai\/knowledge\b/.test(url)) {
      if (req.method() === "POST") {
        const b = body();
        posted.push({ url: "knowledge-create", body: b });
        const row = { id: "k2", title: b.title, category: b.category, content: b.content,
          access_scope: b.accessScope, is_active: true, updated_at: new Date().toISOString() };
        knowledge.push(row);
        return send({ knowledge: row });
      }
      return send({ knowledge });
    }
    if (/\/api\/ai\/inquiries\b/.test(url)) {
      return send({ inquiries: [{ id: "iq1", subject: "PCを紛失しました", status: "new",
        employeeName: "現場 太郎", assignedName: null }] });
    }
    if (/\/api\/ai\/inquiry\b/.test(url)) {
      if (req.method() === "GET") {
        return send({ inquiry: { id: "iq1", subject: "PCを紛失しました", status: "new" },
          messages: [{ id: "m0", sender_type: "system", content: "PCを紛失しました", created_at: new Date().toISOString() }] });
      }
      if (req.method() === "PATCH") {
        posted.push({ url: "inquiry-patch", body: body() });
        return send({ ok: true });
      }
      posted.push({ url: "inquiry-reply", body: body() });
      return send({ message: { id: "m1", sender_type: "admin", content: body().content, created_at: new Date().toISOString() } });
    }
    if (/\/api\/employees/.test(url)) return send({ employees: [ADMIN] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-ai.html`);
  await page.waitForTimeout(1000);

  console.log("— ナレッジを追加できる —");
  await page.locator("#k-title").fill("経費精算の締切");
  await page.locator("#k-category").selectOption("accounting");
  await page.locator("#k-content").fill("月末締め翌月払い");
  await page.locator("#k-save").click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.url === "knowledge-create" && p.body.title === "経費精算の締切"), "追加が送られる");

  console.log("— 既存ナレッジを無効化できる —");
  await page.locator(".kp-todo", { hasText: "有給休暇の申請方法" })
    .locator("button", { hasText: "無効にする" }).click();
  await page.waitForTimeout(400);
  check(posted.some((p) => p.url === "knowledge-update" && p.body.isActive === false), "無効化が送られる");

  console.log("— 問い合わせを開いて返信・状態変更できる —");
  await page.locator(".kp-todo", { hasText: "PCを紛失しました" }).click();
  await page.waitForTimeout(600);
  check(await page.locator("#iq-detail-card").isVisible(), "詳細が開く");
  await page.locator("#iq-d-input").fill("新しいPCを手配します");
  await page.locator("button", { hasText: "送信" }).last().click();
  await page.waitForTimeout(400);
  check(posted.some((p) => p.url === "inquiry-reply" && p.body.content === "新しいPCを手配します"), "返信が送られる");

  await page.locator("#iq-d-status-select").selectOption("in_progress");
  await page.locator("button", { hasText: "更新する" }).click();
  await page.waitForTimeout(400);
  check(posted.some((p) => p.url === "inquiry-patch" && p.body.status === "in_progress"), "状態変更が送られる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 一般メンバーは入れない ===");
{
  const page = await br.newPage({ viewport: { width: 1100, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "genba@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "現場 太郎", shows: {}, stage: null }));
  });
  await page.route("**/api/**", (route) => {
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const url = route.request().url();
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "genba@8grp.co.jp", appRole: "member", shows: {},
        gw: { employee: { id: "emp-1", display_name: "現場 太郎" }, roles: [], isAdmin: false, tenantId: "t1", stage: null } });
    }
    return send({});
  });
  await page.goto(`${BASE}/admin-ai.html`);
  await page.waitForTimeout(900);
  check(page.url().includes("home.html"), `home.html へ送り返される（いま ${page.url()}）`);
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 経理/Office（人事ロールは無いが canManageAiInquiries は true）も入れる ===");
{
  const page = await br.newPage({ viewport: { width: 1100, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "finance@8grp.co.jp" }));
    // appRole は owner/admin/sr/member の4値しか無いため、経理ロールだけの人は member になる
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "経理 三郎", shows: {}, stage: null }));
  });
  await page.route("**/api/**", (route) => {
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const url = route.request().url();
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "finance@8grp.co.jp", appRole: "member", shows: {},
        access: { recruit: false, sell: false, office: true, keiei: false, aiInquiries: true },
        gw: { employee: { id: "emp-fin", display_name: "経理 三郎" }, roles: ["finance"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/ai\/inquiries\b/.test(url)) return send({ inquiries: [] });
    return send({});
  });
  await page.goto(`${BASE}/admin-ai.html`);
  await page.waitForTimeout(900);
  check(page.url().includes("admin-ai.html"), `home.htmlへ送り返されない（appRoleはmemberのまま。いま ${page.url()}）`);
  check(await page.locator("#iq-list").isVisible(), "問い合わせ一覧が開ける");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
