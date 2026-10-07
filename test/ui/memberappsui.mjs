// メンバー管理（admin-members.html）の「使える業務」：採用HR / Sales / Office / 経営 の4つのボタンだけ。
//
// ■ 何を守りたいのか
//   ・各社員の行に出る権限は、4つのボタンだけ（採用HR / Sales / Office / 経営）。ON＝青・OFF＝白
//   ・Office が ON の人だけ、その下に Office の中の業務 3つ（人事・労務／経理・事務／月末月初 → hr／finance／manager）
//   ・IT・管理・社労士・採用担当・営業担当は「高度な権限設定」の中だけ（ふだんは閉じている）。経営者は「経営」のボタン
//   ・押すとすぐ保存される。保存中は同じボタンを押せない（二重クリックしても1回だけ送る）
//   ・成功したら、サーバの応答でその場の同じ行を直す（名簿は取り直さない）。失敗したら元に戻して、エラーを出す
//   ・経営者は4つとも ON で変えられない。会計の管理者は Office が ON で変えられない（理由が出る）
//   ・経営のボタンは、経営者だけが押せる
//   ・アプリ利用権限の表（db/119）が未適用・読めないときは、ボタンを変更できない状態にして、理由を出す
//   ・基本区分（在籍の段階）のプルダウンは、使える業務とは別と分かる名前
//   ・スマホ幅（390px）でも、4つのボタンが押せる・横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// 画面が見せる値の「正解」は、サーバ（lib/member-access.js・lib/gw.js）。ブラウザ側の画面は、これを計算しない
const GW = await import("../../lib/gw.js");
const MA = await import("../../lib/member-access.js");

const OWNER_ME = { email: "own@8grp.co.jp", appRole: "owner", isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "e-own", display_name: "経営 太郎", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
  access: GW.accessOf({ isAdmin: false, isHr: true, roles: ["owner"] }) };

const base = (id, name, roles, apps, isAdmin = false, extra = {}) => ({ id, display_name: name, email: `${id}@8grp.co.jp`, user_id: `u-${id}`,
  department: "開発", employment_type: "正社員", status: "active", employee_kind: "proper", partner_company_id: null,
  roles, accounts: {}, ...MA.accessForMember(roles, `u-${id}`, new Map([[`u-${id}`, isAdmin]]), apps), ...extra });
const EMPLOYEES = () => [
  base("e-own", "経営 太郎", ["owner"], []),
  base("e-hr", "人事 花子", ["hr"], ["hr", "office"]),
  base("e-fin", "経理 一郎", ["finance"], ["office"]),
  base("e-mgr", "責任 二郎", ["manager"], ["hr", "sales", "office"]),
  base("e-sales", "営業 三郎", ["sales"], ["sales"]),
  base("e-none", "一般 七郎", [], []),
  base("e-adm", "管理 六郎", [], [], true),
];
const OFF = { hr: false, sales: false, office: false, keiei: false };

