// 9/9 の指摘ぶん。実際の画面で通す
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const d = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const me = {
  email: "taro@gw.8grp.co.jp",
  gw: { employee: { id: "emp-1", display_name: "今福 太郎", email: "taro@gw.8grp.co.jp",
        department: "制作部", position: "主任", joined_on: "2026-04-01", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null },
  appRole: "member", shows: {},
};

const act = (id, title, o = {}) => ({
  id, title, detail: null, source: "self", sourceLabel: "自分で決めた",
  status: "open", priority: 5, dueDate: null, pinnedAt: null, estimateMin: null,
  createdAt: `${TODAY}T00:00:00Z`, ...o,
});

const DASH = {
  date: TODAY, submittedToday: true,
  morning: { done: true, reported: false },
  top: { ...act("t1", "A社の提案書を出しきる", { dueDate: TODAY }),
         reason: "今日が期限です", reasonLevel: "today" },
  actions: [
    { ...act("a1", "B社の請求書を送る", { dueDate: d(-2) }),
      reason: "期限を 2 日過ぎています", reasonLevel: "over" },
    { ...act("a2", "要件定義のチェック", { dueDate: d(2), estimateMin: 300 }),
      reason: "期限は2日後。5時間かかる見込みなので、今日から", reasonLevel: "lead" },
    { ...act("a3", "掃除当番", { pinnedAt: `${TODAY}T02:00:00Z` }),
      reason: "自分で今日に決めたもの", reasonLevel: "pin" },
  ],
  proposed: [
    { ...act("p1", "〇〇社へのお礼メール送信", {
      status: "proposed", source: "ai", sourceLabel: "AIの提案", dueDate: d(1),
      detail: "日報に「〇〇社訪問完了」の記載があったため" }) },
    { ...act("p2", "次回打ち合わせ資料の作成", {
      status: "proposed", source: "ai", sourceLabel: "AIの提案", dueDate: d(3) }) },
  ],
  overdue: 1,
  kpis: [], kpiSummary: null, alerts: [], growth: null, notices: [], schedule: [], blockers: [],
};

const NIPPO = {
  date: TODAY, weekStart: TODAY,
  me: { userId: "u1", name: "今福 太郎", employType: null },
  today: { id: "n1", work_date: TODAY, top_priority: "A社の提案書を出しきる",
           work_items: [{ task: "A社の提案書を出しきる" }],
           morning_at: `${TODAY}T00:05:00Z`, submitted_at: null },
  recent: [
    { id: "n0", work_date: d(-1), top_priority: "全項目のテストを回す",
      morning_at: `${d(-1)}T00:00:00Z`, submitted_at: `${d(-1)}T09:00:00Z`,
      work_items: [
        { task: "テスト1", done: true, result: "" },
        { task: "テスト2", done: true, result: "" },
        { task: "テスト3", done: true, result: "" },
        { task: "テスト4", done: true, result: "" },
        { task: "テスト5", done: true, result: "" },
        { task: "テスト6", undone_reason: "時間切れ" },
      ] },
  ],
  replies: [], evals: [], aiConfigured: false, thanks: [],
  weekly: null, weekClosing: { on: "2099-01-01", isToday: false, filled: false },
  openActions: [{ ...act("o1", "先週からの持ち越し", { dueDate: d(-3) }) }],
  todayActions: [
    { ...act("t1", "A社の提案書を出しきる", { dueDate: TODAY, priority: 1 }) },
    { ...act("dn", "見積の回収", { status: "done", doneNote: null }) },
  ],
  criteria: [], kpisToday: [], team: [], notSubmitted: [],
};

const TASKS = {
  tasks: [],
  requested: [
    { id: "r1", title: "テスト入力（あなくら）②", body: "テスト送信②です。「頼む」送信した後に、送信側で「取り消す」をクリックしたときに、相手側からタスクは削除されるのか？",
      assignee: { id: "emp-2", display_name: "森田 愛海" }, status: "todo",
      priority: "high", due_on: d(1), byMe: true, canEdit: true },
  ],
  extras: {
    actions: [], onboarding: [],
    proposed: [{ id: "p1", title: "〇〇社へのお礼メール送信", detail: "日報に記載があったため", dueOn: d(1) }],
  },
};

let posted = [];

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(file) {
  const page = await br.newPage({ viewport: { width: 1100, height: 1000 } });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "taro@gw.8grp.co.jp" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "今福 太郎", shows: {}, stage: null }));
    localStorage.removeItem("kp_prop_skipped");
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (req.method() === "POST" || req.method() === "PATCH") {
      posted.push({ url, body: JSON.parse(req.postData() || "{}") });
      return send({ ok: true, count: 1 });
    }
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/dashboard/.test(url)) return send(DASH);
    if (/\/api\/nippo\b/.test(url)) return send(NIPPO);
    if (/\/api\/tasks/.test(url)) return send(TASKS);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/week-goals/.test(url)) return send({ plan: null, goal: null, started: false });
    return send({});
  });
  page.on("pageerror", (e) => errs.push(`${file}: ${e}`));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource/.test(m.text()) && errs.push(`${file}: ${m.text()}`));
  await page.goto(`http://127.0.0.1:8713/${file}`);
  await page.waitForTimeout(1400);
  return page;
}

