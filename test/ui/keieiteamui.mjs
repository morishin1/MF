// 経営：日報・勤怠・チーム状況・全員のタスク（admin-*.html）も、経営者には経営の横タブで出す（2026-10-06 経営の新UIの仕上げ）。
//
// ■ 何を守るテストか
//   1. 経営者が開くと、旧い左メニューではなく、経営の横タブ（ホーム｜売上・営業｜人・組織｜財務｜リスク）が出る
//   2. 「人・組織」が選ばれ、2段目でいま開いている画面（日報・勤怠・チーム状況・全員のタスク）が選ばれている。今週のゴールは「全員のタスク」
//   3. タブの行き先は /keiei/#… （経営の画面へ戻れる）。2段目の外の画面へのリンクはそのまま
//   4. 経営に入れない管理者（会計の管理者）は、これまでどおり左メニュー（経営のタブを出すと、押した先が開けない）
//   5. 1280・390px で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(path, { owner = true, width = 1280 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" })); localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me"); });
  const roles = owner ? ["owner"] : [];
  await page.route("**/api/**", (r) => {
    const u = r.request().url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(u)) {
      return send({ email: "a@b.c", appRole: owner ? "owner" : "admin", isAdmin: true, roles,
        gw: { employee: { id: "e1", display_name: "森田 経営", status: "active" }, roles, tenantId: "t1", isAdmin: true, stage: null },
        access: accessOf({ isAdmin: true, roles }) });
    }
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForSelector(".topbar");
  await page.waitForTimeout(500);
  return { page, errs };
}

const PAGES = [
  ["admin-team.html", "チーム状況"],
  ["admin-tasks.html", "全員のタスク"],
  ["admin-goals.html", "全員のタスク"],
  // 日報・勤怠（admin-nippo.html）は Office の「人・組織」（2026-10-07。test/ui/gwmenuui.mjs・nippoweekui.mjs が見る）
];

for (const [path, sub] of PAGES) {
  console.log(`\n=== 経営者：${path} ===`);
  const { page, errs } = await open(path);
  check(await page.locator("#kp-keiei-nav").count() === 1, "経営の横タブが出る");
  check(await page.locator(".kp-sidebar").count() === 0, "旧い左メニューは出ない");
  const tabs = await page.locator("#kp-keiei-nav .kp-otab").allInnerTexts();
  check(tabs.map((t) => t.trim()).join("|") === "ホーム|売上・営業|人・組織|財務|リスク・権限", `1段目（${tabs.join("|")}）`);
  check((await page.locator("#kp-keiei-nav .kp-otab.on").innerText()).trim() === "人・組織", "「人・組織」が選ばれている");
  const on = await page.locator("#kp-keiei-nav .kp-ostab.on").allInnerTexts();
  check(on.length === 1 && on[0].trim() === sub, `2段目は「${sub}」が選ばれている（${on.join("|")}）`);
  check(await page.locator('#kp-keiei-nav .kp-otab[data-ktab="home"]').getAttribute("href") === "/keiei/#home", "ホームのタブは経営の画面へ");
  check(await page.locator('#kp-keiei-nav .kp-ostab[data-kview="pay"]').getAttribute("href") === "/keiei/#pay", "給与管理は経営の画面へ");
  check(await page.locator("#kp-keiei-nav .kp-ostab.ext", { hasText: "チーム状況" }).getAttribute("href") === "/admin-team.html", "外の画面へのリンクはそのまま");
  check(await page.locator("#kp-keiei-nav .kp-ostab", { hasText: "日報・勤怠" }).count() === 0, "日報・勤怠は経営に置かない（Office の人・組織）");
  check(await page.evaluate(() => document.body.classList.contains("kp-has-officenav")), "本文は採用HR・Sales・Office・経営と同じ見た目（kp-has-officenav）");
  // 本文のデータは空の応答（{}）なので、本文の描画のエラーはここでは見ない（各画面のテストが見る）。ナビの描画で落ちていないことだけ
  check(!errs.some((e) => /layout|keiei|KEIEI/i.test(e)), `ナビの描画でエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 経営に入れない管理者は、これまでどおり左メニュー ===");
{
  const { page } = await open("admin-team.html", { owner: false });
  check(await page.locator("#kp-keiei-nav").count() === 0, "経営の横タブは出ない");
  check(await page.locator(".kp-sidebar").count() === 1, "管理の左メニューが出る");
  await page.close();
}

console.log("\n=== 390px：横にはみ出さない ===");
for (const [path] of PAGES) {
  const { page } = await open(path, { width: 390 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${path}：横にはみ出さない（${over}）`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
