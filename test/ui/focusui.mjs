// 毎日の実行管理の3画面を、実際のブラウザで通す。
//
// ■ ホーム（home.html）
//   翌朝いちばん上に「今日やる3つ」と「0 / 3 完了」。押せば進む。
//
// ■ 日報（nippo.html）
//   明日の3件を決めるまで、日報の欄は開かない。
//   AIは案と理由を出すだけで、確定するのは人。
//
// ■ 管理（admin-tasks.html）
//   誰が何をしていて、誰が止まっているかが1枚で分かる。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = (role = "member") => ({
  email: "a@b.c", appRole: role, shows: {}, isAdmin: role !== "member",
  roles: [], memberships: [],
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: role === "member" ? [] : ["owner"], tenantId: "t1", stage: null },
});

const FOCUS = {
  today: "2026-09-16", tomorrowDate: "2026-09-17",
  todayTasks: [
    { id: "t1", title: "A社へ提案書送付", status: "done", dueOn: "2026-09-16",
      doneCondition: "先方への送付完了", carryCount: 0 },
    { id: "t2", title: "ENGER候補者3名推薦", status: "todo", dueOn: "2026-09-16",
      doneCondition: "3名の推薦完了", carryCount: 0 },
    { id: "t3", title: "新規5社へアプローチ", status: "todo", dueOn: "2026-09-16",
      doneCondition: "5社送信完了", carryCount: 1 },
  ],
  todayProgress: { done: 1, total: 3, label: "1 / 3", allDone: false, pct: 33 },
  todayState: { key: "confirmed", confirmed: true },
  tomorrowTasks: [
    { id: "n1", title: "見積を出す", purpose: "受注のため", doneCondition: "先方へ送付",
      assigneeId: "emp-1", dueOn: "2026-09-17", priority: "high", kpiLink: "新規開拓",
      missing: [], aiReview: { verdict: "fix", reason: "作業になっています",
                               fix: "新規5社へ初回連絡する", doneCondition: "5社に送信が完了している" } },
    { id: "n2", title: "請求書を送る", purpose: "入金のため", doneCondition: "送付完了",
      assigneeId: "emp-1", dueOn: "2026-09-17", priority: "high", missing: [],
      aiAssignee: "emp-2", aiAssigneeWhy: "山田さんに寄っているため" },
    { id: "n3", title: "面談の準備", purpose: "採用のため", doneCondition: "資料が用意できている",
      assigneeId: "emp-1", dueOn: "2026-09-17", priority: "high", missing: [] },
  ],
  tomorrowState: { key: "ai_checked", label: "確認待ち", ready: true, confirmed: false,
                   count: 3, todo: "AIの指摘を見て、確定する", incomplete: [] },
  tomorrowAi: { ok: true, summary: "明日やる内容として妥当です",
                warnings: ["1人に3件とも寄っています"], better: [] },
  carryOver: [
    { id: "old1", title: "昨日の残り", focusDate: "2026-09-15", carryCount: 2,
      notDoneReason: "先方の返事待ち" },
  ],
  carryChoices: [
    { key: "carry", label: "明日へ持ち越す", hint: "同じ内容で" },
    { key: "lower", label: "優先度を下げる", hint: "ふつうのタスクに戻す" },
    { key: "hand", label: "別の人へ渡す", hint: "担当を変える" },
    { key: "drop", label: "やらないことにする", hint: "取りやめる" },
  ],
  fields: [], min: 3, max: 5,
  people: [{ id: "emp-1", name: "山田 太郎", department: "営業" },
           { id: "emp-2", name: "鈴木 次郎", department: "営業" }],
  me: { id: "emp-1", name: "山田 太郎" }, employeeId: "emp-1",
  canManage: false, aiReady: true,
};

