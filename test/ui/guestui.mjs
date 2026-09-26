// 外部メンバー招待を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. メンバー管理に「社員／外部メンバー」の切り替えがあり、増やしすぎない
//   2. 招待すると、範囲（プロジェクト・チャット・資料・タスク）を選んで発行できる。
//      発行直後だけ、URLとSlack用メッセージが見える
//   3. 再発行・無効化・権限の入れ替えができる
//   4. 招待URLを開いた本人は、氏名を確認してパスワードを決めると登録でき、
//      そのまま自分のホーム（外部メンバーバッジ付き）に入れる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ADMIN = { email: "hr@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {}, roles: [], memberships: [],
  gw: { employee: { id: "emp-hr", display_name: "事務 花子", status: "active" },
        roles: ["owner"], tenantId: "t1", stage: null } };

console.log("\n=== 管理画面：外部メンバーの招待・再発行・無効化・権限 ===");
{
  const posted = [];
  let guests = [];
  let nextToken = 1;

  const page = await br.newPage({ viewport: { width: 1400, height: 1200 }, timezoneId: "Asia/Tokyo" });
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

    if (/\/api\/employees\b/.test(url)) return send({ employees: [], canManage: true, canGrantRoles: true, systems: {} });
    if (/\/api\/partners\b/.test(url)) return send({ companies: [], canManage: true });
    if (/\/api\/guests\/options/.test(url)) {
      return send({
        projects: [{ key: "ENGER", label: "ENGER" }],
        threads: [{ key: "th1", label: "ENGERの相談" }],
        documents: [{ key: "d1", label: "規程集" }],
        tasks: [{ key: "t1", label: "見積を出す" }],
      });
    }
    if (/\/api\/guests\/detail/.test(url)) {
      if (req.method() === "GET") {
        const id = new URL(url).searchParams.get("id");
        const g = guests.find((x) => x.id === id);
        return send({
          guest: { id: g.id, display_name: g.displayName, company_name: g.companyName, email: g.email },
          status: g.status,
          invites: [{ id: "iv1", created_at: "2026-09-01T00:00:00Z",
            expires_at: "2026-09-08T00:00:00Z", used_at: null, revoked_at: null }],
          grants: g.grants.map((x, i) => ({ id: `gr${i}`, resource_type: x.resourceType,
            resource_key: x.resourceKey, resource_label: x.resourceLabel, typeLabel: "プロジェクト" })),
        });
      }
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      const g = guests.find((x) => x.id === b.id);
      if (b.action === "reissue") { g.status = "invited"; return send({ token: `retok-${nextToken++}`, expiresAt: "2026-09-15T00:00:00Z" }); }
      if (b.action === "disable") { g.status = "revoked"; return send({ ok: true }); }
      if (b.action === "updateGrants") { g.grants = b.grants; return send({ ok: true, count: b.grants.length }); }
      return send({ ok: true });
    }
    if (/\/api\/guests\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        const made = { id: `g${guests.length + 1}`, displayName: b.displayName, companyName: b.companyName,
          email: b.email, status: "invited", grants: (b.grants || []).map((x) => ({ ...x, label: x.resourceLabel })),
          invitedAt: "2026-09-23T00:00:00Z", expiresAt: "2026-09-30T00:00:00Z", lastLoginAt: null };
        guests = [...guests, made];
        return send({ guest: { id: made.id, display_name: made.displayName }, token: `tok-${nextToken++}`, expiresAt: "2026-09-30T00:00:00Z" });
      }
      return send({ guests });
    }
    if (/\/api\/me\b/.test(url)) return send(ADMIN);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1000);

  console.log("— 切り替えがある。増やしすぎない —");
  check(await page.locator("#tab-guests").isVisible(), "「外部メンバー」タブがある");
  check(await page.locator("#view-guests").isHidden(), "既定では社員のほうが出ている");
  await page.locator("#tab-guests").click();
  await page.waitForTimeout(400);
  check(await page.locator("#view-guests").isVisible(), "切り替わる");
  const heads = await page.locator("#view-guests table thead th").allInnerTexts();
  check(heads.join("・") === "氏名・会社名・メール・招待先・状態・招待日時・有効期限・最終ログイン・",
    `一覧の項目がこの8つ（${heads.join("・")}）`);

  console.log("— 招待する —");
  await page.locator("button", { hasText: "外部メンバーを招待" }).click();
  await page.waitForTimeout(400);
  await page.locator("#g-name").fill("社外 太郎");
  await page.locator("#g-company").fill("サンプル社");
  await page.locator("#g-email").fill("taro@example.com");
  await page.locator('input[data-type="project"][data-key="ENGER"]').check();
  await page.locator("#g-save").click();
  await page.waitForTimeout(600);

  const invited = posted.find((p) => p.displayName === "社外 太郎");
  check(!!invited, "招待が送られた");
  check(invited?.grants?.[0]?.resourceType === "project" && invited.grants[0].resourceKey === "ENGER",
    "選んだ範囲がそのまま送られる");

  console.log("— 発行直後だけ、URLとSlackメッセージが見える —");
  const inviteUrlValue = async () => page.locator("#guest-detail input[readonly]").inputValue();
  check(/guest-invite\.html\?token=tok-1/.test(await inviteUrlValue()), "招待URLが出る");
  check(await page.locator("button", { hasText: "URLをコピー" }).count() === 1, "URLコピーのボタンがある");
  check(await page.locator("button", { hasText: "Slack用メッセージをコピー" }).count() === 1, "Slackメッセージのコピーがある");

  console.log("— 再発行 —");
  const beforeReissue = await inviteUrlValue();
  await page.locator("button", { hasText: "招待を再発行" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "reissue"), "再発行が送られる");
  const afterReissue = await inviteUrlValue();
  check(/retok-\d+/.test(afterReissue) && afterReissue !== beforeReissue, "新しいURLに変わる");

  console.log("— 権限を編集 —");
  await page.locator('input.gd-grant[data-type="task"][data-key="t1"]').check();
  await page.locator("button", { hasText: "権限を保存" }).click();
  await page.waitForTimeout(500);
  const saved = posted.find((p) => p.action === "updateGrants");
  check(!!saved, "権限の保存が送られる");
  check(saved.grants.some((g) => g.resourceType === "task" && g.resourceKey === "t1"), "選んだ内容が送られる");

  console.log("— 無効化 —");
  await page.locator("button", { hasText: "無効化する" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "disable"), "無効化が送られる");
  check(/無効/.test(await page.locator("#guest-detail").innerText()), "状態が「無効」に変わる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 招待された本人：確認して登録する ===");
{
  const registered = [];
  const page = await br.newPage({ viewport: { width: 480, height: 900 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/guests\/accept/.test(url)) {
      if (req.method() === "GET") {
        return send({ displayName: "社外 太郎", companyName: "サンプル社", email: "taro@example.com", tenantName: "株式会社エイト" });
      }
      const b = JSON.parse(req.postData() || "{}");
      registered.push(b);
      return send({ ok: true, email: "taro@example.com" });
    }
    if (/\/api\/guests\/my/.test(url)) {
      return send({
        me: { displayName: "社外 太郎", companyName: "サンプル社", email: "taro@example.com" },
        tasks: [], threads: [], documents: [],
      });
    }
    if (/public-config/.test(url)) return send({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" });
    return send({});
  });
  await page.route("https://example.supabase.co/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/auth\/v1\/token/.test(url)) return send({ access_token: "gt", refresh_token: "rt", expires_in: 3600 });
    return send({});
  });

  await page.goto(`${BASE}/guest-invite.html?token=faketoken1234567890123456789012`);
  await page.waitForTimeout(900);

  console.log("— 招待の中身を確認できる —");
  const box = await page.locator("#box").innerText();
  check(/社外 太郎/.test(box), "氏名が出る");
  check(/サンプル社/.test(box), "会社名が出る");
  check(/株式会社エイト/.test(box), "招待元が出る");

  console.log("— パスワードを決めて登録する —");
  await page.locator("#pw").fill("password123");
  await page.locator("#pw2").fill("password123");
  await page.locator("#go").click();
  await page.waitForTimeout(900);
  check(registered.length === 1, "登録が送られる");
  check(page.url().includes("guest-home.html"), "登録後、自分のホームへ移る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 登録済みの外部メンバー：常に「外部メンバー」バッジが出る ===");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "taro@example.com" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/guests\/my/.test(url)) {
      return send({
        me: { displayName: "社外 太郎", companyName: "サンプル社", email: "taro@example.com" },
        tasks: [{ id: "t1", title: "見積を出す", status: "todo", due_on: "2026-10-01", category: "ENGER" }],
        threads: [{ id: "th1", title: "ENGERの相談" }],
        documents: [{ id: "d1", title: "規程集", description: "", url: "https://example.com/r", fileOnly: false }],
      });
    }
    return send({});
  });

  await page.goto(`${BASE}/guest-home.html`);
  await page.waitForTimeout(900);

  check(await page.locator(".gh-badge", { hasText: "外部メンバー" }).isVisible(), "バッジが常に出ている");
  check(/社外 太郎/.test(await page.locator("#who").innerText()), "本人の名前が出る");
  check(/見積を出す/.test(await page.locator("#tasks").innerText()), "許可されたタスクが見える");
  check(/ENGERの相談/.test(await page.locator("#threads").innerText()), "許可されたチャットが見える");
  check(/規程集/.test(await page.locator("#documents").innerText()), "許可された資料が見える");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
