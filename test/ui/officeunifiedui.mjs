// Office は「役職でアプリを変える」のではなく「同じアプリの中で、権限だけを変える」。実際のブラウザで見る。
//
// ■ 守ること（2026-10-02 の決定 → 2026-10-03 の Office UI/UX 再設計）
//   1. ヘッダーの「Office」を押すと、経営者（owner）でも、管理者（admin）でも、経理（finance）でも、責任者（manager）でも、
//      同じ Office ホーム（/office/）に入る。どの画面から押しても同じ。月次業務はOffice のタブの「月次業務」から
//   2. 全ロールで、Office は同じUI：同じヘッダー・同じOffice のタブの部品・同じ本文の幅・カード・フォント・ボタン・余白・色。
//      違うのは、Office のタブに出る項目（担当）と、見えるデータ・押せる操作だけ。月次業務の一覧は、画面のピクセルまで同じ
//   3. 権限のないメニューだけが出ない：Office に入れない人（営業・一般メンバー）には Office を出さない。
//      人事（人事・労務）・管理者（人事・労務／経理・事務）には Office は出るが、月末月初業務（/office/monthly.html）は出ない
//   4. 月末月初業務の権限のない人が /office/monthly.html を直接開いても、home.html へ戻され、Office の API は1回も呼ばれない
//   5. 旧ダッシュボード（admin-dashboard.html）は Office ホームへ送る。⚙管理はシステム設定だけ（業務の入口を置かない）
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
  // 人事・管理者は Office（人事・労務／経理・事務）に入れるので、ヘッダーに Office は出る。月末月初業務には入れない
  "人事（hr）":                 { appRole: "member", isAdmin: false, roles: ["hr"], who: P(["hr"], { isHr: true }), tools: "hr,office" },
  "営業（sales）":              { appRole: "member", isAdmin: false, roles: ["sales"], who: P(["sales"]), tools: "sales" },
  "会計の管理者だけ（admin）":   { appRole: "admin", isAdmin: true, roles: [], who: P([], { isAdmin: true }), tools: "office,keiei" },
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
console.log("\n=== 1. ヘッダーの「Office」は、役割に関係なく Office ホーム（/office/）へ（どの画面から押しても） ===");
for (const [label, role] of Object.entries(ROLES)) {
  // Office の業務の画面を開ける人（owner・admin）は勤怠管理から、それ以外はホームから押す。どちらの画面からでも同じ
  const starts = role.appRole === "member" ? ["/home.html"] : ["/home.html", "/admin-timecard.html"];
  for (const start of starts) {
    seed();
    const { page } = await open(start, role);
    await page.waitForSelector(".topbar [data-shortcut='office']", { timeout: 8000 });
    const href = await page.locator(".topbar [data-shortcut='office']").getAttribute("href");
    check(href === "/office/", `${label}：${start} の Office → ${href}`);
    await Promise.all([page.waitForURL(/\/office\/?(\?.*)?$/), page.click(".topbar [data-shortcut='office']")]);
    check(new URL(page.url()).pathname === "/office/", `${label}：${start} から Office を押す → /office/（いま ${new URL(page.url()).pathname}）`);
    await page.waitForSelector("#progBox:not([hidden]) #prog .row", { timeout: 8000 });
    check(await page.locator("#cards .oh-card").count() > 0, `${label}：Office ホーム（サマリーカード・月次進捗）が出る`);
    // Office のタブの「月次業務」から、月末月初業務の一覧へ
    // Office のタブ：経理・事務 → 2段目の「月次業務」
    await page.locator('#kp-office-nav .kp-otab[data-cat="office-ops"]').click();
    await page.waitForSelector('#kp-office-nav a.kp-ostab[href="/office/monthly.html"]', { timeout: 8000 });
    await Promise.all([page.waitForURL(/\/office\/monthly\.html/), page.locator('#kp-office-nav a.kp-ostab[href="/office/monthly.html"]').click()]);
    await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
    check((await page.locator("#rows tr[data-id]").count()) === 2, `${label}：月次業務の一覧が出る（2件）`);
    await page.close();
  }
}

