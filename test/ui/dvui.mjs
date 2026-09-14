// 端末管理の画面を、実際のブラウザで通す。
//
// ■ 何を守りたいのか
//
//   「登録済みの会社PCだけを、短い画面で見る」。
//   ここが崩れると、前のように
//     ・上の説明を読み飛ばさないと一覧に着かない
//     ・登録途中のものと正常なものが同じ表に並ぶ
//     ・詳細が縦に長く、下まで誰も見ない
//   に戻る。戻っていないことを、毎回ここで確かめる。
import { launch, BASE } from "../_browser.mjs";

const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();

const me = {
  email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null },
};

// 登録済み3台＋要確認になるもの3台
const LIST = {
  devices: [
    // ① 登録が終わっていて、何も問題がない
    { id: "ok1", label: "USER-PC", hostname: "USER-PC", source: "agent",
      os: "Windows 11", agentVersion: "0.3.1", serial: "JPH0341",
      status: "active", confirmed: true, notifiedAt: ago(600),
      lastSeenAt: ago(2), lastSeen: "2分前",
      employee: { id: "emp-1", name: "森田", department: "営業" },
      links: [{ browser: "chrome", label: "Chrome", installed: true, linked: true },
              { browser: "edge", label: "Edge", installed: true, linked: true }],
      own: { key: "ok", label: "会社貸与" },
      openAlerts: { critical: 0, warn: 0 }, state: { key: "ok", label: "正常" } },

    // ② 登録は終わっているが、ブラウザがつながっていない
    { id: "ok2", label: "SALES-PC", hostname: "SALES-PC", source: "agent",
      os: "Windows 11", agentVersion: "0.3.1",
      status: "active", confirmed: true, notifiedAt: ago(900),
      lastSeenAt: ago(5), lastSeen: "5分前",
      employee: { id: "emp-2", name: "鈴木", department: "営業" },
      links: [{ browser: "chrome", label: "Chrome", installed: true, linked: false }],
      own: { key: "ok", label: "会社貸与" },
      openAlerts: { critical: 0, warn: 0 }, state: { key: "ok", label: "正常" } },

    // ③ 登録は終わっているが、届いていない
    { id: "ok3", label: "OLD-PC", hostname: "OLD-PC", source: "agent",
      os: "Windows 10", agentVersion: "0.3.0",
      status: "active", confirmed: true, notifiedAt: ago(9000),
      lastSeenAt: ago(60 * 30), lastSeen: "1日前",
      employee: { id: "emp-3", name: "田中", department: "制作" },
      links: [{ browser: "chrome", label: "Chrome", installed: true, linked: true }],
      own: { key: "ok", label: "会社貸与" },
      openAlerts: { critical: 0, warn: 0 },
      state: { key: "silent", label: "未通信", note: "24時間以上、届いていません" } },

    // ④ 登録の途中（本人がまだ押していない）
    { id: "w1", label: "NEW-PC", hostname: "NEW-PC", source: "agent",
      os: "Windows 11", agentVersion: "0.3.1",
      status: "unconfirmed", confirmed: false, notifiedAt: null,
      lastSeenAt: ago(10), lastSeen: "10分前",
      employee: { id: "emp-4", name: "佐藤", department: "管理" },
      links: [], own: { key: "ok", label: "会社貸与" },
      openAlerts: { critical: 0, warn: 0 },
      state: { key: "waiting", label: "本人の確認待ち" } },

    // ⑤ 区分が決まっていない
    { id: "u1", label: "UNKNOWN-PC", hostname: "UNKNOWN-PC", source: "agent",
      os: "Windows 11", agentVersion: "0.3.1",
      status: "active", confirmed: true, notifiedAt: ago(300),
      lastSeenAt: ago(4), lastSeen: "4分前",
      employee: { id: "emp-5", name: "高橋", department: "営業" },
      links: [{ browser: "chrome", label: "Chrome", installed: true, linked: true }],
      own: { key: "check", label: "未確認", note: "会社貸与か私物か、まだ分かっていません" },
      openAlerts: { critical: 0, warn: 0 }, state: { key: "ok", label: "正常" } },

    // ⑥ 登録されていない端末から社内システムを開いている
    { id: "b1", label: "macOS の Safari", source: "browser", os: "macOS",
      browser: "Safari", status: "active", confirmed: true, notifiedAt: ago(100),
      lastSeenAt: ago(30), lastSeen: "30分前", linkedTo: null,
      employee: { id: "emp-6", name: "渡辺", department: "営業" },
      own: { key: "check", label: "未確認" },
      openAlerts: { critical: 0, warn: 0 }, state: { key: "ok", label: "正常" } },
  ],
  alerts: [],
  summary: { total: 6 },
  canWipe: true,
  deleted: 0,
  ownerships: [{ key: "company" }, { key: "personal" }, { key: "unknown" }],
};

