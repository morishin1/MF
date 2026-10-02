// Officeのダッシュボード（admin-dashboard.html）を、実際のブラウザで通す。
//
// ■ 何を守りたいのか
//   ・Office業務の NEXT ACTION だけを出す（入社手続き・契約待ち・勤怠確認・経費承認・月次未完了・請求・支払）
//   ・全社員のタスク・日報などチーム全体の状況は出さない（それは経営側の admin-team.html）
//   ・1つ取れなくても、ほかの行は出す（取れなかった行は「—」）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open({ failHr = false } = {}) {
  const page = await br.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "テスト", shows: {}, stage: null }));
  });
  const calls = [];
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    calls.push(url);
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "admin", isAdmin: true, access: {},
        gw: { employee: { id: "e1", display_name: "経理 花子", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null } });
    }
    if (/\/api\/badges/.test(url)) return send({ badges: { esign: 2, timecard: 3, requests: 1, expenses: 4 } });
    if (/\/api\/hr\b/.test(url)) {
      return failHr ? send({ error: "x" }, 500)
        : send({ tabs: [], onboarding: [{ id: "p1" }, { id: "p2" }], offboarding: [{ id: "p3" }] });
    }
    if (/\/api\/closing/.test(url)) return send({ month: "2026-09", closing: { status: "open" }, canClose: false, blockers: [{}, {}], rows: [] });
    if (/\/api\/billing-progress/.test(url)) {
      return send({ progress: [
        { id: "b1", timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true },
        { id: "b2", timesheet_received: true, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
      ] });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/admin-dashboard.html`);
  await page.waitForTimeout(1200);
  return { page, calls };
}

const rows = (page) => page.locator(".od-row").evaluateAll((ns) => ns.map((n) => ({
  label: n.querySelector(".od-label").textContent.trim(),
  n: n.querySelector(".od-num").textContent.trim(),
  href: n.getAttribute("href"),
})));

console.log("— Officeの NEXT ACTION —");
{
  const { page, calls } = await open();
  const r = await rows(page);
  const by = (l) => r.find((x) => x.label === l);
  check(by("入社手続き待ち")?.n === "2" && by("入社手続き待ち").href === "admin-hr.html", "入社手続き待ち 2件 → 入退社");
  check(by("退社手続き待ち")?.n === "1", "退社手続き待ち 1件");
  check(by("契約待ち")?.n === "2" && by("契約待ち").href === "admin-esign.html", "契約待ち 2件 → 電子署名");
  check(by("勤怠確認")?.n === "3" && by("勤怠確認").href === "admin-timecard.html", "勤怠確認 3件 → 勤怠管理");
  check(by("休暇・稟議の承認")?.n === "1", "休暇・稟議の承認 1件");
  check(by("経費承認")?.n === "4" && by("経費承認").href === "admin-expenses.html", "経費承認 4件 → 経費精算");
  check(by("月次未完了")?.n === "1" && by("月次未完了").href === "admin-closing.html", "月次未完了（前月が未締め）→ 月次業務");
  check(by("請求・支払の進行中")?.n === "1" && by("請求・支払の進行中").href === "admin-month-start.html", "請求・支払の進行中 1件（印が揃っていない行だけ）");

  const text = await page.locator(".wrap").innerText();
  for (const x of ["今日のチーム状況", "担当者", "完了数", "期限超過"]) {
    check(!text.includes(x), `チーム全体の状況（${x}）は出さない`);
  }
  check(!calls.some((u) => /\/api\/dashboard\/team/.test(u)), "チーム状況のAPIは呼ばない（経営側の admin-team.html で見る）");
  const side = await page.locator(".kp-sidebar").innerText();
  check(side.includes("ダッシュボード") && !side.includes("全員のタスク"), "左メニューはOffice（全員のタスクは出ない）");
  await page.close();
}

console.log("\n— 1つ取れなくても、ほかの行は出す —");
{
  const { page } = await open({ failHr: true });
  const r = await rows(page);
  check(r.find((x) => x.label === "入社手続き待ち")?.n === "—", "取れなかった行は「—」");
  check(r.find((x) => x.label === "経費承認")?.n === "4", "ほかの行は出る");
  check((await page.locator("#notice").innerText()).includes("取得できなかった"), "取れなかったことが書いてある");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