console.log("— ① 期日から逆算した最優先（ホーム）—");
{
  const p = await open("home.html");
  const txt = await p.locator("#today-card").textContent();
  check(txt.includes("今日が期限です"), "なぜ最優先なのかが出る");
  check((await p.locator("#rest-list .rsn").count()) === 3, "残りにも全部、理由が付く");
  check(txt.includes("期限を 2 日過ぎています"), "期限切れが分かる");
  check(txt.includes("5時間かかる見込みなので、今日から"), "時間のかかる仕事は逆算して出る");
  check(await p.locator("#rest-list .pinmark").count() === 1, "ピン留めに印が付く");
  check(await p.locator("#rest-list .dash-item[draggable='true']").count() === 3, "掴んで動かせる");
  check(await p.locator("button", { hasText: "突発の仕事を足す" }).count() === 1, "突発の仕事を足せる");
  check(await p.locator("button", { hasText: "期日から並べ直す" }).count() === 1, "自動の並びに戻せる");

  posted = [];
  await p.locator("#today-foot button", { hasText: "固定する" }).click();
  await p.waitForTimeout(500);
  check(posted.some((x) => x.body.action === "pin" && x.body.id === "t1"), "固定を押すとピン留めが送られる");

  await p.screenshot({ path: shotPath("f2-home.png"), fullPage: true });
  await p.close();
}

console.log("— ② AI提案の選別（ホーム）—");
{
  const p = await open("home.html");
  check(await p.locator("#prop-card").isVisible(), "AIの提案が別枠で出る");
  check((await p.locator("#prop-tag").textContent()) === "2件", "件数が出る");
  check(!(await p.locator('#prop-list .prop[data-id="p1"] [data-edit]').isVisible()),
    "はじめは入力欄を開かない（そのまま採れるものを迷わせない）");
  await p.locator('#prop-list .prop[data-id="p1"] button', { hasText: "直す" }).click();
  await p.waitForTimeout(250);
  check(await p.locator('#prop-list .prop[data-id="p1"] [data-edit]').isVisible(),
    "「直す」で題名と期日の欄が出る");
  check(!(await p.locator("#today-card").textContent()).includes("お礼メール"),
    "採るまでは「やること」に出てこない");

  // 期日を直してから採用する
  posted = [];
  await p.locator('#prop-list .prop[data-id="p1"] [data-f="due"]').fill(d(5));
  await p.locator('#prop-list .prop[data-id="p1"] button', { hasText: "採用する" }).click();
  await p.waitForTimeout(600);
  const adopt = posted.find((x) => x.body.action === "adopt");
  check(adopt?.body.dueOn === d(5), "直した期日で採用される");
  check(adopt?.body.ids?.[0] === "p1", "採ったものだけが送られる");

  posted = [];
  await p.locator('#prop-list .prop[data-id="p2"] button', { hasText: "いらない" }).click();
  await p.waitForTimeout(600);
  check(posted.some((x) => x.body.action === "reject"), "理由を書かずに断れる");

  await p.locator("button", { hasText: "今回は見送る" }).click();
  await p.waitForTimeout(300);
  check(!(await p.locator("#prop-card").isVisible()), "見送ると閉じる");
  await p.screenshot({ path: shotPath("f2-prop.png"), fullPage: true });
  await p.close();
}

console.log("— 見送っても消えない（やること）—");
{
  const p = await open("tasks.html");
  check(await p.locator("#prop-card").isVisible(), "「やること」に未処理として残る");
  check((await p.locator("#prop-tag").textContent()).includes("1件"), "未確認の件数が出る");
  check((await p.locator("#req-list").textContent()).includes("テスト送信②です"),
    "自分が頼んだことに「補足」が出る");
  await p.screenshot({ path: shotPath("f2-tasks.png"), fullPage: true });
  await p.close();
}

console.log("— 日報の直し —");
{
  const p = await open("nippo.html");
  check(await p.locator("#f-wins-sug").count() === 0, "デキタの「今日の中から入れる」は無くなった");

  const past = await p.locator("#past").textContent();
  check(!past.includes("完了 / 完了"), "これまでの日報に「完了/完了」が出ない");
  check(past.includes("全項目のテスト") || past.includes("全体テスト") || past.includes("テストを回す"),
    "代わりにその日の最優先が1行で出る");
  check(past.includes("できた 5 / 6 件"), "できた件数はそのまま出る");

  // ⑦明日の最優先の候補
  check(await p.locator("#f-tm-hint").isVisible(), "明日の最優先に候補が出る");
  const sug = await p.locator("#f-tm-sug button").allTextContents();
  check(sug.length > 0, `候補が並ぶ（${sug.length}件）`);
  await p.locator("#f-tm-sug button").first().click();
  await p.waitForTimeout(250);
  check((await p.locator("#f-tomorrow").inputValue()).length > 0, "押すと欄に入る");

  // 「やること」で済ませたものが、完了 で埋められていない
  const rows = p.locator("#f-work .np-item");
  const tasks = await rows.locator('[data-k="task"]').evaluateAll((ns) => ns.map((n) => n.value));
  const i = tasks.indexOf("見積の回収");
  check(i >= 0, "済ませたやることが並ぶ");
  check(await rows.nth(i).locator('[data-k="result"]').inputValue() === "",
    "一言を「完了」で埋めない");
  check(await rows.nth(i).locator(".did .yes.on").count() === 1, "それでも「できた」は押された状態");
  check(await rows.nth(i).locator('[data-k="done"]').inputValue() === "1", "done として送られる");

  await p.screenshot({ path: shotPath("f2-nippo.png"), fullPage: true });
  await p.close();
}

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); errs.slice(0, 8).forEach((e) => console.log("  " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
