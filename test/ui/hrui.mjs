// 入退社の画面を、実際のブラウザで通す。
//
// ■ 何を守りたいのか
//
//   「情報を登録するページ」に戻らないこと。
//   開いた人が、次に何をすればよいか分かること。
//
//     ・一覧は5つだけ（氏名・日付・状態・進捗・次の担当）
//     ・詳細のいちばん上は「次にやること」
//     ・その下は担当別のチェックリスト
//     ・長い説明を置かない
//     ・入退社 → 対象者 → チェックリスト の3段階で終わる
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// 保存期限とオリエンテーション。一覧と同じ画面に出る
const RETENTION = {
  today: "2026-09-28",
  rules: [
    { key: "resume", label: "履歴書・職務経歴書", base: "leave", baseLabel: "退職日",
      months: 36, defaultMonths: 36, autoDelete: false },
    { key: "bank", label: "口座情報", base: "leave", baseLabel: "退職日",
      months: 12, defaultMonths: 12, autoDelete: true },
  ],
  schedule: [
    { employeeId: "e9", name: "退職 太郎", kind: "bank", label: "口座情報",
      dueOn: "2026-09-01", daysLeft: -27, expired: true, count: 1, autoDelete: true },
  ],
  expired: 1,
  log: [{ id: 1, name: "退職 太郎", kind: "resume", kindLabel: "履歴書・職務経歴書",
          label: "rireki.pdf", by: "事務 花子", reason: "manual", at: "2026-09-20T00:00:00Z" }],
};
const ORIENTATION = {
  items: [{ id: "o1", title: "会社説明", kind: "video", kindLabel: "動画",
            url: "https://example.jp/v", required: true, confirmed: false,
            active: true, sortOrder: 10, confirmedCount: 2 }],
  kinds: [{ key: "video", label: "動画" }, { key: "link", label: "リンク" },
          { key: "pdf", label: "PDF" }, { key: "text", label: "本文（社内ルール等）" }],
  done: false,
};

const LIST = {
  tabs: [
    { key: "onboarding", label: "入社予定" },
    { key: "offboarding", label: "退社予定" },
    { key: "done", label: "完了" },
  ],
  onboarding: [
    { id: "p1", kind: "onboarding", name: "山田 太郎", department: "営業",
      targetOn: "2026-10-01", days: 3, due: "入社まで3日",
      phase: "prep", phaseLabel: "入社準備",
      progress: { done: 7, total: 10 }, urgency: "soon",
      next: { title: "会社PCの準備", role: "IT・管理", who: "情報 次郎" } },
    { id: "p2", kind: "onboarding", name: "佐藤 花子", department: "制作",
      targetOn: "2026-11-01", days: 34, due: "入社まで34日",
      phase: "planned", phaseLabel: "入社予定",
      progress: { done: 0, total: 10 }, urgency: "ok",
      next: { title: "労働条件・契約の確認", role: "人事", who: "事務 花子" } },
  ],
  offboarding: [
    { id: "p3", kind: "offboarding", name: "鈴木 次郎", department: "営業",
      targetOn: "2026-09-30", days: 2, due: "退社まで2日",
      phase: "prep", phaseLabel: "退社準備",
      progress: { done: 2, total: 13 }, urgency: "soon",
      next: { title: "業務の引継ぎ", role: "上長", who: "部長 三郎" } },
  ],
  done: [],
  people: [{ id: "e1", name: "山田 太郎", department: "営業" },
           { id: "e2", name: "佐藤 花子", department: "制作" }],
  roles: [], today: "2026-09-28",
};

