// 端末管理を、社員ごとに見る画面。
//
// ■ 何を守りたいのか
//
//   管理者が普段見るのは「全員○か、誰か×になっているか」だけ。
//   そこに着くまでにスクロールが要るなら、この画面は仕事をしていない。
//
//     1. 1行＝1人（同じ人のPCとブラウザが、離れて2行にならない）
//     2. ファーストビューに KPI → 要確認 → 社員一覧 が入る
//     3. 正常な人の中身は、開かないと出ない
//     4. × は「削除された」と決めつけない
//     5. 登録解除・再登録・利用停止は、管理者の画面にだけある
import { launch, BASE } from "../_browser.mjs";

const me = {
  email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null },
};

// 社員4人。正常・連携異常・未設定・未登録PC
const PEOPLE = {
  date: "2026-09-14",
  people: [
    { employeeId: "emp-1", name: "山田 太郎", department: "営業",
      work: { key: "working", label: "操作中" },
      ext: { key: "ok", mark: "○", label: "連携済み" },
      lastSeen: "2分前", lastSeenAt: null,
      web: { min: 180, label: "3:00", offMin: 0, top: [{ category: "work", min: 180 }] },
      clockMin: 200,
      devices: [{ id: "d1", source: "browser", label: "Windows の Chrome",
                  status: "active", confirmed: true, ownership: "company",
                  extLinked: true, registered: true, browsers: [],
                  lastSeen: "2分前", extSeen: "1分前", extMissingFrom: null }],
      issues: [], mark: { k: "ok", m: "○", t: "正常" } },
  ],
  check: [
    // ×：一度つないだのに、届かない状態が続いている
    { employeeId: "emp-2", name: "佐藤 花子", department: "管理",
      work: { key: "working", label: "操作中" },
      ext: { key: "removed", mark: "×", label: "連携異常" },
      lastSeen: "5分前", lastSeenAt: null,
      web: { min: 0, label: "0:00", offMin: 0, top: [] },
      clockMin: 180,
      devices: [{ id: "d2", source: "browser", label: "Windows の Edge",
                  status: "active", confirmed: true, ownership: "company",
                  extLinked: false, registered: true, browsers: [],
                  lastSeen: "5分前", extSeen: "3時間前", extMissingFrom: "3時間前" }],
      issues: [{ key: "ext_removed", sev: "critical",
                 what: "グループウェアへのアクセスはありますが、"
                     + "登録済みのブラウザ拡張から通信がありません。"
                     + "拡張が停止・削除されている可能性があります。",
                 next: "本人に、拡張が入っているか確認してください。"
                     + "入れ直しが必要なら、管理者が再登録してください" }],
      mark: { k: "bad", m: "×", t: "要確認" } },

    // △：まだ入れていない
    { employeeId: "emp-3", name: "鈴木 次郎", department: "開発",
      work: { key: "off", label: "勤務時間外" },
      ext: { key: "off", mark: "△", label: "未設定" },
      lastSeen: "1時間前", lastSeenAt: null,
      web: { min: 0, label: "0:00", offMin: 0, top: [] },
      clockMin: null,
      devices: [{ id: "d3", source: "browser", label: "Mac の Chrome",
                  status: "active", confirmed: true, ownership: "company",
                  extLinked: false, registered: false, browsers: [],
                  lastSeen: "1時間前", extSeen: "なし", extMissingFrom: null }],
      issues: [{ key: "ext_off", sev: "warn",
                 what: "ブラウザ拡張がつながっていません（WEB利用が取れません）",
                 next: "本人にマイページを開いて、登録を押してもらってください" }],
      mark: { k: "warn", m: "△", t: "要確認" } },

    // 端末が1台もない
    { employeeId: "emp-4", name: "高橋 三郎", department: "営業",
      work: { key: "off", label: "勤務時間外" },
      ext: { key: "none", mark: "—", label: "端末なし" },
      lastSeen: "なし", lastSeenAt: null,
      web: { min: 0, label: "0:00", offMin: 0, top: [] },
      clockMin: null, devices: [],
      issues: [], mark: { k: "ok", m: "○", t: "正常" } },
  ],
  summary: { total: 4, working: 2, check: 2, extOff: 1, extRemoved: 1 },
  limits: { idleMin: 15 },
};

