// 採用HR Stage 9：admin-esign.html「作成依頼」で、採用承諾時の条件と
// 現在の契約条件を突き合わせる画面を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 対象者を選ぶと、サーバへ承諾済みoffer条件との突き合わせを取りに行く
//   2. 一致していれば緑のチェック表示。［依頼を作る］は出たまま
//   3. 一致していなければ（例：承諾時 月給300,000円 → 現在 月給320,000円）、
//      ［依頼を作る］は隠れ、差分（承諾時／現在）を「差分を見る」で確認できる
//   4. 不一致のまま突破できる simple な確認ボタンは無い。
//      owner・hr だけに「特別な事情がある場合」の理由必須override導線が出る
//      （管理者だけ＝hrでない役職には出ない）。
//      理由を入れて送ると、force・overrideReason つきで作成依頼が送られる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const DOC_KINDS_MOCK = [{ key: "employment", label: "労働条件通知書・雇用契約書" }];
const ORDER_FIELDS_MOCK = [
  { key: "雇用区分", placeholder: "", required: true },
  { key: "賃金", placeholder: "", required: true },
];
const EMPLOYEES = [
  { id: "e1", display_name: "一致 花子", department: "営業", user_id: "u1", status: "active" },
  { id: "e2", display_name: "不一致 太郎", department: "開発", user_id: "u2", status: "active" },
];

const OK_RECONCILE = {
  linked: true, hasAcceptedOffer: true, mismatches: [],
  prefillConditions: { 雇用区分: "正社員", 賃金: "月給 300,000円" },
};
const MISMATCH_RECONCILE = {
  linked: true, hasAcceptedOffer: true,
  mismatches: [
    { key: "wage", label: "給与", offerValue: "月給 300,000円", currentValue: "月給 320,000円" },
  ],
  prefillConditions: { 雇用区分: "正社員", 賃金: "月給 320,000円" },
};

const OWNER = { id: "emp-o1", display_name: "社長", status: "active" };
const ADMIN_EMP = { id: "emp-a1", display_name: "総務 次郎", status: "active" };

function routeCommon(page, { appRole, gwRoles, isHr }, { reconcileCalls, posted, orders = [] }) {
  page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    const path = new URL(url).pathname;
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(path)) {
      return send({
        email: "x@8grp.co.jp", appRole, isAdmin: appRole === "admin", shows: {},
        gw: { employee: appRole === "owner" ? OWNER : ADMIN_EMP, roles: gwRoles, isHr, tenantId: "t1", stage: null },
      });
    }
    if (/\/api\/sign\/templates/.test(path)) {
      return send({ templates: [], kinds: DOC_KINDS_MOCK, mergeFields: [], starters: {} });
    }
    if (/\/api\/employees$/.test(path) && method === "GET") return send({ employees: EMPLOYEES });
    if (/\/api\/sign\/orders/.test(path) && /reconcile=1/.test(url)) {
      reconcileCalls.push(url);
      const empId = new URL(url).searchParams.get("employeeId");
      const body = empId === "e2" ? MISMATCH_RECONCILE
        : empId === "e1" ? OK_RECONCILE
        : { linked: false, hasAcceptedOffer: false, mismatches: [], prefillConditions: {} };
      return send(body);
    }
    if (/\/api\/sign\/orders/.test(path) && method === "GET") {
      return send({
        orders, counts: {}, kinds: DOC_KINDS_MOCK, fields: ORDER_FIELDS_MOCK,
        statuses: [], noticeTitle: "労働条件通知書 兼 雇用契約書", advisor: false,
      });
    }
    if (/\/api\/sign\/orders/.test(path) && method === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      return send({ order: { id: "order-new1", employeeId: b.employeeId, docKind: b.docKind || "employment" } });
    }
    if (/^\/api\/sign$/.test(path) && method === "GET") return send({ requests: [], counts: {} });
    if (/\/api\/notifications/.test(path)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(path)) return send({ badges: {} });
    return send({});
  });
}

