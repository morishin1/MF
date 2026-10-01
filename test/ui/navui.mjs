// 左メニューを、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//
//   「登録済みの機能を全部並べる」に戻らないこと。
//   ヘッダー＝業務領域（ホーム／Office／⚙管理）の切替、
//   サイドメニュー＝選んでいる領域の中だけ。細かい行き先はページの上のタブ。
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
async function open(path, { admin }) {
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
        access: { recruit: admin, sell: admin, office: admin, keiei: admin, aiInquiries: admin },
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
  // admin-timecard.html は Office 領域（人事・労務グループ）の画面
  const page = await open("admin-timecard.html", { admin: true });

  // ヘッダーに Office・⚙管理 のショートカットが出て、いま Office を見ている
  const office = page.locator('.kp-shortcut[data-shortcut="area-office"]');
  const settings = page.locator('.kp-shortcut[data-shortcut="area-settings"]');
  check(await office.isVisible(), "ヘッダーに「Office」が出る");
  check(await settings.isVisible(), "ヘッダーに「管理」（⚙）が出る");
  check(/\bon\b/.test((await office.getAttribute("class")) || ""), "Officeにいるときは「Office」が選ばれて見える");
  check(!/\bon\b/.test((await settings.getAttribute("class")) || ""), "「管理」は選ばれていない");

  const heads = await page.locator(".kp-side-group .lb").allInnerTexts();
  // Office は2グループだけ（ホーム・管理は領域が別なので、ここには出ない）
  check(heads.length === 2, `見出しは2つ（いま ${heads.length}: ${heads.join("・")}）`);
  for (const x of ["人事・労務", "経理・事務"]) {
    check(heads.some((h) => h.trim() === x), `グループ「${x}」`);
  }

  // 見えている項目は、いまいるグループのぶんだけ。ほかは畳んである
  const shown = (await page.locator(".kp-side-sub:not(.hidden) .kp-side-item").allInnerTexts())
    .map((s) => s.trim());
  check(shown.length <= 6, `開いているのは1グループぶんだけ（いま ${shown.length} 行）`);
  check(shown.some((s) => s.includes("勤怠・休暇")), "いまいるグループが開いている");
  // 人事・労務の最終形（採用HRはヘッダーの近道が正式な入口。左には置かない）
  // アイコンはフォントが読めない環境では名前の文字として出るので、最後の行（項目名）だけを比べる
  const hrItems = shown.map((t) => t.split("\n").pop().trim()).join("/");
  check(hrItems === "メンバー/入退社/勤怠・休暇/雇用契約/評価・キャリア",
    `人事・労務の並び（いま ${hrItems}）`);

  // 左メニュー全体（畳まれているグループも含む）に、採用HR・Sales の入口が無い
  const allHref = await page.locator(".kp-sidebar a").evaluateAll((ns) => ns.map((n) => n.getAttribute("href") || ""));
  check(!allHref.some((h) => /(^|\/)hr\/$/.test(h)), "左メニューに「採用」（/hr/）は置かない");
  check(!allHref.some((h) => /(^|\/)sales\/$/.test(h)), "左メニューに「営業」（/sales/）は置かない");
  check(!allHref.some((h) => /(^|\/)office\/$/.test(h)), "左メニューに月次業務（/office/）は置かない");
  // Office の最終メニュー（人事・労務5・経理・事務4）
  // 項目は見出しの隣の .kp-side-sub（同じ data-group）に入っている。畳まれていても数える
  const groupItems = await page.locator(".kp-side-group").evaluateAll((gs) => gs.map((g) => ({
    head: g.querySelector(".lb")?.textContent.trim(),
    items: [...document.querySelectorAll(`.kp-side-sub[data-group="${g.dataset.group}"] .kp-side-item > span:not(.material-symbols-outlined)`)]
      .map((x) => x.textContent.trim()),
  })));
  const want = {
    "人事・労務": "メンバー/入退社/勤怠・休暇/雇用契約/評価・キャリア",
    "経理・事務": "経費精算/月次業務/社内文書/会計",
  };
  for (const [head, list] of Object.entries(want)) {
    const g = groupItems.find((x) => x.head === head);
    const got = (g?.items || []).join("/");
    check(got === list, `${head} の並び（いま ${got}）`);
  }

  // ここがいちばん大事。スクロールなしで全部見えるか。
  //
  // 器（.kp-sidebar）の高さは画面いっぱいなので、測っても分からない。
  // 中身の最後の行が、画面の下より上にあるかを見る
  check(await fits(page, ".kp-sidebar"), await fitsNote(page, ".kp-sidebar"));

  // 2階層目は左に出さない。ページの上の帯に出す
  const side = await page.locator(".kp-sidebar").innerText();
  check(!/休暇・稟議/.test(side), "「休暇・稟議」は左メニューに出ていない");
  check(!/自走レベル/.test(side), "「自走レベル」は左メニューに出ていない");
  check(!/電子署名/.test(side), "「電子署名」は左メニューに出ていない");

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

console.log("\n— 管理者：ホーム領域は平らな5項目 —");
{
  const page = await open("admin-dashboard.html", { admin: true });

  // ホーム・管理は項目が少ないので、Officeのような畳みグループにしない
  check(await page.locator(".kp-side-group").count() === 0, "ホームはグループに畳まない");
  const items = (await page.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts())
    .map((s) => s.trim());
  check(items.join("/") === "ダッシュボード/今日のタスク/日報/社内AI/お知らせ",
    `ホームの並び（いま ${items.join("/")}）`);

  // Office・管理のどちらもいまは選ばれていない
  const office = page.locator('.kp-shortcut[data-shortcut="area-office"]');
  const settings = page.locator('.kp-shortcut[data-shortcut="area-settings"]');
  check(!/\bon\b/.test((await office.getAttribute("class")) || ""), "ホームでは「Office」は選ばれていない");
  check(!/\bon\b/.test((await settings.getAttribute("class")) || ""), "ホームでは「管理」は選ばれていない");

  await page.close();
}

console.log("\n— 社内AI・AIナレッジは1つの項目のタブ —");
{
  const page = await open("admin-ai.html", { admin: true });
  // admin-ai.html の active は ai_admin。「社内AI」項目のタブとして選ばれた状態になる
  const lit = await page.locator(".kp-side-item.on").innerText();
  check(/社内AI/.test(lit), `左では「社内AI」が光る（いま ${lit.trim()}）`);
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "AIチャット/AIナレッジ", `帯の中身（いま ${tabs.join("/")}）`);
  check(await page.locator(".kp-subnav .kp-subtab.on").innerText() === "AIナレッジ",
    "いま見ているほうが選ばれている");
  await page.close();
}

console.log("\n— 管理者：⚙管理 領域は平らな4項目 —");
{
  const page = await open("admin-devices.html", { admin: true });

  check(await page.locator(".kp-side-group").count() === 0, "管理はグループに畳まない");
  const items = (await page.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts())
    .map((s) => s.trim());
  check(items.join("/") === "権限/端末・貸与品/アクセス分析/システム設定",
    `管理の並び（いま ${items.join("/")}）`);

  const settings = page.locator('.kp-shortcut[data-shortcut="area-settings"]');
  check(/\bon\b/.test((await settings.getAttribute("class")) || ""), "管理にいるときは「管理」が選ばれて見える");

  await page.close();
}

console.log("\n— 帯から、隣の画面へ行ける —");
{
  const page = await open("admin-requests.html", { admin: true });
  const on = await page.locator(".kp-subnav .kp-subtab.on").innerText();
  check(on.trim() === "休暇・稟議", `隣を開いても帯が出る（いま ${on}）`);
  // 左メニューでは、まとめた側が光っている
  const lit = await page.locator(".kp-side-item.on").innerText();
  check(/勤怠・休暇/.test(lit), `左では「勤怠・休暇」が光る（いま ${lit.trim()}）`);
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
