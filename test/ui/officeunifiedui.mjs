// Office は「役職でアプリを変える」のではなく「同じアプリの中で、権限だけを変える」。実際のブラウザで見る。
//
// ■ 守ること（2026-10-02 の決定）
//   1. ヘッダーの「Office」を押すと、経営者（owner）でも、管理者（admin）でも、経理（finance）でも、責任者（manager）でも、
//      同じ /office/ に入る（管理画面 admin-dashboard.html へは送らない）。どの画面から押しても同じ
//   2. 全ロールで、Office の基本レイアウトが同一：ヘッダー・ナビ・コンテンツ幅・カード・フォント・ボタン・余白・色。
//      DOM の骨組み、計算済みスタイル、画面のピクセルまで同じ（違うのは、見えるデータ・押せる操作だけ）
//   3. 権限のないメニューだけが出ない：Office に入れない人（人事・営業・会計の管理者だけ・一般メンバー）には Office を出さない。
//      ほかのツール（HR・Sales など）は、その人の権限のとおり
//   4. 権限のない人が /office/ を直接開いても、home.html へ戻され、Office の API は1回も呼ばれない
//   5. 管理画面（admin-dashboard.html）は残っていて、管理者は ⚙管理 から開ける。ただし Office の入口でもナビでもなく、「Office」と名乗らない
//
// ■ 何を通しているか
//   ブラウザの通信は、本物の api/office/{index,timesheet,file,terms}.js のハンドラにつなぐ（DB は偽：test/_memdb.mjs）。
//   /api/me は、ロールごとに、サーバの accessOf（lib/gw.js）そのものの access を返す。
import "../_officeharness.mjs";
import { mem, ctl, call, atRoot, OWNER, MANAGER, FINANCE, P, uid, T1 } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));
const { accessOf } = await import(atRoot("lib/gw.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---- ロール（サーバの判定そのもので access を作る） --------------------------------------------
//   appRole … 管理画面（admin-*.html）を開けるか。owner / admin だけが管理画面を開ける
const ROLES = {
  "経営者（owner）":            { appRole: "owner", isAdmin: false, roles: ["owner"], who: OWNER },
  "管理者＋経理（admin）":       { appRole: "admin", isAdmin: true,  roles: ["finance"], who: P(["finance"], { isAdmin: true }) },
  "経理（finance）":            { appRole: "member", isAdmin: false, roles: ["finance"], who: FINANCE },
  "責任者（manager）":          { appRole: "member", isAdmin: false, roles: ["manager"], who: MANAGER },
};
const DENIED = {
  "人事（hr）":                 { appRole: "member", isAdmin: false, roles: ["hr"], who: P(["hr"], { isHr: true }), tools: "hr" },
  "営業（sales）":              { appRole: "member", isAdmin: false, roles: ["sales"], who: P(["sales"]), tools: "sales" },
  "会計の管理者だけ（admin）":   { appRole: "admin", isAdmin: true, roles: [], who: P([], { isAdmin: true }), tools: "keiei" },
  "一般メンバー":               { appRole: "member", isAdmin: false, roles: [], who: P([]), tools: "" },
};

const EMP_A = uid(101), EMP_B = uid(102), CON_A = uid(201), CON_B = uid(202);
function seed() {
  mem.reset();
  mem.rows.gw_employees = [
    { id: EMP_A, tenant_id: T1, display_name: "田中 太郎", department: null, status: "active", employee_kind: "proper", partner_company_id: null },
    { id: EMP_B, tenant_id: T1, display_name: "鈴木 花子", department: null, status: "active", employee_kind: "bp", partner_company_id: null },
  ];
  mem.rows.gw_site_contracts = [
    { id: CON_A, tenant_id: T1, employee_id: EMP_A, engagement_kind: "pp", site_company: "顧客A社", prime_company: null, period_from: "2026-10-01", period_to: null, unit_price: 500001, unit_price_type: "月額", renewal_status: "pending", note: null },
    { id: CON_B, tenant_id: T1, employee_id: EMP_B, engagement_kind: "bp", site_company: "顧客B社", prime_company: null, period_from: "2026-10-01", period_to: null, unit_price: 500002, unit_price_type: "月額", renewal_status: "confirmed", note: null },
  ];
  mem.rows.gw_billing_progress = [CON_A, CON_B].map((c, i) => ({ id: uid(300 + i), tenant_id: T1, employee_id: i ? EMP_B : EMP_A, site_contract_id: c, billing_month: "2026-10", note: null,
    timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false }));
  mem.rows.gw_submissions = []; mem.rows.gw_timesheets = []; mem.rows.gw_timesheet_days = []; mem.rows.gw_site_contract_terms = []; mem.rows.gw_office_events = [];
}

// 画面ごとの /api/office* の呼び出し（権限のない人の画面から、Office の API が呼ばれていないことを見る）
async function open(url, role, viewport = { width: 1440, height: 1000 }) {
  ctl.who = { ...role.who, factors: [] }; ctl.aal = "aal1";
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = [], calls = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.example|status of 4|status of 5/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" })); localStorage.removeItem("kp_me"); localStorage.removeItem("kp_layout"); });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({
        email: "a@b.c", appRole: role.appRole, isAdmin: role.isAdmin, shows: {}, roles: [],
        access: accessOf({ isAdmin: role.isAdmin, roles: role.roles }),
        mfa: { required: false, enrolled: false, verified: false, enforced: false, blocked: false },
        gw: { employee: { id: "e-me", display_name: "森田", status: "active" }, roles: role.roles, isAdmin: role.isAdmin, tenantId: "t1", stage: null },
      });
    }
    const h = { "/api/office": indexApi, "/api/office/timesheet": sheetApi, "/api/office/file": fileApi, "/api/office/terms": termsApi }[u.pathname];
    if (h) {
      calls.push(u.pathname + u.search);
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  return { page, errs, calls };
}
const shortcuts = (page) => page.locator(".topbar [data-shortcut]").evaluateAll((ns) =>
  ns.map((n) => ({ key: n.dataset.shortcut, href: n.getAttribute("href") })));

