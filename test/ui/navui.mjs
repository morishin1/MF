// 左メニューを、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//
//   「登録済みの機能を全部並べる」に戻らないこと。
//   「左は自分の仕事、上は担当業務」。管理者も、ホーム領域の左メニューは全員と同じ。
//   Office・⚙管理に入ったときだけ専用の左メニュー。細かい行き先はページの上のタブ。
//   管理者とメンバーで、表そのものが別であること。
//
//   ここが崩れると、前のように24項目が一列に並び、
//   毎日押す「日報」と半年に一度の「口コミ流入ブロック」が
//   同じ重さで並ぶ状態に戻る。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

/**
 * 左メニューの中身が、スクロールせずに全部見えるか。
 *
 * 器そのものは画面いっぱいの高さなので、測っても意味がない。
 * いちばん下の行の底が、画面の中に入っているかを見る
 */
const measure = (page, sel) => page.evaluate((s) => {
  const box = document.querySelector(s);
  if (!box) return null;
  const rows = [...box.children].filter((n) => n.offsetParent !== null);
  const last = rows[rows.length - 1];
  if (!last) return null;
  return {
    bottom: Math.round(last.getBoundingClientRect().bottom),
    view: window.innerHeight,
    rows: rows.length,
    scrolls: box.scrollHeight > box.clientHeight + 1,
  };
}, sel);
const fits = async (page, sel) => {
  const m = await measure(page, sel);
  return Boolean(m) && m.bottom <= m.view && !m.scrolls;
};
const fitsNote = async (page, sel) => {
  const m = await measure(page, sel);
  return m
    ? `スクロールなしで最後まで見える（下端 ${m.bottom}px / 画面 ${m.view}px、${m.rows}行）`
    : "左メニューが見つからない";
};

/** ログイン済みの画面を1つ開く */
async function open(path, { admin, access }) {
  const page = await br.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  const role = admin ? "admin" : "member";
  await page.addInitScript((r) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: r, name: "テスト", shows: {}, stage: null }));
    // 開け閉めの記憶を空にしておく。前のテストの状態を持ち込まない
    localStorage.removeItem("kp_nav_open");
    localStorage.removeItem("kp_view");
  }, role);
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({
        email: "a@b.c", appRole: role, shows: {}, isAdmin: admin,
        // access（roles では表せない権限）。admin は owner 相当で全部 true にしておく
        // （admin-ai.html の access:"aiInquiries" のような画面もこのモックで開けるように）
        access: access || { recruit: admin, sell: admin, office: admin, keiei: admin, aiInquiries: admin },
        gw: { employee: { id: "e1", display_name: "テスト", status: "active" },
              roles: admin ? ["owner"] : [], isAdmin: admin, tenantId: "t1", stage: null },
      });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(900);
  return page;
}

