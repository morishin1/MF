// 日報（nippo.html）：朝に決めた「今日やること」と、終業時の「今日の成果」を1対1にする。
// 明日の最優先は、入力 → 保存 → 再取得 → 翌日の「今日やること」まで通る。
//
// ■ 何を守るテストか
//   1. 今日やること 3件 → 成果 3件、2件 → 2件、1件 → 1件（空欄を3つ固定で出さない）
//      朝の「今日の最優先」も1行目に入る（以前は落ちて 3 → 2 になっていた）
//   2. 明日の重要タスク（今日の分）はタスクのID（task_id）つきで並び、提出でもIDを送る
//   3. 明日の重要タスクのカードが読めないときも、⑦ 明日の最優先は直接書けて、提出で送られる
//   4. カードの操作が失敗したら、描き直したあとも理由が残る
//   5. 確定ずみなら、取り消してから直せる（取り消す手段がある）
//   6. スマホ幅（390px）で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const DATE = "2026-10-07";
const NEXT = "2026-10-08";
const ME = {
  email: "a@b.c", appRole: "member", shows: {}, isAdmin: false, roles: [], memberships: [],
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" }, roles: [], tenantId: "t1", stage: null },
};
const nippoBody = (over = {}) => ({
  date: DATE, weekStart: "2026-10-05", me: { userId: "u-1", name: "山田 太郎" },
  today: null, recent: [], replies: [], evals: [], aiConfigured: false, thanks: [],
  weekly: null, weekClosing: { on: "2026-10-09", isToday: false, filled: false },
  openActions: [], todayActions: [], criteria: [], kpisToday: [], team: [], notSubmitted: [], focus: null,
  ...over,
});
const FOCUS_OK = (over = {}) => ({
  today: DATE, tomorrowDate: NEXT, todayTasks: [], todayProgress: { done: 0, total: 0, label: "0 / 0" },
  tomorrowTasks: [], tomorrowState: { key: "draft", label: "登録", ready: false, confirmed: false, coached: false, count: 0, todo: "" },
  carryOver: [], carryChoices: [], openTasks: [{ id: "o1", title: "C社へ見積", dueOn: null }],
  fields: [], min: 1, max: 3, coachSteps: [], coachQuestions: [], qualityLevels: [], people: [], me: { id: "emp-1" },
  ...over,
});

