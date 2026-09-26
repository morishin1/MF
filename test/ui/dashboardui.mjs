// 管理者ダッシュボード（admin-dashboard.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 担当者ごとに、今日の3つ・完了数・期限超過・契約更新待ちだけが出る
//      （入社手続き・端末管理・会計など、他の情報は増やさない）
//   2. 今日の3つを押すと、既存の右ドロワーが開く（別画面へ飛ばない）
//   3. 担当が付いていないタスクは「（未担当）」として、黙って消えない
//   4. 何も無いときは、その旨が分かる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ADMIN = { email: "hr@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {}, roles: [], memberships: [],
  gw: { employee: { id: "emp-hr", display_name: "事務 花子", status: "active" },
        roles: ["owner"], tenantId: "t1", stage: null } };

console.log("\n=== ダッシュボード：今日のチーム状況 ===");
{
  const TEAM = {
    today: "2026-09-17",
    team: [
      { employeeId: "e1", name: "山田 太郎", doneToday: 2, overdue: 1, renewalPending: 0,
        today: [{ id: "t1", title: "見積を出す", done: false }, { id: "t2", title: "面談準備", done: true }] },
      { employeeId: "e2", name: "鈴木 花子", doneToday: 0, overdue: 0, renewalPending: 2, today: [] },
    ],
    unassigned: { overdue: 1, renewalPending: 1, doneToday: 0, today: [] },
    focusReady: true,
  };

  const page = await br.newPage({ viewport: { width: 1300, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/dashboard\/team/.test(url)) return send(TEAM);
    if (/\/api\/tasks\/detail/.test(url)) {
      return send({
        task: { id: "t1", title: "見積を出す", status: "todo", assigneeId: "e1", priority: "normal",
                dueOn: null, canEdit: true },
        canEdit: true, statuses: [{ key: "todo", label: "未着手" }, { key: "done", label: "完了" }],
        people: [{ id: "e1", name: "山田 太郎" }], priorities: [{ key: "normal", label: "ふつう" }],
        comments: [], events: [], carryChoices: [],
      });
    }
    if (/\/api\/me\b/.test(url)) return send(ADMIN);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-dashboard.html`);
  await page.waitForTimeout(1000);

  console.log("— 5つの項目だけが出る —");
  const heads = await page.locator(".dt-table th").allInnerTexts();
  check(heads.join("・") === "担当者・今日の3つ・完了数・期限超過・契約更新待ち", `見出しがこの5つ（${heads.join("・")}）`);
  check(await page.locator("#hr-soon").count() === 0, "入社手続きのカードは出さない");
  const cardHeads = await page.locator(".wrap .card h2").allInnerTexts();
  check(!cardHeads.some((h) => /会計/.test(h)), `会計のカードは出さない（見出し：${cardHeads.join("・")}）`);
  check(await page.locator("text=よく使う操作").count() === 0, "よく使う操作のカードも出さない");

  console.log("— 人ごとの数が出る —");
  const rows = await page.locator(".dt-table tbody tr").allInnerTexts();
  check(rows.some((r) => /山田 太郎/.test(r) && /見積を出す/.test(r)), "山田さんの今日の3つが出る");
  check(rows.some((r) => /鈴木 花子/.test(r)), "鈴木さんも出る");

  console.log("— 担当が付いていないものは「未担当」に —");
  check(rows.some((r) => /未担当/.test(r)), "未担当の行がある");

  console.log("— 今日のタスクを押すと、右ドロワーが開く（別画面へ飛ばない）—");
  await page.locator(".dt-today a", { hasText: "見積を出す" }).click();
  await page.waitForTimeout(500);
  check(await page.locator("#td-root").isVisible(), "ドロワーが開く");
  check(page.url().endsWith("admin-dashboard.html"), "ページ遷移していない");
  const drawerText = await page.locator("#td-panel").innerText();
  check(/見積を出す/.test(drawerText), "そのタスクの詳細が出る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 何も無いとき ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/dashboard\/team/.test(url)) return send({ today: "2026-09-17", team: [], unassigned: null, focusReady: true });
    if (/\/api\/me\b/.test(url)) return send(ADMIN);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-dashboard.html`);
  await page.waitForTimeout(900);
  check(/期限超過も契約更新待ちもありません/.test(await page.locator("#dt-body").innerText()), "空のときの言葉が出る");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 076・077未適用（表がまだ無い）でも、cronベースの部分は落ちない ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 800 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/dashboard\/team/.test(url)) {
      return send({ today: "2026-09-17", team: [], notReady: true,
        message: "この機能に必要なテーブルがまだ作られていません。管理者に db/068_task_flow.sql の実行を依頼してください" });
    }
    if (/\/api\/me\b/.test(url)) return send(ADMIN);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-dashboard.html`);
  await page.waitForTimeout(900);
  check(/068_task_flow\.sql/.test(await page.locator("#notice").innerText()), "何を流せばよいかが出る");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
