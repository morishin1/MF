// 契約・電子署名まわりを、実際の画面で通す。
//  1) プレビューを画面いっぱいで読めること
//  2) 作成依頼 → 届いた書面 → そのまま署名依頼、が1画面で回ること
//  3) 本人が保存・印刷できること（労基則5条）
import { launch, BASE } from "../_browser.mjs";
import fs from "node:fs";
import { shotPath } from "../_shot.mjs";

const meAdmin = {
  email: "zimu@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null },
};
const meMember = {
  email: "yamada@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null },
};

// 本物のPDF。プレビューの枠に出す
const PDF_B64 = fs.readFileSync(
  atRoot("test/fixtures/base.pdf")).toString("base64");

const FIELDS = [
  { key: "雇用区分", placeholder: "正社員", required: true },
  { key: "契約期間", placeholder: "期間の定めなし", required: true },
  { key: "試用期間", placeholder: "3か月" },
  { key: "就業場所", placeholder: "本社", required: true },
  { key: "業務内容", placeholder: "Web制作", required: true },
  { key: "就業時間", placeholder: "9:00〜18:00", required: true },
  { key: "休日・休暇", placeholder: "土日祝", required: true },
  { key: "賃金", placeholder: "月給 300,000円", required: true },
  { key: "賃金の支払", placeholder: "月末締め", required: true },
  { key: "社会保険", placeholder: "加入" },
  { key: "退職", placeholder: "定年65歳" },
];
const KINDS = [
  { key: "employment", label: "労働条件通知書・雇用契約書" },
  { key: "pledge", label: "誓約書・秘密保持誓約書" },
  { key: "other", label: "その他" },
];

let orders = [];
let signRequests = [];
const posted = [];