async function open({ employees = EMPLOYEES(), width = 1500, appsState = "table", canGrantOwner = true, delay = 0, failApp = false, noApps = false } = {}) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const calls = { employeesGet: 0, appPosts: [], rolePosts: [] };
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "own@8grp.co.jp" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open"]) localStorage.removeItem(k);
  });
  page.on("dialog", (d) => d.accept());
  const after = (e) => {
    const isAdmin = e.accessMeta?.accountingAdmin === true;
    const apps = e.__apps;
    return { roles: e.roles, appsState, ...MA.accessForMember(e.roles, e.user_id, new Map([[e.user_id, isAdmin]]), apps) };
  };
  employees.forEach((e) => { e.__apps = Object.keys(e.apps).filter((k) => e.apps[k] && k !== "keiei" && !e.appLocks?.[k]); });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/employees\/apps/.test(url)) {
      const body = JSON.parse(req.postData() || "{}");
      calls.appPosts.push(body);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (failApp) return send({ error: "forbidden", hint: "変更できません" }, 403);
      const e = employees.find((x) => x.id === body.employeeId);
      if (body.app === "keiei") {
        const roles = new Set(e.roles); if (body.grant) roles.add("owner"); else roles.delete("owner"); e.roles = [...roles];
      } else {
        const s = new Set(e.__apps); if (body.grant) s.add(body.app); else s.delete(body.app); e.__apps = [...s];
      }
      const out = after(e);
      Object.assign(e, { apps: out.apps, appLocks: out.appLocks, access: out.access, accessMeta: out.accessMeta });
      if (noApps) return send({ ok: true });
      return send({ ok: true, employeeId: e.id, app: body.app, granted: Boolean(body.grant), ...out });
    }
    if (/\/api\/employees\/roles/.test(url)) {
      const body = JSON.parse(req.postData() || "{}");
      calls.rolePosts.push(body);
      const e = employees.find((x) => x.id === body.employeeId);
      const roles = new Set(e.roles); if (body.grant) roles.add(body.role); else roles.delete(body.role); e.roles = [...roles];
      const out = after(e);
      Object.assign(e, { apps: out.apps, appLocks: out.appLocks, access: out.access, accessMeta: out.accessMeta });
      return send({ ok: true, employeeId: e.id, role: body.role, granted: Boolean(body.grant), ...out });
    }
    if (/\/api\/employees\b/.test(url) && req.method() === "GET") {
      calls.employeesGet++;
      return send({ employees: employees.map(({ __apps, ...e }) => e), canManage: true, canGrantRoles: true, canGrantOwner, appsState, systems: {}, kindReady: true });
    }
    if (/\/api\/partners\b/.test(url)) return send({ companies: [], canManage: true });
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1300);
  page.calls = calls; page.employees = employees;
  return page;
}
const row = (page, id) => page.locator(`#list tr[data-employee="${id}"]`);
const btn = (page, id, app) => row(page, id).locator(`.mb-tg[data-app="${app}"]`);
const pressed = async (page, id) => Object.fromEntries(await row(page, id).locator(".mb-tg").evaluateAll((ns) => ns.map((n) => [n.dataset.app, n.getAttribute("aria-pressed") === "true"])));
const toast = (page) => page.locator("#mb-toast").innerText().catch(() => "");

