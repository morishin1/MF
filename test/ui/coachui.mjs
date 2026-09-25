// ペアコーチング（明日の3タスクを、3人一組の対話で深掘りする）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 聞き方ガイド（手順・質問・オウム返しの例）が画面に出る
//   2. コーチングが済んでいないと、確定ボタンは押せない
//   3. 「これでコーチング完了」を押すと、相手・得たい結果などをサーバへ送る
//   4. 相手を選ばないと完了にできない
//   5. コーチング済みなら、確定ボタンが押せる
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "a@b.c", appRole: "member", shows: {}, isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" }, roles: [], tenantId: "t1", stage: null } };

const COACH_STEPS = [
  { key: "echo", label: "オウム返し" }, { key: "purpose", label: "目的確認" },
  { key: "outcome", label: "成果確認" }, { key: "reason", label: "明日やる理由" },
  { key: "done", label: "完了条件確認" }, { key: "edit", label: "本人がタスクを修正" },
  { key: "confirm", label: "確認済み" },
];
const COACH_QUESTIONS = [
  "このタスクで何を得たい？", "それができると何が前に進む？", "なぜ明日やる必要がある？",
  "数字や状態で表すとどうなれば成果？", "どこまでできたら完了？",
];
const COACH_ECHO = [
  { who: "本人", text: "候補者を10名探します" }, { who: "コーチ", text: "候補者を10名探すんですね" },
];
const QUALITY_LEVELS = [
  { key: 1, label: "作業だけ" }, { key: 2, label: "目的あり" },
  { key: 3, label: "成果が明確" }, { key: 4, label: "成果＋完了条件が明確" },
];

function focusOf({ coached }) {
  return {
    today: "2026-09-16", tomorrowDate: "2026-09-17",
    todayTasks: [], todayProgress: { done: 0, total: 0, label: "0 / 0", allDone: false, pct: 0 },
    todayState: { key: "confirmed", confirmed: true },
    tomorrowTasks: [1, 2, 3].map((n) => ({
      id: `n${n}`, title: `やること${n}`, purpose: "売上をつくるため", doneCondition: "送付が完了している",
      assigneeId: "emp-1", dueOn: "2026-09-17", priority: "high", missing: [],
      outcome: coached ? "面談候補を3名つくる" : null, tomorrowReason: coached ? "今週中に打診したいから" : null,
      qualityLevel: coached ? 4 : 2, coachedAt: coached ? "2026-09-16T01:00:00Z" : null,
      coachedWith: coached ? [{ employeeId: "emp-2", name: "鈴木 次郎" }] : null,
    })),
    tomorrowState: { key: "ai_checked", label: "確認待ち", ready: true, confirmed: false, coached,
                     count: 3, todo: coached ? "確定してください" : "3件のペアコーチングを終えてください", incomplete: [] },
    tomorrowAi: null, carryOver: [],
    carryChoices: [
      { key: "carry", label: "明日へ持ち越す", hint: "同じ内容で" },
      { key: "lower", label: "優先度を下げる", hint: "ふつうのタスクに戻す" },
      { key: "hand", label: "別の人へ渡す", hint: "担当を変える" },
      { key: "drop", label: "やらないことにする", hint: "取りやめる" },
    ],
    fields: [], min: 3, max: 5,
    coachSteps: COACH_STEPS, coachQuestions: COACH_QUESTIONS, coachEcho: COACH_ECHO, qualityLevels: QUALITY_LEVELS,
    people: [{ id: "emp-1", name: "山田 太郎", department: "営業" }, { id: "emp-2", name: "鈴木 次郎", department: "営業" }],
    me: { id: "emp-1", name: "山田 太郎" }, employeeId: "emp-1", canManage: false, aiReady: true,
  };
}