console.log("\n=== 一致している：緑チェック、［依頼を作る］は出たまま ===");
{
  const reconcileCalls = [];
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1300, height: 1300 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "x@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  routeCommon(page, { appRole: "owner", gwRoles: ["owner"], isHr: true }, { reconcileCalls, posted });

  await page.goto(`${BASE}/admin-esign.html?tab=order`);
  await page.waitForTimeout(1000);

  await page.selectOption("#o-emp", "e1");
  await page.waitForTimeout(500);

  check(reconcileCalls.length === 1 && reconcileCalls[0].includes("employeeId=e1"), "対象者を選ぶと突き合わせを取りに行く");
  check((await page.locator("#o-reconcile").innerText()).includes("一致しています"), "一致の表示が出る");
  check(await page.locator("#o-save").isVisible(), "［依頼を作る］は隠れない");
  check(await page.locator("button", { hasText: "特別な事情がある場合" }).count() === 0, "一致していれば特例導線は出ない");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 不一致（承諾時 月給300,000円 → 現在 月給320,000円）：［依頼を作る］が隠れ、差分が見える ===");
{
  const reconcileCalls = [];
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1300, height: 1300 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "x@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  routeCommon(page, { appRole: "owner", gwRoles: ["owner"], isHr: true }, { reconcileCalls, posted });

  await page.goto(`${BASE}/admin-esign.html?tab=order`);
  await page.waitForTimeout(1000);

  await page.selectOption("#o-emp", "e2");
  await page.waitForTimeout(500);

  check((await page.locator("#o-reconcile").innerText()).includes("採用承諾時の条件と異なります"), "不一致の警告が出る");
  check(!(await page.locator("#o-save").isVisible()), "［依頼を作る］が隠れる（通常導線では出せない）");

  check(await page.locator("#o-reconcile-detail").isHidden(), "差分は最初は畳まれている");
  await page.locator("button", { hasText: "差分を見る" }).click();
  await page.waitForTimeout(200);
  const detail = await page.locator("#o-reconcile-detail").innerText();
  check(await page.locator("#o-reconcile-detail").isVisible(), "「差分を見る」で開く");
  check(detail.includes("給与") && detail.includes("300,000円") && detail.includes("320,000円"),
    "承諾時／現在の値が両方見える（給与300,000円→320,000円）");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== owner・hr：特別な事情がある場合の導線（理由必須）で進められる ===");
{
  const reconcileCalls = [];
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1300, height: 1300 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "x@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  routeCommon(page, { appRole: "owner", gwRoles: ["owner"], isHr: true }, { reconcileCalls, posted });

  await page.goto(`${BASE}/admin-esign.html?tab=order`);
  await page.waitForTimeout(1000);
  await page.selectOption("#o-emp", "e2");
  await page.waitForTimeout(500);

  const overrideBtn = page.locator("button", { hasText: "特別な事情がある場合" });
  check(await overrideBtn.count() === 1, "owner・hrには特例導線が出る");
  await overrideBtn.click();
  await page.waitForTimeout(200);

  const submitBtn = page.locator("button", { hasText: "この理由で依頼を進める" });
  await submitBtn.click();
  await page.waitForTimeout(200);
  check((await page.locator("#o-msg").innerText()).includes("理由"), "理由が空だと止まる");
  check(posted.length === 0, "理由が空のあいだはサーバへ送らない");

  await page.locator("#o-override-reason").fill("本人と電話で確認済み。次回改定まではこの条件で契約する合意あり");
  await submitBtn.click();
  await page.waitForTimeout(500);

  check(posted.length === 1, "理由を入れると作成依頼が送られる");
  check(posted[0].action === "create" && posted[0].employeeId === "e2", "対象者を保ったまま送られる");
  check(posted[0].force === true, "forceがつく（missing_conditionsの通常道と同じ形）");
  check(posted[0].overrideReason && posted[0].overrideReason.includes("電話で確認済み"), "理由がそのまま送られる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 管理者（hrでない）：不一致でも特例導線は出ない ===");
{
  const reconcileCalls = [];
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1300, height: 1300 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "x@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  routeCommon(page, { appRole: "admin", gwRoles: ["admin"], isHr: false }, { reconcileCalls, posted });

  await page.goto(`${BASE}/admin-esign.html?tab=order`);
  await page.waitForTimeout(1000);
  await page.selectOption("#o-emp", "e2");
  await page.waitForTimeout(500);

  check(!(await page.locator("#o-save").isVisible()), "不一致なら管理者でも［依頼を作る］は出ない");
  check(await page.locator("button", { hasText: "特別な事情がある場合" }).count() === 0,
    "hrでない管理者には特例導線が出ない（owner・hrだけ）");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== NEXT ACTION：契約の進み具合に合わせて「現在」と次の1手を出す ===");

async function nextActionCase(label, order, wants) {
  const reconcileCalls = [];
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1300, height: 1300 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "x@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  routeCommon(page, { appRole: "owner", gwRoles: ["owner"], isHr: true },
    { reconcileCalls, posted, orders: order ? [order] : [] });

  await page.goto(`${BASE}/admin-esign.html?tab=order`);
  await page.waitForTimeout(1000);
  await page.selectOption("#o-emp", "e1");
  await page.waitForTimeout(500);

  const text = await page.locator("#o-nextaction").innerText();
  check(text.includes(wants.now), `${label}：現在の表示`);
  check(text.includes(wants.next), `${label}：NEXT ACTIONの表示`);
  if (wants.button) {
    check(await page.locator("#o-nextaction button, #o-nextaction a", { hasText: wants.button }).count() === 1,
      `${label}：CTAが出る（${wants.button}）`);
  } else {
    check(await page.locator("#o-nextaction button, #o-nextaction a").count() === 0, `${label}：CTAは出ない`);
  }

  check(errs.length === 0, `${label}：画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await nextActionCase("依頼がまだ無い", null,
  { now: "契約書作成待ち", next: "社労士へ契約書作成を依頼してください" });

await nextActionCase("社労士対応中",
  { id: "o1", employeeId: "e1", docKind: "employment", status: "requested" },
  { now: "社労士対応中", next: "社労士が契約書を作成しています" });

await nextActionCase("契約書完成（アップロード済み）",
  { id: "o1", employeeId: "e1", docKind: "employment", status: "uploaded" },
  { now: "契約書完成", next: "本人へ電子署名を依頼してください", button: "電子署名を依頼" });

await nextActionCase("契約締結待ち（署名依頼ずみ）",
  { id: "o1", employeeId: "e1", docKind: "employment", status: "sent" },
  { now: "契約締結待ち", next: "本人の署名を待っています" });

await nextActionCase("契約締結済み",
  { id: "o1", employeeId: "e1", docKind: "employment", status: "signed" },
  { now: "契約締結済み", next: "入社手続きを進めてください", button: "入社手続きへ" });

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