console.log("— 一覧に出るのは、4つのボタンだけ —");
{
  const page = await open();
  const ths = (await page.locator("#list thead th").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
  check(ths.includes("使える業務") && ths.includes("基本区分") && !ths.includes("社内権限") && !ths.includes("状態"), `列: 基本区分／使える業務（いま ${ths.join("｜")}）`);
  for (const id of ["e-own", "e-hr", "e-fin", "e-mgr", "e-sales", "e-none", "e-adm"]) {
    const labels = await row(page, id).locator(".mb-tg").allInnerTexts();
    check(labels.join(",") === "採用HR,Sales,Office,経営", `${id}: ボタンは 採用HR / Sales / Office / 経営 の4つだけ（いま ${labels.join(",")}）`);
  }
  check(await page.locator('#list tbody input[type="checkbox"]').count() === 0, "一覧にチェックボックスは1つも無い（内部の役割は、詳細設定を開いたときだけ）");
  // 「変えられない理由」の注記（経営者・会計の管理者の行）は、内部の役割を選ぶものではないので除く
  const listText = await page.locator("#list tbody").evaluate((n) => { const c = n.cloneNode(true); c.querySelectorAll(".mb-lockmsg").forEach((x) => x.remove()); return c.innerText; });
  check(!/経営者|IT・管理|責任者|社労士|採用担当|営業担当/.test(listText.replace(/経営 太郎|責任 二郎|営業 三郎/g, "")), "一覧に、経営者・IT・管理・責任者・社労士・採用担当・営業担当（内部の役割）の名前が出ない");
  // 人事・労務／経理・事務／月末月初は、Office が ON の人の「Office の中」だけに出る（2026-10-07）
  const outside = await page.locator("#list tbody").evaluate((n) => { const c = n.cloneNode(true); c.querySelectorAll(".mb-lockmsg, [data-role=\"office-work\"]").forEach((x) => x.remove()); return c.innerText; });
  check(!/人事・労務|経理・事務|月末月初/.test(outside), "人事・労務／経理・事務／月末月初は、Office の中のスイッチ以外に出ない");
  const hr = await pressed(page, "e-hr");
  check(JSON.stringify(hr) === JSON.stringify({ hr: true, sales: false, office: true, keiei: false }), `人事（hr）: 採用HR ON・Sales OFF・Office ON・経営 OFF（サーバの値のまま。いま ${JSON.stringify(hr)}）`);
  check(JSON.stringify(await pressed(page, "e-none")) === JSON.stringify(OFF), "権限なし: 4つとも OFF");
  check(JSON.stringify(await pressed(page, "e-own")) === JSON.stringify({ hr: true, sales: true, office: true, keiei: true }), "経営者: 4つとも ON");
  const css = async (id, app) => btn(page, id, app).evaluate((n) => { const s = getComputedStyle(n); return [s.backgroundColor, s.color]; });
  const on = await css("e-hr", "hr"), off = await css("e-hr", "sales");
  check(on[0] === "rgb(37, 99, 235)" && on[1] === "rgb(255, 255, 255)", `ON は青（${on[0]}）`);
  check(off[0] === "rgb(255, 255, 255)", `OFF は白（${off[0]}）`);
  check(await page.locator("#list tbody tr.mb-detail").count() === 0, "詳細設定は、初めは閉じている");
  await page.screenshot({ path: shotPath("members-apps-pc.png") });
  await page.close();
}

console.log("\n— 押すとすぐ保存・保存中は押せない・成功したらその場で反映 —");
{
  const page = await open({ delay: 700 });
  const get0 = page.calls.employeesGet;
  await btn(page, "e-none", "sales").click();
  check(await btn(page, "e-none", "sales").getAttribute("aria-pressed") === "true", "押した瞬間に ON（青）になる");
  check(await btn(page, "e-none", "sales").isDisabled(), "保存中は同じボタンを押せない（無効）");
  check(await btn(page, "e-none", "sales").evaluate((n) => n.classList.contains("busy")), "保存中の表示が出る");
  await btn(page, "e-none", "sales").click({ force: true }).catch(() => {});
  await page.waitForTimeout(1100);
  check(page.calls.appPosts.length === 1, `二重に押しても、送るのは1回だけ（いま ${page.calls.appPosts.length} 回）`);
  check(JSON.stringify(page.calls.appPosts[0]) === JSON.stringify({ employeeId: "e-none", app: "sales", grant: true }), `送った内容 ${JSON.stringify(page.calls.appPosts[0])}`);
  check(!(await btn(page, "e-none", "sales").isDisabled()) && await btn(page, "e-none", "sales").getAttribute("aria-pressed") === "true", "成功したら ON のまま・また押せる");
  check(page.calls.employeesGet === get0, "名簿は取り直さない（同じ行をその場で直す）");
  check((await toast(page)).includes("一般 七郎 の Sales を ON にしました"), `成功メッセージ（${await toast(page)}）`);
  // 同じ行の別のボタンは、保存中でも押せる（ボタンごとに止める）
  await btn(page, "e-none", "hr").click();
  await btn(page, "e-none", "office").click();
  await page.waitForTimeout(1200);
  check(page.calls.appPosts.length === 3, "別のボタンは、それぞれ送れる");
  check(JSON.stringify(await pressed(page, "e-none")) === JSON.stringify({ hr: true, sales: true, office: true, keiei: false }), "3つとも ON");
  await btn(page, "e-none", "sales").click();
  await page.waitForTimeout(1000);
  check(await btn(page, "e-none", "sales").getAttribute("aria-pressed") === "false" && JSON.stringify(page.calls.appPosts.at(-1)) === JSON.stringify({ employeeId: "e-none", app: "sales", grant: false }), "もう一度押すと OFF（grant:false）");
  await page.close();
}

console.log("\n— 失敗したら元に戻して、エラーを出す —");
{
  const page = await open({ failApp: true });
  await btn(page, "e-hr", "sales").click();
  await page.waitForTimeout(500);
  check(await btn(page, "e-hr", "sales").getAttribute("aria-pressed") === "false", "失敗したら、OFF に戻る");
  check(!(await btn(page, "e-hr", "sales").isDisabled()), "戻ったあとは、また押せる");
  check((await toast(page)).includes("変えられませんでした") && (await toast(page)).includes("変更できません"), `エラー表示（${await toast(page)}）`);
  await btn(page, "e-hr", "hr").click();   // ON → 失敗 → ON のまま
  await page.waitForTimeout(500);
  check(await btn(page, "e-hr", "hr").getAttribute("aria-pressed") === "true", "ON のものを外そうとして失敗したら、ON に戻る");
  await page.close();
}

console.log("\n— 応答に新しい値が無いときは、名簿を読み直す —");
{
  const page = await open({ noApps: true });
  const get0 = page.calls.employeesGet;
  await btn(page, "e-none", "hr").click();
  await page.waitForTimeout(700);
  check(page.calls.employeesGet === get0 + 1, "名簿を読み直す");
  await page.close();
}

console.log("\n— 変えられない行（経営者・会計の管理者）と、経営のボタン —");
{
  const page = await open();
  for (const app of ["hr", "sales", "office", "keiei"]) {
    check(await btn(page, "e-own", app).isDisabled() && await btn(page, "e-own", app).evaluate((n) => n.classList.contains("locked")), `経営者の ${app}: ON のまま変えられない`);
  }
  check((await row(page, "e-own").locator('[data-note="owner"]').innerText()).includes("すべてのアプリを使えます"), "経営者の理由が出る");
  check(await btn(page, "e-adm", "office").isDisabled() && await btn(page, "e-adm", "office").getAttribute("aria-pressed") === "true", "会計の管理者: Office は ON で変えられない");
  check((await row(page, "e-adm").locator('[data-note="accounting-admin"]').innerText()).includes("会計の管理者"), "会計の管理者の理由が出る（accessMeta.accountingAdmin から）");
  check(await btn(page, "e-adm", "hr").isDisabled() === false && await btn(page, "e-adm", "sales").isDisabled() === false, "会計の管理者でも、ほかのボタンは変えられる");
  check(await row(page, "e-hr").locator("[data-note]").count() === 0, "ふつうの行に注記は出ない");
  // 経営のボタン（経営者が押す）＝ owner の付け外し
  await btn(page, "e-none", "keiei").click();
  await page.waitForTimeout(600);
  check(JSON.stringify(page.calls.appPosts.at(-1)) === JSON.stringify({ employeeId: "e-none", app: "keiei", grant: true }), "経営のボタンは app: keiei で送る");
  check(JSON.stringify(await pressed(page, "e-none")) === JSON.stringify({ hr: true, sales: true, office: true, keiei: true }), "経営を ON にすると、4つとも ON（経営者は全部使える）");
  check(await btn(page, "e-none", "keiei").isDisabled(), "ON にした直後から、その行は経営者として固定される");
  await page.close();

  const p2 = await open({ canGrantOwner: false });
  check(await btn(p2, "e-none", "keiei").isDisabled() && (await btn(p2, "e-none", "keiei").getAttribute("title")).includes("経営者だけ"), "経営者でない人には、経営のボタンは押せない（理由つき）");
  check(!(await btn(p2, "e-none", "sales").isDisabled()), "ほかのボタンは押せる");
  await p2.close();
}

console.log("\n— 高度な権限設定：特殊な役割だけ（ふだんは閉じている）—");
{
  const page = await open();
  check((await row(page, "e-hr").locator('[data-role="more"]').innerText()).trim() === "高度な権限設定", "ボタンの名前は「高度な権限設定」");
  await row(page, "e-hr").locator('[data-role="more"]').click();
  const detail = page.locator('tr.mb-detail[data-detail="e-hr"]');
  check(await detail.count() === 1, "その行の下に開く");
  const labels = (await detail.locator("label").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  check(labels.join("／") === "経営者／IT・管理／社労士／採用担当／営業担当", `経営者・IT・管理・社労士・採用担当・営業担当の5つだけ（いま ${labels.join("／")}）`);
  check(await detail.locator('input[data-role="hr"], input[data-role="finance"], input[data-role="manager"]').count() === 0, "人事・経理・責任者は、ここに出さない（Office の中のスイッチと重複させない）");
  const txt = await detail.innerText();
  check(txt.includes("付け外しは経営者だけ") && txt.includes("採用HR・Sales に入れるかは、上のボタン"), "経営者は経営者だけが付け外し、採用担当・営業担当はボタンと別の名札、と書いてある");
  check(await row(page, "e-hr").locator('[data-role="more"]').getAttribute("aria-expanded") === "true", "aria-expanded が開いた状態");
  const get0 = page.calls.employeesGet;
  await detail.locator('input[data-role="recruiter"]').check();
  await page.waitForTimeout(500);
  check(JSON.stringify(page.calls.rolePosts.at(-1)) === JSON.stringify({ employeeId: "e-hr", role: "recruiter", grant: true }), "チェックは /api/employees/roles へ送る");
  check(JSON.stringify(await pressed(page, "e-hr")) === JSON.stringify({ hr: true, sales: false, office: true, keiei: false }), "役割を付けても、4つのボタンは変わらない");
  check(page.calls.employeesGet === get0, "名簿は取り直さない");
  check(await page.locator('tr.mb-detail[data-detail="e-hr"]').count() === 1, "付け外しのあとも開いたまま");
  await row(page, "e-hr").locator('[data-role="more"]').click();
  check(await page.locator("tr.mb-detail").count() === 0, "もう一度押すと閉じる");
  await page.close();
}

console.log("\n— Office の中の業務：Office が ON の人だけ、3つのスイッチ —");
{
  const page = await open();
  const subs = (id) => row(page, id).locator('[data-role="office-work"] .mb-sub');
  const work = async (id) => Object.fromEntries(await subs(id).evaluateAll((ns) => ns.map((n) => [n.dataset.work, n.getAttribute("aria-pressed") === "true"])));
  check((await subs("e-hr").allInnerTexts()).map((t) => t.replace("✓", "").trim()).join("/") === "人事・労務/経理・事務/月末月初", "人事・労務／経理・事務／月末月初");
  check(await subs("e-sales").count() === 0 && await subs("e-none").count() === 0, "Office が OFF の人には出さない");
  check(JSON.stringify(await work("e-hr")) === JSON.stringify({ hr: true, finance: false, month: false }), "人事（hr）→ 人事・労務だけ ON");
  check(JSON.stringify(await work("e-fin")) === JSON.stringify({ hr: false, finance: true, month: true }), "経理（finance）→ 経理・事務と月末月初が ON");
  check(await row(page, "e-fin").locator('.mb-sub[data-work="month"]').isDisabled() && (await row(page, "e-fin").locator('[data-note="office-via"]').innerText()).includes("経理・事務に含まれ"), "経理で使えている月末月初は押せず、理由が出る");
  check(JSON.stringify(await work("e-mgr")) === JSON.stringify({ hr: false, finance: false, month: true }), "責任者（manager）→ 月末月初が ON");
  check(JSON.stringify(await work("e-own")) === JSON.stringify({ hr: true, finance: true, month: true }) && (await row(page, "e-own").locator('[data-note="office-via"]').innerText()).trim() === "経営者として、3つとも使えます", "経営者 → 3つとも ON（「経営者として、3つとも使えます」）");
  // 押すと、内部ロールを付け外しする（DB・API はこれまでどおり）
  await row(page, "e-hr").locator('.mb-sub[data-work="finance"]').click();
  await page.waitForTimeout(500);
  check(JSON.stringify(page.calls.rolePosts.at(-1)) === JSON.stringify({ employeeId: "e-hr", role: "finance", grant: true }), "経理・事務 → finance を付ける");
  check(JSON.stringify(await work("e-hr")) === JSON.stringify({ hr: true, finance: true, month: true }), "サーバの判定で出し直す（経理を付けたので月末月初も ON）");
  await row(page, "e-hr").locator('.mb-sub[data-work="hr"]').click();
  await page.waitForTimeout(500);
  check(JSON.stringify(page.calls.rolePosts.at(-1)) === JSON.stringify({ employeeId: "e-hr", role: "hr", grant: false }), "人事・労務を外す → hr を外す");
  await row(page, "e-mgr").locator('.mb-sub[data-work="month"]').click();
  await page.waitForTimeout(500);
  check(JSON.stringify(page.calls.rolePosts.at(-1)) === JSON.stringify({ employeeId: "e-mgr", role: "manager", grant: false }), "月末月初を外す → manager を外す");
  check(JSON.stringify(await pressed(page, "e-hr")) === JSON.stringify({ hr: true, sales: false, office: true, keiei: false }), "4つのボタンは変わらない");
  await page.screenshot({ path: shotPath("members-office-work.png"), fullPage: true });
  await page.close();
}

console.log("\n— アプリ利用権限の表が未適用・読めないとき —");
for (const [state, text] of [["derived", "db/119"], ["error", "読み込めませんでした"]]) {
  const page = await open({ appsState: state });
  const note = await page.locator('[data-role="apps-state"]').innerText();
  check(note.includes(text), `${state}: 案内が出る（${note.slice(0, 40)}…）`);
  const disabled = await page.locator("#list .mb-tg").evaluateAll((ns) => ns.every((n) => n.disabled));
  check(disabled, `${state}: ボタンは、すべて変更できない`);
  const t = await btn(page, "e-hr", "hr").getAttribute("title");
  check(t && (state === "derived" ? t.includes("未適用") : t.includes("確認できません")), `${state}: 理由がボタンに付く（${t}）`);
  if (state === "derived") check(JSON.stringify(await pressed(page, "e-hr")) === JSON.stringify({ hr: true, sales: false, office: true, keiei: false }), "derived: 表示は、いまの内部の役割から導いた入口（権限は変わらない）");
  await page.close();
}

console.log("\n— 基本区分（在籍の段階）は、使える業務とは別 —");
{
  const page = await open();
  const opts = await row(page, "e-hr").locator("select option").allInnerTexts();
  check(opts.join("|") === "入社準備中|メンバー（在籍中）|退職手続き中|退職", `プルダウン: ${opts.join("|")}`);
  check((await page.locator("#list thead th").allInnerTexts()).some((t) => t.trim() === "基本区分"), "列の名前は「基本区分」");
  await page.close();
}

console.log("\n— CSV —");
{
  const page = await open();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => exportCsv())]);
  const text = (await import("node:fs/promises")).readFile(await dl.path(), "utf8");
  const csv = (await text).replace(/^﻿/, "");
  const lines = csv.split("\r\n");
  check(lines[0] === '"氏名","メール","部署","役職","雇用区分","入社日","基本区分","使える業務","内部の役割"', `見出し（${lines[0]}）`);
  const hr = lines.find((l) => l.startsWith('"人事 花子"'));
  check(hr && hr.includes('"メンバー（在籍中）"') && hr.includes('"採用HR Office"') && hr.endsWith('"人事"'), `人事: 使える業務 = 採用HR Office／内部の役割 = 人事（${hr}）`);
  check(lines.find((l) => l.startsWith('"経営 太郎"')).includes('"採用HR Sales Office 経営"'), "経営者: 4つ");
  await page.close();
}

