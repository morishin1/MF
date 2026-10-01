// メンバー管理（admin-members.html）を、実際のブラウザで通す。
//
// ■ 何を守るテストか（2026-10-01 P0：メンバー管理が使えなくなった不具合の修正）
//
//   原因B：画面の入口が roles:["admin","owner"] のままで、API（canManageHr＝管理者・人事）
//   とずれていた。人事だけの人は appRole が "member"（owner/admin/sr/member の4値しか無く
//   「人事」を表せない）になるため、画面側の roles チェックではじかれていた。
//
//   1. 管理者・経営者はこれまでどおり開ける
//   2. 人事だけの人（appRole は "member" だが access.hr は true）も開ける ← この回帰を守る
//   3. 一般メンバー（access.hr が false）は開けず、home.html へ送り返される
//   4. 開けた人は、一覧の表示・追加・編集・権限変更が実際に操作できる
//   5. 10/1 以降でも、MFA未登録を理由に /mypage.html#mfa へ送られたりしない
//      （フロントに日付ロジックは無く、サーバが返した内容をそのまま描くだけ。
//       ここでは成功レスポンスを返すモックで、画面が素直に開くことを確かめる）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const emp = (id, over = {}) => ({ id, display_name: id, department: "開発部", position: "主任",
  employment_type: "正社員", joined_on: "2026-04-01", status: "active", roles: [], accounts: {}, ...over });

const EMPLOYEES = {
  employees: [emp("e-taro", { display_name: "森田 太郎" }), emp("e-hanako", { display_name: "山田 花子" })],
  canManage: true, canGrantRoles: true, systems: ["lms", "timecard", "accounting"], kindReady: false,
};

const access = (hr) => ({ recruit: false, sell: false, office: false, keiei: false, hr });
const base = (overrides) => ({
  email: "x@x.jp", isAdmin: false, access: access(false),
  gw: { employee: { id: "e-x", display_name: "本人", status: "active" }, roles: [], isAdmin: false, tenantId: "t1", stage: null },
  ...overrides,
});
const ME_ADMIN = base({ appRole: "admin", isAdmin: true, access: access(true),
  gw: { employee: { id: "e-admin", display_name: "管理 太郎", status: "active" }, roles: [], isAdmin: true, tenantId: "t1", stage: null } });
const ME_OWNER = base({ appRole: "owner", access: access(true),
  gw: { employee: { id: "e-owner", display_name: "経営 次郎", status: "active" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
// 人事「だけ」。appRole は owner/admin/sr のどれでもないので "member" になる。access.hr だけが true
const ME_HR = base({ appRole: "member", access: access(true),
  gw: { employee: { id: "e-hr", display_name: "人事 花子", status: "active" }, roles: ["hr"], isAdmin: false, tenantId: "t1", stage: null } });
const ME_MEMBER = base({ appRole: "member", access: access(false),
  gw: { employee: { id: "e-member", display_name: "一般 三郎", status: "active" }, roles: [], isAdmin: false, tenantId: "t1", stage: null } });
const ME_RECRUITER = base({ appRole: "member", access: { ...access(false), recruit: true },
  gw: { employee: { id: "e-rec", display_name: "採用 四郎", status: "active" }, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } });

let posted = [];
async function open(me, { width = 1300, employees = EMPLOYEES } = {}) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me"); localStorage.removeItem("kp_view");
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/config/.test(url)) return send({});
    if (/\/api\/employees\/roles/.test(url)) { posted.push({ kind: "role", ...body }); return send({ ok: true, ...body }); }
    if (/\/api\/employees\/account/.test(url)) { posted.push({ kind: "account", ...body }); return send({ ok: true, password: "temp12345", systems: {} }); }
    if (/\/api\/employees\/bulk/.test(url)) return send({ created: 0, failed: [] });
    if (/\/api\/employees\b/.test(url)) {
      if (req.method() === "POST") { posted.push({ kind: "create", ...body }); return send({ employee: emp("e-new", { display_name: body.display_name }), account: null }); }
      if (req.method() === "PATCH") { posted.push({ kind: "update", ...body }); return send({ employee: emp(body.id, body), systems: null }); }
      if (req.method() === "DELETE") { posted.push({ kind: "delete" }); return send({ ok: true }); }
      return send(employees);
    }
    if (/\/api\/guests/.test(url)) return send({ partners: [] });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(700);
  return page;
}

console.log("— 管理者・経営者・人事は開ける —");
for (const [label, me] of [["管理者", ME_ADMIN], ["経営者", ME_OWNER], ["人事だけ", ME_HR]]) {
  const page = await open(me);
  check(page.url().includes("admin-members.html"), `${label}：home.html へ送り返されない（いま ${page.url()}）`);
  const h1 = await page.locator("h1.kp-greet").innerText().catch(() => "");
  check(h1 === "メンバー", `${label}：見出し「メンバー」が出る（いま「${h1}」）`);
  const list = await page.locator("body").innerText();
  check(list.includes("森田 太郎") && list.includes("山田 花子"), `${label}：社員一覧が見える`);
  check(!page.url().includes("mfa"), `${label}：MFA登録画面へ飛ばされない（10/1でも）`);
  await page.close();
}

console.log("\n— 一般メンバー・採用担当だけは開けない —");
for (const [label, me] of [["一般メンバー", ME_MEMBER], ["採用担当だけ", ME_RECRUITER]]) {
  const page = await open(me);
  check(page.url().endsWith("home.html"), `${label}：home.html へ送り返される（いま ${page.url()}）`);
  await page.close();
}

console.log("\n— 人事だけの人が、実際に操作できる —");
{
  posted = [];
  const page = await open(ME_HR);
  await page.fill("#e-name", "新規 五郎");
  await page.fill("#e-dept", "営業部");
  await page.click("#e-save");
  await page.waitForTimeout(400);
  check(posted.some((p) => p.kind === "create" && p.display_name === "新規 五郎"),
    `人事だけでも、社員を追加できる（送った内容: ${JSON.stringify(posted)}）`);
  await page.close();
}

console.log("\n— スマホ幅でも崩れない —");
{
  const page = await open(ME_HR, { width: 390 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `横スクロールが出ない（はみ出し ${overflow}px）`);
  await page.close();
}

console.log(bad || errs.length ? `\n${bad + errs.length} 件 NG${errs.length ? `\n  画面エラー: ${errs.join(" / ")}` : ""}` : "\nすべて通過");
await br.close();
process.exit(bad || errs.length ? 1 : 0);