const resetServer = () => {
  orders = [
    { id: "o1", employeeId: "emp-1",
      employee: { id: "emp-1", display_name: "山田 太郎", department: "制作部" },
      docKind: "employment", kindLabel: "労働条件通知書・雇用契約書",
      title: "労働条件通知書", assigneeName: "○○社労士事務所", conditions: { 賃金: "月給30万" },
      status: "requested", statusLabel: "依頼中", fileName: null, requestedAt: "2026-09-01T00:00:00Z" },
    { id: "o2", employeeId: "emp-2",
      employee: { id: "emp-2", display_name: "鈴木 花子", department: "営業部" },
      docKind: "employment", kindLabel: "労働条件通知書・雇用契約書",
      title: "労働条件通知書（鈴木）", status: "uploaded", statusLabel: "確認待ち",
      fileName: "suzuki.pdf", requestedAt: "2026-09-02T00:00:00Z" },
  ];
  signRequests = [
    { id: "r1", title: "労働条件通知書（鈴木）", doc_kind: "employment", view: "signed",
      status: "signed", source: "uploaded", sent_at: "2026-09-02T00:00:00Z",
      signed_at: "2026-09-03T00:00:00Z", employee: { display_name: "鈴木 花子", department: "営業部" } },
    { id: "r2", title: "誓約書", doc_kind: "pledge", view: "sent", status: "sent",
      source: "generated", sent_at: "2026-09-05T00:00:00Z", due_on: "2026-09-20",
      employee: { display_name: "山田 太郎", department: "制作部" } },
  ];
  posted.length = 0;
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

function wire(page, me, mine) {
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|pdf/i.test(m.text())
    && errs.push(m.text()));

  // 保存のときに落ちてくるもの。attachment なので画面は動かない
  page.route("**/__view.pdf", (route) => route.fulfill({
    status: 200, contentType: "application/pdf", body: Buffer.from(PDF_B64, "base64"),
  }));
  page.route("**/__dl.pdf", (route) => route.fulfill({
    status: 200, contentType: "application/pdf",
    headers: { "content-disposition": 'attachment; filename="x.pdf"' },
    body: Buffer.from(PDF_B64, "base64"),
  }));
  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};

    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    if (/\/api\/config/.test(url)) return send({});

    // ---- 作成依頼 ----
    if (/\/api\/sign\/orders/.test(url)) {
      if (req.method() === "POST") {
        posted.push(body);
        if (body.action === "create") {
          if (!body.conditions || Object.keys(body.conditions).length < 8) {
            if (!body.force) {
              return route.fulfill({ status: 400, contentType: "application/json",
                body: JSON.stringify({ error: "missing_conditions", missing: ["賃金"],
                                       hint: "賃金 がまだ空です" }) });
            }
          }
          orders = [{ id: `o${orders.length + 1}`, employeeId: body.employeeId,
            employee: { id: body.employeeId, display_name: "山田 太郎" },
            docKind: body.docKind, kindLabel: "労働条件通知書・雇用契約書",
            title: body.title || "労働条件通知書・雇用契約書",
            assigneeName: body.assigneeName, conditions: body.conditions,
            status: "requested", statusLabel: "依頼中", fileName: null }, ...orders];
          return send({ order: orders[0], missing: [] });
        }
        if (body.action === "send") {
          orders = orders.map((o) => (o.id === body.id
            ? { ...o, status: "sent", statusLabel: "署名依頼ずみ", signRequestId: "rNEW" } : o));
          return send({ ok: true, signRequestId: "rNEW", dueOn: "2026-09-30" });
        }
        if (body.action === "cancel") {
          orders = orders.map((o) => (o.id === body.id
            ? { ...o, status: "cancelled", statusLabel: "取り消し" } : o));
          return send({ ok: true });
        }
        return send({ ok: true });
      }
      if (/file=/.test(url)) return send({ url: `${BASE}/__view.pdf` });
      return send({
        orders,
        counts: { requested: orders.filter((o) => o.status === "requested").length,
                  uploaded: orders.filter((o) => o.status === "uploaded").length, sent: 0, signed: 0 },
        kinds: KINDS, fields: FIELDS,
        statuses: [{ key: "requested", label: "依頼中" }, { key: "uploaded", label: "確認待ち" }],
      });
    }

    if (/\/api\/sign\/templates/.test(url)) {
      return send({ templates: [{ id: "t1", name: "誓約書", doc_kind: "pledge", version: 1, due_days: 7, body: "x" }],
                    kinds: KINDS, mergeFields: [{ key: "氏名", from: "名簿" }], starters: {} });
    }
    if (/\/api\/sign\/file/.test(url)) {
      posted.push({ url });
      return send({ url: /download=1/.test(url)
                      ? `${BASE}/__dl.pdf`
                      : `${BASE}/__view.pdf`,
                    kind: "signed",
                    filename: "労働条件通知書.pdf", download: /download=1/.test(url) });
    }
    if (/\/api\/sign\/me/.test(url)) {
      const id = new URL(url).searchParams.get("id");
      if (!id) return send({ contracts: mine.list, agreeText: "内容を確認し、同意します。",
                             me: { name: "山田 太郎" } });
      return send({ contract: mine.one[id], agreeText: "内容を確認し、同意します。",
                    me: { name: "山田 太郎" } });
    }
    if (/\/api\/sign/.test(url)) {
      if (req.method() === "POST") { posted.push(body); return send({ sent: [], failed: [] }); }
      return send({ requests: signRequests,
                    counts: { sent: 1, overdue: 0, signed: 1, cancelled: 0 },
                    kinds: KINDS, mergeFields: [] });
    }
    if (/\/api\/employees/.test(url)) {
      return send({ employees: [
        { id: "emp-1", display_name: "山田 太郎", department: "制作部", status: "active", user_id: "u1" },
        { id: "emp-2", display_name: "鈴木 花子", department: "営業部", status: "active", user_id: "u2" },
      ], canManage: true, canGrantRoles: true });
    }
    return send({});
  });
}

const adminInit = () => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
};
const memberInit = () => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田 太郎", shows: {}, stage: null }));
};

