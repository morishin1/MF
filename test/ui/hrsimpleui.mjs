// 入退社・雇用契約を分かりやすくする（2026-10-06）を、実際のブラウザで確かめる。
//
// ■ 守ること
//   [電子署名 admin-esign.html]
//   ・契約書の作り方が2つ並ぶ（入力して契約書を作る／作成済みPDFを使う）。作成を依頼するは補助の導線
//   ・入力して作る：会社印を選ぶと「署名後の末尾の電子署名記録ページ」と見本、選ばなければ「会社印を付けずに送ります」
//   ・作成済みPDFを使う：作成依頼・条件の入力なしで、対象者 → PDF → 確認 → 署名依頼。会社印は自動追加しないと説明する
//     確認のチェックが無ければ送らない。途中で失敗したら、そこから続ける（依頼を作り直さない）。送信中は二度押しできない
//   ・署名の状況：「署名待ち・閲覧記録あり・期限超過」のように補助の情報を添える。署名済みは［署名済みPDFを開く］［保存］
//   ・人別画面から来たとき（?tab=pdf&employeeId=）は、対象者が選ばれている
//   [入退社 admin-hr.html]
//   ・入社の人別画面：次にすること → 6つの段階 → 契約書（2つの入口。対象者を付けて開く）→ チェックリスト。使い方は別タブ
//   ・名前を取れない行は「対象者情報を取得できません」（空欄にしない・開かせない）
//   ・PC と 390px で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const { accessOf } = await import("../../lib/gw.js");
const { onboardFlow } = await import("../../lib/onboard-flow.js");

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "hr@example.com", appRole: "admin", isAdmin: true, roles: [],
  gw: { employee: { id: "e-hr", display_name: "人事 花子", status: "active" }, roles: ["hr"], isHr: true, tenantId: "t1", stage: null },
  access: accessOf({ isAdmin: true, isHr: true, roles: ["hr"], apps: ["hr", "office"] }) };
const EMPLOYEES = [
  { id: "e-new", display_name: "入社 太郎", department: "開発", status: "invited", user_id: "u-new" },
  { id: "e-hr", display_name: "人事 花子", department: "管理", status: "active", user_id: "u-hr" },
];
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

async function open(path, { width = 1280, calls = [], failAttachOnce = false } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@example.com" }));
    for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k);
  });
  let attachFails = failAttachOnce;
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (u.pathname === "/api/me") return send(ME);
    if (u.pathname === "/api/employees") return send({ employees: EMPLOYEES });
    if (u.pathname === "/api/sign/templates") return send({ templates: [{ id: "tpl-1", name: "雇用契約書", doc_kind: "employment", version: 1, due_days: 7, body: "x" }], kinds: [{ key: "employment", label: "雇用契約" }], mergeFields: [], starters: {} });
    if (u.pathname === "/api/sign/seals") return send({ seals: [{ id: "s1", name: "代表者印", isActive: true, sealType: "company", imageUrl: null }], types: [], limits: {} });
    if (u.pathname === "/api/sign/orders" && req.method() === "GET") return send({ orders: [], counts: {}, kinds: [], fields: [], statuses: [] });
    if (u.pathname === "/api/sign/orders" && req.method() === "POST") {
      calls.push(body.action);
      if (body.action === "pdf_start") return send({ order: { id: "o-1", status: "requested" }, reused: false, employee: { id: body.employeeId, name: "入社 太郎", hasAccount: true }, reconciliation: { linked: true, hasAcceptedOffer: true, matched: true, overridden: false } });
      if (body.action === "upload") return send({ path: "t1/doc-order/o-1/a.pdf", uploadUrl: "https://storage.test/up/a.pdf", token: "t" });
      if (body.action === "attach") {
        if (attachFails) { attachFails = false; return send({ error: "no_file", hint: "置いたファイルを読めませんでした" }, 400); }
        return send({ order: { id: "o-1", status: "uploaded" } });
      }
      if (body.action === "send") { await new Promise((r) => setTimeout(r, 400)); return send({ ok: true, signRequestId: "sr-1", dueOn: body.dueOn, source: "uploaded", notified: true }); }
      return send({});
    }
    if (u.pathname === "/api/sign") {
      return send({ requests: [
        { id: "sr-a", title: "雇用契約書", view: "overdue", status: "sent", first_viewed_at: "2026-10-02T01:00:00Z", due_on: "2026-10-01", sent_at: "2026-09-25T00:00:00Z", employee: { display_name: "入社 太郎" } },
        { id: "sr-b", title: "雇用契約書", view: "signed", status: "signed", signed_at: "2026-10-03T01:00:00Z", sent_at: "2026-09-25T00:00:00Z", employee: { display_name: "人事 花子" } },
        { id: "sr-c", title: "誓約書", view: "cancelled", status: "cancelled", sent_at: "2026-09-25T00:00:00Z", employee: { display_name: "入社 太郎" } },
      ], counts: {} });
    }
    if (u.pathname === "/api/hr") {
      if (u.searchParams.get("id")) return send(ONE);
      return send(LIST);
    }
    if (/\/api\/hr\/retention/.test(u.pathname)) return send({ today: "2026-10-06", rules: [], schedule: [], expired: 0, log: [] });
    if (/\/api\/onboarding\/orientation/.test(u.pathname)) return send({ items: [], kinds: [], done: true });
    if (/\/api\/onboarding\/notice/.test(u.pathname)) return send({ versions: [], employee: { id: "e-new" } });
    if (/\/api\/notifications/.test(u.pathname)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(u.pathname)) return send({ badges: {} });
    return send({});
  });
  await ctx.route("https://storage.test/**", (route) => route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(1500);
  page.ctx = ctx;
  return page;
}