console.log("\n=== ペアコーチング：未実施だと確定できない ===");
{
  const posted = [];
  const state = { coached: false };
  const page = await br.newPage({ viewport: { width: 1280, height: 1200 }, timezoneId: "Asia/Tokyo" });
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
    if (/\/api\/tasks\/focus/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        if (b.action === "coach") {
          if (!b.partners?.length) return route.fulfill({ status: 400, contentType: "application/json",
            body: JSON.stringify({ error: "bad_request", hint: "誰と組んだかを選んでください" }) });
          state.coached = true;
          return send({ task: { id: b.id } });
        }
        return send({ ok: true });
      }
      return send(focusOf(state));
    }
    if (/\/api\/nippo\/plan/.test(url)) return send({ plan: null });
    if (/\/api\/nippo\b/.test(url)) {
      return send({ date: "2026-09-16", weekStart: "2026-09-14", me: { userId: "u-1", name: "山田 太郎" },
        today: null, recent: [], replies: [], evals: [], aiConfigured: false, thanks: [],
        weekly: null, weekClosing: { on: "2026-09-18", isToday: false, filled: false },
        openActions: [], todayActions: [], criteria: [], kpisToday: [], team: [], notSubmitted: [] });
    }
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/nippo.html`);
  await page.waitForTimeout(1000);

  console.log("\n— 聞き方ガイドが出る —");
  const box = await page.locator("#focus-card").innerText();
  check(/聞き方ガイド/.test(box), "見出し");
  for (const s of ["オウム返し", "目的確認", "成果確認", "明日やる理由", "完了条件確認", "本人がタスクを修正", "確認済み"]) {
    check(box.includes(s), `手順：${s}`);
  }
  check(/何を得たい/.test(box), "質問の例");
  check(/候補者を10名探すんですね/.test(box), "オウム返しの例");

  console.log("\n— コーチング未実施だと、確定ボタンが押せない —");
  check(await page.locator("#focus-card button", { hasText: "この内容で確定する" }).isDisabled(), "無効になっている");
  check(/ペアコーチング/.test(await page.locator("#focus-card").innerText()), "理由がひとことで出る");

  console.log("\n— タスクごとに質（Lv）が出る —");
  check(/Lv2：目的あり/.test(box), "得たい結果が無いのでLv2");

  console.log("\n— コーチングを始める —");
  await page.locator(".fc-task button", { hasText: "ペアコーチングをする" }).first().click();
  await page.waitForTimeout(400);
  check(await page.locator(".fc-coach-form").isVisible(), "入力欄が開く");

  console.log("\n— 相手を選ばないと完了にできない —");
  await page.locator(".fc-coach-form button", { hasText: "これでコーチング完了" }).click();
  await page.waitForTimeout(500);
  check(!posted.some((p) => p.action === "coach"), "送られない");
  check((await page.locator(".fc-coach-form").innerText()).includes("組んだ相手"), "理由が出る");

  console.log("\n— 相手を選んで完了にする —");
  await page.selectOption(".fc-coach-form select", { label: "鈴木 次郎" });
  await page.fill('.fc-coach-form input[id^="fcc-outcome-"]', "面談候補を3名つくる");
  await page.locator(".fc-coach-form button", { hasText: "これでコーチング完了" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "coach" && p.outcome === "面談候補を3名つくる"), "得たい結果を送る");
  check(posted.some((p) => p.action === "coach" && p.partners?.some((x) => x.employeeId === "emp-2")), "組んだ相手を送る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== ペアコーチング：3件済ませば確定できる ===");
{
  const page = await br.newPage({ viewport: { width: 1280, height: 1200 }, timezoneId: "Asia/Tokyo" });
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
    if (/\/api\/tasks\/focus/.test(url)) {
      if (req.method() === "POST") return send({ ok: true });
      return send(focusOf({ coached: true }));
    }
    if (/\/api\/nippo\/plan/.test(url)) return send({ plan: null });
    if (/\/api\/nippo\b/.test(url)) {
      return send({ date: "2026-09-16", weekStart: "2026-09-14", me: { userId: "u-1", name: "山田 太郎" },
        today: null, recent: [], replies: [], evals: [], aiConfigured: false, thanks: [],
        weekly: null, weekClosing: { on: "2026-09-18", isToday: false, filled: false },
        openActions: [], todayActions: [], criteria: [], kpisToday: [], team: [], notSubmitted: [] });
    }
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });

  await page.goto(`${BASE}/nippo.html`);
  await page.waitForTimeout(1000);

  check(!(await page.locator("#focus-card button", { hasText: "この内容で確定する" }).isDisabled()),
    "コーチング済みなら押せる");
  check((await page.locator("#focus-card").innerText()).includes("コーチング済み"), "済みの印が出る");
  check((await page.locator("#focus-card").innerText()).includes("組んだ相手：鈴木 次郎"), "誰と組んだかが出る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
