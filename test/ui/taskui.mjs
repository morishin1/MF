// タスク一覧と、右の引き出しを、実際のブラウザで通す。
//
// ■ 何を守りたいのか
//
//   一覧は「探す場所」、引き出しは「処理する場所」。
//     ・一覧は1行が短く、たくさん並ぶ（情報の密度を落とさない）
//     ・行を押しても別の画面へ飛ばない。背面の一覧はそのまま残る
//     ・担当・期限・優先度・完了・コメントを、引き出しの中で変えられる
//     ・変えても、見ていた場所から動かない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ROWS = [
  { id: "t1", title: "A社へ提案書を送る", assigneeId: "emp-1", assignee: "山田 太郎",
    department: "営業", dueOn: "2026-09-10", priority: "high", priorityLabel: "高",
    category: "営業", service: "ENGER", kpi: "新規開拓", status: "todo", statusLabel: "未着手",
    focusDate: null, carryCount: 0, hasAi: false, badges: ["overdue", "urgent"], overdue: true },
  { id: "t2", title: "ENGER候補者3名を推薦", assigneeId: "emp-1", assignee: "山田 太郎",
    department: "営業", dueOn: "2026-09-16", priority: "normal", priorityLabel: "ふつう",
    category: "採用", service: "ENGER", kpi: null, status: "todo", statusLabel: "未着手",
    focusDate: "2026-09-16", carryCount: 1, hasAi: true, aiVerdict: "fix",
    badges: ["today", "ai"], overdue: false },
  { id: "t3", title: "記事の確認", assigneeId: "emp-2", assignee: "鈴木 次郎",
    department: "制作", dueOn: "2026-09-18", priority: "low", priorityLabel: "低",
    category: "制作", service: null, kpi: null, status: "done", statusLabel: "完了",
    focusDate: null, carryCount: 0, hasAi: false, badges: ["done"], overdue: false },
];

const LIST = {
  today: "2026-09-16", tomorrow: "2026-09-17",
  kpi: { today: 3, done: 1, open: 2, overdue: 1, noTomorrow: 2, waiting: 1 },
  rows: ROWS, total: 3,
  ranges: [{ key: "today", label: "今日" }, { key: "tomorrow", label: "明日" },
           { key: "week", label: "今週" }, { key: "month", label: "今月" },
           { key: "all", label: "すべて" }],
  priorities: [{ key: "high", label: "高" }, { key: "normal", label: "ふつう" }, { key: "low", label: "低" }],
  statuses: [{ key: "todo", label: "未着手" }, { key: "doing", label: "着手中" },
             { key: "done", label: "完了" }],
  badges: [], people: [{ id: "emp-1", name: "山田 太郎" }, { id: "emp-2", name: "鈴木 次郎" }],
  departments: ["営業", "制作"], services: ["ENGER"],
  filters: {}, canManage: true, me: { id: "emp-hr", name: "事務 花子" }, legacy: false,
};

const DETAIL = {
  task: {
    id: "t2", title: "ENGER候補者3名を推薦", body: null,
    purpose: "採用KPIを埋めるため", doneCondition: "3名の推薦が完了している",
    kpi: "採用", service: "ENGER", url: null,
    assigneeId: "emp-1", assignee: "山田 太郎", dueOn: "2026-09-16",
    priority: "normal", priorityLabel: "ふつう", status: "todo", statusLabel: "未着手",
    category: "採用", result: null, notDoneReason: null,
    focusDate: "2026-09-16", carryCount: 1, acceptedAt: null, completedAt: null,
    createdAt: "2026-09-15T01:00:00Z", createdBy: "事務 花子", madeBy: "human",
    ai: { verdict: "fix", reason: "作業になっています", fix: "ENGER候補者を5名推薦する",
          doneCondition: "5名の推薦が完了している", kpi: "採用", checkedAt: "2026-09-15T09:00:00Z" },
    aiAssigneeId: "emp-2", aiAssignee: "鈴木 次郎", aiAssigneeWhy: "山田さんに寄っているため",
  },
  comments: [{ id: "c1", name: "事務 花子", body: "今週中にお願いします",
               at: "2026-09-15T02:00:00Z", mine: false }],
  events: [
    { id: 1, kind: "created", kindLabel: "作成", who: "事務 花子", text: "作成しました",
      at: "2026-09-15T01:00:00Z" },
    { id: 2, kind: "due", kindLabel: "期限変更", who: "山田 太郎",
      text: "期限を 2026-09-15 → 2026-09-16", at: "2026-09-15T05:00:00Z" },
  ],
  people: [{ id: "emp-1", name: "山田 太郎" }, { id: "emp-2", name: "鈴木 次郎" }],
  priorities: LIST.priorities, statuses: LIST.statuses,
  carryChoices: [
    { key: "carry", label: "明日へ持ち越す", hint: "同じ内容で" },
    { key: "lower", label: "優先度を下げる", hint: "ふつうのタスクに戻す" },
    { key: "hand", label: "別の人へ渡す", hint: "担当を変える" },
    { key: "drop", label: "やらないことにする", hint: "取りやめる" },
  ],
  canEdit: true, canManage: true, me: { id: "emp-hr", name: "事務 花子" },
};

