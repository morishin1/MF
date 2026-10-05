// メンバー管理（admin-members.html）の「利用できる業務」を、実際のブラウザで通す。
//
// ■ 何を守りたいのか
//   ・各社員の行に、採用HR・Sales・Office（人事・労務／経理・事務／月末月初）・経営 の ○× が出る。
//     ○×はサーバ（lib/gw.js accessOf）が返した access そのまま。画面は条件を持たない
//   ・社内権限のチェックを付け外しすると、同じ行の「利用できる業務」がその場で変わる（名簿は取り直さない）
//   ・「メンバー」のプルダウンは在籍の段階（基本区分）で、業務の権限ではないと分かる名前・説明になっている
//   ・説明文（凡例）は、実際の権限モデル（officeHr に人事が含まれる）と一致する
//   ・読めなかったときは ○× と言い切らず「確認できません」
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// サーバの判定そのもの（画面が表示する値の「正解」。ブラウザ側の画面は、これを計算しない）
const GW = await import("../../lib/gw.js");

const ADMIN_ME = { email: "own@8grp.co.jp", appRole: "owner", isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "e-own", display_name: "経営 太郎", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
  access: GW.accessOf({ isAdmin: false, isHr: true, roles: ["owner"] }) };

const base = (id, name, roles, extra = {}) => ({ id, display_name: name, email: `${id}@8grp.co.jp`, user_id: `u-${id}`,
  department: "開発", employment_type: "正社員", status: "active", employee_kind: "proper", partner_company_id: null,
  roles, accounts: {}, ...extra });
// サーバの応答の形: access（accessOf の結果）と accessMeta（accessOf に渡した isAdmin）
const withAccess = (e, isAdmin = false) => ({ ...e, access: GW.memberAccessOf({ roles: e.roles, isAdmin }), accessMeta: { accountingAdmin: isAdmin } });

async function open({ employees, width = 1500, failRole = false, roleResponder = null } = {}) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const calls = { employeesGet: 0, rolePosts: [] };
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "own@8grp.co.jp" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open"]) localStorage.removeItem(k);
  });
  page.on("dialog", (d) => d.accept());
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/employees\/roles/.test(url)) {
      const body = JSON.parse(req.postData() || "{}");
      calls.rolePosts.push(body);
      if (failRole) return send({ error: "forbidden", hint: "変更できません" }, 403);
      // サーバの代わり: 変更後の roles と access を、本物の accessOf で計算して返す
      const e = employees.find((x) => x.id === body.employeeId);
      const roles = new Set(e.roles);
      if (body.grant) roles.add(body.role); else roles.delete(body.role);
      e.roles = [...roles];
      const isAdmin = e.accessMeta?.accountingAdmin === true;
      const out = roleResponder ? roleResponder(e)
        : { roles: e.roles, access: GW.memberAccessOf({ roles: e.roles, isAdmin }), accessMeta: { accountingAdmin: isAdmin } };
      e.access = out.access;
      if (out.accessMeta !== undefined) e.accessMeta = out.accessMeta;
      return send({ ok: true, employeeId: e.id, role: body.role, granted: Boolean(body.grant), ...out });
    }
    if (/\/api\/employees\b/.test(url) && req.method() === "GET") {
      calls.employeesGet++;
      return send({ employees, canManage: true, canGrantRoles: true, canGrantOwner: true, systems: {}, kindReady: true });
    }
    if (/\/api\/partners\b/.test(url)) return send({ companies: [], canManage: true });
    if (/\/api\/me\b/.test(url)) return send(ADMIN_ME);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1300);
  page.calls = calls;
  return page;
}

const chips = (page, id) => page.locator(`td.mb-acc[data-employee="${id}"] .mb-ab`).evaluateAll((ns) =>
  Object.fromEntries(ns.map((n) => [n.dataset.access, n.dataset.on === "1"])));
const KEYS = ["recruit", "sell", "officeAny", "officeHr", "officeFinance", "office", "keiei"];
const want = (a) => ({ recruit: a.recruit, sell: a.sell, officeAny: a.officeAny, officeHr: a.officeHr, officeFinance: a.officeFinance, office: a.office, keiei: a.keiei });