const DETAIL = {
  device: { ...LIST.devices[0] },
  usage: [{ date: "09-14", active: "6:30", activeMin: 390, idleMin: 30,
            nightMin: 0, holidayMin: 0, firstAt: ago(500), lastAt: ago(2) }],
  apps: [{ exeName: "EXCEL.EXE", product: "Excel", minutes: 120, label: "2:00" }],
  web: [{ label: "業務系", minutes: 190, time: "3:10" },
        { label: "AI", minutes: 42, time: "0:42" }],
  browsers: [],
  canWipe: true,
  events: [
    { at: ago(20), kind: "usb_attach", label: "USB接続", detail: { class: "mass_storage" } },
    { at: ago(40), kind: "logon", label: "ログオン", detail: null },
  ],
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const sent = [];

const page = await br.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error"
  && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/i.test(m.text())
  && errs.push(m.text()));

await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({
    appRole: "admin", name: "事務", shows: {}, stage: null }));
});
await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                      body: JSON.stringify(b) });
  const body = req.postData() ? JSON.parse(req.postData()) : {};
  if (req.method() === "PATCH") { sent.push(body); return send({ ok: true }); }
  if (/\/api\/me\b/.test(url)) return send(me);
  if (/\/api\/devices\/alerts/.test(url)) return send({ alerts: [] });
  if (/\/api\/devices\/policy/.test(url)) return send({ policy: {} });
  if (/\/api\/devices\?.*deviceId/.test(url)) return send(DETAIL);
  if (/\/api\/devices/.test(url)) return send(LIST);
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
page.on("dialog", (d) => d.accept("テストのため"));

await page.goto(`${BASE}/admin-devices.html`);
await page.waitForTimeout(1200);

// ---- 最初に見えるもの ----------------------------------------------------------
console.log("— 開いた瞬間に何が見えるか —");
{
  // 長い説明が最初から出ていると、毎回それを読み飛ばしてから一覧に着くことになる
  check(!(await page.locator("#d-about").isVisible()), "長い説明は、最初は出ていない");
  check(await page.locator("#about-btn").isVisible(), "「端末管理について」はある");

  await page.click("#about-btn");
  check(await page.locator("#d-about").isVisible(), "押すと開く");
  await page.click("#about-btn");
  check(!(await page.locator("#d-about").isVisible()), "もう一度押すと畳む");

  // KPI は4つまで。6つ並ぶと、どれを見ればよいか分からない
  const boxes = await page.locator("#d-sum .box").count();
  check(boxes === 4, `KPI は4つ（${boxes}）`);
  const kpi = await page.locator("#d-sum").innerText();
  for (const k of ["登録端末", "正常", "要確認", "未通信"]) {
    check(kpi.includes(k), `KPI に「${k}」`);
  }
  check(!/会社貸与と未確認|未登録端末からの接続/.test(kpi), "細かい内訳は KPI に出さない");

  // ファーストビューに、一覧の先頭まで入っていること。
  // ここが入らないなら、スクロールしないと何も分からない画面にもどっている
  const y = await page.locator("#d-rows tr").first().evaluate(
    (n) => n.getBoundingClientRect().top);
  check(y > 0 && y < 900, `一覧の先頭が最初の画面に入る（上から ${Math.round(y)}px）`);
}