/** @param {{nippo: () => object, focus: (req) => {status?:number, body:object}}} h */
async function open(h, { width = 1280 } = {}) {
  const posted = [];
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
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
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/tasks\/focus/.test(url)) {
      const b = req.method() === "POST" ? JSON.parse(req.postData() || "{}") : null;
      if (b) posted.push({ kind: "focus", body: b });
      const r = h.focus(b);
      return send(r.body, r.status || 200);
    }
    if (/\/api\/nippo\/plan/.test(url)) return send({ plan: null });
    if (/\/api\/nippo\b/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push({ kind: "nippo", body: b });
        return send({ ok: true, id: "n1", dailyFlags: {}, ai: { configured: false }, actions: { closed: 0 }, tomorrowSeeded: true });
      }
      return send(h.nippo(new URL(url).searchParams.get("date")));
    }
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/nippo.html?date=${DATE}`);
  await page.locator("#f-work .np-item").first().waitFor();
  await page.waitForTimeout(300);
  return { page, posted, errs };
}
const tasksOf = (page) => page.locator("#f-work .np-item [data-k='task']").evaluateAll((xs) => xs.map((x) => x.value));
const noFocus = () => ({ status: 503, body: { error: "not_ready", message: "db/072_focus_tasks.sql" } });

console.log("\n=== 今日やること → 今日の成果（1対1） ===");
for (const [n, top, rest] of [
  [3, "A社へ提案書を送る", ["B社へ電話する", "商品登録を20件行う"]],
  [2, "A社へ提案書を送る", ["B社へ電話する"]],
  [1, "A社へ提案書を送る", []],
]) {
  const { page, errs } = await open({
    nippo: () => nippoBody({ today: { work_date: DATE, morning_at: `${DATE}T09:00:00+09:00`, top_priority: top,
      work_items: rest.map((task) => ({ task })) } }),
    focus: noFocus,
  });
  const got = await tasksOf(page);
  check(got.length === n, `今日やること${n}件 → 成果${n}件（${got.join(" / ")}）`);
  check(got[0] === top, `${n}件：1行目は朝の「今日の最優先」`);
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

{
  const { page, errs } = await open({ nippo: () => nippoBody(), focus: noFocus });
  check((await tasksOf(page)).length === 1, "何も決めていない日は、書く欄を1つだけ（空欄を3つ固定で出さない）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 明日の重要タスク（今日の分）は、タスクのIDつきで成果に並ぶ ===");
{
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const { page, posted, errs } = await open({
    nippo: () => nippoBody({ focus: { date: DATE, today: [
      { id: ids[0], title: "A社へ提案書を送る", status: "todo", doneCondition: "送付済み" },
      { id: ids[1], title: "B社へ電話する", status: "done", result: "話せた" },
      { id: ids[2], title: "商品登録を20件行う", status: "doing" },
    ] } }),
    focus: () => ({ body: FOCUS_OK() }),
  });
  const got = await tasksOf(page);
  check(got.join("|") === "A社へ提案書を送る|B社へ電話する|商品登録を20件行う", `3件 → 3行（${got.join(" / ")}）`);
  const tid = await page.locator("#f-work .np-item [data-k='task_id']").evaluateAll((xs) => xs.map((x) => x.value));
  check(tid.join("|") === ids.join("|"), "各行にタスクのIDが付く");
  check(await page.locator("#f-work .np-item").nth(1).locator(".did .yes.on").count() === 1, "済んだタスクは「できた」の状態で出る");
  await page.locator("#f-work .np-item").nth(0).locator(".did .yes").click();
  await page.locator("#f-work .np-item").nth(2).locator(".did .no").click();
  await page.locator("#f-work .np-item").nth(2).locator("[data-k='undone_reason']").fill("10件まで");
  await page.locator("#submit-btn").click();
  await page.waitForTimeout(600);
  const sent = posted.find((p) => p.kind === "nippo")?.body;
  check(sent?.workItems?.length === 3 && sent.workItems[0].task_id === ids[0] && sent.workItems[0].done === "1",
    "提出でも3件・タスクのIDつきで送る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 明日の最優先：入力 → 保存 → 再取得 → 翌日の「今日やること」 ===");
{
  let saved = null;
  let nextDay = false;   // 翌日になったつもりで開く（日付の欄は今日より先にできないので、API の答えで翌日を再現する）
  const { page, posted, errs } = await open({
    nippo: () => (nextDay
      // 翌日：⑦ から作られた重要タスクが「今日の分」として返る（api/nippo/index.js seedTomorrow → focusFor）
      ? nippoBody({ date: NEXT, focus: { date: NEXT, today: [{ id: "44444444-4444-4444-8444-444444444444", title: saved, status: "todo" }] } })
      : nippoBody({ today: saved ? { work_date: DATE, tomorrow_plan: saved, work_items: [{ task: "A社へ提案", done: true }] } : null })),
    focus: noFocus,
  });
  check(await page.locator("#f-tomorrow").isVisible() && !(await page.locator("#f-tomorrow").evaluate((x) => x.readOnly)),
    "明日の重要タスクのカードが読めなくても、⑦ に直接書ける");
  check((await page.locator("#f-tomorrow-lead").innerText()).includes("明日の「今日やること」に入ります"), "書いたらどうなるかを出す");
  await page.locator("#f-work .np-item [data-k='task']").first().fill("A社へ提案");
  await page.locator("#f-work .np-item").first().locator(".did .yes").click();
  await page.fill("#f-tomorrow", "B社へ見積を出す");
  await page.locator("#submit-btn").click();
  await page.waitForTimeout(600);
  const sent = posted.find((p) => p.kind === "nippo")?.body;
  check(sent?.tomorrowPlan === "B社へ見積を出す", "提出で ⑦ を送る");
  saved = sent?.tomorrowPlan;
  await page.reload();
  await page.locator("#f-work .np-item").first().waitFor();
  await page.waitForTimeout(300);
  check(await page.locator("#f-tomorrow").inputValue() === "B社へ見積を出す", "ページを開き直しても、保存した内容が残る");
  nextDay = true;
  await page.reload();
  await page.locator("#f-work .np-item").first().waitFor();
  await page.waitForTimeout(300);
  check((await tasksOf(page)).includes("B社へ見積を出す"), "翌日の「今日やること」（成果の行）に出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 明日の重要タスクのカード：失敗の理由が残る・確定を取り消して直せる ===");
{
  let confirmed = true;
  const { page, posted, errs } = await open({
    nippo: () => nippoBody(),
    focus: (b) => {
      if (b?.action === "select") return { status: 409, body: { error: "already_confirmed", hint: "確定ずみです。直すには、いったん確定を取り消してください" } };
      if (b?.action === "unconfirm") { confirmed = false; return { body: { ok: true, state: { confirmed: false } } }; }
      if (b) return { body: { ok: true } };
      return { body: FOCUS_OK({
        tomorrowTasks: [{ id: "n1", title: "見積を出す", focusRank: 1 }],
        tomorrowState: { key: confirmed ? "confirmed" : "draft", label: "", ready: true, confirmed, coached: true, count: 1, todo: "" },
      }) };
    },
  });
  check(await page.locator("#fc-locked").isVisible(), "確定ずみの印と「確定を取り消す」が出る");
  check(await page.locator("#fc-c-o1").isDisabled() && await page.locator("#fc-quick-title").isDisabled(), "確定ずみの間は、候補・追加を押せない");
  check(await page.locator("#f-tomorrow-view").innerText() === "見積を出す", "⑦ は選んだ最優先");
  check(!(await page.locator("#f-tomorrow").isVisible()) && await page.locator("#f-tomorrow").evaluate((x) => x.readOnly),
    "カードがあるときは、⑦ を別に書かせない（カードで選んだものとそろえる）");
  // 押せない状態でも、サーバが断ったときに理由が消えないことを確かめる（描き直したあとも出ている）
  await page.evaluate(() => toggleCandidate("o1", true));
  await page.waitForTimeout(500);
  check((await page.locator("#fc-msg").innerText()).includes("確定ずみです"), "失敗の理由は、描き直したあとも出ている");
  await page.locator("#fc-locked button", { hasText: "確定を取り消す" }).click();
  await page.waitForTimeout(600);
  check(posted.some((p) => p.kind === "focus" && p.body.action === "unconfirm" && p.body.date === NEXT), "確定の取り消しを送る");
  check(!(await page.locator("#fc-locked").count()) && !(await page.locator("#fc-c-o1").isDisabled()), "取り消すと、また選べる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== スマホ幅（390px）・タブレット（768px） ===");
for (const width of [390, 768]) {
  const { page, errs } = await open({
    nippo: () => nippoBody({ today: { work_date: DATE, top_priority: "A社へ提案書を送る", work_items: [{ task: "B社へ電話する" }, { task: "商品登録を20件行う" }] } }),
    focus: noFocus,
  }, { width });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `${width}px：横にはみ出さない（${over}px）`);
  check((await tasksOf(page)).length === 3, `${width}px：成果3件`);
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
