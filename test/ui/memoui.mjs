// とりあえずメモを、実際のブラウザで通す。
//
// ■ ホーム（home.html）
//   期日・担当なしで1行だけ入れて、その場で保存できる。
//
// ■ 日報（nippo.html）
//   退勤時に一覧が出て、AIの案（付けるだけ・決めない）と、
//   人が押して初めて決まることを確かめる。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = () => ({
  email: "a@b.c", appRole: "member", shows: {}, isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], tenantId: "t1", stage: null },
});

console.log("\n=== ホーム：とりあえずメモを残す ===");
{
  const posted = [];
  const page = await br.newPage({ viewport: { width: 1100, height: 950 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/tasks\/memo/.test(url) && req.method() === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      return send({ memo: { id: "m1", body: b.body, status: "open" } });
    }
    if (/\/api\/tasks\/focus/.test(url)) return send({});
    if (/\/api\/me\b/.test(url)) return send(ME());
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/home.html`);
  await page.waitForTimeout(700);

  check(await page.locator("#memo-input").count() === 1, "入力欄が出る（期日・担当の項目はない）");

  await page.locator("#memo-input").fill("A社 見積確認");
  await page.locator("#memo-box button", { hasText: "追加" }).click();
  await page.waitForTimeout(500);

  check(posted.length === 1 && posted[0].action === "add" && posted[0].body === "A社 見積確認",
    "本文だけをそのまま送る");
  check((await page.locator("#memo-input").inputValue()) === "", "送ったら空にする（続けて書ける）");
  check(/残しました/.test(await page.locator("#memo-msg").innerText()), "残ったことが分かる");

  // Enter でも送れる（考えさせない）
  await page.locator("#memo-input").fill("もう1件");
  await page.locator("#memo-input").press("Enter");
  await page.waitForTimeout(500);
  check(posted.length === 2 && posted[1].body === "もう1件", "Enterでも送れる");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 日報：とりあえずメモをどうするか決める ===");
{
  const posted = [];
  let decided = false;
  const page = await br.newPage({ viewport: { width: 1280, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  const FOCUS = {
    today: "2026-09-16", tomorrowDate: "2026-09-17",
    todayTasks: [], todayProgress: { done: 0, total: 0 },
    todayState: { key: "confirmed", confirmed: true },
    tomorrowTasks: [],
    tomorrowState: { key: "draft", label: "登録中", ready: false, confirmed: false,
                     count: 0, todo: "明日の重要タスクを3件まで決める", incomplete: [] },
    tomorrowAi: null, carryOver: [],
    carryChoices: [
      { key: "carry", label: "明日へ持ち越す", hint: "" },
      { key: "lower", label: "優先度を下げる", hint: "" },
      { key: "hand", label: "別の人へ渡す", hint: "" },
      { key: "drop", label: "やらないことにする", hint: "" },
    ],
    fields: [], min: 3, max: 5,
    people: [{ id: "emp-1", name: "山田 太郎" }, { id: "emp-2", name: "鈴木 次郎" }],
    me: { id: "emp-1", name: "山田 太郎" }, employeeId: "emp-1",
    canManage: false, aiReady: true,
  };

  const memos = [
    { id: "m1", body: "A社 見積確認", status: "open", decision: null, decisionLabel: null,
      aiDecision: null, aiReason: null, promotedTaskId: null, createdAt: "2026-09-16T01:00:00Z" },
  ];

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/tasks\/memo/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        if (b.action === "review") {
          memos[0].aiDecision = "task";
          memos[0].aiReason = "取引先への提案に関わるため";
          return send({ memos });
        }
        if (b.action === "decide") {
          decided = true;
          memos.length = 0;
          return send({ memo: { id: b.id, status: "decided", decision: b.decision } });
        }
        return send({ ok: true });
      }
      return send({ memos: decided ? [] : memos, bodyMax: 200, aiReady: true, employeeId: "emp-1" });
    }
    if (/\/api\/tasks\/focus/.test(url)) return send(FOCUS);
    if (/\/api\/nippo\/plan/.test(url)) return send({ plan: null });
    if (/\/api\/nippo\b/.test(url)) {
      return send({
        date: "2026-09-16", weekStart: "2026-09-14", me: { userId: "u-1", name: "山田 太郎" },
        today: null, recent: [], replies: [], evals: [], aiConfigured: false, thanks: [],
        weekly: null, weekClosing: { on: "2026-09-18", isToday: false, filled: false },
        openActions: [], todayActions: [], criteria: [], kpisToday: [], team: [], notSubmitted: [],
      });
    }
    if (/\/api\/me\b/.test(url)) return send(ME());
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/nippo.html`);
  await page.waitForTimeout(1000);

  const body1 = await page.locator("#memo-box2").innerText();
  check(/とりあえずメモ/.test(body1), "見出しが出る");
  check(/A社 見積確認/.test(body1), "内容が出る");
  check(await page.locator("#memo-box2 button", { hasText: "正式タスク化" }).count() === 1,
    "決める4つのボタンが出る");

  console.log("— AIは案を置くだけ —");
  await page.locator("#memo-box2 a", { hasText: "AIに案を出してもらう" }).click();
  await page.waitForTimeout(500);
  const body2 = await page.locator("#memo-box2").innerText();
  check(/AI：正式タスク化/.test(body2), "AIの案が出る");
  check(!decided, "案を出しただけでは、まだ何も決まっていない");

  console.log("— 人が決める —");
  await page.locator("#memo-box2 button", { hasText: "自分で対応済み" }).click();
  await page.waitForTimeout(600);
  check(posted.some((p) => p.action === "decide" && p.decision === "self"), "押した決定が送られる");
  check((await page.locator("#memo-box2").count()) === 1 && !/A社 見積確認/.test(await page.locator("#memo-box2").innerText()),
    "決めたら一覧から消える");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