const FLOW = onboardFlow({ facts: { procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null, items: [] },
  employee: { user_id: "u-new" }, targetOn: "2026-10-20", items: [], today: "2026-10-06" });
const LIST = {
  tabs: [{ key: "onboarding", label: "入社予定" }, { key: "offboarding", label: "退社予定" }, { key: "done", label: "完了" }],
  onboarding: [
    { id: "p-new", kind: "onboarding", employeeId: "e-new", name: "入社 太郎", department: "開発", employmentType: "正社員", targetOn: "2026-10-20", days: 14, due: "入社まで14日",
      phase: "prep", phaseLabel: "入社準備", progress: { done: 0, total: 6 }, urgency: "warn", next: { title: "契約書の準備", role: "人事", who: "人事 花子" },
      stage: "conditions", stageN: 1, stageLabel: "作成依頼", nextActors: ["admin"], nextActorLabel: "会社", blockers: ["契約書の準備がまだです（入力して作る・作成済みPDFを使う・作成を依頼する）"], pct: 0, daysLeft: 14 },
    { id: "p-x", kind: "onboarding", employeeId: "e-x", name: "（不明）", department: null, targetOn: null, days: null, due: "", phase: "prep", phaseLabel: "入社準備",
      progress: { done: 0, total: 1 }, urgency: "", next: null, stage: "conditions", stageN: 1, stageLabel: "作成依頼", nextActors: ["admin"], nextActorLabel: "会社", blockers: [], pct: 0 },
  ],
  offboarding: [], done: [], people: [], roles: [], today: "2026-10-06",
};
const ONE = { procedure: { ...LIST.onboarding[0], flow: FLOW, groups: [
  { role: "hr", label: "人事", done: 0, total: 1, items: [{ id: "i1", title: "会社PCの準備", owner: "hr", ownerLabel: "人事", phase: "prep", done: false, assignee: null, href: null }] }],
  drive: null }, roles: [], people: [] };

