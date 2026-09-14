import { launch, BASE } from "../_browser.mjs";

const me = {
  email: "taro@gw.8grp.co.jp",
  gw: { employee: { id: "emp-1", display_name: "今福 太郎", email: "taro@gw.8grp.co.jp",
        department: "制作部", position: "主任", joined_on: "2026-04-01", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null },
  appRole: "member", shows: {},
};

const CONTRACTS = {
  contracts: [
    { id: "c1", title: "労働条件通知書 兼 雇用契約書", kind: "employment",
      kindLabel: "労働条件通知書・雇用契約書", view: "signed",
      sentAt: "2026-04-01T02:00:00Z", dueOn: "2026-04-08", signedAt: "2026-04-02T05:12:00Z" },
    { id: "c2", title: "誓約書 兼 秘密保持誓約書", kind: "pledge",
      kindLabel: "誓約書・秘密保持誓約書", view: "signed",
      sentAt: "2026-04-01T02:00:00Z", dueOn: "2026-04-08", signedAt: "2026-04-02T05:20:00Z" },
    { id: "c3", title: "PC・備品貸与契約書", kind: "equipment",
      kindLabel: "PC・備品貸与契約書", view: "sent",
      sentAt: "2026-09-01T02:00:00Z", dueOn: "2026-09-14", signedAt: null },
  ],
  agreeText: "内容を確認し、同意します。",
  me: { name: "今福 太郎", email: "taro@gw.8grp.co.jp" },
};

const OB = {
  known: { joinedOn: "2026-04-01", contract: "正社員", wage: "月給 320,000円" },
  companyDocuments: [], consents: [], consentHistory: [], profile: null, items: [],
};

const br = await launch();
const errs = [];
const page = await br.newPage({ viewport: { width: 1100, height: 1000 } });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "taro@gw.8grp.co.jp" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "今福 太郎", shows: {}, stage: null }));
});
await page.route("**/api/**", (route) => {
  const url = route.request().url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (/\/api\/me\b/.test(url)) return send(me);
  if (/\/api\/sign\/me/.test(url)) return send(CONTRACTS);
  if (/\/api\/onboarding\/me/.test(url)) return send(OB);
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  return send({});
});
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error"
  && !/fonts\.googleapis|net::ERR|Failed to load resource/.test(m.text()) && errs.push(m.text()));
await page.goto(`${BASE}/mypage.html`);
await page.waitForTimeout(1500);

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
check(await page.locator("#sg-card").isVisible(), "「署名した契約書」の欄が出る");
check((await page.locator("#sg-tag").textContent()) === "2件", "署名済みの件数が出る");
check(await page.locator("#sg .cd-row").count() === 2, "署名済み2件が並ぶ");
check((await page.locator("#sg").textContent() || "").includes("労働条件通知書"), "労働条件通知書が載っている");
check((await page.locator("#sg .banner.warn").textContent() || "").includes("1 件"), "未署名が残っていることも分かる");
check(await page.locator("#sg a[href='contracts.html']").count() > 0, "契約書の画面へ行ける");

await page.screenshot({ path: "mypage-signed.png", fullPage: true });
await br.close();
if (errs.length) { console.log("画面のエラー:", errs.slice(0, 5)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
