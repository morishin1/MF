// メンバー → 管理サイド共通チャットを、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. メンバー側には「管理サイドへ連絡」という入口が1つだけあり、
//      押すと相手を選ばずにスレッドが開く
//   2. 開いたスレッドは kind: admin_contact。参加者管理のボタンは出ない
//      （個人のDM・グループの管理UIと混ざらない）
//   3. 管理サイド側の一覧には「誰からの連絡か」が分かる名前と、
//      それと分かる印（アイコン・チップ）が出る
//   4. 管理サイドは、そのまま返信できる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("\n=== メンバー側：「管理サイドへ連絡」を開く ===");
{
  const posted = [];
  let opened = false; // admin-contact を開いたあとか

  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "genba@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "現場 太郎", shows: {}, stage: null }));
  });

  const ME = { id: "emp-member", display_name: "現場 太郎", department: "制作部", status: "active" };

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "genba@8grp.co.jp", appRole: "member", shows: {},
        gw: { employee: ME, roles: [], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/messages\/admin-contact/.test(url) && req.method() === "POST") {
      opened = true;
      posted.push({ url, body: {} });
      return send({ threadId: "th-ac", existed: false });
    }
    if (/\/api\/messages\/thread/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push({ url, body: b });
        return send({ message: { id: "m1", thread_id: b.threadId, sender_id: ME.id, body: b.body, created_at: new Date().toISOString(), files: [] } });
      }
      return send({
        thread: { id: "th-ac", kind: "admin_contact", contact_employee_id: ME.id,
          displayName: "管理サイドへの連絡", members: [ME], canManage: false, last_message_at: new Date().toISOString() },
        messages: [], hasMore: false, oldest: null, lastReadAt: null, me: ME,
      });
    }
    if (/\/api\/messages\b/.test(url)) {
      return send({
        me: ME,
        threads: opened ? [{ id: "th-ac", kind: "admin_contact", displayName: "管理サイドへの連絡",
          unread: 0, members: [ME], lastMessage: null, last_message_at: new Date().toISOString() }] : [],
      });
    }
    if (/\/api\/employees/.test(url)) return send({ employees: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/messages.html`);
  await page.waitForTimeout(1200);

  console.log("— 入口が1つだけある —");
  const contactCard = page.locator(".card", { hasText: "管理サイドへ連絡" });
  check(await contactCard.count() === 1, "「管理サイドへ連絡」の入口が1つだけある");
  check((await contactCard.innerText()).includes("誰に送ればいいか迷ったら"), "説明が出る");

  console.log("— 押すと、相手を選ばずにスレッドが開く —");
  await contactCard.locator("button", { hasText: "開く" }).click();
  await page.waitForTimeout(900);
  check(posted.some((p) => /admin-contact/.test(p.url)), "admin-contact が呼ばれる（相手を選ばない）");
  check(await page.locator("#view-thread").isVisible(), "スレッド画面に切り替わる");
  check((await page.locator("#th-title").textContent()) === "管理サイドへの連絡", "タイトルが固定文言");
  check((await page.locator("#th-sub").textContent()).includes("共通窓口"), "説明が出る");
  check(await page.locator("#th-members-btn").isHidden(), "参加者管理のボタンは出ない（個人のグループ管理と混ざらない）");

  console.log("— 送信できる —");
  await page.locator("#th-input").fill("経費精算のやり方を教えてください");
  await page.locator("#th-send").click();
  await page.waitForTimeout(600);
  check(posted.some((p) => /messages\/thread/.test(p.url) && p.body.body === "経費精算のやり方を教えてください"),
    "本文が送られる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 管理サイド側：一覧で「誰からの連絡か」が分かる ===");
{
  const posted = [];
  const page = await br.newPage({ viewport: { width: 900, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務 花子", shows: {}, stage: null }));
  });

  const HR = { id: "emp-hr", display_name: "事務 花子", department: "管理部", status: "active" };
  const REQUESTER = { id: "emp-member", display_name: "現場 太郎", department: "制作部" };

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "hr@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {},
        gw: { employee: HR, roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null } });
    }
    if (/\/api\/messages\/thread/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push({ url, body: b });
        return send({ message: { id: "m2", thread_id: b.threadId, sender_id: HR.id, body: b.body, created_at: new Date().toISOString(), files: [] } });
      }
      return send({
        thread: { id: "th-ac", kind: "admin_contact", contact_employee_id: REQUESTER.id,
          displayName: "現場 太郎 さんからの連絡", members: [HR, REQUESTER], canManage: false,
          last_message_at: new Date().toISOString() },
        messages: [{ id: "m0", thread_id: "th-ac", sender_id: REQUESTER.id, body: "経費精算のやり方を教えてください",
          created_at: new Date().toISOString(), files: [], readBy: { count: 0, total: 1, mine: false } }],
        hasMore: false, oldest: null, lastReadAt: null, me: HR,
      });
    }
    if (/\/api\/messages\b/.test(url)) {
      return send({
        me: HR,
        threads: [{ id: "th-ac", kind: "admin_contact", displayName: "現場 太郎 さんからの連絡",
          unread: 1, members: [HR, REQUESTER], lastMessage: { body: "経費精算のやり方を教えてください", created_at: new Date().toISOString() },
          last_message_at: new Date().toISOString() }],
      });
    }
    if (/\/api\/employees/.test(url)) return send({ employees: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/messages.html`);
  await page.waitForTimeout(1200);

  console.log("— 一覧に、誰からの連絡かが分かる —");
  const row = page.locator(".kp-todo", { hasText: "現場 太郎 さんからの連絡" });
  check(await row.count() === 1, "表示名が出る");
  check((await row.innerText()).includes("管理連絡"), "それと分かる印（チップ）が出る");

  console.log("— 開いて返信できる —");
  await row.click();
  await page.waitForTimeout(900);
  check((await page.locator("#th-title").textContent()) === "現場 太郎 さんからの連絡", "本人の名前がタイトルに出る");
  check((await page.locator("#th-sub").textContent()).includes("共通窓口"), "共通窓口の説明が出る");

  await page.locator("#th-input").fill("経費精算は expenses.html からどうぞ");
  await page.locator("#th-send").click();
  await page.waitForTimeout(600);
  check(posted.some((p) => p.body.body === "経費精算は expenses.html からどうぞ"), "返信が送られる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