const posted = [];
const asked = [];

const page = await br.newPage({ viewport: { width: 1440, height: 950 }, timezoneId: "Asia/Tokyo" });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({
    appRole: "admin", name: "事務", shows: {}, stage: null }));
});
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("dialog", (d) => d.accept());

await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                      body: JSON.stringify(b) });
  if (/\/api\/tasks\/detail/.test(url)) {
    if (req.method() === "POST") { posted.push(JSON.parse(req.postData() || "{}")); return send({ ok: true, label: "明日へ持ち越す" }); }
    return send(DETAIL);
  }
  if (/\/api\/tasks\/list/.test(url)) { asked.push(url); return send(LIST); }
  if (/\/api\/tasks\/board/.test(url)) {
    return send({ date: "2026-09-16", tomorrow: "2026-09-17", rows: [],
                  summary: {}, departments: [], people: [], states: [] });
  }
  if (/\/api\/tasks/.test(url)) return send({ tasks: [], templates: [], canManage: true });
  if (/\/api\/employees/.test(url)) return send({ employees: [] });
  if (/\/api\/me\b/.test(url)) {
    return send({ email: "a@b.c", appRole: "admin", shows: {}, isAdmin: true,
      roles: [], memberships: [],
      gw: { employee: { id: "emp-hr", display_name: "事務 花子", status: "active" },
            roles: ["owner"], tenantId: "t1", stage: null } });
  }
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  return send({});
});

await page.goto(`${BASE}/admin-tasks.html`);
await page.waitForTimeout(900);

console.log("\n— 初期表示は「今日の実行状況」。タブで切り替える —");
{
  check(await page.locator("#panel-today").isVisible(), "最初は今日の実行状況");
  check(!(await page.locator("#panel-all").isVisible()), "全タスクは最初は隠れている");
  check(await page.locator("#tab-today").getAttribute("class") === "tab active", "今日の実行状況タブが選ばれている");
  await page.locator("#tab-all").click();
  await page.waitForTimeout(300);
  check(await page.locator("#panel-all").isVisible(), "押すと全タスクに切り替わる");
  check(!(await page.locator("#panel-today").isVisible()), "今日の実行状況は隠れる");
}

console.log("\n— 上の6つの数 —");
{
  const kpi = await page.locator("#tk-kpi").innerText();
  for (const label of ["今日のタスク", "完了", "未完了", "期限超過", "明日の3タスク未登録", "AI確認待ち"]) {
    check(kpi.includes(label), `KPI：${label}`);
  }
  check(await page.locator("#tk-kpi .box").count() === 6, "6つ");
}