// ============================================================================================
console.log("\n=== 1. ヘッダーの「Office」は、役割に関係なく /office/ へ（どの画面から押しても） ===");
for (const [label, role] of Object.entries(ROLES)) {
  // 管理画面を開ける人（owner・admin）は管理画面から、それ以外はホームから押す。どちらの画面からでも同じ
  const starts = role.appRole === "member" ? ["/home.html"] : ["/home.html", "/admin-dashboard.html", "/admin-timecard.html"];
  for (const start of starts) {
    seed();
    const { page } = await open(start, role);
    await page.waitForSelector(".topbar [data-shortcut='office']", { timeout: 8000 });
    const href = await page.locator(".topbar [data-shortcut='office']").getAttribute("href");
    check(href === "/office/", `${label}：${start} の Office → ${href}`);
    check(!(await shortcuts(page)).some((s) => /admin-dashboard|admin-team|admin-members|admin-expenses/.test(s.href || "") && s.key === "office"), `${label}：Office が管理画面を指さない`);
    await Promise.all([page.waitForURL(/\/office\/?(index\.html)?(\?.*)?$/), page.click(".topbar [data-shortcut='office']")]);
    check(new URL(page.url()).pathname === "/office/", `${label}：${start} から Office を押す → /office/（いま ${new URL(page.url()).pathname}）`);
    await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
    check((await page.locator("#rows tr[data-id]").count()) === 2, `${label}：月次業務の一覧が出る（2件）`);
    await page.close();
  }
}

