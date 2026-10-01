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

  // ヘッダーに Office・⚙管理 のショートカットが出て、いま Office を見ている。
  // ⚙管理は幅を取らないよう、通知ベルと同じアイコン＋ドロップダウン（#kp-admin-menu-btn）
  const office = page.locator('.kp-shortcut[data-shortcut="area-office"]');
  const settings = page.locator('#kp-admin-menu-btn');
  check(await office.isVisible(), "ヘッダーに「Office」が出る");
  check(await settings.isVisible(), "ヘッダーに「管理」（⚙）が出る");
  check(/\bon\b/.test((await office.getAttribute("class")) || ""), "Officeにいるときは「Office」が選ばれて見える");
  check(!/\bon\b/.test((await settings.getAttribute("class")) || ""), "「管理」は選ばれていない");

  const heads = await page.locator(".kp-side-group .lb").allInnerTexts();
  // Office は3グループだけ（ホーム＝全員と同じ左メニュー・管理は領域が別なので、ここには出ない）
  check(heads.length === 3, `見出しは3つ（いま ${heads.length}: ${heads.join("・")}）`);
  for (const x of ["人事・労務", "経理・事務", "全社運営"]) {
    check(heads.some((h) => h.trim() === x), `グループ「${x}」`);
  }

  // 見えている項目は、いまいるグループのぶんだけ。ほかは畳んである
  const shown = (await page.locator(".kp-side-sub:not(.hidden) .kp-side-item").allInnerTexts())
    .map((s) => s.trim());
  check(shown.length <= 6, `開いているのは1グループぶんだけ（いま ${shown.length} 行）`);
  check(shown.some((s) => s.includes("勤怠管理")), "いまいるグループが開いている");
  // 人事・労務の最終形（採用HRはヘッダーの近道が正式な入口。左には置かない）
  // アイコンはフォントが読めない環境では名前の文字として出るので、最後の行（項目名）だけを比べる
  const hrItems = shown.map((t) => t.split("\n").pop().trim()).join("/");
  check(hrItems === "メンバー/入退社/勤怠管理/雇用契約/評価・キャリア",
    `人事・労務の並び（いま ${hrItems}）`);

  // 左メニュー全体（畳まれているグループも含む）に、採用HR・Sales の入口が無い
  const allHref = await page.locator(".kp-sidebar a").evaluateAll((ns) => ns.map((n) => n.getAttribute("href") || ""));
  check(!allHref.some((h) => /(^|\/)hr\/$/.test(h)), "左メニューに「採用」（/hr/）は置かない");
  check(!allHref.some((h) => /(^|\/)sales\/$/.test(h)), "左メニューに「営業」（/sales/）は置かない");
  check(!allHref.some((h) => /(^|\/)office\/$/.test(h)), "左メニューに月次業務（/office/）は置かない");
  // 先頭のダッシュボードは、グループの外の1行
  const top = (await page.locator(".kp-sidebar > .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts()).map((x) => x.trim());
  check(top.join("/") === "ダッシュボード", `Officeの先頭（いま ${top.join("/")}）`);
  // Office の最終メニュー（人事・労務5・経理・事務4・全社運営4）
  // 項目は見出しの隣の .kp-side-sub（同じ data-group）に入っている。畳まれていても数える
  const groupItems = await page.locator(".kp-side-group").evaluateAll((gs) => gs.map((g) => ({
    head: g.querySelector(".lb")?.textContent.trim(),
    items: [...document.querySelectorAll(`.kp-side-sub[data-group="${g.dataset.group}"] .kp-side-item > span:not(.material-symbols-outlined)`)]
      .map((x) => x.textContent.trim()),
  })));
  const want = {
    "人事・労務": "メンバー/入退社/勤怠管理/雇用契約/評価・キャリア",
    "経理・事務": "経費精算/月次業務/社内文書/会計",
    "全社運営": "全員のタスク/全員の日報/お知らせ配信/AIナレッジ",
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

console.log("\n— 管理者：ホーム領域の左メニューは全員と同じ —");
{
  // admin-dashboard.html は Office 領域（先頭のダッシュボード）
  const d = await open("admin-dashboard.html", { admin: true });
  check(await d.locator('.kp-shortcut[data-shortcut="area-office"].on').count() === 1, "ダッシュボードにいるときは「Office」が選ばれて見える");
  check((await d.locator(".kp-app").innerText()).includes("OFFICE"), "ヘッダーに「/ OFFICE」と出る");
  check((await d.locator(".kp-side-item.on").innerText()).includes("ダッシュボード"), "Officeの左でダッシュボードが光る");
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
  for (const x of ["メンバー管理", "入退社", "勤怠管理", "全員の日報", "AIナレッジ", "システム設定"]) {
    check(!side.includes(x), `左メニューに管理用の「${x}」を置かない`);
  }

  // Office・管理のどちらもいまは選ばれていない。ヘッダーのロゴは home.html
  check(await page.locator(".kp-shortcut.on").count() === 0, "ホームでは Office は選ばれていない");
  check(!/\bon\b/.test((await page.locator("#kp-admin-menu-btn").getAttribute("class")) || ""), "ホームでは「管理」は選ばれていない");
  check((await page.locator(".topbar .brand a").getAttribute("href")) === "home.html", "ロゴは全員共通のホームへ");
  await page.close();
}

console.log("\n— AIナレッジは Office（全社運営）の中。社内AIは左メニュー —");
{
  const page = await open("admin-ai.html", { admin: true });
  const lit = await page.locator(".kp-side-item.on").innerText();
  check(/AIナレッジ/.test(lit), `Officeの左では「AIナレッジ」が光る（いま ${lit.trim()}）`);
  check(await page.locator(".kp-subnav").count() === 0, "AIチャットとの切替帯は出さない（本人用と管理用を混ぜない）");
  await page.close();
  const chat = await open("messages.html", { admin: true });
  const l2 = await chat.locator(".kp-sidebar.member .kp-side-item.on").innerText();
  check(/社内AI/.test(l2), `管理者の社内AIは、左メニュー（全員と同じ）で光る（いま ${l2.trim()}）`);
  await chat.close();
}

console.log("\n— 管理者：⚙管理 領域は平らな4項目 —");
{
  const page = await open("admin-devices.html", { admin: true });

  check(await page.locator(".kp-side-group").count() === 0, "管理はグループに畳まない");
  const items = (await page.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts())
    .map((s) => s.trim());
  check(items.join("/") === "権限/端末・貸与品/アクセス分析/システム設定",
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
  // 左メニューでは、まとめた側が光っている
  const lit = await page.locator(".kp-side-item.on").innerText();
  check(/勤怠管理/.test(lit), `左では「勤怠管理」が光る（いま ${lit.trim()}）`);
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