console.log("\n— 絞り込み。初期表示は少なく、詳細条件にまとめる —");
{
  const seg = await page.locator("#tk-range button").allTextContents();
  check(seg.join("").includes("今日") && seg.join("").includes("今週") && seg.join("").includes("今月"),
    "今日・明日・今週・今月");
  for (const id of ["tk-who", "tk-st"]) {
    check(await page.locator(`#${id}`).count() === 1 && await page.locator(`#${id}`).isVisible(), `初期表示：${id}`);
  }
  check(!(await page.locator("#tk-adv").isVisible()), "詳細条件は最初は隠れている");
  for (const id of ["tk-dep", "tk-svc", "tk-pri", "tk-ai", "tk-q"]) {
    check(await page.locator(`#${id}`).count() === 1, `詳細条件の中にある：${id}`);
  }
  await page.locator("#tk-adv-btn").click();
  await page.waitForTimeout(300);
  check(await page.locator("#tk-adv").isVisible(), "押すと詳細条件が開く");

  await page.locator("#tk-range button", { hasText: "今日" }).click();
  await page.waitForTimeout(400);
  check(asked.some((u) => /range=today/.test(u)), "期間をサーバに渡す");
  await page.fill("#tk-q", "ENGER");
  await page.waitForTimeout(600);
  check(asked.some((u) => /q=ENGER/.test(u)), "キーワードをサーバに渡す");
}

console.log("\n— 一覧は1行が短く、印で分かる —");
{
  check(await page.locator(".tk-row").count() === 3, "3行");
  const first = await page.locator(".tk-row").first().innerText();
  check(/A社へ提案書を送る/.test(first), "タスク名");
  check(/山田 太郎/.test(first), "担当");
  check(/09\/10/.test(first), "期限");
  check(/高/.test(first), "優先度");
  check(/営業/.test(first) && /ENGER/.test(first), "分類とサービス");
  check(/期限超過/.test(first) && /緊急/.test(first), "印");
  const second = await page.locator(".tk-row").nth(1).innerText();
  check(/今日/.test(second) && /AI提案/.test(second), "今日・AI提案の印");
  check(/完了/.test(await page.locator(".tk-row").nth(2).innerText()), "完了の印");
  // 一覧に長い文章を出さない
  check(!first.includes("採用KPIを埋めるため"), "目的や完了条件は一覧に出さない");
}

console.log("\n— 押すと右から引き出し。一覧は残る —");
{
  await page.locator(".tk-row").nth(1).click();
  await page.waitForTimeout(600);
  check(await page.locator("#td-panel").isVisible(), "引き出しが出る");
  check(await page.locator(".tk-row").count() === 3, "背面の一覧は残っている");
  check(page.url().endsWith("/admin-tasks.html"), "別の画面へ飛ばない");

  const box = page.locator("#td-panel");
  const head = await box.innerText();
  check(/ENGER候補者3名を推薦/.test(head), "タスク名");
  for (const id of ["td-status", "td-who", "td-pri", "td-due"]) {
    check(await page.locator(`#${id}`).count() === 1, `上で直せる：${id}`);
  }
  check(await page.locator("#td-due").inputValue() === "2026-09-16", "期限が入っている");
}

console.log("\n— タブ（概要・コメント・履歴）—");
{
  const about = await page.locator("#td-body").innerText();
  check(/採用KPIを埋めるため/.test(about) || (await page.locator("#td-purpose").inputValue()) === "採用KPIを埋めるため",
    "概要に目的");
  check((await page.locator("#td-doneCondition").inputValue()) === "3名の推薦が完了している", "完了条件");
  check(/人が作成/.test(about), "AI作成／人作成");
  check(/事務 花子/.test(about), "作成者");

  await page.locator(".td-tabs button", { hasText: "コメント" }).click();
  await page.waitForTimeout(250);
  const c = await page.locator("#td-body").innerText();
  check(/今週中にお願いします/.test(c), "コメントが並ぶ");
  await page.fill("#td-c-input", "明日までにやります");
  await page.locator("#td-body button", { hasText: "送る" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "comment" && p.body === "明日までにやります"), "コメントを送る");

  await page.locator(".td-tabs button", { hasText: "履歴" }).click();
  await page.waitForTimeout(250);
  const h = await page.locator("#td-body").innerText();
  check(/作成/.test(h) && /期限変更/.test(h), "履歴が時系列で並ぶ");
  check(/2026-09-15 → 2026-09-16/.test(h), "何から何へ");
}