// ============================================================================================
console.log("\n=== 2. 全ロールで、Office の基本レイアウトが同一（ヘッダー・ナビ・幅・カード・フォント・ボタン・余白・色） ===");
const sig = {};
const shots = {};
for (const [label, role] of Object.entries(ROLES)) {
  seed();
  const { page, errs, calls } = await open("/office/index.html?month=2026-10", role);
  await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
  await page.waitForTimeout(500);
  sig[label] = await page.evaluate(() => {
    const cs = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, c[p]])); };
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    return {
      bodyClass: document.body.className,
      bar: document.querySelector(".of-bar")?.outerHTML.replace(/\s+/g, " "),
      // アイコンの名前（material symbols の文字）は除いて、ラベルの文字だけを見る
      navLabels: [...document.querySelectorAll(".of-nav a")].map((a) => [...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()),
      navHrefs: [...document.querySelectorAll(".of-nav a")].map((a) => a.getAttribute("href")),
      ids: [...document.querySelectorAll("[id]")].map((e) => e.id).filter((i) => !/^kp-|^of-user/.test(i)),
      sections: [...document.querySelectorAll(".of-sec-h, h1")].map((e) => e.textContent.trim().replace(/\s+/g, " ")),
      heads: [...document.querySelectorAll(".of-table thead th")].map((e) => e.textContent.trim()),
      hasAdminChrome: Boolean(document.querySelector(".topbar, .kp-sidebar, .kp-side-group, #kp-admin-menu-btn")),
      adminLinks: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => /admin-/.test(h)),
      body: cs("body", ["fontFamily", "backgroundColor", "color", "fontSize"]),
      wrap: cs(".wrap", ["maxWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginLeft"]),
      wrapBox: box(".wrap"), barBox: box(".of-bar"),
      bar_css: cs(".of-bar", ["height", "backgroundColor", "borderBottomColor", "paddingLeft", "position"]),
      navOn: cs(".of-nav a.on", ["color", "fontWeight", "borderBottomColor"]),
      title: cs("h1.of-title", ["fontSize", "fontWeight", "color"]),
      card: cs(".of-card", ["backgroundColor", "borderTopColor", "borderRadius", "paddingTop", "fontFamily"]),
      table: cs(".of-table", ["backgroundColor", "borderTopColor"]),
      th: cs(".of-table th", ["fontSize", "color", "backgroundColor", "paddingTop"]),
      btn: cs(".of-btn", ["backgroundColor", "color", "borderRadius", "fontSize", "fontWeight", "paddingTop", "paddingLeft"]),
      cta: cs(".of-btn.cta", ["backgroundColor", "color", "borderRadius", "fontSize"]),
      pill: cs(".of-st", ["fontSize", "borderRadius", "fontWeight"]),
    };
  });
  shots[label] = await page.screenshot({ animations: "disabled", caret: "hide" });
  check(calls.length > 0 && errs.length === 0, `${label}：Office が表示される（API ${calls.length}回・画面のエラーなし ${errs.join(" | ").slice(0, 120)}）`);
  if (label.startsWith("経営者")) await page.screenshot({ path: shotPath("office-unified-owner.png") });
  if (label.startsWith("経理")) await page.screenshot({ path: shotPath("office-unified-finance.png") });
  await page.close();
}
const base = sig["経営者（owner）"];
check(base && base.navLabels.join("|") === "月次業務" && base.navHrefs.join("|") === "/office/", `ナビは全員同じ1つの定義（いま ${base?.navLabels.join("|")}）`);
check(base && base.bodyClass.includes("of-app") && base.bar.includes("EIGHT") && base.bar.includes("/ OFFICE"), "Office 専用のヘッダー（EIGHT / OFFICE）");
check(base && !base.hasAdminChrome && base.adminLinks.length === 0, "Office の画面に、管理画面のヘッダー・左メニュー・admin-*.html へのリンクが無い");
for (const [label, s] of Object.entries(sig)) {
  if (label.startsWith("経営者")) continue;
  const diff = Object.keys(base).filter((k) => JSON.stringify(base[k]) !== JSON.stringify(s[k]));
  check(diff.length === 0, `${label} は 経営者と同じレイアウト${diff.length ? `（違い：${diff.join("・")}）` : "（ヘッダー・ナビ・DOMの骨組み・幅・余白・色・フォント・カード・ボタンが同一）"}`);
}
for (const [label, buf] of Object.entries(shots)) {
  if (label.startsWith("経営者")) continue;
  check(Buffer.compare(shots["経営者（owner）"], buf) === 0, `${label} は 経営者と、画面のピクセルまで同じ（PC幅 1440px）`);
}

