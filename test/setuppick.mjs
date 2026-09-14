// device-setup.html を管理者として開いたときに、誰のパソコンか選べるか。
//
// 初回は管理者が対象PCで入れる（商用のコード署名証明書を使わないため）。
// そのとき押すのは管理者なので、ここが効かないと全台が管理者の持ち物になる。
import { launch, BASE } from "./_browser.mjs";

const TOKEN = "t".repeat(43);
const me = { email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: { id: "emp-hr", display_name: "事務 担当", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null } };

const br = await launch();
const page = await br.newPage({ viewport: { width: 1000, height: 1100 }, timezoneId: "Asia/Tokyo" });
const errs = [];
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error"
  && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/i.test(m.text()) && errs.push(m.text()));

let claimed = null;
await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

  if (/\/api\/devices\/pair/.test(url) && req.method() === "POST") {
    claimed = JSON.parse(req.postData() || "{}");
    return send({ ok: true, pc: { hostname: "DESKTOP-A123" }, waitSec: 60 });
  }
  if (/\/api\/devices\/pair/.test(url)) {
    return send({
      pc: { hostname: "DESKTOP-A123", os: "Windows 11",
            browsers: [{ key: "chrome", label: "Chrome" }, { key: "edge", label: "Edge" }] },
      used: false,
      me: { id: "emp-hr", name: "事務 担当" },
      members: [
        { id: "emp-hr", name: "事務 担当", department: "管理" },
        { id: "emp-1", name: "田中 太郎", department: "営業" },
      ],
    });
  }
  if (/\/api\/me\b/.test(url)) return send(me);
  if (/\/api\/devices/.test(url)) return send({ devices: [] });
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
});

await page.goto(`http://127.0.0.1:8713/device-setup.html?pair=${TOKEN}`);
await page.waitForTimeout(1500);

check(await page.locator("#pick").isVisible(), "管理者には「使う人」の欄が出る");
const opts = await page.locator("#pick-emp option").allTextContents();
check(opts.length === 2 && /事務 担当/.test(opts[0]), "自分が既定で選ばれている");
check(!(await page.locator("#card-claim input").count()), "打たせる欄はない");

await page.selectOption("#pick-emp", "emp-1");
await page.waitForTimeout(200);
check(/田中 太郎/.test(await page.locator("#who").textContent()),
  "選ぶと「誰のものになるか」の表示が変わる");

await page.screenshot({ path: "/tmp/claude-0/-home-user-MF/ded29588-4821-5de3-8900-cbdd762650f3/scratchpad/setup-pick-before.png", fullPage: true });

await page.click("#go");
await page.waitForTimeout(900);
check(claimed?.employeeId === "emp-1", "選んだ人を送る");
check(claimed?.deviceUid === null || claimed?.deviceUid === undefined,
  "管理者のブラウザは束ねない（社員の持ち物として台帳に載ってしまう）");
check(await page.locator("#card-wait").isVisible(), "そのまま待ちの画面に進む");

await page.screenshot({ path: "/tmp/claude-0/-home-user-MF/ded29588-4821-5de3-8900-cbdd762650f3/scratchpad/setup-pick.png", fullPage: true });
await br.close();

if (errs.length) { console.log("\nスクリプトのエラー:", errs); bad++; }
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