console.log("\n— スマホ幅（390px）—");
{
  const page = await open({ width: 390 });
  // ページ全体の横幅は、Office の横タブ（共通ヘッダー直下。このページの変更ではない）で13px広がることがある。
  // この画面の中身（#roles）が、画面の幅に収まっていること（横スクロールは表の枠 .table-scroll の中だけ）を見る
  const ov = await page.evaluate(() => {
    const w = window.innerWidth;
    const out = [...document.querySelectorAll("#roles *")].filter((n) => !n.closest(".table-scroll") && n.getBoundingClientRect().width > 0)
      .map((n) => Math.round(n.getBoundingClientRect().right - w));
    const ts = document.querySelector("#roles .table-scroll");
    return { over: Math.max(0, ...out), scrollBox: ts ? Math.round(ts.getBoundingClientRect().right - w) : 0 };
  });
  check(ov.over <= 0 && ov.scrollBox <= 0, `この画面の中身が、画面の幅に収まる（表の外のはみ出し ${ov.over}px・表の枠 ${ov.scrollBox}px）`);
  const b = btn(page, "e-none", "hr");
  await b.scrollIntoViewIfNeeded();
  const boxes = await row(page, "e-none").locator(".mb-tg").evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check(boxes.length === 4 && boxes.every(([w, h]) => w >= 60 && h >= 32), `4つのボタンが押せる大きさ（${boxes.map((x) => x.join("x")).join(" ")}）`);
  await b.click();
  await page.waitForTimeout(500);
  check(page.calls.appPosts.length === 1 && await b.getAttribute("aria-pressed") === "true", "スマホ幅でも押せて、保存される");
  await page.screenshot({ path: shotPath("members-apps-sp.png") });
  await page.close();
}