// スマホ幅でも同じ（カード表示）
{
  const mob = {};
  for (const label of ["経営者（owner）", "管理者＋経理（admin）", "経理（finance）"]) {
    seed();
    const { page } = await open("/office/index.html?month=2026-10", ROLES[label], { width: 390, height: 800 });
    await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
    await page.waitForTimeout(500);
    mob[label] = await page.screenshot({ animations: "disabled", caret: "hide" });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}：スマホ幅で横スクロールが要らない`);
    await page.close();
  }
  check(Buffer.compare(mob["経営者（owner）"], mob["経理（finance）"]) === 0 && Buffer.compare(mob["経営者（owner）"], mob["管理者＋経理（admin）"]) === 0, "スマホ幅（390px）も、経営者・管理者・経理で、画面のピクセルまで同じ");
}

// ============================================================================================
console.log("\n=== 3. 権限のないメニューだけが出ない（Office に入れない人に Office を出さない。ほかのツールは権限のとおり） ===");
for (const [label, role] of Object.entries(DENIED)) {
  seed();
  const { page, calls } = await open("/home.html", role);
  await page.waitForSelector(".topbar", { timeout: 8000 });
  await page.waitForTimeout(700);
  const keys = (await shortcuts(page)).map((s) => s.key).filter((k) => ["hr", "sales", "office", "keiei"].includes(k));
  check(!keys.includes("office"), `${label}：ヘッダーに Office を出さない（いま ${keys.join(",") || "なし"}）`);
  check(keys.join(",") === role.tools, `${label}：ほかのツールは権限のとおり（いま "${keys.join(",")}"・期待 "${role.tools}"）`);
  check(calls.length === 0, `${label}：ホームを開いても、Office の API は呼ばれない`);
  await page.close();
}
// ナビ（機能単位）：権限のある項目だけ出す。役割（appRole）では変えない
{
  seed();
  const { page } = await open("/office/index.html?month=2026-10", ROLES["経営者（owner）"]);
  await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
  const r = await page.evaluate(() => {
    const L = window.OfficeLayout, names = (me) => L.navFor(me).map((n) => n.key).join(",");
    return {
      none: names({ appRole: "owner", access: { office: false } }),
      noAccess: names({ appRole: "owner" }),
      owner: names({ appRole: "owner", access: { office: true } }),
      admin: names({ appRole: "admin", isAdmin: true, access: { office: true } }),
      member: names({ appRole: "member", access: { office: true } }),
      nav: L.NAV.map((n) => n.needs).join(","),
    };
  });
  check(r.none === "" && r.noAccess === "", "ナビ：権限（access.office）が無ければ、その項目だけを出さない（owner でも出さない）");
  check(r.owner === "monthly" && r.owner === r.admin && r.admin === r.member, `ナビ：権限が同じなら、appRole（owner／admin／member）によらず同じ（いま ${r.owner}／${r.admin}／${r.member}）`);
  check(r.nav === "office", "ナビの各項目は、役割名ではなく access のキー（needs）で決まる");
  await page.close();
}

// ============================================================================================
console.log("\n=== 4. 権限のない人が /office/ を直接開いても、home.html へ戻され、Office の API は呼ばれない ===");
for (const [label, role] of Object.entries(DENIED)) {
  seed();
  const { page, calls } = await open("/office/index.html?month=2026-10", role);
  await page.waitForURL(/home\.html/, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  check(/home\.html/.test(page.url()), `${label}：/office/ を直接開くと home.html へ戻される（いま ${new URL(page.url()).pathname}）`);
  check(calls.length === 0, `${label}：権限のない Office の API は、1回も呼ばれない（${calls.length}回）`);
  check(!/mypage\.html/.test(page.url()), `${label}：マイページへも送られない`);
  await page.close();
}
// 画面を通らない直接の呼び出しも、サーバが 403 で断る（画面で隠すだけにしない）。何も読まず・書かない
for (const [label, role] of Object.entries(DENIED)) {
  seed(); ctl.who = { ...role.who, factors: [] }; ctl.aal = "aal1";
  const before = mem.state.log.length;
  const rs = [
    await call(indexApi, "/api/office?month=2026-10"),
    await call(sheetApi, `/api/office/timesheet?contract=${CON_A}&month=2026-10`),
    await call(termsApi, `/api/office/terms?contract=${CON_A}`),
    await call(termsApi, "/api/office/terms", { method: "POST", body: { siteContractId: CON_A, validFrom: "2026-10-01", pricingType: "monthly", salesUnitPrice: 1 } }),
  ];
  check(rs.every((r) => r.statusCode === 403), `${label}：Office の API（一覧・勤務表・契約条件の閲覧と登録）を直接呼んでも、すべて 403（${rs.map((r) => r.statusCode).join(",")}）`);
  check(mem.state.log.length === before && (mem.rows.gw_site_contract_terms || []).length === 0, `${label}：何も書かれない`);
}

// ============================================================================================
console.log("\n=== 5. 管理画面（admin-dashboard.html）は残る。入口は ⚙管理。Office の入口でもナビでもなく、「Office」と名乗らない ===");
for (const label of ["経営者（owner）", "管理者＋経理（admin）"]) {
  seed();
  const { page } = await open("/home.html", ROLES[label]);
  await page.waitForSelector("#kp-admin-menu-btn", { timeout: 8000 });
  // アイコンのフォントを読めない環境では、アイコンの文字が重なって隣のボタンが押せないことがあるので、クリックの合図を直接送る
  await page.locator("#kp-admin-menu-btn").dispatchEvent("click");
  check(await page.locator('#kp-admin-menu-panel a[href="admin-dashboard.html"]').count() === 1, `${label}：⚙管理 から管理画面（admin-dashboard.html）を開ける`);
  await Promise.all([page.waitForURL(/admin-dashboard\.html/), page.locator('#kp-admin-menu-panel a[href="admin-dashboard.html"]').dispatchEvent("click")]);
  await page.waitForSelector(".topbar .kp-app", { timeout: 8000 });
  const tag = await page.locator(".topbar .kp-app").innerText();
  check(tag.includes("管理") && !/OFFICE/i.test(tag), `${label}：管理画面のタグは「管理」（いま ${tag.trim()}）`);
  check(await page.locator(".topbar .kp-shortcut.on").count() === 0, `${label}：管理画面では、Office を含む業務ツールは選ばれない`);
  check((await page.locator(".topbar [data-shortcut='office']").getAttribute("href")) === "/office/", `${label}：管理画面からでも、Office は /office/ へ`);
  await page.close();
}
{
  // ⚙管理：経理（経理・事務の管理画面に入れる）には、管理画面の入口だけを出す。責任者（管理画面に入れない）には出さない
  for (const [label, gear] of [["経理（finance）", true], ["責任者（manager）", false]]) {
    seed();
    const { page } = await open("/home.html", ROLES[label]);
    await page.waitForSelector(".topbar [data-shortcut='office']", { timeout: 8000 });
    check(await page.locator("#kp-admin-menu-btn").count() === (gear ? 1 : 0), `${label}：⚙管理（管理画面の入口）は${gear ? "出る" : "出ない"}。Office は出る`);
    if (gear) {
      await page.locator("#kp-admin-menu-btn").click();
      const menu = await page.locator("#kp-admin-menu-panel a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
      check(menu.join() === "admin-dashboard.html", `${label}：⚙管理は管理画面の入口だけ（いま ${menu.join()}）`);
    }
    await page.close();
  }
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