const LIST = { devices: [], alerts: [], people: [],
               summary: { total: 0 }, deleted: 0, canWipe: true, ownerships: [] };

// 端末を1台も持たない人の WEB利用。
// 中身は空でも、形は持っている人と同じであること（api/devices/web.js の dayShape）
const WEB = {
  range: { key: "today", label: "今日", from: "2026-09-14", to: "2026-09-14" },
  scope: "work",
  total: { seconds: 0, label: "0:00" },
  byCategory: [], visits: [], alerts: [], hosts: [],
  day: {
    date: "2026-09-14", work: null,
    usage: { firstAt: null, lastAt: null, activeMin: 0, activeText: "0:00",
             idleMin: 0, idleText: "0:00", lockedMin: 0, nightMin: 0 },
    appMin: 0, appText: "0:00", nightSec: 0,
    verdict: { key: "check", mark: "△", label: "未設定",
               note: "この方の端末がまだ登録されていません。"
                   + "本人にマイページから登録してもらってください" },
  },
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const sent = [];

const page = await br.newPage({ viewport: { width: 1440, height: 900 },
                                timezoneId: "Asia/Tokyo" });
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
  if (req.method() === "PATCH") { sent.push(body); return send({ ok: true, notified: true }); }
  if (/\/api\/me\b/.test(url)) return send(me);
  if (/\/api\/devices\/people/.test(url)) return send(PEOPLE);
  if (/\/api\/devices\/web/.test(url)) return send(WEB);
  if (/\/api\/devices\/alerts/.test(url)) return send({ alerts: [] });
  if (/\/api\/devices/.test(url)) return send(LIST);
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
page.on("dialog", (d) => d.accept());

await page.goto(`${BASE}/admin-devices.html`);
await page.waitForTimeout(1300);

// ---- 開いた瞬間 --------------------------------------------------------------
console.log("— 開いた瞬間に何が見えるか —");
{
  check(await page.locator("#p-people").isVisible(), "入口は社員ごとの画面");
  check(!(await page.locator("#d-about").isVisible()), "長い説明は畳んである");

  const kpi = await page.locator("#pp-sum").innerText();
  for (const k of ["正常", "要確認", "未設定"]) check(kpi.includes(k), `KPI に「${k}」`);
  // 判定の数字は社内の管理基準。画面には出さない
  check(!/\d+分/.test(kpi), "しきい値の数字を出さない");

  // ファーストビューに、社員一覧の先頭まで入っていること
  const y = await page.locator("#pp-rows tr").first().evaluate(
    (n) => n.getBoundingClientRect().top);
  check(y > 0 && y < 900, `社員一覧の先頭が最初の画面に入る（上から ${Math.round(y)}px）`);
}

// ---- 一覧 --------------------------------------------------------------------
console.log("— 1行＝1人 —");
{
  const rows = page.locator("#pp-rows tr:not(.pp-det)");
  const n = await rows.count();
  check(n === 4, `社員の数だけ（${n} 行）`);

  const head = await page.locator("#p-people thead").innerText();
  for (const h of ["社員", "会社PC", "ブラウザ", "最終通信", "状態"]) {
    check(head.includes(h), `列「${h}」`);
  }

  const t = await page.locator("#pp-rows").innerText();
  check(t.includes("山田 太郎") && t.includes("佐藤 花子"), "氏名が出る");
  check(/○.*Browserのみ/s.test(t), "会社PCは ○ Browserのみ（source: browser のみ登録）");
  check(t.includes("PC未登録"), "端末が1台も無い人は PC未登録（高橋さん）");
  check(t.includes("連携済み") && t.includes("連携異常") && t.includes("未設定"),
    "ブラウザは ○ △ × で書き分ける");

  // 手を打つものが上
  const first = await rows.first().innerText();
  check(first.includes("佐藤 花子"), "要確認がいちばん上");

  // 正常な人の中身は、開かないと出ない
  check(!t.includes("WEB利用を見る"), "開くまで中身は出さない");
}

// ---- 要確認 ------------------------------------------------------------------
console.log("— 要確認の社員 —");
{
  check(await page.locator("#pp-check-card").isVisible(), "要確認のカードが出る");
  const t = await page.locator("#pp-check").innerText();
  check(t.includes("佐藤 花子") && t.includes("鈴木 次郎"), "対象の人が並ぶ");
  check(!t.includes("山田 太郎"), "正常な人は出さない");
}

// ---- × の書き方 ---------------------------------------------------------------
console.log("— × は「削除された」と決めつけない —");
{
  await page.locator("#pp-rows tr", { hasText: "佐藤 花子" }).first().click();
  await page.waitForTimeout(300);
  const t = await page.locator("#pp-d-emp-2").innerText();
  check(t.includes("グループウェアへのアクセスはありますが、"
                 + "登録済みのブラウザ拡張から通信がありません。"),
    "決めた文がそのまま出る");
  check(t.includes("可能性があります"), "断定しない");
  check(!/削除されました|削除しました/.test(t), "「消された」と書かない");
  check(t.includes("3時間前"), "いつから届いていないかが分かる");
}

// ---- 管理者の操作 --------------------------------------------------------------
console.log("— 外せるのは管理者だけ —");
{
  const box = page.locator("#pp-d-emp-2");
  for (const b of ["登録解除", "再登録を依頼", "利用停止"]) {
    check(await box.locator("button", { hasText: b }).first().isVisible(), `「${b}」がある`);
  }

  await box.locator("button", { hasText: "登録解除" }).first().click();
  await page.waitForTimeout(400);
  const u = sent.find((b) => b.action === "ext_unlink");
  check(Boolean(u), "確認してはじめて送る");
  check(u && u.deviceId === "d2", "その端末を指している");

  // 一覧の行にはボタンを置かない。ワンクリックで外れないこと
  const rowText = await page.locator("#pp-rows tr:not(.pp-det)").first().innerText();
  check(!/登録解除/.test(rowText), "一覧の行に「登録解除」を出さない");
}

// ---- 閉じられる ---------------------------------------------------------------
console.log("— 開いた行は閉じられる —");
{
  await page.locator("#pp-rows tr:not(.pp-det)", { hasText: "佐藤 花子" }).first().click();
  await page.waitForTimeout(300);
  check(!(await page.locator("#pp-d-emp-2").isVisible()), "もう一度押すと閉じる");
}

// ---- 端末を持たない人 ----------------------------------------------------------
console.log("— 端末が1台も無い人を開いても、落ちない —");
{
  await page.locator("#pp-rows tr:not(.pp-det)", { hasText: "高橋 三郎" }).first().click();
  await page.waitForTimeout(300);
  const t = await page.locator("#pp-d-emp-4").innerText();
  check(/まだ1台もありません/.test(t), "端末が無いと書いてある");

  await page.locator("#pp-d-emp-4 button", { hasText: "WEB利用を見る" }).click();
  await page.waitForTimeout(500);
  const w = await page.locator("#d-web").innerText();
  check(/高橋 三郎/.test(w), "その人の WEB利用が開く");
  check(/記録なし/.test(w), "PC稼働は「記録なし」");
  check(!/error|Cannot read/i.test(w), `画面が落ちていない：${w.slice(0, 80)}`);
}

check(errs.length === 0, `画面のエラーなし${errs.length ? "：" + errs[0] : ""}`);

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