const ONE = {
  procedure: {
    id: "p1", kind: "onboarding", name: "山田 太郎", department: "営業",
    targetOn: "2026-10-01", days: 3, due: "入社まで3日",
    phase: "prep", phaseLabel: "入社準備",
    progress: { done: 7, total: 10 }, urgency: "soon",
    next: { title: "会社PCの準備", role: "IT・管理", who: "情報 次郎" },
    groups: [
      { role: "hr", label: "人事", done: 3, total: 3, items: [
        { id: "i1", title: "労働条件・契約の確認", owner: "hr", ownerLabel: "人事",
          phase: "prep", done: true, completedAt: "2026-09-20T00:00:00Z",
          assignee: { id: "e9", name: "事務 花子" }, href: "admin-contracts.html" },
        { id: "i2", title: "必要書類の回収", owner: "hr", ownerLabel: "人事",
          phase: "prep", done: true, assignee: { id: "e9", name: "事務 花子" }, href: null },
        { id: "i3", title: "社内ルールの確認", owner: "hr", ownerLabel: "人事",
          phase: "prep", done: true, assignee: { id: "e9", name: "事務 花子" }, href: null },
      ] },
      { role: "it", label: "IT・管理", done: 2, total: 5, items: [
        { id: "i4", title: "会社PCの準備", owner: "it", ownerLabel: "IT・管理",
          phase: "prep", done: false, assignee: { id: "e8", name: "情報 次郎" }, href: null },
        { id: "i5", title: "メールの発行", owner: "it", ownerLabel: "IT・管理",
          phase: "prep", done: false, assignee: { id: "e8", name: "情報 次郎" }, href: null },
        { id: "i6", title: "EIGHT Agent の設定", owner: "it", ownerLabel: "IT・管理",
          phase: "prep", done: false, assignee: { id: "e8", name: "情報 次郎" },
          href: "admin-devices.html" },
        { id: "i7", title: "Slack・グループウェアの発行", owner: "it", ownerLabel: "IT・管理",
          phase: "prep", done: true, assignee: { id: "e8", name: "情報 次郎" }, href: null },
        { id: "i8", title: "必要システムの権限付与", owner: "it", ownerLabel: "IT・管理",
          phase: "prep", done: true, assignee: { id: "e8", name: "情報 次郎" },
          href: "admin-members.html#roles" },
      ] },
      { role: "manager", label: "上長", done: 1, total: 3, items: [
        { id: "i9", title: "担当業務の設定", owner: "manager", ownerLabel: "上長",
          phase: "prep", done: true, assignee: { id: "e7", name: "部長 三郎" }, href: null },
        { id: "i10", title: "初日の予定の登録", owner: "manager", ownerLabel: "上長",
          phase: "day1", done: false, assignee: { id: "e7", name: "部長 三郎" }, href: null },
        { id: "i11", title: "オリエンテーション", owner: "manager", ownerLabel: "上長",
          phase: "day1", done: false, assignee: null, href: null },
      ] },
      { role: "finance", label: "経理", done: 1, total: 1, items: [
        { id: "i12", title: "給与・振込情報の確認", owner: "finance", ownerLabel: "経理",
          phase: "prep", done: true, assignee: { id: "e6", name: "経理 四郎" }, href: null },
      ] },
    ],
  },
  roles: [], people: LIST.people,
};

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
  localStorage.removeItem("kp_nav_open");
  localStorage.removeItem("kp_view");
});
await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                      body: JSON.stringify(b) });
  const body = req.postData() ? JSON.parse(req.postData()) : {};
  if (req.method() === "POST" && /\/api\/hr/.test(url)) {
    sent.push({ m: "POST", ...body });
    return send({ ok: true, id: "p1", added: 12, told: 4 });
  }
  if (req.method() === "PATCH" && /\/api\/hr/.test(url)) {
    sent.push({ m: "PATCH", ...body });
    return send({ ok: true, told: 4, progress: { done: 8, total: 10 } });
  }
  // 入退社の画面は、保存期限とオリエンテーションも読む。/api/hr より先に見る
  if (/\/api\/hr\/retention/.test(url)) return send(RETENTION);
  if (/\/api\/onboarding\/orientation/.test(url)) return send(ORIENTATION);
  if (/\/api\/hr\?id=/.test(url)) return send(ONE);
  if (/\/api\/hr/.test(url)) return send(LIST);
  if (/\/api\/me\b/.test(url)) {
    return send({ email: "a@b.c", appRole: "admin", shows: {}, isAdmin: true,
      gw: { employee: { id: "e1", display_name: "事務", status: "active" },
            roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null } });
  }
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});

