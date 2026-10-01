// ヘッダーの業務ツール切替（採用HR・Sales・Office・経営）を、実際のブラウザで見る（管理画面・メンバー画面とも）。
//
// ■ 何を守りたいのか
//   ・権限のある人にだけ出る（経営者は4つとも、責任者は 採用HR・Sales・Office、採用担当は HR、営業は Sales、経理は Office）
//   ・経営（/keiei/）は経営者だけ。責任者・人事・採用担当・営業・経理・IT・管理者には出さない
//   ・複数の権限があれば、使えるものをすべて出す（人事＋経理 → HR と Office）。並びは HR｜Sales｜Office｜経営
//   ・出し分けは /api/me の access（サーバの canAccessHr / canAccessSales / canAccessOffice / canAccessKeiei）どおり
//   ・一般メンバーの画面でも、権限があれば出る。権限を付けたら、再読込で出る
//   ・メンバー表示で確認中も、実際の権限どおりに出る
//   ・行き先が /hr/ と /sales/ と /office/ と /keiei/
//   ・メンバー表示・通知・ログアウトを壊さない
//   ・狭い画面で「HR」「Sales」「Office」「経営」に縮み、通知・ログアウトを押し出さない
//   ・入口はヘッダーだけ。左メニュー（管理者・メンバーとも）には採用・営業・Office・経営を置かない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

/**
 * @param {string} path
 * @param {{appRole:string, isAdmin?:boolean, roles?:string[], width?:number, memberView?:boolean}} who
 */
// サーバ（lib/gw.js accessOf）そのもの。/api/me の access の代わりに返す
const { accessOf: serverAccessOf } = await import("../../lib/gw.js");
const accessOf = (w) => serverAccessOf({ isAdmin: Boolean(w.isAdmin), roles: w.roles || [] });