// ============================================================================================
console.log("\n=== 2. 全ロールで、Office の基本レイアウトが同一（ヘッダー・ナビ・幅・カード・フォント・ボタン・余白・色） ===");
const sig = {};
const shots = {};
const groupsOf = {};
for (const [label, role] of Object.entries(ROLES)) {
  seed();
  const { page, errs, calls } = await open("/office/monthly.html?month=2026-10", role);
  await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
  await page.waitForTimeout(500);
  sig[label] = await page.evaluate(() => {
    const cs = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, c[p]])); };
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    return {
      bodyClass: document.body.className,
      // 共通の枠：ヘッダー（.topbar）と Office の横タブ（#kp-office-nav）。いま選ばれているのは Office・月次業務。左サイドバーは無い
      chrome: Boolean(document.querySelector(".topbar")) && Boolean(document.querySelector("#kp-office-nav.kp-officenav")) && !document.querySelector(".kp-sidebar"),
      officeOn: Boolean(document.querySelector('.topbar [data-shortcut="office"].on')),
      sideOn: document.querySelector("#kp-office-nav .kp-ostab.on > span")?.textContent.trim(),
      noOwnHeader: !document.querySelector(".of-bar, .of-logo, .of-back") && !document.body.innerText.includes("GWへ戻る"),
      ids: [...document.querySelectorAll("[id]")].map((e) => e.id).filter((i) => !/^kp-|^of-user/.test(i)),
      sections: [...document.querySelectorAll(".of-sec-h, h1")].map((e) => e.textContent.trim().replace(/\s+/g, " ")),
      heads: [...document.querySelectorAll(".of-table thead th")].map((e) => e.textContent.trim()),
      body: cs("body", ["fontFamily", "backgroundColor", "color", "fontSize"]),
      wrap: cs(".wrap", ["maxWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginLeft"]),
      wrapBox: (box(".wrap") || []).slice(0, 3),
      topbar: cs(".topbar", ["height", "backgroundColor", "position"]),
      officeNav: cs("#kp-office-nav", ["backgroundColor", "position"]),
      catOn: cs("#kp-office-nav .kp-otab.on", ["color", "fontWeight", "borderBottomColor"]),
      tabOn: cs("#kp-office-nav .kp-ostab.on", ["color", "backgroundColor", "fontWeight"]),
      title: cs("h1.of-title", ["fontSize", "fontWeight", "color"]),
      card: cs(".of-card", ["backgroundColor", "borderTopColor", "borderRadius", "paddingTop", "fontFamily"]),
      table: cs(".of-table", ["backgroundColor", "borderTopColor"]),
      th: cs(".of-table th", ["fontSize", "color", "backgroundColor", "paddingTop"]),
      btn: cs(".of-btn", ["backgroundColor", "color", "borderRadius", "fontSize", "fontWeight", "paddingTop", "paddingLeft"]),
      cta: cs(".of-btn.cta", ["backgroundColor", "color", "borderRadius", "fontSize"]),
      pill: cs(".of-st", ["fontSize", "borderRadius", "fontWeight"]),
    };
  });
  // 本文の一覧（データが同じなら、役割によらず、描いた結果＝マークアップ・各セルの計算済みスタイル・大きさまで同じ）。
  // Office のタブは担当で項目が変わるので、比べない（スクリーンショットのバイト比較は、スクロール位置の端数で揺れるので使わない）
  shots[label] = await page.locator(".of-table").evaluate((t) => t.outerHTML.replace(/\s+/g, " ") + JSON.stringify([...t.querySelectorAll("th, td, .of-st, .of-btn")].map((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return [c.fontSize, c.color, c.backgroundColor, c.paddingTop, Math.round(r.width), Math.round(r.height)]; })));
  groupsOf[label] = await page.locator("#kp-office-nav .kp-otab > span").allInnerTexts().then((a) => a.map((x) => x.trim()).filter((x) => x !== "ホーム").join("|"));
  check(calls.length > 0 && errs.length === 0, `${label}：Office が表示される（API ${calls.length}回・画面のエラーなし ${errs.join(" | ").slice(0, 120)}）`);
  if (label.startsWith("経営者")) await page.screenshot({ path: shotPath("office-unified-owner.png") });
  if (label.startsWith("経理")) await page.screenshot({ path: shotPath("office-unified-finance.png") });
  await page.close();
}
const base = sig["経営者（owner）"];
check(base && base.chrome && base.officeOn && base.sideOn === "月次業務", `Office 共通の枠（ヘッダーの Office・Office のタブの月次業務が選ばれている。いま ${base?.sideOn}）`);
check(base && base.noOwnHeader, "月次業務の専用ヘッダー・「GWへ戻る」は無い");
// 担当で変わるのは、Office のタブのグループ（項目）だけ
check(groupsOf["経営者（owner）"] === "人事・労務|経理・事務|社内管理", `経営者：Office のタブは全部（いま ${groupsOf["経営者（owner）"]}）`);
check(groupsOf["管理者＋経理（admin）"] === "人事・労務|経理・事務|社内管理", `管理者＋経理：Office のタブは全部（いま ${groupsOf["管理者＋経理（admin）"]}）`);
check(groupsOf["経理（finance）"] === "経理・事務|社内管理", `経理：経理・事務／社内管理（いま ${groupsOf["経理（finance）"]}）`);
check(groupsOf["責任者（manager）"] === "経理・事務", `責任者：経理・事務（月次業務・請求・支払）だけ（いま ${groupsOf["責任者（manager）"]}）`);
for (const [label, s] of Object.entries(sig)) {
  if (label.startsWith("経営者")) continue;
  // 責任者は月次締め・月初作業管理（経理・事務の管理画面）に入れないので、月次業務の帯（タブ）が出ない。そのぶんだけ縦の位置が違う
  const skip = label.startsWith("責任者") ? ["wrapBox"] : [];
  const diff = Object.keys(base).filter((k) => !skip.includes(k) && JSON.stringify(base[k]) !== JSON.stringify(s[k]));
  check(diff.length === 0, `${label} は 経営者と同じレイアウト${diff.length ? `（違い：${diff.join("・")}）` : "（ヘッダー・Office のタブの部品・DOMの骨組み・幅・余白・色・フォント・カード・ボタンが同一）"}`);
}
for (const [label, buf] of Object.entries(shots)) {
  if (label.startsWith("経営者")) continue;
  check(shots["経営者（owner）"] === buf, `${label} は 経営者と、月次業務の一覧の描画（マークアップ・スタイル・大きさ）が同じ（PC幅 1440px）`);
}