// ---------------------------------------------------------------------------
console.log("\n=== ホーム：今日やる3つ ===");
{
  const posted = [];
  // ここで完了を押すと状態が変わる。あとの画面に持ち越さないよう、写しで動かす
  const state = JSON.parse(JSON.stringify(FOCUS));
  const page = await br.newPage({ viewport: { width: 1200, height: 950 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/tasks\/focus/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        const t = state.todayTasks.find((x) => x.id === b.id);
        if (t) t.status = b.action === "complete" ? "done" : "todo";
        const done = state.todayTasks.filter((x) => x.status === "done").length;
        state.todayProgress = { done, total: 3, label: `${done} / 3`,
                                allDone: done === 3, pct: Math.round(done / 3 * 100) };
        return send({ ok: true, progress: state.todayProgress });
      }
      return send(state);
    }
    if (/\/api\/me\b/.test(url)) return send(ME());
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/home.html`);
  await page.waitForTimeout(900);

  const card = await page.locator("#f3").innerText();
  check(/今日やる3つ/.test(card), "見出しが出る");
  check(/1 \/ 3/.test(card), "いくつ終わったかが常に出る");
  check(/A社へ提案書送付/.test(card) && /ENGER候補者3名推薦/.test(card), "3つが並ぶ");
  check(/完了条件：先方への送付完了/.test(card), "完了条件が出る");
  check(/持ち越し 1 回目/.test(card), "持ち越しは目に入る");
  check(await page.locator("#f3 .f3-item").count() === 3, "3行");
  check(await page.locator("#f3 button", { hasText: "完了する" }).count() === 2,
    "終わっていないものにだけ完了ボタン");

  // 押すと 2 / 3 に進む
  await page.locator("#f3 button", { hasText: "完了する" }).first().click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "complete" && p.id === "t2"), "完了をサーバへ送る");
  check(/2 \/ 3/.test(await page.locator("#f3").innerText()), "数が進む");

  // 3つ終わると「今日の重要タスク完了」
  await page.locator("#f3 button", { hasText: "完了する" }).first().click();
  await page.waitForTimeout(700);
  const after = await page.locator("#f3").innerText();
  check(/3 \/ 3/.test(after), "3 / 3 になる");
  check(/今日の重要タスク完了/.test(after), "終わったことを、その場で伝える");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("\n=== 日報：明日の3件を決めてから ===");
{
  const posted = [];
  let confirmed = false;
  const page = await br.newPage({ viewport: { width: 1280, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/tasks\/focus/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        if (b.action === "confirm") confirmed = true;
        return send({ ok: true, sent: 0,
                      state: { key: "confirmed", confirmed: true, label: "確定" } });
      }
      const f = JSON.parse(JSON.stringify(FOCUS));
      if (confirmed) {
        f.tomorrowState = { key: "confirmed", label: "確定", ready: true, confirmed: true,
                            count: 3, todo: "", incomplete: [] };
      }
      return send(f);
    }
    if (/\/api\/nippo\/plan/.test(url)) return send({ plan: null });
    if (/\/api\/nippo\b/.test(url)) {
      return send({
        date: "2026-09-16", weekStart: "2026-09-14",
        me: { userId: "u-1", name: "山田 太郎" },
        today: null, recent: [], replies: [], evals: [], aiConfigured: false, thanks: [],
        weekly: null, weekClosing: { on: "2026-09-18", isToday: false, filled: false },
        openActions: [], todayActions: [], criteria: [], kpisToday: [],
        team: [], notSubmitted: [],
      });
    }
    if (/\/api\/me\b/.test(url)) return send(ME());
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/nippo.html`);
  await page.waitForTimeout(1000);

  console.log("\n— 決まるまで、日報は開かない —");
  check(await page.locator("#write-lock").count() === 1, "先に決めるよう案内が出る");
  check(await page.locator("#write-card.fc-lock").count() === 1, "日報の欄は触れない");

  console.log("\n— 決める画面 —");
  const box = await page.locator("#focus-card").innerText();
  check(/明日の重要タスクを決める/.test(box), "見出し");
  check(/2026-09-17/.test(box), "いつのぶんか");
  check(/1\. 見積を出す/.test(box) && /2\. 請求書を送る/.test(box), "3件が並ぶ");
  check(/目的：受注のため/.test(box), "目的が出る");
  check(/完了条件：先方へ送付/.test(box), "完了条件が出る");

  console.log("\n— AIは理由と直し方を出す —");
  check(/明日やる内容として妥当です/.test(box), "全体の講評");
  check(/1人に3件とも寄っています/.test(box), "気づいたこと");
  check(/作業になっています/.test(box), "そう判断した理由");
  check(/新規5社へ初回連絡する/.test(box), "直した文");
  check(await page.locator("#focus-card button", { hasText: "この案にする" }).count() >= 1,
    "案を採るボタン（押すまで変わらない）");
  check(/鈴木 次郎/.test(box) && /寄っているため/.test(box), "担当の案と理由");

  console.log("\n— 今日のタスクと、終わらなかったもの —");
  check(/今日のタスク/.test(box), "今日のぶんも同じ画面に出る");
  check(/1 \/ 3/.test(box), "今日の進み具合");
  check(/終わらなかったタスク/.test(box), "未完了は自動で動かさず、ここに出す");
  check(/持ち越し 2回/.test(box), "何回持ち越したか");
  for (const l of ["明日へ持ち越す", "優先度を下げる", "別の人へ渡す", "やらないことにする"]) {
    check(box.includes(l), `決め方：${l}`);
  }

  console.log("\n— 確定すると、日報が開く —");
  await page.locator("#focus-card button", { hasText: "この内容で確定する" }).click();
  await page.waitForTimeout(800);
  check(posted.some((p) => p.action === "confirm"), "確定をサーバへ送る");
  check(await page.locator("#write-lock").count() === 0, "案内が消える");
  check(await page.locator("#write-card.fc-lock").count() === 0, "日報の欄が開く");
  check(/今日の日報を入力してください/.test(await page.locator("#focus-card").innerText()),
    "次にやることを伝える");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

// ---------------------------------------------------------------------------
console.log("\n=== 管理：誰が止まっているか ===");
{
  const BOARD = {
    date: "2026-09-16", tomorrow: "2026-09-17",
    rows: [
      { employeeId: "e2", name: "B", department: "制作",
        today: { count: 3, done: 1, label: "1 / 3", allDone: false, confirmed: true },
        tomorrow: { count: 0, state: "draft", label: "登録中", confirmed: false },
        state: "warn", stateLabel: "注意", stuck: "明日のタスクが未登録",
        todayList: [{ id: "x1", title: "見積作成", status: "done" }],
        tomorrowList: [], hasAi: false, carrying: 0 },
      { employeeId: "e3", name: "C", department: "営業",
        today: { count: 3, done: 2, label: "2 / 3", allDone: false, confirmed: true },
        tomorrow: { count: 3, state: "ai_checked", label: "確認待ち", confirmed: false },
        state: "working", stateLabel: "進行中", stuck: "明日のタスクが確認待ち",
        todayList: [], tomorrowList: [], hasAi: true, carrying: 1 },
      { employeeId: "e1", name: "A", department: "営業",
        today: { count: 3, done: 3, label: "3 / 3", allDone: true, confirmed: true },
        tomorrow: { count: 3, state: "confirmed", label: "確定", confirmed: true },
        state: "done", stateLabel: "完了", stuck: "",
        todayList: [], tomorrowList: [], hasAi: false, carrying: 0 },
    ],
    summary: { people: 3, doneAll: 1, noTomorrow: 1, waiting: 1, warn: 1 },
    departments: ["営業", "制作"],
    people: [{ id: "e1", name: "A" }, { id: "e2", name: "B" }, { id: "e3", name: "C" }],
    states: [{ key: "warn", label: "注意" }, { key: "working", label: "進行中" },
             { key: "done", label: "完了" }],
  };
  const asked = [];
  const page = await br.newPage({ viewport: { width: 1440, height: 950 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/tasks\/board/.test(url)) { asked.push(url); return send(BOARD); }
    if (/\/api\/tasks\/focus/.test(url)) return send(FOCUS);
    if (/\/api\/tasks/.test(url)) return send({ tasks: [], templates: [], canManage: true });
    if (/\/api\/employees/.test(url)) return send({ employees: [] });
    if (/\/api\/me\b/.test(url)) return send(ME("admin"));
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/admin-tasks.html`);
  await page.waitForTimeout(900);

  const board = await page.locator("#board-card").innerText();
  check(/今日の実行状況/.test(board), "見出し");
  check(/明日が未登録/.test(board) && /確定待ち/.test(board), "上の数で、止まっている人が分かる");
  check(await page.locator("#bd-rows tr").count() === 3, "3人ぶん");
  const first = await page.locator("#bd-rows tr").first().innerText();
  check(/B/.test(first) && /注意/.test(first), "止まっている人が上に来る");
  check(/明日のタスクが未登録/.test(first), "何が止まっているか");
  check(/1 \/ 3/.test(board) && /3 \/ 3/.test(board), "完了数が出る");

  console.log("\n— 絞り込み —");
  for (const id of ["bd-date", "bd-month", "bd-person", "bd-dep", "bd-biz", "bd-done", "bd-state", "bd-ai"]) {
    check(await page.locator(`#${id}`).count() === 1, `絞り込み：${id}`);
  }
  await page.selectOption("#bd-state", "warn");
  await page.waitForTimeout(500);
  check(asked.some((u) => /state=warn/.test(u)), "状態で絞ると、サーバにも渡す");

  console.log("\n— その人を開く —");
  await page.locator("#bd-rows tr").first().click();
  await page.waitForTimeout(700);
  const detail = await page.locator("#bd-detail").innerText();
  check(/今日（2026-09-16）/.test(detail), "今日ぶん");
  check(/明日（2026-09-17）/.test(detail), "明日ぶん");
  check(/A社へ提案書送付/.test(detail), "中身は開いたときだけ");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