console.log("— 電子署名：2つの作り方 —");
{
  const page = await open("admin-esign.html");
  const ways = (await page.locator(".es-way b").allInnerTexts()).map((x) => x.trim());
  check(ways.join("|") === "入力して契約書を作る|作成済みPDFを使う", `入口は2つ（${ways.join("|")}）`);
  check(await page.locator("#es-entry a", { hasText: "作成を依頼する" }).count() === 1, "作成を依頼するは補助の導線");
  check((await page.locator('#es-entry a[href="help.html#contracts"]').getAttribute("target")) === "_blank", "使い方は別のタブ（入力中の内容を消さない）");
  // 会社印の説明
  check((await page.locator("#s-seal-note").innerText()).includes("会社印を付けずに送ります"), "会社印なし：付けずに送ります");
  await page.locator('input[name="s-seal"][value="s1"]').check();
  const note = await page.locator("#s-seal-note").innerText();
  check(note.includes("代表者印") && note.includes("電子署名記録") && note.includes("見本") && note.includes("まだ署名済みではありません"), "会社印あり：配置先（署名後の電子署名記録ページ）と見本。未署名を署名済みに見せない");
  // 署名の状況
  await page.locator("#tab-list").click();
  await page.waitForTimeout(300);
  const rows = await page.locator("#r-rows tr").allInnerTexts();
  check(rows.some((r) => r.includes("署名待ち・閲覧記録あり・期限超過") && r.includes("案内文をコピー") && r.includes("再通知") && r.includes("状況を見る")), "署名待ち・閲覧記録あり・期限超過＋操作");
  check(rows.some((r) => r.includes("署名済み") && r.includes("署名済みPDFを開く") && r.includes("保存")), "署名済み：署名済みPDFを開く・保存");
  check(rows.some((r) => r.includes("取消済み") && r.includes("履歴を見る")), "取消済み：履歴を見る");
  await page.screenshot({ path: shotPath("esign-entry.png"), fullPage: true });
  await page.ctx.close();
}