// ---- 登録済みの一覧 -------------------------------------------------------------
console.log("— 登録済みの一覧 —");
{
  const rows = page.locator("#d-rows tr");
  const n = await rows.count();
  // 登録が終わっているのは ①②③⑤ の4台。④は登録途中、⑥はブラウザだけ
  check(n === 4, `登録が終わった端末だけ（${n} 行）`);

  const t = await page.locator("#d-rows").innerText();
  check(t.includes("USER-PC") && t.includes("森田"), "PC名と利用者が出る");
  check(!t.includes("NEW-PC"), "登録途中は混ぜない");
  check(!t.includes("Safari"), "未登録のブラウザは混ぜない");

  // 見出しは CSS で大文字になる。中身を見るので、大小は問わない
  const head = (await page.locator("#p-list table thead").first().innerText()).toLowerCase();
  for (const h of ["PC名", "利用者", "Agent", "Browser", "最終通信", "状態"]) {
    check(head.includes(h.toLowerCase()), `列「${h}」`);
  }

  // ○△× が出ていること。手を打つものが上に来ていること
  check(/[○△×]/.test(t), "○ △ × で状態が分かる");
  const first = await rows.first().innerText();
  check(first.includes("OLD-PC"), "未通信がいちばん上");
}

// ---- 要確認 ---------------------------------------------------------------------
console.log("— 要確認 —");
{
  const tabTxt = await page.locator("#t-check").innerText();
  check(/要確認（\d+）/.test(tabTxt), `タブに件数（${tabTxt}）`);

  await page.click("#t-check");
  await page.waitForTimeout(250);
  const t = await page.locator("#c-rows").innerText();

  check(t.includes("NEW-PC"), "登録途中が出る");
  check(t.includes("UNKNOWN-PC"), "区分が決まっていないものが出る");
  check(t.includes("OLD-PC"), "未通信が出る");
  check(t.includes("SALES-PC"), "ブラウザ未連携が出る");
  check(t.includes("Safari"), "未登録端末からの接続が出る");

  // 「何が問題か」と「次に何をすればよいか」が1行で分かること
  check(/本人の確認が終わっていません/.test(t), "何が問題かが書いてある");
  check(/会社貸与か私物か、まだ決まっていません/.test(t), "区分未確認の言い方");
  check(/連携していません/.test(t), "ブラウザ未連携の言い方");

  const btns = await page.locator("#c-rows button").allInnerTexts();
  for (const b of ["会社貸与にする", "私物として扱う", "お知らせを送る"]) {
    check(btns.includes(b), `その場で押せる「${b}」`);
  }

  // 押したら、本当にサーバへ行くこと
  sent.length = 0;
  await page.locator("#c-rows button", { hasText: "会社貸与にする" }).first().click();
  await page.waitForTimeout(400);
  check(sent.some((x) => x.action === "ownership" && x.ownership === "company"),
        "「会社貸与にする」で区分が送られる");
}