await page.goto(`${BASE}/admin-hr.html`);
await page.waitForTimeout(1100);

// ---------------------------------------------------------------------------
console.log("— 一覧 —");
{
  const tabs = (await page.locator("#hr-tabs button").allInnerTexts()).map((s) => s.trim());
  check(tabs.length === 3, `タブは3つ（いま ${tabs.length}）`);
  check(tabs[0].startsWith("入社予定"), `1つめ ${tabs[0]}`);
  check(tabs[1].startsWith("退社予定"), `2つめ ${tabs[1]}`);
  check(tabs[2].startsWith("完了"), `3つめ ${tabs[2]}`);
  check(tabs[0].includes("2"), "件数が出る");

  // 氏名・日付・状態・進捗・次の担当 に「止まっているもの」を足した6つ。
  // 「何が止まっているか」が一覧だけで分かるのが、この画面の仕事
  const heads = (await page.locator(".hr-table th").allInnerTexts()).map((s) => s.trim());
  check(heads.filter(Boolean).length === 6,
    `見出しは6つ（いま ${heads.filter(Boolean).join("・")}）`);
  check(heads.includes("止まっているもの"), "「止まっているもの」の列がある");

  const first = await page.locator("#hr-rows tr").first().innerText();
  check(/山田 太郎/.test(first), "氏名");
  check(/入社まで3日/.test(first), "入社日までの日数");
  check(/入社準備/.test(first), "状態");
  check(/7\/10/.test(first), "進捗");
  check(/IT・管理：会社PCの準備/.test(first), "次の担当（誰が・何を）");

  // 急ぎは色で分かる
  const cls = await page.locator("#hr-rows tr").first().locator(".hr-due").getAttribute("class");
  check(/soon/.test(cls || ""), `期日が近いと目立つ（class=${cls}）`);

  // 長い説明を置かない
  const card = await page.locator("#hr-list-card").innerText();
  check(card.length < 700, `一覧の文字数 ${card.length}（説明で埋めない）`);
}