async function open(path, who) {
  const page = await br.newPage({
    viewport: { width: who.width || 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript((w) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout");
    localStorage.removeItem("kp_me");
    localStorage.removeItem("kp_nav_open");
    if (w.memberView) localStorage.setItem("kp_view", "member");
    else localStorage.removeItem("kp_view");
  }, who);
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      // who.roles は途中で書き換える（権限を付けたあとの再読込を再現する）
      return send({
        email: "a@b.c", appRole: who.appRole, isAdmin: Boolean(who.isAdmin), roles: [],
        gw: { employee: { id: "e1", display_name: "森田", status: "active" },
              roles: who.roles || [], tenantId: "t1", stage: null },
        ...(who.noAccess ? {} : { access: accessOf(who) }),
      });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 3 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(900);
  return page;
}

const shortcuts = (page) => page.locator(".topbar [data-shortcut]").evaluateAll((ns) =>
  ns.map((n) => ({ key: n.dataset.shortcut, href: n.getAttribute("href"), text: n.innerText.trim() })));
// 業務ツール（採用HR・Sales・月次業務・経営）は社内権限（access）で出し分ける4つ。
// Office（ナビ再設計の管理画面エリア）・⚙管理（area-office・area-settings）は
// appRole（admin/owner）だけで出る別枠で、社内権限の有無に関わらず付く
const TOOL_KEYS = ["hr", "sales", "office", "keiei"];
const toolsOnly = (sc) => sc.filter((s) => TOOL_KEYS.includes(s.key));

console.log("— owner：採用HR・Sales・月次業務・経営の4つ（＋管理者だけのOffice・⚙管理） —");
{
  const page = await open("admin-dashboard.html", { appRole: "owner", roles: ["owner"] });
  const sc = await shortcuts(page);
  const tools = toolsOnly(sc);
  check(tools.map((s) => s.key).join(",") === "hr,sales,office,keiei", `並び ホーム｜HR｜Sales｜月次業務｜経営（いま ${tools.map((s) => s.key)}）`);
  check(sc.map((s) => s.key).join(",") === "hr,sales,office,keiei,area-office,area-settings",
    `owner はさらに Office（area-office）・⚙管理（area-settings）が付く（いま ${sc.map((s) => s.key)}）`);
  check(sc.find((s) => s.key === "hr")?.href === "/hr/", "採用HR → /hr/");
  check(sc.find((s) => s.key === "sales")?.href === "/sales/", "Sales → /sales/");
  check(sc.find((s) => s.key === "office")?.href === "/office/", "月次業務（旧 Office の実体） → /office/");
  check(sc.find((s) => s.key === "office")?.text.includes("月次業務"), "PCでは「月次業務」と出る（旧ラベル「Office」は管理画面側のエリア名に譲った）");
  check(sc.find((s) => s.key === "hr")?.text.includes("採用HR"), "PCでは「採用HR」と出る");
  check(sc.find((s) => s.key === "keiei")?.href === "/keiei/", "経営 → /keiei/");
  check(sc.find((s) => s.key === "area-office")?.href === "admin-dashboard.html", "Office（管理画面エリア） → admin-dashboard.html（Officeのダッシュボード）");
  check(sc.find((s) => s.key === "area-office")?.text.includes("Office"), "PCでは管理画面側のOfficeに「Office」と出る");
  // ⚙管理は直リンクではなくドロップダウン（権限・端末・貸与品・アクセス分析・システム設定への4本リンク）
  check(await page.locator("#kp-admin-menu-panel a[href=\"admin-devices.html\"]").count() === 1,
    "⚙管理のドロップダウンに「端末・貸与品」→ admin-devices.html がある");
  // アイコン（Material Symbols の名前）は文字として読めてしまうので、ラベルの部分だけを見る
  const labels = await page.locator(".topbar [data-shortcut] .kp-sc-long").allInnerTexts();
  check(labels.map((t) => t.trim()).join(" ｜ ") === "採用HR ｜ Sales ｜ 月次業務 ｜ 経営 ｜ Office",
    `PCの表示（いま ${labels.join(" ｜ ")}）`);
  check(await page.locator(".topbar .kp-shortcut.btn-secondary").count() === 5, "既存の secondary ボタン（TOOLS4つ＋Officeの管理画面エリア1つ）");
  // admin-dashboard.html は Office 領域の先頭（全社のダッシュボード）。ここでは Office が選ばれて見える
  check(await page.locator(".topbar .kp-shortcut.on").count() === 1, "Officeのダッシュボードでは Office だけが active");
  check(await page.locator("#kp-admin-menu-btn").isVisible(), "⚙管理のアイコンボタンが出る（フルサイズのボタンにはしない。幅を取りすぎるため）");

  // 既存の3つを壊していない
  check(await page.locator(".topbar button:has-text('メンバー表示')").isVisible(), "メンバー表示ボタン");
  check(await page.locator("#kp-bell-btn").isVisible(), "通知ボタン");
  check((await page.locator("#kp-bell-badge").innerText()).trim() === "3", "通知の件数");
  check(await page.locator(".topbar button:has-text('ログアウト')").isVisible(), "ログアウト");
  await page.click("#kp-bell-btn");
  check(await page.locator("#kp-bell-panel").isVisible(), "通知パネルが開く");

  // ヘッダーの高さを極端に変えない
  const h = await page.locator(".topbar").evaluate((n) => n.getBoundingClientRect().height);
  check(h <= 64, `ヘッダーの高さ ${Math.round(h)}px`);

  // 正式な入口はヘッダー。左メニューには置かない（二重導線にしない）
  const side = await page.locator(".kp-sidebar").evaluate((n) =>
    [...n.querySelectorAll("a")].map((a) => a.getAttribute("href")));
  check(!side.some((h) => /(^|\/)hr\/$/.test(h || "")), "左メニューに「採用」は置かない");
  check(!side.some((h) => /(^|\/)sales\/$/.test(h || "")), "左メニューに「営業」は置かない");
  check(!side.some((h) => /(^|\/)office\/$/.test(h || "")), "左メニューに「Office」は置かない");
  check(!side.some((h) => /(^|\/)keiei\/$/.test(h || "")), "左メニューに「経営」は置かない");

  await page.screenshot({ path: shotPath("header-shortcuts-pc.png") });
  await page.close();
}

console.log("\n— 会計の管理者だけ・IT・管理だけでは、業務ツールは出さない（社内権限が正式な設定元） —");
// admin（会計側の管理者）・owner は appRole だけで Office（管理画面エリア）・⚙管理 が出る
// （admin-members.html 等はもともと roles:["admin","owner"] だけで開ける画面なので一致する）。
// ここで見ているのは、採用HR・Sales・月次業務・経営（社内権限＝access で出し分ける4つ）の方
{
  const page = await open("admin-dashboard.html", { appRole: "admin", isAdmin: true, roles: [] });
  const sc = await shortcuts(page);
  check(toolsOnly(sc).length === 0, "会計の管理者だけ（社内権限なし）には業務ツールを出さない");
  check(sc.map((s) => s.key).join(",") === "area-office,area-settings",
    "会計の管理者には Office（管理画面エリア）・⚙管理は appRole だけで出る");
  await page.close();
  const it = await open("admin-dashboard.html", { appRole: "admin", isAdmin: true, roles: ["it"] });
  check(toolsOnly(await shortcuts(it)).length === 0, "IT・管理だけには業務ツールを出さない");
  await it.close();
  const both = await open("admin-dashboard.html", { appRole: "admin", isAdmin: true, roles: ["recruiter", "sales"] });
  check(toolsOnly(await shortcuts(both)).map((s) => s.key).join(",") === "hr,sales", "採用担当・営業担当を付けた管理者には HR と Sales（月次業務・経営は出さない）");
  await both.close();
  const fin = await open("admin-dashboard.html", { appRole: "admin", isAdmin: true, roles: ["finance"] });
  check(toolsOnly(await shortcuts(fin)).map((s) => s.key).join(",") === "office", "経理を付けた管理者には月次業務だけ（管理者の権限では出さない）");
  await fin.close();
}

console.log("\n— 権限に応じて出し分ける（経営は経営者だけ） —");
for (const [roles, want, label] of [
  [["recruiter"], "hr", "採用担当 → 採用HRだけ"],
  [["hr"], "hr", "人事 → 採用HRだけ"],
  [["sales"], "sales", "営業 → Salesだけ"],
  [["owner"], "hr,sales,office,keiei", "経営者 → ホーム｜HR｜Sales｜Office｜経営"],
  [["manager"], "hr,sales,office", "責任者 → 3つとも（経営は出ない）"],
  [["finance"], "office", "経理 → Office だけ（ホーム｜Office）"],
  [[], "", "権限なし → どれも出さない"],
  [["it"], "", "IT・管理だけ → どれも出さない"],
  [["labor_advisor"], "", "社労士 → どれも出さない（共有された手続きだけを見る）"],
  [["recruiter", "sales"], "hr,sales", "採用担当＋営業担当 → HR と Sales"],
  [["hr", "finance"], "hr,office", "人事＋経理 → ホーム｜HR｜Office"],
  [["sales", "finance"], "sales,office", "営業担当＋経理 → ホーム｜Sales｜Office"],
  [["hr", "manager", "recruiter", "sales", "finance"], "hr,sales,office", "経営者以外の権限を全部 → 経営は出ない"],
  [["owner", "hr"], "hr,sales,office,keiei", "経営者＋人事 → 経営者として全ツール"],
]) {
  const page = await open("home.html", { appRole: "member", roles });
  const got = (await shortcuts(page)).map((s) => s.key).join(",");
  check(got === want, `${label}（いま "${got}"）`);
  await page.close();
}

console.log("\n— サーバの access どおりに出す（役割名ではなく判定結果で） —");
{
  // 役割が何であっても、サーバが「入れない」と言えば出さない（逆も同じ）
  const page = await open("home.html", { appRole: "member", roles: ["sales"], noAccess: false });
  check((await shortcuts(page)).map((s) => s.key).join(",") === "sales", "access.sell のときだけ Sales");
  await page.close();
  // 前の版の /api/me（access 無し）を覚えていても、採用HR・Sales は同じ基準で出す
  const old = await open("home.html", { appRole: "member", roles: ["recruiter"], noAccess: true });
  check((await shortcuts(old)).map((s) => s.key).join(",") === "hr", "access が無い古い応答でも、採用HR は同じ基準");
  await old.close();
  const mgr = await open("home.html", { appRole: "member", roles: ["manager"], noAccess: true });
  check((await shortcuts(mgr)).map((s) => s.key).join(",") === "hr,sales", "access が無い古い応答でも、責任者は HR と Sales（旧仕様の並びに戻らない）");
  await mgr.close();
  // Office は金額を扱うので、access が無いときは出さない（入れない側に倒す）
  const oldOffice = await open("home.html", { appRole: "member", roles: ["finance", "owner"], noAccess: true });
  check(!(await shortcuts(oldOffice)).some((s) => s.key === "office"), "access が無い古い応答では、Office は出さない");
  await oldOffice.close();
  // 経営は経営者だけ。access が無い古い応答でも、owner を持たない人には出さない
  const oldKeiei = await open("home.html", { appRole: "member", roles: ["manager", "hr", "finance"], noAccess: true });
  check(!(await shortcuts(oldKeiei)).some((s) => s.key === "keiei"), "access が無い古い応答でも、経営は経営者だけ");
  await oldKeiei.close();
  // サーバが「Office に入れる」と言ったときだけ出す
  const yes = await open("home.html", { appRole: "member", roles: ["finance"], noAccess: false });
  check((await shortcuts(yes)).map((s) => s.key).join(",") === "office", "access.office のときだけ Office");
  await yes.close();
}

console.log("\n— 一般メンバーの画面：並びと、既存の氏名・通知・ログアウト —");
{
  const page = await open("home.html", { appRole: "member", roles: ["manager"] });
  const order = await page.locator(".topbar").evaluate((bar) => {
    const pick = (el) => {
      if (el.matches?.(".brand")) return "エイト";
      if (el.dataset?.shortcut) return { hr: "採用HR", sales: "Sales", office: "Office", keiei: "経営" }[el.dataset.shortcut];
      if (el.classList?.contains("kp-who-name")) return "氏名";
      if (el.id === "kp-bell-btn") return "通知";
      if (el.tagName === "BUTTON" && /ログアウト/.test(el.textContent)) return "ログアウト";
      return null;
    };
    return [...bar.querySelectorAll(".brand, [data-shortcut], .kp-who-name, #kp-bell-btn, button")]
      .map(pick).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  });
  check(order.join(" | ") === "エイト | 採用HR | Sales | Office | 氏名 | 通知 | ログアウト",
    `PC の並び（いま ${order.join(" | ")}）`);
  const side = await page.locator(".kp-sidebar").innerText().catch(() => "");
  check(!/採用|営業|Sales|Office/.test(side), "メンバーの左メニューには追加しない");
  await page.screenshot({ path: shotPath("header-shortcuts-member.png") });
  await page.close();
}

console.log("\n— 権限を付けたら、再ログインなしで再読込後に出る —");
{
  const who = { appRole: "member", roles: [] };
  const page = await open("home.html", who);
  check((await shortcuts(page)).length === 0, "付ける前は出ない");
  // メンバー管理で「採用担当」「営業担当」を付けた（gw_role_grants に入った）
  who.roles = ["recruiter", "sales"];
  await page.reload();
  await page.waitForTimeout(900);
  check((await shortcuts(page)).map((s) => s.key).join(",") === "hr,sales", "再読込で 採用HR・Sales が出る");
  // 外したら、再読込で消える
  who.roles = [];
  await page.reload();
  await page.waitForTimeout(900);
  check((await shortcuts(page)).length === 0, "外したら再読込で消える");
  await page.close();
}

console.log("\n— メンバー表示で確認中も、実際の権限どおりに出る —");
{
  const page = await open("home.html", { appRole: "owner", roles: ["owner"], memberView: true });
  check((await shortcuts(page)).map((s) => s.key).join(",") === "hr,sales,office,keiei",
    "メンバー表示中も、同じ権限のメンバーと同じく切替が出る（経営者は経営も）");
  check(await page.locator(".topbar button:has-text('管理画面に戻る')").isVisible(), "管理画面に戻る");
  await page.close();
}

console.log("\n— メンバー管理の社内権限チェックが、採用HR・Sales の設定元 —");
{
  const page = await br.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me");
  });
  const grants = [];
  const emp = { id: "e9", display_name: "山田 採用", status: "active", roles: [], user_id: "u9" };
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: false, roles: [],
        gw: { employee: { id: "e1", display_name: "森田", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
        access: accessOf({ roles: ["owner"] }) });
    }
    if (/\/api\/employees\/roles/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      grants.push(b);
      emp.roles = b.grant === false ? emp.roles.filter((r) => r !== b.role) : [...new Set([...emp.roles, b.role])];
      return send({ ok: true });
    }
    if (/\/api\/employees\b/.test(url)) return send({ employees: [emp], canManage: true, canGrantRoles: true });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(900);
  const legend = await page.locator("#role-legend").innerText();
  check(legend.includes("採用HR") && legend.includes("経営者・責任者・人事・採用担当"), "凡例：採用HR＝経営者・責任者・人事・採用担当");
  check(legend.includes("Sales") && legend.includes("経営者・責任者・営業担当"), "凡例：Sales＝経営者・責任者・営業担当");
  check(legend.includes("Office") && legend.includes("経営者・責任者・経理"), "凡例：Office＝経営者・責任者・経理");
  check(legend.includes("経営") && legend.includes("経営者だけ"), "凡例：経営＝経営者だけ");
  check(legend.includes("IT・管理") && legend.includes("入れません"), "凡例：IT・管理だけでは入れない");
  const itTitle = await page.locator('input[data-role="it"]').first().evaluate((n) => n.closest("label").title);
  check(/どのツールにも入れない/.test(itTitle), "IT・管理のチェックに説明");
  await page.locator('input[data-role="recruiter"]').first().check();
  await page.waitForTimeout(300);
  await page.locator('input[data-role="sales"]').first().check();
  await page.waitForTimeout(300);
  check(grants.some((g) => g.role === "recruiter" && g.grant !== false) && grants.some((g) => g.role === "sales" && g.grant !== false),
    "「採用担当」「営業担当」のチェックで社内権限が付く");
  await page.locator('input[data-role="sales"]').first().uncheck();
  await page.waitForTimeout(300);
  check(grants.some((g) => g.role === "sales" && g.grant === false), "チェックを外すと社内権限が外れる");
  check(accessOf({ roles: emp.roles }).recruit && !accessOf({ roles: emp.roles }).sell,
    "付け外しの結果が、そのままサーバの判定（採用HR ○ / Sales ×）になる");
  await page.close();
}

