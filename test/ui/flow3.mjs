// 9/10 の指摘ぶん。実際の画面で通す
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

const emp = { id: "emp-1", display_name: "今福 太郎", email: "taro@gw.8grp.co.jp",
              department: "制作部", position: "主任", joined_on: "2026-04-01", status: "active" };

const meAdmin = { email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: emp, roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null } };
const meMember = { email: "taro@gw.8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: emp, roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const BADGES = { badges: { messages: 3, expenses: 2, requests: 1, timecard: 4, contracts: 1, esign: 5 } };

// 休暇の承認から自動でできた予定 ＋ 本人が入れた予定
const SCHEDULE = {
  events: [
    { id: "ev-leave", title: "鈴木 花子さん 休暇", body: null, location: null,
      category: "other", all_day: true, visibility: "shared", source: "leave",
      starts_at: `${TODAY}T00:00:00+09:00`, ends_at: `${TODAY}T23:59:00+09:00`,
      gcal_event_id: null, created_at: `${TODAY}T00:00:00Z` },
    { id: "ev-mine", title: "A社と打ち合わせ", body: "資料持参", location: "本社",
      category: "meeting", all_day: false, visibility: "private", source: "self",
      starts_at: `${TODAY}T10:00:00+09:00`, ends_at: `${TODAY}T11:00:00+09:00`,
      gcal_event_id: null, created_at: `${TODAY}T00:00:00Z` },
  ],
  bookings: [], tasks: [], external: { connected: false, events: [] },
  googleLink: { connected: false, canWrite: false },
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(file, who, badges = BADGES) {
  const page = await br.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript((r) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: r, name: "テスト", shows: {}, stage: null }));
    localStorage.removeItem("kp_nav_open");
  }, who.appRole);
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(who);
    if (/\/api\/badges/.test(url)) return send(badges);
    if (/\/api\/schedule\/team/.test(url)) return send({ events: [] });
    if (/\/api\/schedule/.test(url)) return send(SCHEDULE);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/dashboard/.test(url)) return send({ date: TODAY, top: null, actions: [], proposed: [],
      submittedToday: true, morning: { done: true }, kpis: [], notices: [], schedule: [], blockers: [] });
    return send({});
  });
  page.on("pageerror", (e) => errs.push(`${file}: ${e}`));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource/.test(m.text()) && errs.push(`${file}: ${m.text()}`));
  await page.goto(`http://127.0.0.1:8713/${file}`);
  await page.waitForTimeout(1500);
  return page;
}

console.log("— 件数バッジ（管理者・ホーム領域）—");
{
  // home.html は管理者が開くとホーム領域のサイドメニュー（ダッシュボード・今日のタスク・
  // 日報・社内AI・お知らせ）になる。Officeの項目（経費精算・勤怠など）はここには無い
  // （ヘッダーで領域を切り替えた先・Officeのサイドメニューにある。下のブロックで見る）
  const p = await open("home.html", meAdmin);
  const badge = (k) => p.locator(`[data-badge~="${k}"]`).first();
  const shown = async (k) => !(await badge(k).evaluate((n) => n.classList.contains("hidden")));

  check(await shown("messages"), "社内AIに件数が出る");
  check((await badge("messages").textContent()) === "3", "件数が合っている");

  // 0 のものは出さない
  check(!(await shown("nippo")), "件数が無いものは出さない");
  check(!(await shown("notices")), "お知らせにも出ない");

  await p.screenshot({ path: shotPath("f3-badges-admin.png"), fullPage: false });
  await p.close();
}

console.log("— 件数バッジ（管理者・Office領域）—");
{
  // admin-expenses.html は Office の「経理・事務」の画面。2段目のタブ（経費精算）に件数が出る。
  // ほかのカテゴリ（人事・労務）のタブにも、中に用があることの印が付く
  const p = await open("admin-expenses.html", meAdmin);
  const badge = (k) => p.locator(`[data-badge~="${k}"]`).first();
  const shown = async (k) => !(await badge(k).evaluate((n) => n.classList.contains("hidden")));

  check(await shown("expenses"), "経費精算に件数が出る");
  check((await badge("expenses").textContent()) === "2", "経費の件数が合っている");

  const dot = p.locator('[data-cat-dot="office-hr"]');
  check(await dot.count() === 1 && await dot.isVisible(), "人事・労務のタブに印が付く（中に勤怠の件数がある）");
  await p.close();

  // カテゴリのタブを開けば、中の画面のタブに件数が見える（勤怠管理 5＝勤怠 4＋休暇・稟議 1。タブの鍵をまとめて背負う）
  const h = await open("admin-members.html", meAdmin);
  const tc = h.locator('#kp-office-nav .kp-ostab [data-badge~="timecard"]');
  check(await tc.isVisible() && (await tc.textContent()) === "5", `「人事・労務」を開くと勤怠管理の件数が見える（いま ${await tc.textContent()}）`);
  await h.close();
}

console.log("— 件数バッジ（メンバー）—");
{
  const p = await open("home.html", meMember, { badges: { messages: 12, contracts: 1 } });
  check((await p.locator('[data-badge~="messages"]').first().textContent()) === "12", "メンバーにも出る");
  // 契約書はマイページの中のタブになった。件数はマイページの行が背負う。
  // 背負わないと、未署名が1件あっても開くまで気づけない
  check(await p.locator('[data-badge~="contracts"]').first().isVisible(),
        "未署名の契約書にも出る（マイページの行が背負う）");
  // メンバーのメニューに経費の項目そのものが無い（承認する立場でないため）
  check(await p.locator('.kp-sidebar.member a[href="admin-expenses.html"]').count() === 0,
    "承認する立場でない人には、経費の件数を出さない");
  await p.close();
}

console.log("— 大きい数 —");
{
  const p = await open("home.html", meMember, { badges: { messages: 250 } });
  check((await p.locator('[data-badge="messages"]').first().textContent()) === "99+",
    "3桁は 99+ にする（メニューの幅が崩れない）");
  await p.close();
}

console.log("— バッジが取れなくても画面は動く —");
{
  const page = await br.newPage({ viewport: { width: 1200, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "テスト", shows: {}, stage: null }));
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (/\/api\/badges/.test(url)) return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    if (/\/api\/me\b/.test(url)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(meMember) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(`${BASE}/home.html`);
  await page.waitForTimeout(1400);
  check(await page.locator(".kp-sidebar").count() > 0, "バッジが500でもメニューは出る");
  check(await page.locator("[data-badge]:not(.hidden)").count() === 0, "数字は出ない（0を出さない）");
  await page.close();
}

console.log("— 休暇の予定は予定表から直せない —");
{
  const p = await open("schedule.html", meMember);
  const rows = p.locator(".kp-event");
  const leave = rows.filter({ hasText: "休暇" }).first();
  check(await leave.count() > 0, "承認した休暇が予定表に出る");
  check(await leave.locator('button[title="直す"]').count() === 0, "休暇の行に「直す」は無い");
  check(await leave.locator('button[title="消す"]').count() === 0, "休暇の行に「消す」は無い");
  check((await leave.textContent()).includes("申請・承認"), "どこで直すのかが行に書いてある");

  const mine = rows.filter({ hasText: "A社と打ち合わせ" }).first();
  check(await mine.locator('button[title="直す"]').count() === 1, "自分の予定はこれまでどおり直せる");
  check(await mine.locator('button[title="消す"]').count() === 1, "自分の予定は消せる");

  await p.screenshot({ path: shotPath("f3-schedule.png"), fullPage: true });
  await p.close();
}

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); errs.slice(0, 8).forEach((e) => console.log("  " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