// ---- 詳細 -----------------------------------------------------------------------
console.log("— 詳細 —");
{
  await page.click("#t-list");
  await page.waitForTimeout(200);
  await page.locator("#d-rows tr", { hasText: "USER-PC" }).first().click();
  await page.waitForTimeout(500);

  const head = await page.locator(".dv-dhead").innerText();
  check(head.includes("USER-PC"), "頭にPC名");
  check(head.includes("森田"), "頭に利用者");
  check(/Agent/.test(head), "頭に Agent の状態");
  check(/最終通信/.test(head), "頭に最終通信");

  // 縦に全部積まない
  const tabs = await page.locator("#dt-tabs button").allInnerTexts();
  for (const x of ["概要", "利用状況", "WEB", "アプリ", "セキュリティ", "履歴"]) {
    check(tabs.includes(x), `タブ「${x}」`);
  }

  // 管理操作は「…」の中。横一列に並べない
  check(!(await page.locator("#ops-menu").isVisible()), "管理操作は最初は畳んである");
  const flat = await page.locator(".dv-dhead").innerText();
  check(!flat.includes("使用終了にする"), "危ない操作が、開かないと出ない");
  await page.click("#ops-btn");
  check(await page.locator("#ops-menu").isVisible(), "「…」で開く");
  const ops = await page.locator("#ops-menu").innerText();
  for (const x of ["使う人を変える", "名前を変える", "会社貸与／私物", "停止する", "使用終了にする", "メモ"]) {
    check(ops.includes(x), `操作「${x}」`);
  }

  // 端末の一生。退職・PC交換・故障・紛失を、この画面だけで終わらせる
  for (const x of ["紛失した", "端末を削除"]) {
    check(ops.includes(x), `操作「${x}」`);
  }

  // 削除は、押した瞬間には消さない。
  // 一覧からワンクリックでは出さず、詳細 →「…」→ 端末を削除 → 確認 の順
  const before = sent.length;
  await page.locator("#ops-menu button", { hasText: "端末を削除" }).click();
  await page.waitForTimeout(150);
  check(sent.length === before, "「端末を削除」を押しただけでは、まだ送らない");
  const ask = await page.locator("#ops-menu").innerText();
  check(/登録を解除します/.test(ask), "何が起きるかを、押す前に出す");
  check(/EIGHT Agent も自動的に削除されます/.test(ask), "Agent が消えることを書く");
  check(/記録（監査・WEB利用・セキュリティ）は消えません/.test(ask),
        "端末の削除と、過去ログの削除は別だと書く");
  check(await page.locator("#ops-menu button", { hasText: "キャンセル" }).isVisible(),
        "やめられる");

  await page.locator("#ops-menu button.danger", { hasText: "端末を削除" }).click();
  await page.waitForTimeout(200);
  const wipe = sent.find((b) => b.action === "wipe");
  check(Boolean(wipe), "確認してはじめて送る");
  check(wipe && wipe.deviceId === "ok1", "その端末を指している");

  // 一覧からは削除できない。行にボタンを置かない
  const listText = await page.locator("#d-rows").innerText();
  check(!/削除/.test(listText), "一覧の行に「削除」を出さない");

  await page.click("#ops-btn");
  await page.waitForTimeout(100);

  // 区分は選ばせる。prompt に company と打たせない
  await page.locator("#ops-menu button", { hasText: "会社貸与／私物" }).click();
  const own = await page.locator("#ops-menu").innerText();
  check(/会社貸与（業務に使ってよい）/.test(own), "区分は選んで決める");
  check(!/company/.test(own), "英語の値を打たせない");

  // WEB は独立したタブ。概要には出さない
  const sum = await page.locator("#dt-body").innerText();
  check(!/AI|業務系/.test(sum), "概要に WEB の内訳を出さない");
  await page.locator("#dt-tabs button", { hasText: "WEB" }).click();
  await page.waitForTimeout(200);
  const web = await page.locator("#dt-body").innerText();
  check(/業務系/.test(web) && /AI/.test(web), "WEB タブに種類ごとの時間");

  await page.locator("#dt-tabs button", { hasText: "セキュリティ" }).click();
  await page.waitForTimeout(200);
  const sec = await page.locator("#dt-body").innerText();
  check(/USB/.test(sec), "セキュリティに USB の出入り");
  check(!/ログオン/.test(sec), "働きかたの記録は混ぜない");
}

check(errs.length === 0, `画面のエラーなし${errs.length ? "：" + errs[0] : ""}`);

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
