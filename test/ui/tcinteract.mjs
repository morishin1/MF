// 押して開く／直す のところまで動かす。描いただけでは分からない落ち方を拾う
import { launch, BASE } from "../_browser.mjs";
import { ROUTES, me } from "./tcdata.mjs";

const br = await launch();
let bad = 0;
const errs = [];

async function open(file, role, w = 1280) {
  const page = await br.newPage({ viewport: { width: w, height: 1000 } });
  await page.addInitScript((r) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "zimu@8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: r, name: "事務", shows: {}, stage: null }));
  }, role);
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    for (const [re, body] of ROUTES) if (re.test(url)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  page.on("pageerror", (e) => errs.push(`${file}: ${e}`));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource/.test(m.text()) && errs.push(`${file}: ${m.text()}`));
  await page.goto(`http://127.0.0.1:8713/${file}`);
  await page.waitForTimeout(1200);
  return page;
}
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---- 管理側 ----
{
  const p = await open("admin-timecard.html", "admin");
  // 人を開くと、その人の日別が出る
  await p.locator(".tk-head").first().click();
  await p.waitForTimeout(300);
  check(await p.locator(".tk-body").first().isVisible(), "人を押すと日別が開く");
  check(await p.locator(".tk-day").count() > 0, "日別の行が出ている");

  // 「直す」で編集フォームが開き、その日の値が入る
  await p.locator(".tk-body button", { hasText: "直す" }).first().click();
  await p.waitForTimeout(300);
  check(await p.locator("#edit-card").isVisible(), "直すで編集が開く");
  check(await p.locator("#e-date").inputValue() !== "", "日付が入っている");
  check(await p.locator("#e-in").inputValue() !== "", "出勤の時刻が入っている");

  // 理由なしでは保存させない
  await p.locator("#e-reason").fill("");
  await p.locator("#edit-card button", { hasText: "保存" }).click();
  await p.waitForTimeout(300);
  check((await p.locator("#e-msg").textContent() || "").trim() !== "", "理由なしは止まる");

  await p.locator("#edit-card button", { hasText: "やめる" }).click();
  await p.waitForTimeout(200);
  check(!(await p.locator("#edit-card").isVisible()), "やめるで閉じる");
  await p.screenshot({ path: "tc-admin-open.png", fullPage: true });
  await p.close();
}

// ---- 本人 ----
{
  const p = await open("timecard.html", "member");
  // 出勤中なので「出勤」は押せず、「退勤」は押せる
  check(await p.locator("#b-in").isDisabled(), "出勤中に「出勤」は押せない");
  check(!(await p.locator("#b-out").isDisabled()), "「退勤」は押せる");
  check(!(await p.locator("#b-break").isDisabled()), "「休憩に入る」は押せる");
  check(await p.locator("#b-resume").isDisabled(), "休憩していないので「戻る」は押せない");

  // 修正の申請
  await p.locator("table button", { hasText: "直す" }).first().click();
  await p.waitForTimeout(300);
  check(await p.locator("#fix-card").isVisible(), "直すで申請フォームが開く");
  await p.locator("#x-reason").fill("");
  await p.locator("#fix-card button", { hasText: "申請" }).first().click();
  await p.waitForTimeout(300);
  check((await p.locator("#x-msg").textContent() || "").trim() !== "", "理由なしの申請は止まる");
  await p.screenshot({ path: "tc-member-fix.png", fullPage: true });
  await p.close();
}

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); errs.slice(0, 8).forEach((e) => console.log("  " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