console.log("\n— Office の入口と中の業務の食い違いを、行に出す —");
{
  const employees = [
    ...EMPLOYEES(),
    base("e-empty", "入口 だけ", [], ["office"]),
    base("e-finoff", "経理 入口なし", ["finance"], []),
  ];
  const page = await open({ employees });
  const note = (id, k) => row(page, id).locator(`[data-note="${k}"]`);
  const warn = note("e-empty", "office-empty");
  check(await warn.count() === 1 && (await warn.innerText()).includes("Office内の権限が未設定"), "Office だけ ON・役割なし →「Office内の権限が未設定」");
  check(await warn.evaluate((n) => n.tagName === "BUTTON" && getComputedStyle(n).color === "rgb(180, 83, 9)"), "オレンジ色で、押せる");
  check(await note("e-finoff", "office-off").count() === 1, "経理の役割あり・Office OFF →「Office が OFF のため…使えません」");
  for (const id of ["e-own", "e-hr", "e-fin", "e-mgr", "e-sales", "e-none", "e-adm"]) {
    check(await row(page, id).locator('.mb-gap, [data-note="office-empty"]').count() === 0, `${id}: 食い違いが無い行には出ない（会計の管理者・経営者・人事・経理・責任者）`);
  }
  // 一覧の上で、該当者がまとめて分かる
  const sum = page.locator('[data-role="office-empty-sum"]');
  check(await sum.count() === 1 && (await sum.innerText()).includes("1人") && (await sum.innerText()).includes("入口 だけ"), "一覧の上に「Office内の権限が未設定：1人」と名前");
  // 押すと、Office の下の3つのスイッチのところに案内（権限は付けない）
  await warn.click();
  await page.waitForTimeout(300);
  const guide = row(page, "e-empty").locator('[data-role="office-guide"]');
  const gt = await guide.innerText();
  check(await guide.count() === 1 && /人事・労務/.test(gt) && /経理・事務/.test(gt) && /月末月初/.test(gt) && /自動では付けません/.test(gt), "押すと、人事・労務／経理・事務／月末月初 のどれかを ON にする案内");
  check(await row(page, "e-empty").locator('[data-role="office-work"] .mb-sub').count() === 3, "そのすぐ上に3つのスイッチ");
  check(page.calls.rolePosts.length === 0, "案内を出しただけでは、権限を付けない");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: shotPath("members-office-empty.png"), fullPage: true });
  // 人事・労務を ON にすると、表示が消える
  await row(page, "e-empty").locator('.mb-sub[data-work="hr"]').click();
  await page.waitForTimeout(500);
  check(JSON.stringify(page.calls.rolePosts.at(-1)) === JSON.stringify({ employeeId: "e-empty", role: "hr", grant: true }), "人事・労務 → hr を付ける");
  check(await note("e-empty", "office-empty").count() === 0 && await page.locator('[data-role="office-guide"]').count() === 0, "ON にすると「Office内の権限が未設定」が消える");
  check(await page.locator('[data-role="office-empty-sum"]').count() === 0, "一覧の上の表示も消える");
  // 直すと、その場で消える（Office を ON にする／役割を付ける）
  await btn(page, "e-finoff", "office").click();
  await page.waitForTimeout(500);
  check(await row(page, "e-finoff").locator(".mb-gap").count() === 0, "Office を ON にすると、注記が消える");
  check(await page.locator('[data-role="office-guide"]').count() === 0, "役割がある人の Office を ON にしても、案内は出ない");
  await page.close();
}