console.log("\n— タブを切り替える —");
{
  await page.locator("#hr-tabs button", { hasText: "退社予定" }).click();
  await page.waitForTimeout(200);
  const t = await page.locator("#hr-rows").innerText();
  check(/鈴木 次郎/.test(t), "退社予定に切り替わる");
  check(!/山田 太郎/.test(t), "入社予定は出ていない");
  await page.locator("#hr-tabs button", { hasText: "入社予定" }).click();
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
console.log("\n— 詳細（入退社 → 対象者 → チェックリスト）—");
{
  await page.locator("#hr-rows tr").first().click();
  await page.waitForTimeout(500);

  const head = await page.locator(".hr-head").innerText();
  check(/山田 太郎/.test(head), "上に氏名");
  check(/10月1日 入社/.test(head), "上に入社日（何日かが分かる）");
  check(/入社まで3日/.test(head), "上にあと何日か");
  check(/7\/10 完了/.test(head), "上に進捗");

  // 押した直後に、氏名と期日が上のバーの裏に隠れないこと
  const hidden = await page.evaluate(() => {
    const h = document.querySelector(".hr-head");
    const bar = document.querySelector(".topbar");
    if (!h || !bar) return false;
    return h.getBoundingClientRect().top < bar.getBoundingClientRect().bottom;
  });
  check(!hidden, "見出しがバーの裏に隠れない");

  // いちばん上は「次にやること」
  const now = page.locator(".hr-now");
  check(await now.isVisible(), "「次にやること」が出る");
  const nowText = await now.innerText();
  check(/次にやること/.test(nowText), "見出し");
  check(/IT・管理：会社PCの準備/.test(nowText), "誰が・何を");
  check(/情報 次郎/.test(nowText), "担当者の名前");

  // 本文の並び順。次にやることが、チェックリストより上
  const order = await page.evaluate(() => {
    const c = document.querySelector("#hr-detail .card");
    const kids = [...c.children].map((n) => n.className);
    return { now: kids.findIndex((k) => /hr-now/.test(k)),
             grp: kids.findIndex((k) => /hr-grp/.test(k)) };
  });
  check(order.now >= 0 && order.now < order.grp, "「次にやること」がリストより上");

  const groups = (await page.locator(".hr-grp > .h b").allInnerTexts()).map((s) => s.trim());
  check(groups.join("・") === "人事・IT・管理・上長・経理", `担当別（いま ${groups.join("・")}）`);

  const it = await page.locator(".hr-grp").nth(1).innerText();
  check(/2\/5/.test(it), "担当ごとの進み具合");
  check(/情報 次郎/.test(it), "担当者の名前");

  // 終わったものは見た目で分かる
  const doneRows = await page.locator(".hr-row.done").count();
  check(doneRows === 7, `終わったものに印（いま ${doneRows}）`);

  // 別の画面でやる作業には、行き先が出る
  const agentRow = page.locator(".hr-row", { hasText: "EIGHT Agent の設定" });
  check(await agentRow.locator("a.go").getAttribute("href") === "admin-devices.html",
    "EIGHT Agent は端末管理へ飛べる");

  // 初日ぶんは、そう分かる
  const d1 = await page.locator(".hr-row", { hasText: "初日の予定の登録" }).innerText();
  check(/初日/.test(d1), "初日にやるものが分かる");

  // 担当が決まっていないものは、そう出す
  const noone = await page.locator(".hr-grp").nth(2).innerText();
  check(/オリエンテーション/.test(noone), "担当未定でも項目は出る");

  await page.screenshot({ path: shotPath("hr-detail.png"), fullPage: true });
}

console.log("\n— チェックを付ける —");
{
  const before = sent.length;
  await page.locator(".hr-row", { hasText: "会社PCの準備" }).locator("input").check();
  await page.waitForTimeout(600);
  const p = sent.slice(before).find((x) => x.m === "PATCH");
  check(Boolean(p), "サーバへ送る");
  check(p && p.itemId === "i4" && p.done === true, `どれを付けたか（${JSON.stringify(p)}）`);
}

console.log("\n— 日付を変えると、知らせ直すと書いてある —");
{
  await page.locator(".hr-head button", { hasText: "日付を変える" }).click();
  await page.waitForTimeout(200);
  const t = await page.locator("#hr-date").innerText();
  check(/もう一度お知らせ/.test(t), "知らせ直すことを先に書く");
  check(/期限も合わせて/.test(t), "期限も動くと書く");
}

console.log("\n— 登録は、この画面の中で終わる —");
{
  await page.locator(".hr-head button", { hasText: "閉じる" }).click();
  await page.waitForTimeout(200);
  await page.locator("button", { hasText: "入退社を登録する" }).click();
  await page.waitForTimeout(200);
  const box = await page.locator("#hr-new").innerText();
  check(/お知らせと「やること」が届きます/.test(box), "何が起きるか書いてある");
  check(await page.locator("#n-emp").isVisible(), "対象の方を選べる");
  check(await page.locator("#n-date").isVisible(), "日付を入れられる");

  const before = sent.length;
  await page.locator("#n-date").fill("2026-10-01");
  await page.locator("button", { hasText: "登録して知らせる" }).click();
  await page.waitForTimeout(700);
  const p = sent.slice(before).find((x) => x.m === "POST");
  check(Boolean(p), "サーバへ送る");
  check(p && p.targetOn === "2026-10-01", `日付を渡す（${JSON.stringify(p)}）`);
}

// ---------------------------------------------------------------------------
console.log("\n— 通知から直接ひらく —");
//
//   「あなたの担当が3件あります」と知らせても、そこから開けなければ
//   結局メニューを探すことになる
{
  const p2 = await br.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  await p2.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  await p2.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/hr\?id=/.test(url)) return send(ONE);
    if (/\/api\/hr/.test(url)) return send(LIST);
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "admin", shows: {}, isAdmin: true,
        gw: { employee: { id: "e1", display_name: "事務", status: "active" },
              roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null } });
    }
    return send({ notifications: [], unread: 0, badges: {} });
  });
  // 通知が出す行き先そのもの
  await p2.goto(`${BASE}/admin-hr.html?id=p1`);
  await p2.waitForTimeout(1200);
  check(await p2.locator(".hr-now").isVisible(), "通知のリンクで、その人が開く");
  const h = await p2.locator(".hr-head").innerText();
  check(/山田 太郎/.test(h), "開いたのはその人");
  await p2.close();
}