console.log("\n— AIの提案は3つのボタン —");
{
  const ai = await page.locator(".td-ai").innerText();
  check(/作業になっています/.test(ai), "理由");
  check(/ENGER候補者を5名推薦する/.test(ai), "直し方");
  check(/鈴木 次郎/.test(ai) && /寄っているため/.test(ai), "担当の案と理由");
  const btns = await page.locator(".td-ai button").allTextContents();
  check(btns.length === 3, `ボタンは3つ（${btns.join("／")}）`);
  check(btns.some((b) => b.includes("提案を採用")) && btns.some((b) => b.includes("このまま進める")),
    "採用・このまま");
  await page.locator(".td-ai button", { hasText: "提案を採用" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "ai" && p.how === "adopt"), "採用を送る");
}

console.log("\n— 引き出しの中で変える —");
{
  const before = posted.length;
  await page.selectOption("#td-pri", "high");
  await page.waitForTimeout(500);
  check(posted.slice(before).some((p) => p.action === "update" && p.priority === "high"), "優先度");
  await page.fill("#td-due", "2026-09-20");
  await page.locator("#td-due").dispatchEvent("change");
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "update" && p.dueOn === "2026-09-20"), "期限");
  await page.selectOption("#td-who", "emp-2");
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "update" && p.assigneeId === "emp-2"), "担当");
  await page.locator("#td-panel button", { hasText: "完了する" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "status" && p.status === "done"), "完了");
}

console.log("\n— 持ち越しも引き出しの中 —");
{
  await page.locator("#td-panel button", { hasText: "持ち越し" }).click();
  await page.waitForTimeout(300);
  const c = await page.locator("#td-body").innerText();
  for (const l of ["明日へ持ち越す", "優先度を下げる", "別の人へ渡す", "やらないことにする"]) {
    check(c.includes(l), `決め方：${l}`);
  }
  await page.locator("#td-body button", { hasText: "明日へ持ち越す" }).click();
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "carry" && p.decision === "carry"), "持ち越しを送る");
}

console.log("\n— 閉じると元の場所 —");
{
  await page.locator("#td-panel .td-x").click();
  await page.waitForTimeout(300);
  check(await page.locator("#td-root.hidden").count() === 1, "引き出しが閉じる");
  check(await page.locator(".tk-row").count() === 3, "一覧はそのまま");
}

console.log("\n— 一覧から直接完了 —");
{
  const before = posted.length;
  await page.locator(".tk-row").first().locator("input[type=checkbox]").check();
  await page.waitForTimeout(500);
  check(posted.slice(before).some((p) => p.action === "status" && p.status === "done"),
    "チェックだけで完了にできる");
}

console.log("\n— スマホでは下から —");
{
  const sp = await br.newPage({ viewport: { width: 390, height: 780 }, timezoneId: "Asia/Tokyo" });
  await sp.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  await sp.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/tasks\/detail/.test(url)) return send(DETAIL);
    if (/\/api\/tasks\/list/.test(url)) return send(LIST);
    if (/\/api\/tasks\/board/.test(url)) return send({ date: "2026-09-16", rows: [], summary: {},
                                                       departments: [], people: [], states: [] });
    if (/\/api\/tasks/.test(url)) return send({ tasks: [], templates: [], canManage: true });
    if (/\/api\/employees/.test(url)) return send({ employees: [] });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "admin", shows: {}, isAdmin: true, roles: [], memberships: [],
        gw: { employee: { id: "emp-hr", display_name: "事務 花子", status: "active" },
              roles: ["owner"], tenantId: "t1", stage: null } });
    }
    return send({});
  });
  await sp.goto(`${BASE}/admin-tasks.html`);
  await sp.waitForTimeout(900);
  await sp.locator("#tab-all").click();
  await sp.waitForTimeout(300);
  await sp.locator(".tk-row").first().click();
  await sp.waitForTimeout(600);
  const r = await sp.locator("#td-panel").boundingBox();
  const vw = 390;
  check(r && r.width > vw * 0.9, `全幅で出る（${Math.round(r?.width || 0)}px）`);
  check(r && r.y > 40, "下から出る（上端ではない）");
  await sp.close();
}

console.log("\n— 画面のエラー —");
check(errs.length === 0, `エラーなし：${errs.join(" / ")}`);

await page.close();
await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