// ---------------------------------------------------------------------------
console.log("— 管理者：ヘッダーの業務領域切替 —");
{
  // admin-timecard.html は Office（人事・労務グループ）の画面。2026-10-03 の Office UI/UX 再設計で、業務の管理画面は Office の中
  const page = await open("admin-timecard.html", { admin: true });

  // ヘッダーに Office・⚙管理 のショートカットが出る。Office の業務の画面にいるときは、Office が選ばれて見える
  // （⚙管理はシステム設定の画面のときだけ）。⚙管理は幅を取らないよう、通知ベルと同じアイコン＋ドロップダウン（#kp-admin-menu-btn）
  const office = page.locator('.kp-shortcut[data-shortcut="office"]');
  const settings = page.locator('#kp-admin-menu-btn');
  check(await office.isVisible(), "ヘッダーに「Office」が出る");
  check(await settings.isVisible(), "ヘッダーに「管理」（⚙）が出る");
  check((await office.getAttribute("href")) === "/office/", "Office の行き先は /office/（管理画面へは送らない）");
  check(/\bon\b/.test((await office.getAttribute("class")) || ""), "Office の業務の画面にいるときは「Office」が選ばれて見える");
  check(!/\bon\b/.test((await settings.getAttribute("class")) || ""), "Office の業務の画面では「管理」（⚙）は選ばれない");
  check((await page.locator(".kp-app").innerText()).includes("Office"), "タグは「Office」");

  // Office のナビゲーションは、共通ヘッダーの下の横タブ（左サイドバーは無い）
  check(await page.locator(".kp-sidebar").count() === 0, "Office に左サイドバーは無い");
  const cat = await page.locator("#kp-office-nav .kp-otab").evaluateAll((ns) => ns.map((n) => ({
    label: n.querySelector("span").textContent.trim(), href: n.getAttribute("href"), on: n.classList.contains("on") })));
  check(cat.map((x) => x.label).join("/") === "ホーム/人・組織/請求・支払/契約・書類/端末・貸与品", `1段目のタブ（いま ${cat.map((x) => x.label).join("/")}）`);
  check(cat[0]?.href === "/office/", "ホーム → /office/");
  check(cat.find((x) => x.on)?.label === "人・組織", "いまいるカテゴリ（人・組織）が選ばれている");
  // 2段目：いまのカテゴリの中の画面。人・組織の最終形（日報・勤怠が初め。採用HRはヘッダーの近道が正式な入口。ここには置かない）
  const sub2 = await page.locator("#kp-office-nav .kp-ostab").evaluateAll((ns) => ns.map((n) => ({
    label: n.querySelector("span").textContent.trim(), href: n.getAttribute("href"), on: n.classList.contains("on") })));
  check(sub2.map((x) => x.label).join("/") === "日報・勤怠/メンバー/入退社/勤怠管理/評価・キャリア", `人・組織の並び（いま ${sub2.map((x) => x.label).join("/")}）`);
  check(sub2.find((x) => x.on)?.label === "勤怠管理", "いまいる画面（勤怠管理）が選ばれている");
  const allHref = await page.locator("#kp-office-nav a").evaluateAll((ns) => ns.map((n) => n.getAttribute("href") || ""));
  check(!allHref.some((h) => /(^|\/)hr\/$/.test(h)), "Office のタブに「採用」（/hr/）は置かない");
  check(!allHref.some((h) => /(^|\/)sales\/$/.test(h)), "Office のタブに「営業」（/sales/）は置かない");
  const nav = await page.locator("#kp-office-nav").innerText();
  for (const x of ["全員のタスク", "AIナレッジ", "チーム状況", "アクセス分析", "システム設定"]) {
    check(!nav.includes(x), `Office のタブに「${x}」を置かない（経営・⚙管理の側）`);
  }
  // 3段目（画面の中の切り替え）は、Office のタブではなく見出しの下の帯
  check(!/休暇・稟議/.test(nav), "「休暇・稟議」は Office のタブに出ていない（見出しの下の帯）");
  // ほかのカテゴリの中身（2段目）
  for (const [file, head, list] of [
    ["admin-expenses.html", "請求・支払", "請求・支払/経費精算/月次業務/会計"],
    ["admin-docs.html", "契約・書類", "雇用契約/社内文書/定例業務/お知らせ配信"],
    ["admin-devices.html", "端末・貸与品", "端末・貸与品"],
  ]) {
    const q = await open(file, { admin: true });
    const got = (await q.locator("#kp-office-nav .kp-ostab span:first-child").allInnerTexts()).map((x) => x.trim()).join("/");
    check(got === list, `${head} の並び（いま ${got}）`);
    await q.close();
  }

  const sub = page.locator(".kp-subnav");
  check(await sub.isVisible(), "ページの上に切り替えの帯が出る");
  const tabs = (await sub.locator(".kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "勤怠/休暇・稟議", `帯の中身（いま ${tabs.join("/")}）`);
  check(await sub.locator(".kp-subtab.on").innerText() === "勤怠", "いま見ているほうが選ばれている");

  // 帯は見出しの直後。本文より先に出ていないと、行き来できると気づけない
  const order = await page.evaluate(() => {
    const w = document.querySelector(".wrap");
    const h1 = w.querySelector("h1");
    return h1 && h1.nextElementSibling && h1.nextElementSibling.className;
  });
  check(/kp-subnav/.test(order || ""), "帯は見出しのすぐ下");

  await page.screenshot({ path: shotPath("nav-admin.png") });
  await page.close();
}

console.log("\n— 管理者：ホーム領域の左メニューは全員と同じ —");
{
  // 旧ダッシュボード（admin-dashboard.html）は Office ホーム（/office/）へ送る。Office の中で、ホームが光る
  const d = await open("admin-dashboard.html", { admin: true });
  check(new URL(d.url()).pathname === "/office/", `admin-dashboard.html → /office/（いま ${new URL(d.url()).pathname}）`);
  check(await d.locator('.kp-shortcut[data-shortcut="office"].on').count() === 1, "Office ホームでは「Office」が選ばれる");
  check((await d.locator(".kp-app").innerText()).includes("Office"), "ヘッダーに「/ Office」と出る");
  check((await d.locator("#kp-office-nav .kp-otab.on").innerText()).includes("ホーム"), "Office のタブでホームが選ばれる");
  await d.close();

  // home.html はホーム領域。管理者でも、メンバーと同じ左メニューになる
  const page = await open("home.html", { admin: true });
  check(await page.locator(".kp-side-group").count() === 0, "ホームはグループに畳まない");
  check(await page.locator(".kp-sidebar.member").count() === 1, "管理者でもメンバーと同じ左メニュー");
  const items = (await page.locator(".kp-sidebar.member .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts())
    .map((s) => s.trim());
  for (const x of ["ホーム", "今日やること", "社内AI", "勤怠・申請", "キャリア", "社内情報", "マイページ"]) {
    check(items.some((i) => i.includes(x)), `管理者の左にも「${x}」`);
  }
  const side = await page.locator(".kp-sidebar.member").innerText();
  for (const x of ["メンバー管理", "入退社", "勤怠管理", "日報・勤怠", "AIナレッジ", "システム設定"]) {
    check(!side.includes(x), `左メニューに管理用の「${x}」を置かない`);
  }

  // Office・管理のどちらもいまは選ばれていない。ヘッダーのロゴは home.html
  check(await page.locator(".kp-shortcut.on").count() === 0, "ホームでは Office は選ばれていない");
  check(!/\bon\b/.test((await page.locator("#kp-admin-menu-btn").getAttribute("class")) || ""), "ホームでは「管理」は選ばれていない");
  check((await page.locator(".topbar .brand a").getAttribute("href")) === "home.html", "ロゴは全員共通のホームへ");
  await page.close();
}

console.log("\n— AIナレッジは⚙管理。社内AIは左メニュー —");
{
  const page = await open("admin-ai.html", { admin: true });
  const lit = await page.locator(".kp-side-item.on").innerText();
  check(/AIナレッジ/.test(lit), `⚙管理の左では「AIナレッジ」が光る（いま ${lit.trim()}）`);
  check(/\bon\b/.test((await page.locator("#kp-admin-menu-btn").getAttribute("class")) || ""), "ヘッダーの⚙管理が選ばれて見える");
  check(await page.locator(".kp-subnav").count() === 0, "AIチャットとの切替帯は出さない（本人用と管理用を混ぜない）");
  await page.close();
  const chat = await open("messages.html", { admin: true });
  const l2 = await chat.locator(".kp-sidebar.member .kp-side-item.on").innerText();
  check(/社内AI/.test(l2), `管理者の社内AIは、左メニュー（全員と同じ）で光る（いま ${l2.trim()}）`);
  await chat.close();
}

console.log("\n— 経営：全員のタスク・日報・チーム状況 —");
{
  const page = await open("admin-tasks.html", { admin: true });
  // 経営者には、経営（/keiei）と同じ横タブで出す（2026-10-06：左メニューは出さない。test/ui/keieiteamui.mjs も見る）
  check(await page.locator(".kp-sidebar").count() === 0, "経営者には左メニューを出さない");
  const subs = (await page.locator("#kp-keiei-nav .kp-ostab").allInnerTexts()).map((x) => x.trim());
  check(subs.join("/") === "チーム状況/全員のタスク/入社準備/給与管理/概要", `経営の「人・組織」の並び（日報・勤怠は Office）（いま ${subs.join("/")}）`);
  check((await page.locator("#kp-keiei-nav .kp-ostab.on").innerText()).trim() === "全員のタスク", "「全員のタスク」が選ばれている");
  check(/\bon\b/.test((await page.locator('.kp-shortcut[data-shortcut="keiei"]').getAttribute("class")) || ""), "ヘッダーの「経営」が選ばれて見える");
  check((await page.locator(".kp-app").innerText()).includes("経営"), "ヘッダーに「/ 経営」と出る");
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("/") === "タスク・予定/今週のゴール", `全員のタスクの帯（いま ${tabs.join("/")}）`);
  await page.close();
}

console.log("\n— 管理者（経営者・経理の権限なし）：入れる入口だけが出る —");
{
  // 会計側の管理者だけ（access.keiei・access.office なし）。管理画面は開けるが、/keiei と /office は入れない
  const only = { recruit: false, sell: false, office: false, keiei: false, aiInquiries: true };
  const t = await open("admin-tasks.html", { admin: true, access: only });
  const items = (await t.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts()).map((x) => x.trim());
  check(items.join("/") === "チーム状況/全員のタスク/アクセス分析", `経営ホーム（/keiei）は経営者だけ。管理者はチーム状況・全員のタスク・アクセス分析（いま ${items.join("/")}）`);
  check((await t.locator('.kp-shortcut[data-shortcut="keiei"]').getAttribute("href")) === "admin-team.html", "管理者の「経営」は、チーム状況から入る（導線がある）");
  // 管理者は人事・労務／経理・事務（officeHr・officeFinance）に入れるので、Office は出る（Office ホームは担当の分だけ）
  check((await t.locator('.kp-shortcut[data-shortcut="office"]').getAttribute("href")) === "/office/", "access.office が無い管理者にも「Office」（人事・労務／経理・事務）→ /office/");
  await t.close();
  const c = await open("admin-closing.html", { admin: true, access: only });
  const tabs = (await c.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((x) => x.trim());
  check(tabs.join("/") === "月次締め/月初作業管理", `/office に入れない人には「月末月初業務」を出さない（いま ${tabs.join("/")}）`);
  await c.close();

  // access.office のある管理者（経営者・責任者・経理を兼ねる）には、月次業務の帯の先頭に月末月初業務（/office/monthly.html）が出る
  const c2 = await open("admin-closing.html", { admin: true });
  const tabs2 = await c2.locator(".kp-subnav .kp-subtab").evaluateAll((ns) => ns.map((n) => `${n.textContent.trim()}|${n.getAttribute("href") || ""}`));
  check(tabs2.join(",") === "月末月初業務|/office/monthly.html,月次締め|,月初作業管理|admin-month-start.html", `月次業務の帯に 月末月初業務（いま ${tabs2.join(",")}）`);
  await c2.close();
}

console.log("\n— 同じ鍵でもメンバー画面は本人用（管理者でもOfficeの左メニューにしない） —");
{
  for (const f of ["timecard.html", "expenses.html", "tasks.html", "nippo.html", "notices.html", "career.html"]) {
    const page = await open(f, { admin: true });
    check(await page.locator(".kp-sidebar.member").count() === 1, `${f}: 管理者でもメンバーと同じ左メニュー`);
    check(await page.locator(".kp-side-group").count() === 0, `${f}: Officeのグループは出ない`);
    await page.close();
  }
}

console.log("\n— 管理者：⚙管理 領域は平らな2項目（AIナレッジ・システム設定。2026-10-07）—");
{
  const page = await open("admin-settings.html", { admin: true });

  check(await page.locator(".kp-side-group").count() === 0, "管理はグループに畳まない");
  const items = (await page.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts())
    .map((s) => s.trim());
  check(items.join("/") === "AIナレッジ/システム設定",
    `管理の並び（いま ${items.join("/")}）`);

  const settings = page.locator('#kp-admin-menu-btn');
  check(/\bon\b/.test((await settings.getAttribute("class")) || ""), "管理にいるときは「管理」が選ばれて見える");

  await page.close();
}

console.log("\n— 帯から、隣の画面へ行ける —");
{
  const page = await open("admin-requests.html", { admin: true });
  const on = await page.locator(".kp-subnav .kp-subtab.on").innerText();
  check(on.trim() === "休暇・稟議", `隣を開いても帯が出る（いま ${on}）`);
  // Office のタブ（2段目）では、まとめた側が選ばれている
  const lit = await page.locator("#kp-office-nav .kp-ostab.on").innerText();
  check(/勤怠管理/.test(lit), `タブでは「勤怠管理」が選ばれる（いま ${lit.trim()}）`);
  await page.close();
}

console.log("\n— 雇用契約は、業務順の3タブ —");
{
  const page = await open("admin-contracts.html", { admin: true });
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "契約・面談/契約書作成依頼/電子署名",
    `①契約・面談 ②契約書作成依頼 ③電子署名 の順（いま ${tabs.join("/")}）`);
  check(await page.locator(".kp-subnav .kp-subtab.on").innerText() === "契約・面談",
    "いま見ているほうが選ばれている");
  await page.close();
}
{
  // 「契約書作成依頼」は admin-esign.html 自身の中のタブへ ?tab=order で飛ぶ。
  // 新しい画面は作らない。「電子署名」の中に埋め込まれていない（別タブ）ことを確かめる
  const page = await open("admin-esign.html?tab=order", { admin: true });
  const on = await page.locator(".kp-subnav .kp-subtab.on").innerText();
  check(on.trim() === "契約書作成依頼", `?tab=order で開くと、こちらが選ばれる（いま ${on}）`);
  await page.close();
}
{
  const page = await open("admin-esign.html", { admin: true });
  const on = await page.locator(".kp-subnav .kp-subtab.on").innerText();
  check(on.trim() === "電子署名", `そのまま開くと「電子署名」が選ばれる（いま ${on}）`);
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("\n— メンバーの左メニュー —");
{
  const page = await open("tasks.html", { admin: false });

  const items = (await page.locator(".kp-sidebar.member .kp-side-item").allInnerTexts())
    .map((s) => s.trim());
  check(items.length <= 9, `項目は9つまで（いま ${items.length}: ${items.join("・")}）`);
  // 評価・キャリア再設計 §37 の7つ
  for (const x of ["ホーム", "今日やること", "社内AI", "勤怠・申請", "キャリア", "社内情報", "マイページ"]) {
    check(items.some((i) => i.includes(x)), `「${x}」`);
  }
  check(!items.some((i) => i.includes("スペース予約")), "スペース予約は通常メニューに出さない");

  // 管理側のものが1つも混ざっていないこと
  const side = await page.locator(".kp-sidebar.member").innerText();
  for (const x of ["メンバー管理", "入退社", "端末管理", "システム設定", "試用期間", "月次締め"]) {
    check(!side.includes(x), `メンバーに「${x}」を出さない`);
  }

  // タスク・日報・予定は「今日やること」の中のタブ
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "タスク/日報/スケジュール", `今日やることの帯（いま ${tabs.join("/")}）`);
  check(!side.includes("スケジュール"), "「スケジュール」は左メニューに出ていない");

  check(await fits(page, ".kp-sidebar.member"), await fitsNote(page, ".kp-sidebar.member"));

  await page.screenshot({ path: shotPath("nav-member.png") });
  await page.close();
}

console.log("\n— 契約書は、マイページの中から開ける —");
{
  const page = await open("mypage.html", { admin: false });
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.includes("契約・署名"), `署名の入口が残っている（いま ${tabs.join("/")}）`);
  const side = await page.locator(".kp-sidebar.member").innerText();
  check(!side.includes("契約書"), "左メニューには出さない");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