console.log("\n— 作成済みPDFを使う —");
{
  const calls = [];
  const page = await open("admin-esign.html?tab=pdf&employeeId=e-new", { calls, failAttachOnce: true });
  check(!(await page.locator("#pane-pdf").isHidden()), "人別画面から：PDFを使うが開く");
  check((await page.locator("#p-emp").inputValue()) === "e-new", "対象者が選ばれている");
  check((await page.locator("#pane-pdf").innerText()).includes("会社印は自動追加されません"), "会社印は自動追加しないと説明");
  check(await page.locator("#pane-pdf input[type=text]").count() === 1, "入力するのは書類名だけ（条件・依頼先の欄は無い）");
  await page.setInputFiles("#p-file", { name: "雇用契約書.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForTimeout(300);
  check(!(await page.locator("#p-preview").isHidden()), "選んだPDFをその場でプレビュー");
  await page.locator("#p-send").click();
  await page.waitForTimeout(300);
  check(/確認して、チェック/.test(await page.locator("#p-msg").innerText()) && calls.length === 0, "確認のチェックが無ければ送らない（何も呼ばない）");
  await page.locator("#p-ok").check();
  await page.locator("#p-send").click();
  await page.waitForTimeout(1200);
  check(/PDFの取り込みで止まりました/.test(await page.locator("#p-msg").innerText()), "途中で失敗：どこで止まったかと、続きから進めることを出す");
  check(calls.join(",") === "pdf_start,upload,attach", `ここまでの呼び出し（${calls.join(",")}）`);
  await page.locator("#p-send").click();
  await page.waitForTimeout(100);
  check(await page.locator("#p-send").isDisabled(), "送信中はボタンを押せない（二度押しを防ぐ）");
  await page.waitForTimeout(1200);
  check(calls.join(",") === "pdf_start,upload,attach,upload,attach,send", `やり直しは取り込みから（依頼は作り直さない。${calls.join(",")}）`);
  const result = await page.locator("#p-result").innerText();
  check(result.includes("署名依頼を登録しました") && result.includes("メール・Slack に届いたかは記録していません"), "依頼の登録と、外部への到達を区別する");
  check(!/送信済/.test(await page.locator("#pane-pdf").innerText()), "送信済みと出さない");
  check((await page.locator("#p-recon").innerText()).includes("自動では照合していません"), "PDFの中身は照合していないと正直に出す");
  await page.ctx.close();
}

console.log("\n— 入退社：一覧と入社の人別画面 —");
{
  const page = await open("admin-hr.html");
  const heads = (await page.locator(".hr-table th").allInnerTexts()).map((x) => x.trim());
  check(heads.join("|") === "対象者|入社日／退職日|現在の状態|次にすること|担当|期限|操作", `一覧の列（${heads.join("|")}）`);
  const bad1 = page.locator('#hr-rows tr[data-row="p-x"]');
  check((await bad1.innerText()).includes("対象者情報を取得できません") && await bad1.locator("button").count() === 0, "名前を取れない行は空欄にせず、開かせない");
  const row = page.locator('#hr-rows tr[data-row="p-new"]');
  check((await row.innerText()).includes("2026/10/20") && (await row.innerText()).includes("人事 花子"), "入社日・担当");
  await row.locator("button", { hasText: "手続きを開く" }).click();
  await page.waitForSelector("#ob", { timeout: 8000 });
  const ids = await page.locator("#ob > section").evaluateAll((ns) => ns.map((n) => n.id));
  check(ids.join(",") === "ob-next,ob-flow,ob-contract", `次にすること → 進み具合 → 契約書（${ids.join(",")}）`);
  check((await page.locator("#ob-next").innerText()).includes("契約書を準備する"), "次にすること：契約書を準備する");
  const steps = (await page.locator("#ob-flow tbody tr td:first-child").allInnerTexts()).map((x) => x.trim().replace(/^\d+\.\s*/, ""));
  check(steps.join("|") === "基本情報|契約書の準備|本人の確認・署名|入社情報・必要書類|アカウント・貸与品|会社確認・完了", `6つの段階（${steps.join("|")}）`);
  const make = await page.locator('#ob-contract a[data-act="make"]').getAttribute("href");
  const pdf = await page.locator('#ob-contract a[data-act="pdf"]').getAttribute("href");
  check(make.includes("tab=send") && make.includes("employeeId=e-new") && pdf.includes("tab=pdf") && pdf.includes("employeeId=e-new"), "2つの入口は対象者を付けて開く");
  check((await page.locator('#ob-next a[href="help.html#hr-onboarding"]').getAttribute("target")) === "_blank", "使い方は別のタブ");
  const pos = await page.evaluate(() => {
    const ob = document.getElementById("ob"), grp = document.querySelector(".hr-grp");
    return Boolean(ob && grp && (ob.compareDocumentPosition(grp) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  check(pos, "チェックリストは下に残る");
  await page.screenshot({ path: shotPath("hr-onboarding-detail.png"), fullPage: true });
  await page.ctx.close();
}

console.log("\n— 390px —");
for (const path of ["admin-esign.html?tab=pdf&employeeId=e-new", "admin-hr.html?id=p-new"]) {
  const page = await open(path, { width: 390 });
  const over = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const root = document.querySelector("#es-entry, #ob")?.closest(".wrap") || document.body;
    return [...root.querySelectorAll("#es-entry, #es-entry *, #pane-pdf *, #ob, #ob *")].filter((n) => n.getBoundingClientRect().width > 0 && !n.closest(".table-scroll, iframe"))
      .map((n) => Math.round(n.getBoundingClientRect().right - W)).reduce((a, b) => Math.max(a, b), -999);
  });
  check(over <= 0, `${path}：横にはみ出さない（${over}px）`);
  const btn = path.includes("esign") ? page.locator("#p-send") : page.locator('#ob-contract a[data-act="pdf"]');
  const box = await btn.boundingBox();
  check(box && box.width >= 44 && box.height >= 28, `${path}：主要なボタンが押せる大きさ`);
  await page.ctx.close();
}

check(errs.length === 0, `画面のエラーなし（${errs.slice(0, 3).join(" / ")}）`);
await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