console.log("\n— スマホ幅：短縮して、通知・ログアウトを押し出さない —");
// .kp-shortcut（短縮ラベルを持つ、採用HR・Sales・月次業務・経営・Officeの管理画面エリア）だけを見る。
// ⚙管理（#kp-admin-menu-btn）は短縮ラベルを持たないアイコン単体のボタンなので、別で画面内かだけ見る
const shortcutLabels = (page) => page.locator(".topbar .kp-shortcut").evaluateAll((ns) =>
  ns.map((n) => n.innerText.trim()));
for (const [width, path, who, want] of [
  [390, "admin-dashboard.html", { appRole: "owner", roles: ["owner"] }, "HR/Sales/月次/経営/Office"],
  [360, "admin-dashboard.html", { appRole: "owner", roles: ["owner"] }, "HR/Sales/月次/経営/Office"],
  [390, "home.html", { appRole: "member", roles: ["manager"] }, "HR/Sales/月次"],
  [360, "home.html", { appRole: "member", roles: ["manager"] }, "HR/Sales/月次"],
  [390, "home.html", { appRole: "member", roles: ["recruiter", "sales"] }, "HR/Sales"],
  [360, "home.html", { appRole: "member", roles: ["finance"] }, "月次"],
]) {
  const page = await open(path, { ...who, width });
  const got = await shortcutLabels(page);
  check(got.join("/") === want, `${width}px:「${want}」に縮む（いま ${got.join("/")}）`);
  const inView = async (sel) => page.locator(sel).evaluate((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= window.innerWidth;
  });
  check(await inView("#kp-bell-btn"), `${width}px ${path}: 通知が画面内`);
  if (who.appRole === "owner") check(await inView("#kp-admin-menu-btn"), `${width}px ${path}: ⚙管理が画面内`);
  check(await inView(".topbar .kp-who-name"), `${width}px ${path}: 氏名が画面内`);
  check(await inView(".topbar button:has-text('ログアウト')"), `${width}px: ログアウトが画面内`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${width}px: 横スクロールが出ない（はみ出し ${overflow}px）`);
  if (width === 390) await page.screenshot({ path: shotPath(`header-shortcuts-sp-${path.replace(".html", "")}.png`) });
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