// スマホ幅でも同じ（カード表示）
{
  const mob = {};
  for (const label of ["経営者（owner）", "管理者＋経理（admin）", "経理（finance）"]) {
    seed();
    const { page } = await open("/office/monthly.html?month=2026-10", ROLES[label], { width: 390, height: 800 });
    await page.waitForSelector("#rows tr[data-id]", { timeout: 8000 });
    await page.waitForTimeout(500);
    mob[label] = await page.locator(".of-table").evaluate((t) => t.outerHTML.replace(/\s+/g, " ") + JSON.stringify([...t.querySelectorAll("th, td, .of-st, .of-btn")].map((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return [c.fontSize, c.color, c.backgroundColor, c.paddingTop, Math.round(r.width), Math.round(r.height)]; })));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}：スマホ幅で横スクロールが要らない`);
    await page.close();
  }
  check(mob["経営者（owner）"] === mob["経理（finance）"] && mob["経営者（owner）"] === mob["管理者＋経理（admin）"], "スマホ幅（390px）も、経営者・管理者・経理で、月次業務の一覧の描画が同じ");
}

// ============================================================================================
console.log("\n=== 3. 権限のないメニューだけが出ない（ヘッダーのツールは権限のとおり。月末月初業務の権限が無ければ、Office のタブに出さない） ===");
for (const [label, role] of Object.entries(DENIED)) {
  seed();
  const { page, calls } = await open("/home.html", role);
  await page.waitForSelector(".topbar", { timeout: 8000 });
  await page.waitForTimeout(700);
  const keys = (await shortcuts(page)).map((s) => s.key).filter((k) => ["hr", "sales", "office", "keiei"].includes(k));
  check(keys.join(",") === role.tools, `${label}：ほかのツールは権限のとおり（いま "${keys.join(",")}"・期待 "${role.tools}"）`);
  check(calls.length === 0, `${label}：ホームを開いても、Office の API は呼ばれない`);
  await page.close();
}
// Office に入れる人（人事・管理者）でも、月末月初業務（月次業務の中の月末月初業務・請求・支払）は出さない
for (const label of ["人事（hr）", "会計の管理者だけ（admin）"]) {
  seed();
  const { page, calls } = await open("/office/", DENIED[label]);
  await page.waitForSelector("#cards", { timeout: 8000 });
  await page.waitForTimeout(500);
  const hrefs = await page.locator("#kp-office-nav a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check(!hrefs.some((h) => /\/office\/(monthly|billing)\.html/.test(h)), `${label}：Office のタブに月末月初業務・請求・支払は出ない（${hrefs.join(" ")}）`);
  check(!(await page.locator("#progBox").isVisible()), `${label}：Office ホームに月次進捗は出ない`);
  check(calls.length === 0, `${label}：Office ホームを開いても、月末月初業務の API は呼ばれない（${calls.length}回）`);
  await page.close();
}

// ============================================================================================
console.log("\n=== 4. 月末月初業務の権限のない人が /office/monthly.html を直接開いても、home.html へ戻され、Office の API は呼ばれない ===");
for (const [label, role] of Object.entries(DENIED)) {
  seed();
  const { page, calls } = await open("/office/monthly.html?month=2026-10", role);
  await page.waitForURL(/home\.html/, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  check(/home\.html/.test(page.url()), `${label}：/office/monthly.html を直接開くと home.html へ戻される（いま ${new URL(page.url()).pathname}）`);
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
console.log("\n=== 5. 旧ダッシュボードは Office ホームへ。⚙管理はシステム設定だけ ===");
for (const label of ["経営者（owner）", "管理者＋経理（admin）"]) {
  seed();
  const { page } = await open("/admin-dashboard.html", ROLES[label]);
  await page.waitForURL(/\/office\/$/, { timeout: 8000 }).catch(() => {});
  check(new URL(page.url()).pathname === "/office/", `${label}：admin-dashboard.html → /office/（いま ${new URL(page.url()).pathname}）`);
  await page.waitForSelector("#kp-admin-menu-btn", { timeout: 8000 });
  await page.locator("#kp-admin-menu-btn").dispatchEvent("click");
  const menu = await page.locator("#kp-admin-menu-panel a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check(menu.length > 0 && !menu.some((h) => /admin-(dashboard|expenses|closing|month-start|docs|notices|timecard|hr\.html|contracts|career)|\/office\//.test(h)),
    `${label}：⚙管理に業務の入口を置かない（いま ${menu.join(" ")}）`);
  await page.close();
  const st = await open("/admin-settings.html", ROLES[label]);
  await st.page.waitForSelector(".topbar .kp-app", { timeout: 8000 });
  const tag = await st.page.locator(".topbar .kp-app").innerText();
  check(tag.includes("管理") && !/OFFICE/i.test(tag), `${label}：システム設定の画面のタグは「管理」（いま ${tag.trim()}）`);
  check(await st.page.locator(".topbar .kp-shortcut.on").count() === 0, `${label}：システム設定の画面では、Office を含む業務ツールは選ばれない`);
  await st.page.close();
}
{
  // ⚙管理は管理者・経営者だけ。経理・責任者には出さない（業務は Office のOffice のタブから）
  for (const label of ["経理（finance）", "責任者（manager）"]) {
    seed();
    const { page } = await open("/home.html", ROLES[label]);
    await page.waitForSelector(".topbar [data-shortcut='office']", { timeout: 8000 });
    check(await page.locator("#kp-admin-menu-btn").count() === 0, `${label}：⚙管理は出ない。Office は出る`);
    await page.close();
  }
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