// ===== 管理側：作成依頼とプレビュー =====
{
  resetServer();
  const page = await br.newPage({ viewport: { width: 1400, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(adminInit);
  await wire(page, meAdmin, null);
  page.on("dialog", (d) => d.accept());

  console.log("— 作成依頼のタブ —");
  await page.goto(`${BASE}/admin-esign.html?tab=order&employeeId=emp-1`);
  await page.waitForTimeout(1200);

  check(!(await page.locator("#pane-order").isHidden()), "URLで作成依頼のタブが開く");
  check(await page.locator("#o-emp").inputValue() === "emp-1", "名簿から来た人が、そのまま宛先に入る");
  check(await page.locator("[data-cond]").count() === FIELDS.length, "条件の欄が並ぶ");
  check(await page.locator("#o-cond .req").count() === 8, "必須の項目に印が付く");
  {
    const t = await page.locator("#pane-order").textContent();
    check(t.includes("労働基準法施行規則第5条"), "なぜこの項目なのかが書いてある");
    check(t.includes("メールはここからは送りません"), "メールを送らないと明記する");
  }
  check((await page.locator("#c-order").textContent()).trim() === "1",
    "確認待ちの件数がタブに出る");

  console.log("— 依頼の一覧 —");
  check(await page.locator("#o-rows tr").count() === 2, "依頼ごとに1行");
  check((await page.locator("#o-rows").textContent()).includes("まだ届いていません"),
    "書面が届いていないことが分かる");
  check(await page.locator("#o-rows tr:has-text('鈴木 花子') button:has-text('この内容で署名依頼')").count() === 1,
    "届いたものだけ、そのまま送れる");
  check(await page.locator("#o-rows tr:has-text('山田 太郎') button:has-text('この内容で署名依頼')").count() === 0,
    "届いていないものは送れない");

  console.log("— 必須が空のまま出そうとしたとき —");
  await page.locator("#o-save").click();
  await page.waitForTimeout(500);
  check((await page.locator("#o-msg").textContent()).includes("賃金"), "どこが空か出る");
  check(await page.locator("#o-msg button:has-text('このまま依頼する')").count() === 1,
    "それでも出すかは、押す人が決める");

  console.log("— 条件を埋めて依頼する —");
  for (const f of FIELDS) {
    await page.locator(`[data-cond="${f.key}"]`).fill("あり");
  }
  await page.locator("#o-assignee").fill("○○社労士事務所");
  await page.locator("#o-save").click();
  await page.waitForTimeout(700);
  {
    const c = posted.filter((p) => p.action === "create").pop();
    check(c && c.employeeId === "emp-1", "宛先が付いて送られる");
    check(c && c.conditions["賃金"] === "あり", "条件がそのまま渡る");
    check(await page.locator("#o-emp").inputValue() === "", "作ったらフォームは空に戻る");
  }

  console.log("— 届いた書面を、大きく見る —");
  await page.locator("#o-rows tr:has-text('鈴木 花子') button:has-text('見る')").click();
  await page.waitForTimeout(900);
  check(await page.locator("#kp-viewer").count() === 1, "画面いっぱいの器が出る");
  check((await page.locator(".kp-viewer-bar .t").textContent()).includes("鈴木 花子"),
    "誰あての書面か、器の上に出る");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(await page.locator("#kp-viewer").count() === 0, "Escで閉じる");

  console.log("— そのまま署名依頼 —");
  await page.locator("#o-rows tr:has-text('鈴木 花子') button:has-text('この内容で署名依頼')").click();
  await page.waitForTimeout(900);
  {
    const s = posted.find((p) => p.action === "send");
    check(s && s.id === "o2", "押すだけで送れる（宛先を打ち直さない）");
    check((await page.locator("#o-rows").textContent()).includes("署名依頼ずみ"), "状態が変わる");
  }

  console.log("— 送る（雛形から）のプレビューを大きく見る —");
  await page.locator("#tab-send").click();
  await page.waitForTimeout(300);
  check(await page.locator("#s-big").isHidden(), "プレビュー前は「大きく見る」を出さない");
  await page.locator("#s-template").selectOption("t1");
  await page.locator('#s-who input[value="emp-1"]').check();
  await page.route("**/api/sign", (route) => {
    const b = route.request().postData() ? JSON.parse(route.request().postData()) : {};
    if (b.preview) {
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ title: "誓約書", text: "本文", missing: [], fields: {},
                               employee: { id: "emp-1", name: "山田 太郎" }, pdfBase64: PDF_B64 }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sent: [], failed: [] }) });
  });
  await page.locator("button:has-text('プレビュー')").first().click();
  await page.waitForTimeout(1200);
  check(!(await page.locator("#s-big").isHidden()), "プレビューを作ると「大きく見る」が出る");
  await page.locator("#s-big").click();
  await page.waitForTimeout(700);
  check(await page.locator("#kp-viewer").count() === 1, "プレビューを画面いっぱいで読める");
  {
    const box = await page.locator(".kp-viewer-body iframe").boundingBox();
    const vp = page.viewportSize();
    check(box && box.width > vp.width * 0.9, `横幅が画面いっぱい（${box && Math.round(box.width)}px）`);
    check(box && box.height > vp.height * 0.8, `高さも画面いっぱい（${box && Math.round(box.height)}px）`);
  }
  await page.locator("[data-kp-viewer-close]").click();
  await page.waitForTimeout(300);
  check(await page.locator("#kp-viewer").count() === 0, "✕で閉じる");

  console.log("— 署名の状況 —");
  await page.locator("#tab-list").click();
  await page.waitForTimeout(600);
  check(await page.locator("#r-rows .es-src").count() === 1,
    "受け取った書面かどうかが、ひと目で分かる");
  check(await page.locator("#r-rows tr:has-text('鈴木') button:has-text('保存')").count() === 1,
    "署名済みは、会社側からも保存できる");
  posted.length = 0;
  await page.locator("#r-rows tr:has-text('鈴木') button:has-text('保存')").click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.url && /download=1/.test(p.url)), "保存のURLを取りに行く");

  await page.screenshot({ path: shotPath("sign-admin.png"), fullPage: false });
  await page.locator("#tab-order").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotPath("sign-order.png"), fullPage: false });
  await page.close();
}