const EMPLOYEES = () => [
  withAccess(base("e-own", "経営 太郎", ["owner"])),
  withAccess(base("e-hr", "人事 花子", ["hr"])),
  withAccess(base("e-fin", "経理 一郎", ["finance"])),
  withAccess(base("e-mgr", "責任 二郎", ["manager"])),
  withAccess(base("e-rec", "採用 三郎", ["recruiter"])),
  withAccess(base("e-none", "一般 七郎", [])),
  // 会計の管理者。「利用中のシステム」（accounts）は読めなかった想定で空にしてある。注記は accounts ではなく accessMeta から出る
  withAccess(base("e-adm", "管理 六郎", [], { accounts: {} }), true),
];

console.log("— 各行の「利用できる業務」（サーバの accessOf のとおり）—");
{
  const employees = EMPLOYEES();
  const page = await open({ employees });
  const ths = (await page.locator("#list thead th").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
  check(ths.some((t) => t.startsWith("基本区分")) && ths.some((t) => t.startsWith("社内権限")) && ths.some((t) => t.startsWith("利用できる業務")),
    `列: 基本区分／社内権限／利用できる業務（いま ${ths.join("｜")}）`);
  check(!ths.includes("状態"), "「状態」という名前の列は無い（在籍の段階は「基本区分」）");
  for (const e of employees) {
    const got = await chips(page, e.id);
    check(JSON.stringify(Object.keys(got)) === JSON.stringify(KEYS), `${e.display_name}: 並びは 採用HR／Sales／Office（人事・労務・経理・事務・月末月初）／経営（いま ${Object.keys(got)}）`);
    check(JSON.stringify(got) === JSON.stringify(want(e.access)), `${e.display_name}: ○×がサーバの access と同じ ${JSON.stringify(got)}`);
  }
  // 代表例（accessOf の仕様を文章で固定）
  const g = async (id) => chips(page, id);
  const hr = await g("e-hr");
  check(hr.recruit && hr.officeHr && hr.officeAny && !hr.officeFinance && !hr.office && !hr.sell && !hr.keiei, "人事: 採用HR ○／Office ○（人事・労務 ○・経理・事務 ×・月末月初 ×）／Sales ×／経営 ×");
  const fin = await g("e-fin");
  check(fin.officeFinance && fin.office && !fin.officeHr && !fin.recruit, "経理: Office ○（経理・事務 ○・月末月初 ○・人事・労務 ×）／採用HR ×");
  const mgr = await g("e-mgr");
  check(mgr.recruit && mgr.sell && mgr.office && mgr.officeAny && !mgr.officeHr && !mgr.officeFinance, "責任者: 採用HR・Sales ○／Office は 月末月初だけ ○（人事・労務・経理・事務は ×）");
  const own = await g("e-own");
  check(KEYS.every((k) => own[k]), "経営者: 全部 ○");
  const none = await g("e-none");
  check(KEYS.every((k) => !none[k]), "権限なし: 全部 ×");
  const adm = await g("e-adm");
  check(adm.officeHr && adm.officeFinance && adm.officeAny && !adm.recruit && !adm.sell && !adm.office && !adm.keiei, "会計の管理者（社内権限なし）: 人事・労務 ○・経理・事務 ○（採用HR・Sales・月末月初・経営は ×）");
  check((await page.locator('td.mb-acc[data-employee="e-adm"] [data-note="accounting-admin"]').count()) === 1, "会計の管理者の行には、社内権限と別の軸だと分かる注記が出る");
  check((await page.locator('td.mb-acc[data-employee="e-hr"] [data-note="accounting-admin"]').count()) === 0, "管理者でない行に注記は出ない");
  const txt = (await page.locator('td.mb-acc[data-employee="e-hr"]').innerText()).replace(/\s+/g, " ");
  check(txt.includes("採用HR ○") && txt.includes("Sales ×") && txt.includes("Office ○") && txt.includes("人事・労務 ○") && txt.includes("経理・事務 ×") && txt.includes("月末月初 ×") && txt.includes("経営 ×"),
    `行の文字でも ○× が読める（${txt}）`);
  await page.close();
}

console.log("\n— 社内権限のチェックを変えると、同じ行がその場で変わる（名簿は取り直さない）—");
{
  const employees = EMPLOYEES();
  const page = await open({ employees });
  const getsBefore = page.calls.employeesGet;
  const box = (id, role) => page.locator(`tr:has(td.mb-acc[data-employee="${id}"]) input[data-role="${role}"]`);

  await box("e-none", "finance").check();
  await page.waitForTimeout(350);
  let a = await chips(page, "e-none");
  check(page.calls.rolePosts.length === 1 && page.calls.rolePosts[0].role === "finance" && page.calls.rolePosts[0].grant === true, "チェック → 権限の付与がサーバへ");
  check(a.officeFinance && a.office && a.officeAny && !a.officeHr && !a.recruit, "経理を付けた直後: Office ○（経理・事務 ○・月末月初 ○）、人事・労務 ×");
  check(page.calls.employeesGet === getsBefore, "名簿は取り直していない（サーバの応答で同じ行だけ直した）");

  await box("e-none", "hr").check();
  await page.waitForTimeout(350);
  a = await chips(page, "e-none");
  check(a.officeHr && a.officeFinance && a.recruit && a.officeAny, "人事も付けた直後: 人事・労務 ○・経理・事務 ○・採用HR ○（足し合わさる）");

  await box("e-none", "finance").uncheck();
  await page.waitForTimeout(350);
  a = await chips(page, "e-none");
  check(a.officeHr && !a.officeFinance && !a.office && a.recruit, "経理を外した直後: 経理・事務 ×・月末月初 ×、人事・労務 ○ は残る");

  await box("e-none", "hr").uncheck();
  await page.waitForTimeout(350);
  a = await chips(page, "e-none");
  check(KEYS.every((k) => !a[k]), "人事も外した直後: 全部 ×");

  await box("e-none", "manager").check();
  await page.waitForTimeout(350);
  a = await chips(page, "e-none");
  check(a.recruit && a.sell && a.office && a.officeAny && !a.officeHr && !a.officeFinance, "責任者を付けた直後: 採用HR・Sales・月末月初 ○（人事・労務・経理・事務は ×）");

  // ほかの行は変わらない
  const other = await chips(page, "e-hr");
  check(JSON.stringify(other) === JSON.stringify(want(employees.find((e) => e.id === "e-hr").access)), "ほかの人の行は変わらない");
  check(page.calls.employeesGet === getsBefore, "最後まで、名簿は取り直していない");
  await page.close();
}

console.log("\n— 変更に失敗したとき —");
{
  const employees = EMPLOYEES();
  const page = await open({ employees, failRole: true });
  const before = await chips(page, "e-none");
  await page.locator('tr:has(td.mb-acc[data-employee="e-none"]) input[data-role="finance"]').check();
  await page.waitForTimeout(400);
  check(JSON.stringify(await chips(page, "e-none")) === JSON.stringify(before), "失敗したら「利用できる業務」は変わらない");
  check(!(await page.locator('tr:has(td.mb-acc[data-employee="e-none"]) input[data-role="finance"]').isChecked()), "チェックも元に戻る");
  await page.close();
}

console.log("\n— 応答に access が無い・読めなかったとき —");
{
  // 付け外しは成功したが、サーバが access を返せなかった（null）→「確認できません」と言う（×と言い切らない）
  const employees = EMPLOYEES();
  const page = await open({ employees, roleResponder: (e) => ({ roles: e.roles, access: null }) });
  await page.locator('tr:has(td.mb-acc[data-employee="e-none"]) input[data-role="finance"]').check();
  await page.waitForTimeout(350);
  check((await page.locator('td.mb-acc[data-employee="e-none"] [data-access-unknown]').count()) === 1, "access = null → 「確認できません」");
  await page.close();

  // 応答に access の項目そのものが無い（古いサーバ）→ 名簿を読み直して、表示と実際を合わせる
  const emps2 = EMPLOYEES();
  const p2 = await open({ employees: emps2, roleResponder: (e) => ({ roles: e.roles }) });
  const g0 = p2.calls.employeesGet;
  await p2.locator('tr:has(td.mb-acc[data-employee="e-none"]) input[data-role="finance"]').check();
  await p2.waitForTimeout(500);
  check(p2.calls.employeesGet === g0 + 1, "access が無い応答のときは、名簿を読み直す");
  await p2.close();

  // 名簿そのものが access を持たない（読める立場ではない）→ ○× を出さない
  const emps3 = EMPLOYEES().map(({ access, ...e }) => e);
  const p3 = await open({ employees: emps3 });
  check((await p3.locator("td.mb-acc .mb-ab").count()) === 0, "access が無い名簿では、○× を出さない（推測しない）");
  await p3.close();
}

console.log("\n— 会計の管理者の注記は、accessOf に渡した isAdmin（accessMeta.accountingAdmin）から出す —");
{
  // 1) accounts（利用中のシステム）が空でも、accessMeta が true なら注記が出る
  // 2) accounts が「管理者」に見えても、accessMeta が false なら注記は出ない（accounts から推測しない）
  // 3) access も accessMeta も null（memberships が読めなかった）→「確認できません」。注記は出ない
  const employees = [
    withAccess(base("e-adm", "管理 六郎", [], { accounts: {} }), true),
    withAccess(base("e-fake", "見せかけ 一郎", [], { accounts: { accounting: { exists: true, active: true, role: "admin" } } }), false),
    { ...base("e-unk", "不明 二郎", ["hr"], { accounts: { accounting: { exists: true, active: true, role: "staff" } } }), access: null, accessMeta: { accountingAdmin: null } },
  ];
  const page = await open({ employees });
  const note = (id) => page.locator(`td.mb-acc[data-employee="${id}"] [data-note="accounting-admin"]`).count();
  check(await note("e-adm") === 1, "accounts が空でも、accessMeta.accountingAdmin = true なら「会計の管理者」の注記が出る");
  const adm = await chips(page, "e-adm");
  check(adm.officeHr && adm.officeFinance, "その人の 人事・労務 ○・経理・事務 ○ は、同じ isAdmin から（注記と○の理由が一致する）");
  check(await note("e-fake") === 0, "accounts が admin に見えても、accessMeta が false なら注記は出ない（推測しない）");
  const fake = await chips(page, "e-fake");
  check(!fake.officeHr && !fake.officeFinance, "注記が無い人は、人事・労務／経理・事務も ×（注記と実効権限が一致する）");
  check(await note("e-unk") === 0, "isAdmin が分からない（null）人には、注記を出さない（staff に見える accounts でも）");
  check((await page.locator('td.mb-acc[data-employee="e-unk"] [data-access-unknown]').count()) === 1, "memberships が読めない（access = null）→「確認できません」");
  check((await page.locator('td.mb-acc[data-employee="e-unk"] .mb-ab').count()) === 0, "分からない人に ○× は出さない");
  await page.close();

  // 権限変更の応答の accessMeta で、同じ行の注記も変わる（accountingAdmin が変わらなければ消えない／null なら消える）
  const emps2 = [withAccess(base("e-adm", "管理 六郎", [], { accounts: {} }), true), withAccess(base("e-none", "一般 七郎", []))];
  const p2 = await open({ employees: emps2 });
  await p2.locator('tr:has(td.mb-acc[data-employee="e-adm"]) input[data-role="sales"]').check();
  await p2.waitForTimeout(350);
  check(await p2.locator('td.mb-acc[data-employee="e-adm"] [data-note="accounting-admin"]').count() === 1, "権限を付けても、会計の管理者の注記は残る（応答の accessMeta から）");
  const a2 = await chips(p2, "e-adm");
  check(a2.recruit === false && a2.sell && a2.officeHr && a2.officeFinance, "Sales ○ が足され、人事・労務／経理・事務 ○ は管理者のまま");
  await p2.close();

  const p3 = await open({ employees: [withAccess(base("e-adm", "管理 六郎", [], { accounts: {} }), true)],
    roleResponder: (e) => ({ roles: e.roles, access: null, accessMeta: { accountingAdmin: null } }) });
  await p3.locator('tr:has(td.mb-acc[data-employee="e-adm"]) input[data-role="sales"]').check();
  await p3.waitForTimeout(350);
  check(await p3.locator('td.mb-acc[data-employee="e-adm"] [data-note="accounting-admin"]').count() === 0, "応答で isAdmin が分からなくなったら、注記も消える");
  check((await p3.locator('td.mb-acc[data-employee="e-adm"] [data-access-unknown]').count()) === 1, "「確認できません」になる");
  await p3.close();

  // 応答に accessMeta が無い（古いサーバ）→ 名簿を読み直して、表示と実際を合わせる（注記を推測で出さない）
  const p4 = await open({ employees: [withAccess(base("e-none", "一般 七郎", []))],
    roleResponder: (e) => ({ roles: e.roles, access: GW.memberAccessOf({ roles: e.roles, isAdmin: false }) }) });
  const g0 = p4.calls.employeesGet;
  await p4.locator('tr:has(td.mb-acc[data-employee="e-none"]) input[data-role="finance"]').check();
  await p4.waitForTimeout(500);
  check(p4.calls.employeesGet === g0 + 1, "accessMeta が無い応答のときは、名簿を読み直す");
  await p4.close();
}

console.log("\n— 「メンバー」のプルダウン = 基本区分（在籍の段階）。業務の権限ではない —");
{
  const page = await open({ employees: EMPLOYEES() });
  const sel = page.locator('tr:has(td.mb-acc[data-employee="e-hr"]) select[data-kind="base-status"]');
  const opts = (await sel.locator("option").allInnerTexts()).map((x) => x.trim());
  check(opts.join("|") === "入社準備中|メンバー（在籍中）|退職手続き中|退職", `選択肢の名前は在籍の段階（いま ${opts.join("|")}）`);
  check((await sel.getAttribute("title")).includes("業務の権限ではありません"), "プルダウンに「業務の権限ではない」と説明が付く");
  check((await sel.getAttribute("aria-label")).includes("基本区分"), "読み上げ名は「基本区分」");
  const th = (await page.locator("#list thead th.mb-th").first().innerText()).replace(/\s+/g, " ");
  check(th.includes("基本区分") && th.includes("権限ではない"), `列の見出しに「基本区分／在籍の段階（権限ではない）」（${th}）`);
  const axes = (await page.locator(".mb-axes").innerText()).replace(/\s+/g, " ");
  check(axes.includes("基本区分＝在籍の段階") && axes.includes("社内権限＝チェックで付ける業務の権限") && axes.includes("利用できる業務＝社内権限"), "3つの違いの説明が一覧の下に出る");
  await page.close();
}

console.log("\n— 説明文（凡例）が、実際の権限モデルと一致する —");
{
  const page = await open({ employees: EMPLOYEES() });
  await page.locator(".mb-legend summary").click();
  const legend = (await page.locator("#role-legend").innerText()).replace(/\s+/g, " ");
  check(!/Office（\/office\/）を使える：経営者・責任者・経理/.test(legend), "古い説明（Office＝経営者・責任者・経理）は残っていない");
  const L = { owner: "経営者", manager: "責任者", hr: "人事", recruiter: "採用担当", sales: "営業担当", finance: "経理" };
  const names = (roles) => roles.map((r) => L[r]);
  const line = (key) => (legend.match(new RegExp(`${key}`)) ? true : false);
  const lineText = async (sel) => (await page.locator(sel).innerText()).replace(/\s+/g, " ");
  const hrT = await lineText('[data-legend="officeHr"]');
  const finT = await lineText('[data-legend="officeFinance"]');
  const appT = await lineText('[data-legend="office"]');
  // 人事・労務 = 経営者・人事（+会計の管理者）、経理・事務 = 経営者・経理（+会計の管理者）、月末月初 = lib/gw.js OFFICE_ROLES
  check(hrT.includes("人事・労務") && hrT.includes("経営者・人事・会計の管理者"), `人事・労務: 経営者・人事・会計の管理者（${hrT}）`);
  check(finT.includes("経理・事務") && finT.includes("経営者・経理・会計の管理者"), `経理・事務: 経営者・経理・会計の管理者（${finT}）`);
  check(appT.includes("月末月初") && appT.includes(names(GW.OFFICE_ROLES).join("・")), `月末月初: ${names(GW.OFFICE_ROLES).join("・")}（lib/gw.js OFFICE_ROLES と同じ。${appT}）`);
  check(legend.includes(`採用HR（/hr/）を使える：${names(GW.HR_ROLES).join("・")}`), "採用HR: lib/gw.js HR_ROLES と同じ並び");
  check(legend.includes(`Sales（/sales/）を使える：${names(GW.SALES_ROLES).join("・")}`), "Sales: lib/gw.js SALES_ROLES と同じ並び");
  check(legend.includes("経営（/keiei/）を使える：経営者だけ"), "経営: 経営者だけ");
  check(legend.includes("Officeは、次の3つのどれか1つでも使えれば使えます"), "Office は 3つのどれか1つで使える、と書いてある");
  check(legend.includes("同じ行の「利用できる業務」がすぐ変わります"), "チェックを変えると同じ行がすぐ変わる、と書いてある");
  check(legend.includes("会計の管理者は、社内権限のチェックとは別の軸"), "会計の管理者は別の軸、と書いてある");
  // 各権限の説明（チェックのヒント）も、新しいモデルに合っている
  const hint = async (role) => page.locator(`input[data-role="${role}"]`).first().locator("xpath=ancestor::label").getAttribute("title");
  const hh = await hint("hr");
  const hf = await hint("finance");
  const hm = await hint("manager");
  check(hh.includes("Office の人事・労務") && hh.includes("経理・事務、月末月初は使えない"), `人事のヒント: ${hh}`);
  check(hf.includes("経理・事務") && hf.includes("月末月初") && hf.includes("人事・労務は使えない"), `経理のヒント: ${hf}`);
  check(hm.includes("月末月初") && hm.includes("人事・労務／経理・事務は使えない"), `責任者のヒント: ${hm}`);
  await page.close();
}

console.log("\n— CSV —");
{
  const employees = EMPLOYEES();
  const page = await open({ employees });
  const csv = await page.evaluate(() => {
    let text = "";
    const origBlob = window.Blob;
    window.Blob = function (parts, opts) { text = parts.join(""); return new origBlob(parts, opts); };
    URL.createObjectURL = () => "blob:x";
    HTMLAnchorElement.prototype.click = function () {};
    exportCsv();
    return text;
  });
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  check(lines[0].includes("基本区分") && lines[0].includes("社内権限") && lines[0].includes("利用できる業務"), `CSV の見出し: ${lines[0]}`);
  const hrLine = lines.find((l) => l.includes("人事 花子"));
  check(hrLine.includes("採用HR") && hrLine.includes("Office（人事・労務）") && !hrLine.includes("Sales"), `人事の行: ${hrLine}`);
  await page.close();
}

console.log("\n— スマホ幅・狭い画面 —");
{
  const page = await open({ employees: EMPLOYEES(), width: 390 });
  // ページ上部の Office のタブ帯（別の画面の部品）は、この画面の変更とは別。ここでは、この画面の一覧・説明が
  // ページを横に押し広げないことを見る（表は、表の枠の中でスクロールする）
  const out = await page.evaluate(() => {
    const w = window.innerWidth;
    const bad = [];
    for (const n of document.querySelectorAll("#roles *")) {
      if (n.closest(".table-scroll")) continue;
      if (n.getBoundingClientRect().right > w + 1) bad.push(`${n.tagName}.${n.className}`);
    }
    return bad;
  });
  check(out.length === 0, `390px: 一覧の枠（表の外）がページを横に押し広げない（${out.slice(0, 3).join(",")}）`);
  check(await page.locator("#list .table-scroll").evaluate((n) => n.scrollWidth >= n.clientWidth), "表は表の枠の中でスクロールする");
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
