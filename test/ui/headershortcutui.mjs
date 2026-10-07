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
//   ・タブレット幅（721〜1024px。ヘッダーが1行のまま）で、近道が切れない・名前と重ならない
//     （2026-10-07：768px で Office・経営が名前の下で切れていた。メンバー表示・ログアウトはアイコンだけにし、
//       入らないぶんは名前を…で縮める）
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
const accessOf = (w) => serverAccessOf({ isAdmin: Boolean(w.isAdmin), roles: w.roles || [], apps: w.apps });

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
        gw: { employee: { id: "e1", display_name: who.name || "森田", status: "active" },
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
// ヘッダーは「採用HR｜Sales｜Office｜経営（＋⚙管理）」の5つ。Office は1つの名前に1つだけ
// （月次業務は Office の中の機能。ヘッダーに別名で出さない）。
// ⚙管理（area-settings）は管理者（admin/owner）だけのアイコン＋ドロップダウン
const TOOL_KEYS = ["hr", "sales", "office", "keiei"];
const toolsOnly = (sc) => sc.filter((s) => TOOL_KEYS.includes(s.key));
const hrefOf = (sc, k) => sc.find((s) => s.key === k)?.href;

console.log("— owner：採用HR・Sales・Office・経営（＋⚙管理） —");
{
  const page = await open("admin-settings.html", { appRole: "owner", roles: ["owner"] });
  const sc = await shortcuts(page);
  const tools = toolsOnly(sc);
  check(tools.map((s) => s.key).join(",") === "hr,sales,office,keiei", `並び ホーム｜HR｜Sales｜Office｜経営（いま ${tools.map((s) => s.key)}）`);
  check(sc.map((s) => s.key).join(",") === "hr,sales,office,keiei,area-settings",
    `owner はさらに ⚙管理（area-settings）が付く。Officeは1つだけ（いま ${sc.map((s) => s.key)}）`);
  check(hrefOf(sc, "hr") === "/hr/", "採用HR → /hr/");
  check(hrefOf(sc, "sales") === "/sales/", "Sales → /sales/");
  // Office は役割で入口を変えない（2026-10-02）。経営者でも経理でも /office/。管理画面（admin-dashboard.html）へは送らない
  check(hrefOf(sc, "office") === "/office/", "Office（経営者） → /office/（管理画面へは送らない）");
  check(!sc.some((s) => /admin-dashboard/.test(s.href || "")), "ヘッダーの業務ツールのどれも、admin-dashboard.html へ行かない");
  check(sc.find((s) => s.key === "office")?.text.includes("Office"), "PCでは「Office」と出る");
  check(sc.find((s) => s.key === "hr")?.text.includes("採用HR"), "PCでは「採用HR」と出る");
  check(hrefOf(sc, "keiei") === "/keiei/", "経営者の経営 → /keiei/");
  // ⚙管理は直リンクではなくドロップダウン（権限・端末・貸与品・アクセス分析・AIナレッジ・システム設定）
  check(await page.locator("#kp-admin-menu-panel a[href=\"admin-devices.html\"]").count() === 1,
    "⚙管理のドロップダウンに「端末・貸与品」→ admin-devices.html がある");
  check(await page.locator("#kp-admin-menu-panel a[href=\"admin-ai.html\"]").count() === 1, "⚙管理に「AIナレッジ」がある");
  // Office UI/UX 再設計（2026-10-03）：業務（人事・労務／経理・事務／社内管理）は Office の左メニューへ移した。
  // ⚙管理はシステム設定だけ（業務の入口・旧ダッシュボードは置かない）
  const gear = await page.locator("#kp-admin-menu-panel a").evaluateAll((ns) => ns.map((n) => n.getAttribute("href")));
  check(!gear.some((h) => /admin-(dashboard|members\.html$|expenses|closing|month-start|docs|notices|timecard|hr\.html)/.test(h || "")),
    `⚙管理に業務の画面を置かない（いま ${gear.join(" ")}）`);
  check(gear[0] === "admin-members.html#roles", "⚙管理の先頭は「権限」");
  // アイコン（Material Symbols の名前）は文字として読めてしまうので、ラベルの部分だけを見る
  const labels = await page.locator(".topbar [data-shortcut] .kp-sc-long").allInnerTexts();
  check(labels.map((t) => t.trim()).join(" ｜ ") === "採用HR ｜ Sales ｜ Office ｜ 経営", `PCの表示（いま ${labels.join(" ｜ ")}）`);
  check(!labels.some((t) => /月次業務/.test(t)), "ヘッダーに「月次業務」は出ない（Officeの中の機能）");
  check(await page.locator(".topbar .kp-shortcut.btn-secondary").count() === 4, "既存の secondary ボタン（4つ）");
  // システム設定（⚙管理）の画面では、業務ツールのどれも選ばれず、⚙管理が選ばれて見える
  check(await page.locator(".topbar .kp-shortcut.on").count() === 0, "⚙管理の画面では、Office を含む業務ツールは選ばれない");
  check(/\bon\b/.test((await page.locator("#kp-admin-menu-btn").getAttribute("class")) || ""), "⚙管理の画面では ⚙管理 が選ばれて見える");
  check((await page.locator(".topbar .kp-app").innerText()).includes("管理") && !(await page.locator(".topbar .kp-app").innerText()).includes("OFFICE"),
    "⚙管理の画面のタグは「管理」（Office と名乗らない）");
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
  check(!side.some((h) => /(^|\/)keiei\/$/.test(h || "")), "左メニューに「経営」は置かない");

  await page.screenshot({ path: shotPath("header-shortcuts-pc.png") });
  await page.close();
}

console.log("\n— 管理者（admin/owner）：Office は access.office のとおり。入口は役割に関係なく /office/ —");
// Office は役割で入口を変えない（2026-10-02）。出るのは access.office（サーバの canAccessOffice）の人だけで、
// 経営者でも・経理を付けた管理者でも、行き先は /office/。会計の管理者だけ（Office の権限が無い）には、Office を出さない
// （押しても入れない入口を出さない）。管理画面（admin-*.html）へは ⚙管理 から入る。
// 経営アプリ（/keiei）は経営者だけなので、管理者の「経営」はチーム状況（admin-team.html。全員のタスク・日報）から入る。
// 採用HR・Sales は社内権限（access）のとおり
// 2026-10-03 Office UI/UX 再設計：Office は人事・労務（officeHr）／経理・事務（officeFinance）／月末月初業務（office）の
// どれかに入れる人に出す。管理者（isAdmin）は officeHr・officeFinance を持つので、Office が出る（中身は担当の分だけ）
for (const [who, want, wantHref, label] of [
  [{ appRole: "admin", isAdmin: true, roles: [] }, "office,keiei", { office: "/office/", keiei: "admin-team.html" }, "管理者（人事・労務／経理・事務。月末月初業務はなし）"],
  [{ appRole: "admin", isAdmin: true, roles: ["it"] }, "office,keiei", { office: "/office/" }, "IT・管理を付けた管理者"],
  [{ appRole: "admin", isAdmin: true, roles: ["recruiter", "sales"] }, "hr,sales,office,keiei", {}, "採用担当・営業担当を付けた管理者"],
  [{ appRole: "admin", isAdmin: true, roles: ["finance"] }, "office,keiei", { office: "/office/" }, "経理を付けた管理者（役割によらず /office/）"],
  [{ appRole: "admin", isAdmin: true, roles: ["manager"] }, "hr,sales,office,keiei", { office: "/office/" }, "責任者を付けた管理者（/office/）"],
  [{ appRole: "owner", roles: ["owner"] }, "hr,sales,office,keiei", { office: "/office/", keiei: "/keiei/" }, "経営者（/office/）"],
]) {
  const page = await open("admin-settings.html", who);
  const sc = await shortcuts(page);
  check(toolsOnly(sc).map((s) => s.key).join(",") === want, `${label} → ${want}（いま ${toolsOnly(sc).map((s) => s.key)}）`);
  for (const [k, h] of Object.entries(wantHref)) check(hrefOf(sc, k) === h, `${label}: ${k} の行き先は ${h}（いま ${hrefOf(sc, k)}）`);
  await page.close();
}

console.log("\n— 権限に応じて出し分ける（経営は経営者だけ） —");
for (const [roles, want, label] of [
  [["recruiter"], "hr", "採用担当 → 採用HRだけ"],
  [["hr"], "hr,office", "人事 → 採用HR と Office（人事・労務）"],
  [["sales"], "sales", "営業 → Salesだけ"],
  [["owner"], "hr,sales,office,keiei", "経営者 → ホーム｜HR｜Sales｜Office｜経営"],
  [["manager"], "hr,sales,office", "責任者 → 3つとも（経営は出ない）"],
  [["finance"], "office", "経理 → Office だけ（ホーム｜Office）"],
  [[], "", "権限なし → どれも出さない"],
  [["it"], "", "IT・管理だけ → どれも出さない"],
  [["labor_advisor"], "", "社労士 → どれも出さない（共有された手続きだけを見る）"],
  [["recruiter", "sales"], "hr,sales", "採用担当＋営業担当 → HR と Sales"],
  [["hr", "finance"], "hr,office", "人事＋経理 → HR と Office"],
  [["sales", "finance"], "sales,office", "営業担当＋経理 → ホーム｜Sales｜Office"],
  [["hr", "manager", "recruiter", "sales", "finance"], "hr,sales,office", "経営者以外の権限を全部 → 経営は出ない"],
  [["owner", "hr"], "hr,sales,office,keiei", "経営者＋人事 → 経営者として全ツール"],
]) {
  const page = await open("home.html", { appRole: "member", roles });
  const got = toolsOnly(await shortcuts(page)).map((s) => s.key).join(",");
  check(got === want, `${label}（いま "${got}"）`);
  await page.close();
}

console.log("\n— 出た入口は、押して入れるところへ行く（Officeが出たのに403、を作らない） —");
{
  // Office の行き先は、役割に関係なく /office/（月次業務）。管理画面（admin-*.html）へは送らない
  for (const [roles, label] of [[["finance"], "経理"], [["manager"], "責任者"]]) {
    const page = await open("home.html", { appRole: "member", roles });
    const sc = await shortcuts(page);
    check(hrefOf(sc, "office") === "/office/", `${label}（メンバー）の Office → /office/（月次業務）`);
    await page.close();
  }
  // 人事だけの人も、Office（人事・労務）に入れるので Office が出る。行き先は /office/（Office ホーム）
  const hr = await open("home.html", { appRole: "member", roles: ["hr"] });
  check(hrefOf(await shortcuts(hr), "office") === "/office/", "人事（メンバー）の Office → /office/（人事・労務の分だけ見える）");
  await hr.close();
  // ⚙管理はシステム設定だけ（管理者・経営者）。業務の担当（人事・経理）・責任者・営業・採用には出さない
  for (const [roles, label] of [[["finance"], "経理"], [["hr"], "人事"], [["manager"], "責任者"], [["sales"], "営業"], [["recruiter"], "採用担当"]]) {
    const page = await open("home.html", { appRole: "member", roles });
    const sc = await shortcuts(page);
    check(!sc.some((x) => x.key === "area-settings"), `${label}（メンバー）に ⚙管理は出ない（業務は Office から）`);
    await page.close();
  }
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
  check(toolsOnly(await shortcuts(yes)).map((s) => s.key).join(",") === "office", "access.office のときだけ Office");
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
  // 4つのボタン（採用HR / Sales / Office / 経営）で、アプリへ入れるかを決める。内部の役割は「詳細設定」の中だけ
  const MA = await import("../../lib/member-access.js");
  const emp = { id: "e9", display_name: "山田 採用", status: "active", roles: [], user_id: "u9", employee_kind: "proper" };
  let apps = [];
  const refresh = () => Object.assign(emp, MA.accessForMember(emp.roles, "u9", new Map([["u9", false]]), apps));
  refresh();
  const appPosts = [];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: false, roles: [],
        gw: { employee: { id: "e1", display_name: "森田", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
        access: accessOf({ roles: ["owner"] }) });
    }
    if (/\/api\/employees\/apps/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      appPosts.push(b);
      apps = b.grant === false ? apps.filter((a) => a !== b.app) : [...new Set([...apps, b.app])];
      refresh();
      return send({ ok: true, roles: emp.roles, appsState: "table", apps: emp.apps, appLocks: emp.appLocks, access: emp.access, accessMeta: emp.accessMeta });
    }
    if (/\/api\/employees\/roles/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      grants.push(b);
      emp.roles = b.grant === false ? emp.roles.filter((r) => r !== b.role) : [...new Set([...emp.roles, b.role])];
      refresh();
      return send({ ok: true, roles: emp.roles, appsState: "table", apps: emp.apps, appLocks: emp.appLocks, access: emp.access, accessMeta: emp.accessMeta });
    }
    if (/\/api\/employees\b/.test(url)) return send({ employees: [emp], canManage: true, canGrantRoles: true, canGrantOwner: true, appsState: "table" });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(900);
  // 凡例は一覧の上の折りたたみ（「使える業務（4つのボタン）の見かた」）。開いて読む
  await page.locator(".mb-legend summary").click();
  const legend = await page.locator("#role-legend").innerText();
  check(legend.includes("採用HR") && legend.includes("Sales") && legend.includes("Office") && legend.includes("経営"), "凡例：4つのボタン（採用HR・Sales・Office・経営）");
  check(legend.includes("どのアプリへ入れるか"), "凡例：ボタンは「どのアプリへ入れるか」だけ");
  check(legend.includes("Office をONにしただけでは、中の業務は使えません"), "凡例：Office を ON にしただけでは中の業務は使えない");
  check(legend.includes("経営者はすべてのアプリを使えます"), "凡例：経営者は全部使える");
  check(legend.includes("内部の役割を付けただけでは、アプリへは入れません"), "凡例：内部の役割だけでは入れない");
  check(await page.locator('#list tbody input[type="checkbox"]').count() === 0, "一覧に、内部の役割のチェックボックスは出ない");
  // 内部の役割は、詳細設定の中だけ
  await page.locator('[data-role="more"]').first().click();
  const itTitle = await page.locator('input[data-role="it"]').first().evaluate((n) => n.closest("label").title);
  check(/どのアプリにも入れない/.test(itTitle), "詳細設定の中：IT・管理に説明（これだけではどのアプリにも入れない）");
  // ボタン：採用HR を ON → Sales を ON → Sales を OFF
  await page.locator('.mb-tg[data-app="hr"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('.mb-tg[data-app="sales"]').first().click();
  await page.waitForTimeout(400);
  check(appPosts.some((g) => g.app === "hr" && g.grant === true) && appPosts.some((g) => g.app === "sales" && g.grant === true),
    "「採用HR」「Sales」のボタンで、アプリ利用権限が付く");
  await page.locator('.mb-tg[data-app="sales"]').first().click();
  await page.waitForTimeout(400);
  check(appPosts.some((g) => g.app === "sales" && g.grant === false), "もう一度押すと外れる");
  check(accessOf({ roles: emp.roles, apps }).recruit && !accessOf({ roles: emp.roles, apps }).sell,
    "付け外しの結果が、そのままサーバの判定（採用HR ○ / Sales ×）になる");
  // 内部の役割を付けても、入口は変わらない（Sales の担当ラベルを付けても Sales へは入れない）
  await page.locator('input[data-role="sales"]').first().check();
  await page.waitForTimeout(400);
  check(grants.some((g) => g.role === "sales" && g.grant !== false) && !accessOf({ roles: emp.roles, apps }).sell,
    "詳細設定で「営業担当」を付けても、Sales のボタンが OFF のままなら入れない");
  await page.close();
}

console.log("\n— スマホ幅：短縮して、通知・ログアウトを押し出さない —");
// .kp-shortcut（短縮ラベルを持つ、採用HR・Sales・月次業務・経営・Officeの管理画面エリア）だけを見る。
// ⚙管理（#kp-admin-menu-btn）は短縮ラベルを持たないアイコン単体のボタンなので、別で画面内かだけ見る
const shortcutLabels = (page) => page.locator(".topbar .kp-shortcut").evaluateAll((ns) =>
  ns.map((n) => n.innerText.trim()));
for (const [width, path, who, want] of [
  [390, "admin-settings.html", { appRole: "owner", roles: ["owner"] }, "HR/Sales/Office/経営"],
  [360, "admin-settings.html", { appRole: "owner", roles: ["owner"] }, "HR/Sales/Office/経営"],
  [390, "home.html", { appRole: "member", roles: ["manager"] }, "HR/Sales/Office"],
  [360, "home.html", { appRole: "member", roles: ["manager"] }, "HR/Sales/Office"],
  [390, "home.html", { appRole: "member", roles: ["recruiter", "sales"] }, "HR/Sales"],
  [360, "home.html", { appRole: "member", roles: ["finance"] }, "Office"],
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

console.log("\n— タブレット幅（721〜1024px）：近道が切れない・名前と重ならない —");
for (const [width, path, name] of [
  [721, "admin-nippo.html"], [768, "admin-nippo.html"], [820, "admin-nippo.html"], [1024, "admin-nippo.html"],
  [721, "timecard.html"], [768, "timecard.html"], [1024, "timecard.html"],
  [768, "admin-nippo.html", "長谷川 真理子郎"], [768, "timecard.html", "ジョナサン・アレクサンダー・ウィリアムズ"],
]) {
  const page = await open(path, { appRole: "owner", roles: ["owner"], width, name });
  // アイコンフォント（Google Fonts）は、オフラインの環境では読めず、アイコン名が文字で出て幅を取る。
  // 本番と同じ幅（20px の枠。本番の 18px より広め）に置き換えて、配置を確かめる（keieihubui と同じ）
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:20px;height:20px;display:inline-block;flex:none}" });
  await page.waitForTimeout(200);
  const tag = `${width}px ${path}${name ? "（長い名前）" : ""}`;
  const r = await page.evaluate(() => {
    const box = (n) => n.getBoundingClientRect();
    const bar = document.querySelector(".topbar");
    const nav = bar.querySelector(".kp-shortcuts");
    const nm = bar.querySelector(".kp-who-name");
    const links = [...nav.querySelectorAll(".kp-shortcut")];
    const nb = box(nav), mb = box(nm);
    return {
      labels: links.map((a) => a.querySelector(".kp-sc-short").textContent.trim()).join("/"),
      clipped: links.filter((a) => box(a).right > nb.right + 0.5 || box(a).left < nb.left - 0.5).map((a) => a.innerText.trim()),
      scrolled: nav.scrollWidth - nav.clientWidth,
      overName: links.filter((a) => { const b = box(a); return b.right > mb.left + 0.5 && b.left < mb.right - 0.5; }).map((a) => a.innerText.trim()),
      nameTitle: nm.title, nameText: nm.textContent, nameCut: nm.scrollWidth > nm.clientWidth + 0.5,
      height: Math.round(box(bar).height),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      // 読み上げの文字＝アイコン（material-symbols）を除いたボタンの文字
      buttons: [...bar.querySelectorAll(".who > .btn")].map((b) => ({ title: b.title,
        text: [...b.childNodes].filter((n) => !(n.classList && n.classList.contains("material-symbols-outlined"))).map((n) => n.textContent).join("").trim(),
        inView: box(b).left >= 0 && box(b).right <= window.innerWidth, w: Math.round(box(b).width) })),
    };
  });
  check(r.labels === "HR/Sales/Office/経営", `${tag}: 近道は4つ（いま ${r.labels}）`);
  check(!r.clipped.length && r.scrolled <= 1, `${tag}: 近道が切れない（切れている ${r.clipped.join("・") || "なし"}・はみ出し ${r.scrolled}px）`);
  check(!r.overName.length, `${tag}: 近道と名前が重ならない（重なり ${r.overName.join("・") || "なし"}）`);
  check(r.height <= 60, `${tag}: ヘッダーは1行のまま（高さ ${r.height}px）`);
  check(r.overflow <= 0, `${tag}: 横スクロールが出ない（はみ出し ${r.overflow}px）`);
  check(r.buttons.map((b) => b.text).join("/") === "メンバー表示/ログアウト" && r.buttons.every((b) => b.inView && b.title && b.w <= 40),
    `${tag}: メンバー表示・ログアウトはアイコンだけで画面内。title と読み上げの文字は残る（${r.buttons.map((b) => `${b.text}:${b.w}px`).join("・")}）`);
  check(r.nameTitle === r.nameText, `${tag}: 名前の全文は title に残る`);
  if (name && name.length > 12) check(r.nameCut, `${tag}: 入らない名前は…で縮める（近道を削らない）`);
  if (width === 768 && !name) await page.screenshot({ path: shotPath(`header-shortcuts-tablet-${path.replace(".html", "")}.png`), clip: { x: 0, y: 0, width, height: 120 } });
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