// ===== 本人側 =====
{
  resetServer();
  const mine = {
    list: [
      { id: "c1", title: "労働条件通知書", kindLabel: "労働条件通知書・雇用契約書",
        view: "sent", source: "uploaded", sentAt: "2026-09-02T00:00:00Z", dueOn: "2026-09-20" },
      { id: "c2", title: "誓約書", kindLabel: "誓約書・秘密保持誓約書",
        view: "signed", source: "generated", sentAt: "2026-08-01T00:00:00Z",
        signedAt: "2026-08-02T00:00:00Z" },
    ],
    one: {
      c1: { id: "c1", title: "労働条件通知書", kindLabel: "労働条件通知書・雇用契約書",
            source: "uploaded", fileName: "通知書.pdf",
            body: "この書類はPDFで届いています。下のPDFをご覧ください。\n（通知書.pdf）",
            view: "sent", sentAt: "2026-09-02T00:00:00Z", dueOn: "2026-09-20" },
      c2: { id: "c2", title: "誓約書", kindLabel: "誓約書・秘密保持誓約書",
            source: "generated", body: "第1条　秘密を守ります。\n第2条　……",
            view: "signed", sentAt: "2026-08-01T00:00:00Z", signedAt: "2026-08-02T00:00:00Z",
            signerName: "山田 太郎", agreedText: "内容を確認し、同意します。", hash: "abc" },
    },
  };

  const page = await br.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(memberInit);
  await wire(page, meMember, mine);
  page.on("dialog", (d) => d.accept());

  console.log("\n— 本人の一覧 —");
  await page.goto(`${BASE}/contracts.html`);
  await page.waitForTimeout(1200);
  {
    const t = await page.locator("#done-card").textContent();
    check(t.includes("退職などでログインできなくなると"), "退職後は開けないと先に伝える");
    check(t.includes("PDFを保存"), "いま保存しておくよう案内する");
  }
  check(await page.locator("#done-list button:has-text('保存')").count() === 1,
    "一覧からも保存できる");

  console.log("— PDFで届いた書類 —");
  await page.locator("#open-list button:has-text('開いて署名する')").click();
  await page.waitForTimeout(1200);
  check(!(await page.locator("#o-pdf").isHidden()), "PDFで届いたものは、そのまま画面に出る");
  check((await page.locator("#o-frame").getAttribute("src") || "").includes("__view.pdf"),
    "PDFを読み込んでいる");
  check(await page.locator(".ct-tools button:has-text('大きく読む')").count() === 1, "大きく読める");
  check(await page.locator(".ct-tools button:has-text('PDFを保存')").count() === 1, "保存できる");
  check(await page.locator(".ct-tools button:has-text('印刷')").count() === 1, "印刷できる");

  await page.locator("button:has-text('大きく読む')").click();
  await page.waitForTimeout(900);
  check(await page.locator("#kp-viewer").count() === 1, "画面いっぱいで読める");
  check(await page.locator(".kp-viewer-body iframe").count() === 1, "中身はPDF");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  posted.length = 0;
  await page.locator("button:has-text('PDFを保存')").click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.url && /download=1/.test(p.url)), "保存のURLを取りに行く");

  console.log("— 文字で届いた書類 —");
  await page.goto(`${BASE}/contracts.html?id=c2`);
  await page.waitForTimeout(1200);
  check(await page.locator("#o-pdf").isHidden(), "文字で届いたものはPDFを埋め込まない");
  check((await page.locator("#o-body").textContent()).includes("第1条"), "本文が出る");
  await page.locator("button:has-text('大きく読む')").click();
  await page.waitForTimeout(600);
  check(await page.locator(".kp-viewer-text").count() === 1, "本文を画面いっぱいで読める");
  check((await page.locator(".kp-viewer-text").textContent()).includes("第2条"), "全文が入る");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  console.log("— 印刷したときに紙に出るもの —");
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => document.body.classList.add("kp-printing"));
  await page.waitForTimeout(300);
  check(await page.locator(".ct-tools").isHidden(), "ボタンは紙に出さない");
  check(await page.locator("#done-detail").isHidden(), "署名の記録は紙に出さない");
  check(!(await page.locator("#o-body").isHidden()), "本文は紙に出る");
  check(await page.locator(".topbar").isHidden() || await page.locator(".topbar").count() === 0,
    "画面まわりは紙に出さない");
  {
    // 高さの制限が外れていないと、1画面ぶんで切れる
    const style = await page.locator("#o-body").evaluate((n) => getComputedStyle(n).maxHeight);
    check(style === "none", `本文の高さ制限が外れる（${style}）`);
  }
  await page.screenshot({ path: shotPath("sign-print.png"), fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.close();
}

// ===== 申請の入口 =====
{
  resetServer();
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(adminInit);
  await wire(page, meAdmin, null);
  await page.goto(`${BASE}/workflow.html`);
  await page.waitForTimeout(1200);
  console.log("\n— 申請の入口 —");
  check(!(await page.locator("#hr-card").isHidden()), "人事には作成依頼の入口が出る");
  check(await page.locator('#hr-card a[href="admin-esign.html?tab=order"]').count() === 1,
    "押すと作成依頼のタブが開く");
  await page.close();

  const p2 = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await p2.addInitScript(memberInit);
  await wire(p2, meMember, null);
  await p2.goto(`${BASE}/workflow.html`);
  await p2.waitForTimeout(1200);
  check(await p2.locator("#hr-card").isHidden(), "メンバーには出さない");
  await p2.close();
}

// ===== 名簿からの導線 =====
{
  resetServer();
  const page = await br.newPage({ viewport: { width: 1500, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(adminInit);
  await wire(page, meAdmin, null);
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1200);
  console.log("\n— 名簿から頼む —");
  check(await page.locator("button:has-text('書類を依頼')").count() === 2, "人ごとにボタンが出る");
  await page.locator("tr:has-text('鈴木 花子') button:has-text('書類を依頼')").click();
  await page.waitForTimeout(1300);
  check(page.url().includes("tab=order") && page.url().includes("emp-2"),
    `その人を選んだ状態で開く（${page.url().split("/").pop()}）`);
  await page.waitForTimeout(700);
  check(await page.locator("#o-emp").inputValue() === "emp-2", "宛先が先に入っている");
  await page.close();
}

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); for (const e of new Set(errs)) console.log("  -", e); bad += errs.length; }
console.log(bad ? `\nNG ${bad} 件` : "\nすべて通過");
process.exit(bad ? 1 : 0);