console.log("\n— ホームの「今日対応する入退社」 —");
{
  const p3 = await br.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Tokyo" });
  await p3.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  await p3.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/hr\?soon=1/.test(url)) {
      return send({ today: "2026-09-28", soon: [{
        id: "p1", kind: "onboarding", name: "山田 太郎", due: "入社まで3日",
        days: 3, urgency: "soon", progress: { done: 7, total: 10 },
        open: [{ title: "会社PCの準備", role: "IT・管理" },
               { title: "メールの発行", role: "IT・管理" }],
        recentDone: "労働条件・契約の確認",
      }] });
    }
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "admin", shows: {}, isAdmin: true,
        gw: { employee: { id: "e1", display_name: "事務", status: "active" },
              roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null } });
    }
    return send({ notifications: [], unread: 0, badges: {}, clients: [] });
  });
  await p3.goto(`${BASE}/admin-dashboard.html`);
  await p3.waitForTimeout(1300);

  const box = p3.locator("#hr-soon");
  check(await box.isVisible(), "ホームに出る");
  const t = await box.innerText();
  check(/今日対応する入退社/.test(t), "見出し");
  check(/山田 太郎/.test(t), "誰の");
  check(/入社まで3日/.test(t), "いつ");
  check(/IT・管理：会社PCの準備/.test(t), "何が残っているか");
  check(/労働条件・契約の確認/.test(t), "終わったものも1つ出す");
  check(/🔴|🟠/.test(t), "急ぎが目で分かる");
  check(/✅/.test(t), "終わったものが目で分かる");

  const href = await box.locator("a").first().getAttribute("href");
  check(href === "admin-hr.html?id=p1", `押すとその人が開く（${href}）`);
  await p3.screenshot({ path: shotPath("hr-home.png") });
  await p3.close();
}

// ---- 表がまだ無いとき -----------------------------------------------------------
//
//   SQL を流す前に開くと、サーバは
//     { error: "not_ready", message: "…db/066_hr_flow.sql の実行を…" }
//   と、やることまで書いて返している。
//   それが画面に届かず、赤い枠に「not_ready」とだけ出ていた。
//   この画面を見ているのは管理者なので、そのまま直しにいける形で出す。
console.log("— まだ SQL を流していないとき —");
{
  const p4 = await br.newPage({ viewport: { width: 1280, height: 900 },
                                timezoneId: "Asia/Tokyo" });
  await p4.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({
      appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  await p4.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, st = 200) => route.fulfill({ status: st, contentType: "application/json",
                                                  body: JSON.stringify(b) });
    if (/\/api\/hr/.test(url)) {
      return send({ error: "not_ready",
                    message: "この機能に必要なテーブルがまだ作られていません。"
                           + "管理者に db/008_onboarding.sql → 066_hr_flow.sql "
                           + "の実行を依頼してください" }, 503);
    }
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "admin", shows: {}, isAdmin: true,
                    gw: { employee: { id: "e0", display_name: "事務" }, roles: ["hr"],
                          isAdmin: true, tenantId: "t1", stage: null } });
    }
    return send({ notifications: [], unread: 0, badges: {} });
  });
  await p4.goto(`${BASE}/admin-hr.html`);
  await p4.waitForTimeout(900);

  const t = await p4.locator("#hr-rows").innerText();
  check(!/not_ready/.test(t), `コード名を出さない（${t.slice(0, 60)}）`);
  check(/066_hr_flow\.sql/.test(t), "流す SQL の名前が出る");
  check(/まだ使える状態になっていません/.test(t), "壊れたのではなく、まだ、と書く");
  // 壊れているのではないので、赤くしない
  const red = await p4.locator("#hr-rows .banner.err").count();
  check(red === 0, "赤いエラーにしない");
  await p4.close();
}

check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
