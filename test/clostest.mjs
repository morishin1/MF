// 月次締め。実際の画面で通す
import { launch, BASE } from "./_browser.mjs";

const meAdmin = { email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null } };

const row = (name, o = {}) => ({
  employee: { id: name, name, email: `${name}@x`, department: "制作部", status: "active" },
  work: { days: 20, workMinutes: 9600, breakMinutes: 1200, openDays: 0,
          nightMinutes: 0, holidayMinutes: 0, ...(o.work || {}) },
  leave: { paid: 2, other: 0, ...(o.leave || {}) },
  expense: { total: 12800, count: 3, ...(o.expense || {}) },
  pending: { leave: 0, ringi: 0, expense: 0, timefix: 0, ...(o.pending || {}) },
});

// 未承認あり → 締められない
const BLOCKED = {
  month: "2026-08",
  rows: [row("今福 太郎"), row("鈴木 花子", { pending: { expense: 2 } }),
         row("田中 一郎", { work: { openDays: 1 } })],
  closing: { status: "open" },
  canClose: false,
  blockers: [{ name: "鈴木 花子", what: "経費精算", count: 2 }],
  totals: { people: 3, workMinutes: 28800, paidLeave: 6, expense: 38400, pending: 2 },
};

// 未承認なし → 締められる
const READY = {
  ...BLOCKED,
  rows: [row("今福 太郎"), row("鈴木 花子")],
  canClose: true, blockers: [],
  totals: { people: 2, workMinutes: 19200, paidLeave: 4, expense: 25600, pending: 0 },
};

// 締め済
const CLOSED = {
  ...READY,
  closing: { status: "closed", closedAt: "2026-09-01T02:00:00Z" },
};

let state = BLOCKED;
const posted = [];

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const page = await br.newPage({ viewport: { width: 1400, height: 1000 }, timezoneId: "Asia/Tokyo" });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
});
await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (req.method() === "PATCH") {
    posted.push(JSON.parse(req.postData() || "{}"));
    return send({ ok: true });
  }
  if (/\/api\/me\b/.test(url)) return send(meAdmin);
  if (/\/api\/closing/.test(url)) return send(state);
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error"
  && !/fonts\.googleapis|net::ERR|Failed to load resource/.test(m.text()) && errs.push(m.text()));
page.on("dialog", (d) => d.accept("テストのため"));

await page.goto(`${BASE}/admin-closing.html`);
await page.waitForTimeout(1600);

console.log("— 一覧 —");
check((await page.locator("#c-rows tr").count()) === 3, "社員ごとに1行");
{
  const t = await page.locator("#c-rows").textContent();
  check(t.includes("今福 太郎") && t.includes("鈴木 花子"), "氏名が出る");
  check(t.includes("160:00"), "実労働が 時:分 で出る");
  check(t.includes("2日"), "有給の日数が出る");
  check(t.includes("12,800円"), "経費の金額が出る");
  check(t.includes("退勤の打刻が無い日 1日"), "退勤を打っていない日が分かる");
}
check(await page.locator("#c-rows tr.warn").count() === 2,
  "未承認がある人と、打刻が欠けている人に印が付く");
check(await page.locator("#c-rows .cl-pend:not(.none)").count() === 1, "未承認の数が出る");
check(await page.locator('#c-rows a[href="admin-expenses.html"]').count() === 1,
  "未承認の数を押すと、その画面へ行ける");

console.log("— 合計 —");
{
  const t = await page.locator("#c-sum").textContent();
  check(t.includes("3名"), "対象の人数");
  check(t.includes("480:00"), "実労働の合計");
  check(t.includes("38,400円"), "経費の合計");
  check(t.includes("2件"), "未承認の合計");
}

console.log("— 未承認が残っていると締められない —");
check(await page.locator("#c-close").isDisabled(), "「締める」が押せない");
check(await page.locator(".cl-block").isVisible(), "止めている理由が出る");
{
  const t = await page.locator(".cl-block").textContent();
  check(t.includes("鈴木 花子") && t.includes("経費精算") && t.includes("2件"),
    "誰の何が残っているかが分かる");
}
await page.screenshot({ path: "clos-blocked.png", fullPage: true });

console.log("— 未承認が無くなれば締められる —");
state = READY;
await page.locator("#c-month").fill("2026-08");
await page.waitForTimeout(900);
check(!(await page.locator("#c-close").isDisabled()), "「締める」が押せる");
check(await page.locator(".cl-block").count() === 0, "止めている理由は出ない");

posted.length = 0;
await page.locator("#c-close").click();
await page.waitForTimeout(900);
check(posted.some((x) => x.action === "close" && x.month === "2026-08"), "締められる");

console.log("— 締めたあと —");
state = CLOSED;
await page.locator("#c-month").fill("2026-08");
await page.waitForTimeout(900);
check((await page.locator("#c-state").textContent()) === "締め済", "締め済と出る");
check(await page.locator("#c-close").count() > 0 && !(await page.locator("#c-close").isVisible()),
  "「締める」は消える");
check(await page.locator("#c-reopen").isVisible(), "「締めを解く」が出る");

posted.length = 0;
await page.locator("#c-reopen").click();
await page.waitForTimeout(900);
{
  const r = posted.find((x) => x.action === "reopen");
  check(!!r, "解ける");
  check(r?.reason === "テストのため", "理由が送られる（理由なしでは解けない）");
}
await page.screenshot({ path: "clos-closed.png", fullPage: true });

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); errs.slice(0, 6).forEach((e) => console.log("  " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