console.log("\n— Office を ON にした瞬間：中の役割が無ければ、その場で案内（自動では付けない）—");
{
  const page = await open({ delay: 600 });
  await btn(page, "e-none", "office").click();
  await page.waitForTimeout(150);
  check(await row(page, "e-none").locator('[data-role="office-guide"]').count() === 1, "保存の終わりを待たずに、押した瞬間に案内が出る");
  await page.waitForTimeout(900);
  check(await row(page, "e-none").locator('[data-role="office-guide"]').count() === 1, "保存後も、サーバの判定で案内が残る");
  check(await row(page, "e-none").locator('[data-note="office-empty"]').count() === 1, "行に「Office内の権限が未設定」");
  check(/Office内の権限（責任者・人事・経理）が未設定/.test(await toast(page)), `知らせにも出る（${await toast(page)}）`);
  check(page.calls.rolePosts.length === 0 && page.calls.appPosts.length === 1, "役割は送っていない（Office の ON だけ）");
  await page.close();
}
{
  // 会計の管理者は役割なしでも Office の業務を使える（サーバの判定）。だから案内は出さない
  const page = await open({ employees: [...EMPLOYEES(), base("e-adm2", "管理 八郎", [], [], true)] });
  check(await row(page, "e-adm2").locator('[data-note="office-empty"]').count() === 0, "会計の管理者には出さない");
  await page.close();
}
{
  const page = await open({ failApp: true });
  await btn(page, "e-none", "office").click();
  await page.waitForTimeout(500);
  check(await page.locator('[data-role="office-guide"]').count() === 0 && await row(page, "e-none").locator('[data-note="office-empty"]').count() === 0, "保存に失敗したら、案内も消える（OFF のまま）");
  await page.close();
}
{
  const page = await open({ employees: [base("e-empty", "入口 だけ", [], ["office"])], appsState: "derived" });
  check(await row(page, "e-empty").locator('.mb-gap, [data-note="office-empty"]').count() === 0, "db/119 の前（入口は内部ロールから決まる）は出さない");
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
