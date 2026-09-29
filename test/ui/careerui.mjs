// 評価・キャリアを、実際の画面で通す。
//
// ■ 本人（career.html）
//   並びが「現在地 → 次のLevel → 次にやること → 1年後/3年後 → できるようになったこと → 前回評価」。
//   給与レンジには必ず「目安」の注記。✓ △ ○ が出る。「今期の目標に追加」が押せる。
//   キャリア未設定でも、できるようになったことは見える
// ■ 管理（admin-career.html）
//   一覧は NEXT ACTION 順。社員を押すとドロワー。評価はモーダルで、基準ごとに人が選ぶ。
//   「根拠を見る」がある。システム判定は参考。最終判断を選ばないと確定できない。
//   Level Up を選ぶと次の給与レンジと「昇給を検討」が出て、確定後は契約更新への導線が出る
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { journeyOf } from "../../lib/journey.js";

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME_MEMBER = { email: "t@x.jp", appRole: "member", isAdmin: false,
  gw: { employee: { id: "e-taro", display_name: "森田 太郎", status: "active" }, roles: [], isAdmin: false, tenantId: "t1", stage: null } };
const ME_OWNER = { email: "o@x.jp", appRole: "owner", isAdmin: false,
  gw: { employee: { id: "e-owner", display_name: "経営", status: "active" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };

const LABELS = {
  criterionResults: [{ key: "achieved", label: "達成" }, { key: "in_progress", label: "取り組み中" },
                     { key: "not_yet", label: "未達" }, { key: "na", label: "対象外" }],
  reviewResults: [{ key: "continue", label: "現Level継続" }, { key: "level_up", label: "Level Up" }, { key: "hold", label: "保留" }],
  salaryDecisions: [{ key: "none", label: "判断なし" }, { key: "keep", label: "変更なし" }, { key: "raise", label: "昇給を検討" }],
  evidenceTypes: [{ key: "manager", label: "上長の確認" }, { key: "kpi", label: "3か月KPI" }],
};

const MY = {
  career: { trackName: "エンジニア", nextReviewOn: "2027-01-31", oneYearTargetNote: "一人で案件を回す", threeYearTargetNote: null, agreed: true },
  currentLevel: { levelNo: 1, levelName: "基本業務習得", salaryRange: "220,000円〜250,000円" },
  nextLevel: { levelNo: 2, levelName: "一人で担当業務を完結", roleSummary: "一人で業務を完結", salaryRange: "260,000円〜300,000円" },
  currentWage: { wageType: "月給", wageAmount: 240000 },
  rangeNote: "このレンジは次レベルの目安です。実際の給与は評価・役割・契約条件等を確認して決定します。",
  progress: {
    achieved: 1, total: 4,
    categories: [
      { category: "業務遂行", achieved: 1, total: 2, items: [
        { id: "c1", title: "担当タスクを期限内に完了できる", status: "achieved" },
        { id: "c2", title: "指示された内容を正しく実行できる", status: "in_progress" }] },
      { category: "顧客・品質", achieved: 0, total: 2, items: [
        { id: "c3", title: "顧客対応を1案件担当する", status: "not_yet" },
        { id: "c4", title: "品質基準を守れる", status: "not_yet" }] },
    ],
    remaining: [
      { id: "c2", category: "業務遂行", title: "指示された内容を正しく実行できる", status: "in_progress", required: true },
      { id: "c3", category: "顧客・品質", title: "顧客対応を1案件担当する", status: "not_yet", required: true },
      { id: "c4", category: "顧客・品質", title: "品質基準を守れる", status: "not_yet", required: true },
    ],
  },
  horizon: {
    oneYear: { level: { levelNo: 2, levelName: "一人で担当業務を完結" }, goal: "一人で担当業務を完結・基本的な顧客対応" },
    threeYear: { level: { levelNo: 3, levelName: "改善・後輩支援" }, goal: "後輩育成・案件/チーム責任" },
    note: "標準的なキャリアの目安です。昇格時期は役割・成果・成長状況により異なります。",
  },
  growthHistory: [{ on: "2026-10-01", title: "問い合わせ対応を一人で完了できるようになった" }],
  lastReview: { decidedAt: "2026-07-31T00:00:00Z", result: "continue", achieved: 1, total: 4,
                targetLevel: { levelNo: 2 }, managerComment: "よく頑張っています" },
  labels: LABELS,
};

const LEVELS = [
  { id: "l1", trackId: "t-eng", levelNo: 1, levelName: "基本業務習得", salaryMin: 220000, salaryMax: 250000 },
  { id: "l2", trackId: "t-eng", levelNo: 2, levelName: "一人で担当業務を完結", salaryMin: 260000, salaryMax: 300000 },
];
const FLOW_STATES = [
  { key: "setup", label: "未設定", tone: "red" }, { key: "meeting", label: "面談準備", tone: "blue" },
  { key: "contract_preparing", label: "契約準備", tone: "blue" }, { key: "employee_review", label: "本人確認待ち", tone: "yellow" },
  { key: "signing", label: "署名待ち", tone: "yellow" }, { key: "active", label: "開始", tone: "green" },
  { key: "review_due", label: "評価時期", tone: "blue" },
];
const LIST = {
  today: "2026-09-27",
  flowStates: FLOW_STATES,
  tracks: [{ id: "t-eng", name: "エンジニア" }],
  levels: LEVELS,
  canDecide: true, canEditMaster: true,
  people: [
    { employee: { id: "e-new", name: "新人 花子" }, career: null, nextAction: { rank: 0, key: "setup", label: "キャリア設定が必要です" },
      flow: { state: "setup", stateLabel: "未設定", tone: "red", label: "契約・キャリア面談を設定してください" },
      currentWage: { wageType: "月給", wageAmount: 230000 },
      suggestion: { trackId: "t-eng", trackName: "エンジニア", levelId: "l1" } },
    { employee: { id: "e-taro", name: "森田 太郎", department: "開発", managerName: "上長 一郎" },
      career: { trackId: "t-eng", trackName: "エンジニア", currentLevel: LEVELS[0], nextLevel: LEVELS[1], nextReviewOn: "2026-10-05" },
      currentWage: { wageType: "月給", wageAmount: 240000 },
      flow: { state: "review_due", stateLabel: "評価時期", tone: "blue", label: "3か月評価を実施してください", sub: "次回評価：2026/10/05" },
      nextAction: { rank: 3, key: "review", label: "評価面談を実施してください" } },
    { employee: { id: "e-yama", name: "山田 次郎" },
      career: { trackId: "t-eng", trackName: "エンジニア", currentLevel: LEVELS[1], nextLevel: null, nextReviewOn: "2026-12-31" },
      flow: { state: "employee_review", stateLabel: "本人確認待ち", tone: "yellow", label: "本人の確認待ちです", sub: "送信：2026/09/28" },
      nextAction: { rank: 7, key: "progress", label: "L3まで3項目" } },
  ],
};
const DETAIL = {
  employee: { id: "e-taro", name: "森田 太郎", department: "開発", autonomyLevel: 2 },
  career: { id: "car1", trackId: "t-eng", currentLevelId: "l1", nextReviewOn: "2026-10-05", agreedAt: "2026-04-10", managerNote: "内部メモ" },
  track: { name: "エンジニア" },
  currentLevel: LEVELS[0], nextLevel: LEVELS[1], levels: LEVELS, allLevels: LEVELS, tracks: LIST.tracks,
  criteria: [
    { id: "c1", category: "業務遂行", title: "担当タスクを期限内に完了できる", required: true, evidenceType: "tasks" },
    { id: "c2", category: "改善・AI活用", title: "AIを日常業務に使える", required: true, evidenceType: "nippo" },
  ],
  progress: { achieved: 0, total: 2, remaining: [], categories: [
    { category: "業務遂行", achieved: 0, total: 1 }, { category: "改善・AI活用", achieved: 0, total: 1 }] },
  currentWage: { wageType: "月給", wageAmount: 240000 },
  rangeNote: "次のレベルの給与レンジです。実際の昇給・昇格は、評価・役割・会社状況等を確認して決定します。",
  draft: null, reviews: [],
  nextAction: { key: "review", label: "評価面談を実施してください" },
  labels: LABELS, canDecide: true, today: "2026-09-27",
  flow: { state: "review_due", stateLabel: "評価時期", tone: "blue", label: "3か月評価を実施してください",
          sub: "次回評価：2026/10/05", cta: { key: "review", label: "評価する" } },
  contract: { contractType: "正社員", wageType: "月給", wageAmount: 240000, periodFrom: "2026-04-01", probationMonths: 6, workHours: "9:00〜17:00" },
  pastContracts: [{ contractType: "契約社員", wageAmount: 220000, periodFrom: "2025-10-01" }],
  signs: [{ id: "s1", title: "労働条件通知書", status: "signed", sentAt: "2026-03-20", signedAt: "2026-03-25" }],
  orders: [],
  growth: { status: "active", from: "2026-10-01", to: "2026-12-31", threeMonthKgi: "小規模機能を一人で",
            months: [{ monthNo: 1, kgi: "設計を1件", kpis: [{ name: "設計書", target: 1, unit: "件" }] }] },
  autonomy: { level: 2, label: "選択実行型", canEdit: true, recent: [], note: "自走レベルは任せられる範囲です。キャリアLevelとは別に決めます。",
              levels: [{ level: 1, label: "指示実行型" }, { level: 2, label: "選択実行型" }, { level: 3, label: "自律実行型" }, { level: 4, label: "自己組織型" }] },
  contractLinks: { order: "admin-esign.html?tab=order&employeeId=e-taro", signs: "admin-esign.html?tab=list",
                   growth: "admin-growth.html?employeeId=e-taro", preview: "career.html?preview=e-taro" },
};
DETAIL.employee.userId = "u-taro";
DETAIL.employee.managerName = "上長 一郎";
DETAIL.tracks = [{ id: "t-eng", name: "エンジニア", oneYearGoal: "小規模な開発を一人で担当できる", threeYearGoal: "案件をリードできる" }];
DETAIL.progress.items = [
  { id: "c1", category: "業務遂行", title: "担当タスクを期限内に完了できる", status: "achieved" },
  { id: "c2", category: "改善・AI活用", title: "AIを日常業務に使える", status: "not_yet" },
];
DETAIL.progress.remaining = [DETAIL.progress.items[1]];

// キャリア未設定の新人（面談を始める前 → STEP2 のあとはキャリアあり）
const NEW_BASE = {
  employee: { id: "e-new", userId: "u-new", name: "新人 花子", autonomyLevel: 1 },
  career: null, track: null, currentLevel: null, nextLevel: null, levels: [], allLevels: LEVELS, tracks: DETAIL.tracks,
  criteria: [], progress: null, currentWage: { wageType: "月給", wageAmount: 230000 },
  contract: { contractType: "正社員", wageType: "月給", wageAmount: 230000, periodFrom: "2026-10-01", probationMonths: 6, workHours: "9:00〜17:00" },
  pastContracts: [], signs: [], orders: [], growth: null,
  autonomy: { ...DETAIL.autonomy, level: 1, label: "指示実行型" },
  rangeNote: DETAIL.rangeNote, timelineNote: "標準的なキャリアの目安です。",
  draft: null, reviews: [], labels: LABELS, canDecide: true, canGrowth: true, today: "2026-09-27",
  suggestion: { trackId: "t-eng", trackName: "エンジニア", levelId: "l1" },
  flow: { state: "setup", stateLabel: "未設定", tone: "red", label: "契約・キャリア面談を設定してください",
          cta: { key: "meeting", label: "契約・キャリア面談を開始" } },
  contractLinks: { order: "admin-esign.html?tab=order&employeeId=e-new", signs: "admin-esign.html?tab=list",
                   growth: "admin-growth.html?employeeId=e-new", preview: "career.html?preview=e-new" },
};
const newDetail = () => {
  if (!newState.career) return NEW_BASE;
  return {
    ...NEW_BASE, track: { name: "エンジニア", one_year_goal: "小規模な開発を一人で担当できる" },
    career: { id: "car-new", trackId: "t-eng", currentLevelId: "l1", nextReviewOn: newState.review || null,
              oneYearTargetNote: newState.one || null, threeYearTargetNote: newState.three || null,
              confirmPending: Boolean(newState.sent), confirmRequestedAt: newState.sent ? "2026-09-28T01:00:00Z" : null },
    currentLevel: LEVELS[0], nextLevel: LEVELS[1], levels: LEVELS,
    criteria: DETAIL.criteria, progress: { achieved: 1, total: 2, remaining: [DETAIL.progress.items[1]], categories: [], items: DETAIL.progress.items },
    growth: newState.growth ? { status: "draft", from: "2026-10-01", to: "2026-12-31", threeMonthKgi: null, months: [] } : null,
    flow: { state: "meeting", stateLabel: "面談準備", tone: "blue", label: "面談準備が必要です", cta: { key: "meeting", label: "面談を続ける" } },
  };
};
let newState = {};

// 採用決定 → 育成 の進行
// ステータスバーの形（6段階・誰の対応か）は、サーバと同じ lib/journey.js で作る
const REAL = {
  hired: () => journeyOf({ applicant: { status: "accepted" }, employee: null, canAdvance: true, links: {}, today: "2026-09-28" }),
  signing: () => journeyOf({ employee: { id: "e" }, procedure: { id: "p" }, stage: { key: "signing" }, facts: { sign: { status: "sent" } }, links: {}, today: "2026-09-28" }),
  active: () => journeyOf({ employee: { id: "e" }, procedure: null, career: { id: "c" }, careerFlow: { state: "active" }, links: {}, today: "2026-09-28" }),
};
const J = (state, stateLabel, label, extra = {}) => {
  const r = REAL[state]();
  return { ...r, state, stateLabel, label, step: extra.step || 1, total: 10, tone: extra.tone || "blue",
    actorLabel: extra.actorLabel || null, actor: extra.actor || null, sub: extra.sub || null, cta: extra.cta || null };
};
const JOURNEY = {
  today: "2026-09-28", seesApplicants: true,
  states: [{ key: "hired", label: "採用決定" }, { key: "signing", label: "本人確認・署名" }, { key: "active", label: "通常評価" }],
  rows: [
    { kind: "applicant", id: "a-ok", name: "承諾 済子", joinOn: "2026-11-01", updatedAt: "2026-09-27",
      journey: J("hired", "採用決定", "契約条件を設定してください", { actorLabel: "経営者・人事", tone: "red",
        cta: { key: "link", label: "契約条件を設定", href: "admin-onboard.html?applicantId=a-ok" } }) },
    { kind: "employee", id: "e-sign", name: "署名 待男", joinOn: "2026-10-01", updatedAt: "2026-09-25",
      journey: J("signing", "本人署名待ち", "本人の署名完了を待っています", { step: 4, actorLabel: "本人", tone: "yellow" }) },
    { kind: "employee", id: "e-old", name: "通常 評価", joinOn: "2025-04-01", updatedAt: "2026-09-01",
      journey: J("active", "通常評価", "育成中です", { step: 10, tone: "green" }) },
  ],
};
const SIGN_DETAIL = {
  ...NEW_BASE, employee: { id: "e-sign", name: "署名 待男", autonomyLevel: 1 },
  journey: J("signing", "本人署名待ち", "本人の署名完了を待っています", { step: 4, actorLabel: "本人", tone: "yellow",
    cta: { key: "link", label: "署名状況を見る", href: "admin-esign.html?tab=list" } }),
  onboarding: { procedureId: "p1", targetOn: "2026-10-01", stage: "signing", stageN: 3, stageLabel: "締結",
    steps: [{ key: "conditions", n: 1, label: "作成依頼", actorLabel: "管理者", state: "done" },
            { key: "advisor_review", n: 2, label: "社労士確認", actorLabel: "社労士", state: "done" },
            { key: "signing", n: 3, label: "締結", actorLabel: "本人", state: "now" },
            { key: "intake", n: 4, label: "情報入力・提出", actorLabel: "本人", state: "todo" },
            { key: "complete", n: 5, label: "完了", actorLabel: "—", state: "todo" }],
    blockers: ["労働条件通知書の締結がまだです"], profileSubmitted: false, employeeOpen: 3, internalOpen: 2,
    signStatus: "sent", consentsOk: false, links: { hr: "admin-hr.html?id=p1", view: "onboarding.html?employeeId=e-sign" } },
};
const APPLICANT = {
  applicant: { id: "a-ok", name: "承諾 済子", status: "accepted", joinDate: "2026-11-01", employmentType: "正社員",
    wageType: "月給", wageAmount: 250000, probationMonths: 3, workLocation: "本社", recruiterName: "採用 担当" },
  journey: JOURNEY.rows[0].journey, canAdvance: true, links: { applicant: "hr/applicants.html?id=a-ok" },
};
const EVIDENCE = {
  period: { from: "2026-06-29", to: "2026-09-27" }, note: "",
  kpi: { threeMonthKgi: "一人で問い合わせ対応", months: [{ monthNo: 1, kgi: "対応10件", kpis: [{ name: "対応件数", target: 10, unit: "件" }] }] },
  nippo: { days: 42, aiEvaluated: 40 }, tasks: { done: 18, overdue: 1, recentDone: ["資料作成"] },
  growthHistory: [{ on: "2026-09-01", title: "問い合わせ対応を一人で完了" }],
  autonomy: { level: 2, recent: [] }, probation: [], managerComments: [],
  links: { goals: "admin-goals.html" },
};

let posted = [];
async function open(me, path, width = 1400) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me"); localStorage.removeItem("kp_view");
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/career\/me/.test(url)) {
      if (req.method() === "POST") { posted.push(body); return send({ ok: true, taskId: "t9" }); }
      if (/summary=1/.test(url)) return send(me.__summary || { show: false });
      return send(me.__career || MY);
    }
    if (/\/api\/growth/.test(url) && req.method() === "POST") { posted.push({ growth: true, ...body }); newState.growth = true; return send({ plan: {} }); }
    if (/\/api\/autonomy/.test(url) && req.method() === "POST") { posted.push({ autonomy: true, ...body }); return send({ ok: true }); }
    if (/\/api\/career/.test(url)) {
      if (req.method() === "POST") {
        posted.push(body);
        if (body.action === "saveReview") return send({ review: { id: "rv1", status: "draft" }, systemJudgement: {} });
        if (body.action === "setCareer" && body.employeeId === "e-new") {
          newState.career = true;
          if ("oneYearTargetNote" in body) { newState.one = body.oneYearTargetNote; newState.three = body.threeYearTargetNote; }
          if ("nextReviewOn" in body) newState.review = body.nextReviewOn;
          return send({ career: {} });
        }
        if (body.action === "requestConfirm") { newState.sent = true; return send({ ok: true }); }
        if (body.action === "confirmReview") {
          return send({ review: { id: "rv1" }, newLevel: body.result === "level_up" ? LEVELS[1] : null,
            contractNext: body.salaryDecision === "raise" ? { message: "新しい給与条件は、労働条件通知書の更新と電子署名で確定します",
              order: "admin-esign.html?tab=order&employeeId=e-taro" } : null });
        }
        return send({ ok: true });
      }
      if (/evidence=/.test(url)) return send(EVIDENCE);
      if (/preview=/.test(url)) return send({ ...MY, confirm: { pending: true }, contractSign: { pending: [{ id: "s9", title: "労働条件通知書" }], link: "contracts.html" },
        contract: { contractType: "正社員" }, preview: { employeeName: "森田 太郎" } });
      if (/employeeId=e-new/.test(url)) return send(newDetail());
      if (/employeeId=e-sign/.test(url)) return send(SIGN_DETAIL);
      if (/journey=1/.test(url)) return send(JOURNEY);
      if (/applicant=/.test(url)) return send(APPLICANT);
      if (/employeeId=/.test(url)) return send(DETAIL);
      if (/history=1/.test(url)) return send({ reviews: [], labels: LABELS });
      return send(LIST);
    }
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(900);
  return page;
}

console.log("— 本人：career.html —");
{
  const page = await open(ME_MEMBER, "career.html");
  const order = await page.locator(".card[id^='sec-']").evaluateAll((ns) => ns.map((n) => n.id));
  check(order.join(",") === "sec-now,sec-next,sec-todo,sec-horizon,sec-dekiru,sec-last",
    `並び：現在地→次のLevel→次にやること→1年/3年→できるようになったこと→前回評価（いま ${order}）`);
  const now = await page.locator("#sec-now").innerText();
  check(now.includes("エンジニア") && now.includes("LEVEL 1") && now.includes("240,000円") && now.includes("2027年1月31日"),
    "現在地：職種・Level・現在給与・次回評価");
  const next = await page.locator("#sec-next").innerText();
  check(next.includes("LEVEL 2") && next.includes("260,000円〜300,000円"), "次のLevelと給与レンジ");
  check((await page.locator("#range-note").innerText()).includes("目安"), "レンジに「目安」の注記");
  check(!next.includes("必ず"), "「必ず○円になる」とは書かない");
  const todo = await page.locator("#sec-todo").innerText();
  check(todo.includes("次のLevelまで、あと3つ"), "「次のLevelまで、あと3つ」");
  check(await page.locator("#sec-todo button:has-text('今期の目標に追加')").count() === 3, "「今期の目標に追加」");
  check(todo.includes("✓") && todo.includes("△") && todo.includes("○"), "✓ △ ○ を出す");
  check(todo.includes("1 / 2") && todo.includes("0 / 2"), "カテゴリーごとの進捗");
  const hz = await page.locator("#sec-horizon").innerText();
  check(hz.includes("1年後") && hz.includes("3年後") && hz.includes("標準的なキャリアの目安"), "1年後/3年後と注記");
  check((await page.locator("#sec-dekiru").innerText()).includes("問い合わせ対応を一人で完了"), "できるようになったこと");
  check((await page.locator("#sec-last").innerText()).includes("現Level継続"), "前回評価");
  await page.locator("#sec-todo button:has-text('今期の目標に追加')").first().click();
  await page.waitForTimeout(300);
  check(posted.some((p) => p.action === "addGoal" && p.criterionId === "c2"), "押すと addGoal が届く");
  const side = await page.locator(".kp-sidebar").innerText().catch(() => "");
  check(side.includes("キャリア"), "左メニューに「キャリア」");
  await page.screenshot({ path: shotPath("career-member.png"), fullPage: true });
  await page.close();
}

console.log("\n— 本人：キャリア未設定 —");
{
  const page = await open({ ...ME_MEMBER, __career: { career: null, message: "キャリアはまだ設定されていません。", growthHistory: [{ on: "2026-09-01", title: "日報を毎日出せるようになった" }] } }, "career.html");
  const t = await page.locator("#body").innerText();
  check(t.includes("まだ設定されていません") && t.includes("日報を毎日出せるようになった"), "未設定でも、できるようになったことは見える");
  await page.close();
}

console.log("\n— 本人：スマホ幅 —");
{
  const page = await open(ME_MEMBER, "career.html", 390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `横スクロールが出ない（はみ出し ${overflow}px）`);
  await page.close();
}

console.log("\n— 管理：admin-career.html —");
{
  posted = [];
  const page = await open(ME_OWNER, "admin-career.html");
  const names = await page.locator("#rows tr[data-emp]").evaluateAll((ns) => ns.map((n) => n.dataset.emp));
  check(names.join(",") === "e-new,e-taro,e-yama", `NEXT ACTION 順（いま ${names}）`);
  const first = await page.locator("#rows tr").first().innerText();
  check(first.includes("契約・キャリア面談を設定してください") && first.includes("候補：エンジニア") && first.includes("未設定"),
    "未設定・NEXT ACTION・職種の候補");
  const heads = (await page.locator("thead th").allInnerTexts()).map((x) => x.trim()).slice(0, 10);
  check(heads.join("/") === "氏名/職種/現在/現在給与/契約/キャリア/次回評価/状態/NEXT ACTION/担当", `一覧の列（いま ${heads.join("/")}）`);
  const taroRow = await page.locator('#rows tr[data-emp="e-taro"]').innerText();
  check(taroRow.includes("240,000円") && taroRow.includes("評価時期") && taroRow.includes("上長 一郎"), "現在給与・状態・担当");
  check(await page.locator('#rows tr[data-emp="e-yama"] .cr-tone.yellow').count() === 1
    && (await page.locator('#rows tr[data-emp="e-yama"]').innerText()).includes("本人確認待ち"), "状態は色＋文字（黄＝確認待ち）");
  check(!taroRow.includes("1年後") && !taroRow.includes("3年後"), "一覧に1年後・3年後は出さない");
  await page.selectOption("#f-state", "employee_review");
  check(await page.locator("#rows tr[data-emp]").count() === 1, "状態フィルタ");
  await page.selectOption("#f-state", "");
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "キャリア/入社〜育成/3か月育成/自走レベル/評価履歴", `上部タブ（いま ${tabs.join("/")}）`);
  const side = await page.locator(".kp-sidebar").innerText();
  check(side.includes("評価・キャリア") && !side.includes("評価・育成"), "左メニューは「評価・キャリア」");

  await page.selectOption("#f-when", "unset");
  check(await page.locator("#rows tr[data-emp]").count() === 1, "評価時期フィルタ（未設定）");
  await page.selectOption("#f-when", "");
  await page.fill("#f-q", "山田");
  check(await page.locator("#rows tr[data-emp]").count() === 1, "検索");
  await page.fill("#f-q", "");

  await page.click('#rows tr[data-emp="e-taro"]');
  await page.waitForTimeout(400);
  const dr = await page.locator(".cr-drawer").innerText();
  check(dr.includes("NEXT ACTION") && dr.includes("3か月評価を実施してください"), "ドロワー：NEXT ACTION");
  const sum = await page.locator("#cr-sum").innerText();
  check(sum.includes("L1") && sum.includes("L2") && sum.includes("240,000円") && sum.includes("2026/10/05") && sum.includes("評価時期"),
    "ドロワー上部：現在・次のLevel・現在給与・次回評価・状態");
  check(await page.locator(".cr-drawer .btn-primary").count() === 1, "Primary CTA は1つ");
  const dtabs = (await page.locator(".cr-tabs button").allInnerTexts()).map((x) => x.trim());
  check(dtabs.join("/") === "概要/契約/入社手続き/キャリア/育成/履歴", `ドロワーのタブ（いま ${dtabs.join("/")}）`);
  await page.click('.cr-tabs button[data-tab="contract"]');
  const ct = await page.locator("#cr-tab-body").innerText();
  check(ct.includes("正社員") && ct.includes("9:00〜17:00") && ct.includes("署名済み") && ct.includes("220,000円"), "契約タブ：現在の契約・電子署名・過去契約");
  check(await page.locator('#cr-tab-body a[href*="tab=order"]').count() === 1, "契約タブ：契約書作成依頼へ");
  await page.click('.cr-tabs button[data-tab="career"]');
  const cct = await page.locator("#cr-tab-body").innerText();
  check(cct.includes("260,000円〜300,000円") && cct.includes("実際の昇給・昇格は") && cct.includes("AIを日常業務に使える"),
    "キャリアタブ：給与レンジ（注記つき）・評価基準");
  await page.click('.cr-tabs button[data-tab="growth"]');
  await page.waitForTimeout(300);
  const gt = await page.locator("#cr-tab-body").innerText();
  check(gt.includes("小規模機能を一人で") && gt.includes("設計書") && gt.includes("選択実行型") && gt.includes("問い合わせ対応を一人で完了"),
    "育成タブ：3か月育成・KPI・自走レベル・できるようになったこと");
  await page.click('.cr-tabs button[data-tab="history"]');
  const ht = await page.locator("#cr-tab-body").innerText();
  check(ht.includes("契約") && ht.includes("労働条件通知書 に署名"), "履歴タブ：契約変更・署名");
  await page.click('.cr-tabs button[data-tab="overview"]');
  await page.screenshot({ path: shotPath("career-admin-drawer.png") });

  await page.click("#cr-cta");
  await page.waitForTimeout(500);
  check(await page.locator(".cr-modal").isVisible(), "評価はモーダル");
  const opts = await page.locator('.cr-crit[data-crit="c1"] .cr-opts').innerText();
  check(["達成", "取り組み中", "未達", "対象外"].every((x) => opts.includes(x)), "基準ごとに 達成/取り組み中/未達/対象外");
  await page.click('.cr-crit[data-crit="c1"] button:has-text("根拠を見る")');
  const ev = await page.locator("#ev-c1").innerText();
  check(ev.includes("完了 18件") && ev.includes("対応件数") && ev.includes("LEVEL 2"), "根拠を見る：タスク・KPI・自走レベル");
  await page.check('input[name="rv-c1"][value="achieved"]');
  await page.check('input[name="rv-c2"][value="in_progress"]');
  const judge = await page.locator("#rv-judge").innerText();
  check(judge.includes("1 / 2 達成") && judge.includes("システム判定") && judge.includes("参考"), "システム判定は参考として出す");

  // 最終判断を選ばないと確定できない
  await page.click("#rv-confirm");
  await page.waitForTimeout(200);
  check((await page.locator("#rv-msg").innerText()).includes("最終判断"), "最終判断を選ばないと確定しない");
  check(!posted.some((p) => p.action === "confirmReview"), "（確定は送られていない）");

  await page.check('input[name="rv-result"][value="level_up"]');
  const sal = await page.locator("#rv-salary").innerText();
  check(sal.includes("260,000円〜300,000円") && sal.includes("240,000円") && sal.includes("変更なし") && sal.includes("昇給を検討"),
    "Level Up：次のレンジ・現在給与・給与変更");
  check(sal.includes("ここでは給与を変えません"), "その場で給与は変えない旨");
  await page.screenshot({ path: shotPath("career-admin-review.png") });
  await page.check('input[name="rv-salary"][value="raise"]');
  await page.click("#rv-confirm");
  await page.waitForTimeout(800);
  const conf = posted.find((p) => p.action === "confirmReview");
  check(conf && conf.result === "level_up" && conf.salaryDecision === "raise", "人が選んだ判断で確定を送る");
  const saved = posted.find((p) => p.action === "saveReview");
  check(saved && saved.criterionResults.length === 2, "基準ごとの結果を保存");
  const done = await page.locator("#rv-done").innerText().catch(() => "");
  check(done.includes("電子署名") && await page.locator('#rv-done a[href*="tab=order"]').count() === 1, "確定後、契約更新（作成依頼）への導線");
  await page.close();
}

console.log("\n— 管理：契約・キャリア面談（5 STEP） —");
{
  posted = []; newState = {};
  const page = await open(ME_OWNER, "admin-career.html");
  await page.click('#rows tr[data-emp="e-new"]');
  await page.waitForTimeout(400);
  check((await page.locator("#cr-cta").innerText()).includes("契約・キャリア面談を開始"), "未設定の社員：CTA「契約・キャリア面談を開始」");
  await page.click("#cr-cta");
  await page.waitForTimeout(300);
  const box = await page.locator(".cr-modal.wz").boundingBox();
  check(box && box.width >= 720 && box.width <= 820, `モーダル幅 720〜820px（いま ${Math.round(box?.width)}）`);
  check(box && box.height <= 1000 * 0.88 + 1, "モーダルの高さは 88vh まで");
  const steps = (await page.locator(".wz-steps li").allInnerTexts()).map((x) => x.replace(/\s+/g, ""));
  check(steps.length === 5 && steps[0].includes("現在の契約") && steps[4].includes("本人へ確認依頼"), "上部に5 STEP");
  check(await page.locator(".wz-steps li.on").count() === 1, "現在の STEP だけ強調");
  const s1 = await page.locator("#wz-contract").innerText();
  check(s1.includes("正社員") && s1.includes("230,000円") && s1.includes("6か月") && s1.includes("9:00〜17:00"), "STEP1：active 契約を自動表示");
  check((await page.locator("#wz-change-contract").getAttribute("href")).includes("tab=order&employeeId=e-new"), "「契約内容を変更する」は既存の作成依頼へ");
  check(await page.locator(".cr-modal .btn-primary").count() === 1, "STEP1 の Primary は1つ");
  // 背景を押すとモーダルだけ閉じる
  await page.mouse.click(10, 500);
  await page.waitForTimeout(200);
  check(await page.locator(".cr-modal").count() === 0 && await page.locator(".cr-drawer").isVisible(), "背景クリック：モーダルだけ閉じ、ドロワーは残る");
  await page.click("#cr-cta");
  await page.click("#wz-next");
  await page.waitForTimeout(300);
  check(await page.locator(".wz-steps li.done").count() === 1, "完了した STEP にチェック");
  check(await page.locator("#wz-track").isVisible() && await page.locator("#wz-level").isVisible() && await page.locator("#wz-autonomy").isVisible(),
    "STEP2：職種・キャリアLevel・自走レベル");
  check((await page.locator(".wz-body").innerText()).includes("キャリアLevelとは別"), "Level と自走レベルは別と明示");
  await page.selectOption("#wz-autonomy", "2");
  await page.click("#wz-next");
  await page.waitForTimeout(200);
  check((await page.locator("#wz-msg").innerText()).includes("理由"), "自走レベルを変えるときは理由が要る");
  await page.fill("#wz-autonomy-note", "手順を自分で選べるようになった");
  await page.click("#wz-next");
  await page.waitForTimeout(400);
  const setc = posted.find((p) => p.action === "setCareer");
  check(setc && setc.trackId === "t-eng" && setc.currentLevelId === "l1", "STEP2 で職種・Level を保存");
  check(posted.some((p) => p.autonomy && p.level === 2 && p.userId === "u-new"), "自走レベルは既存の /api/autonomy（理由つき）");
  check((await page.locator("#wz-1y").inputValue()).includes("小規模な開発") && (await page.locator("#wz-3y").inputValue()).includes("案件をリード"),
    "STEP3：職種マスタから初期表示");
  check((await page.locator(".wz-body").innerText()).includes("職種マスタは変わりません"), "職種マスタは壊さない旨");
  await page.fill("#wz-1y", "小規模開発を一人で完結");
  await page.click("#wz-next");
  await page.waitForTimeout(400);
  check(posted.some((p) => p.action === "setCareer" && p.oneYearTargetNote === "小規模開発を一人で完結" && !("managerNote" in p)),
    "STEP3：社員個別の目標として保存（他の項目は送らない）");
  const s4 = await page.locator(".wz-body").innerText();
  check(s4.includes("LEVEL 1") && s4.includes("LEVEL 2") && s4.includes("260,000円〜300,000円"), "STEP4：現在 → 次のLevel・給与レンジ");
  check(s4.includes("目安であり、昇給を保証するものではありません"), "STEP4：レンジは目安の注記");
  check(await page.locator("#crit-list li.ok").count() === 1 && await page.locator("#crit-list li.no").count() === 1, "STEP4：評価条件 ✓/□ で未達が一目で分かる");
  await page.click("#wz-growth");
  await page.waitForTimeout(400);
  check(posted.some((p) => p.growth && p.action === "create" && p.employeeId === "e-new"), "「3か月育成計画を作る」は既存の /api/growth");
  await page.click("#wz-next");
  await page.waitForTimeout(200);
  check((await page.locator("#wz-msg").innerText()).includes("次回評価日"), "次回評価日が無いと進めない");
  await page.fill("#wz-review", "2026-12-20");
  await page.click("#wz-next");
  await page.waitForTimeout(400);
  const s5 = await page.locator("#wz-summary").innerText();
  check(["現在の契約条件", "新しい契約条件", "現在のLevel", "次のLevel", "次の給与レンジ", "評価基準", "1年後", "3年後", "次回評価日", "3か月育成目標"]
    .every((x) => s5.includes(x)), "STEP5：本人へ送る内容の一覧");
  check((await page.locator("#wz-preview").getAttribute("href")) === "career.html?preview=e-new", "本人画面をプレビュー");
  check(await page.locator(".cr-modal .btn-primary").count() === 1, "STEP5 の Primary は「本人へ確認依頼を送る」だけ");
  await page.screenshot({ path: shotPath("career-admin-meeting.png") });
  await page.click("#wz-send");
  await page.waitForTimeout(500);
  check(posted.some((p) => p.action === "requestConfirm" && p.employeeId === "e-new"), "本人へ確認依頼を送る");
  check(await page.locator("#wz-sent").isVisible(), "送信完了の表示");
  check(!posted.some((p) => p.action === "confirmReview"), "面談で評価・昇格は確定しない");
  await page.close();
}

console.log("\n— 管理：スマホ幅のドロワー —");
{
  const page = await open(ME_OWNER, "admin-career.html", 390);
  await page.click('#rows tr[data-emp="e-taro"]');
  await page.waitForTimeout(400);
  const vh = 1000;
  const inView = async (sel) => { const b = await page.locator(sel).first().boundingBox(); return b && b.y + b.height <= vh; };
  check(await inView("#cr-cta") && await inView("#cr-next") && await inView("#cr-sum"), "NEXT ACTION・CTA・現在/次Level/次回評価が最初の画面に入る");
  const w = await page.locator(".cr-drawer").boundingBox();
  check(w && w.width >= 380, "ドロワーはほぼ全画面");
  await page.close();
}

console.log("\n— 本人：契約・キャリアの確認 —");
{
  posted = [];
  const ask = { ...MY, confirm: { pending: true, requestedAt: "2026-09-28T01:00:00Z" },
    contract: { contractType: "正社員", wageType: "月給", wageAmount: 240000 },
    contractSign: { pending: [{ id: "s9", title: "労働条件通知書" }], link: "contracts.html" } };
  const page = await open({ ...ME_MEMBER, __career: ask }, "career.html#confirm", 390);
  const first = await page.locator(".card[id^='sec-']").first().getAttribute("id");
  check(first === "sec-confirm", "確認依頼があるとき、いちばん上に「あなたの契約・キャリア」");
  const t = await page.locator("#sec-confirm").innerText();
  check(t.includes("240,000円") && t.includes("L1") && t.includes("L2") && t.includes("260,000円〜300,000円"), "現在の契約・現在・次・次の給与レンジ");
  check(t.includes("目安であり、昇給を保証するものではありません"), "レンジは目安の注記");
  check(t.includes("あと必要なこと") && t.includes("1 / 4") && t.includes("顧客対応を1案件担当する"), "あと必要なこと（未達）");
  check(t.includes("1年後") && t.includes("3年後") && t.includes("2027年1月31日"), "1年後・3年後・次回評価");
  check(await page.locator('#act-contract a:has-text("内容を確認して署名")').getAttribute("href") === "contracts.html", "契約書：内容を確認して署名（電子署名へ）");
  check(t.includes("法的な署名ではありません"), "キャリアプランは法的な署名ではない");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `スマホで横スクロールが出ない（はみ出し ${overflow}px）`);
  await page.screenshot({ path: shotPath("career-member-confirm.png"), fullPage: true });
  await page.click("#btn-confirm-plan");
  await page.waitForTimeout(400);
  check(posted.some((p) => p.action === "confirmPlan"), "「内容を確認しました」を送る");
  await page.close();
}

console.log("\n— 管理者の本人画面プレビュー —");
{
  posted = [];
  const page = await open(ME_OWNER, "career.html?preview=e-taro");
  check(await page.locator("#preview-banner").isVisible(), "プレビューの表示");
  check(await page.locator("#btn-confirm-plan").isDisabled(), "プレビューでは押せない");
  await page.locator("#sec-todo button").first().click().catch(() => {});
  await page.waitForTimeout(200);
  check(!posted.length, "プレビューでは何も送らない");
  await page.close();
}

console.log("\n— 本人：ホームの NEXT ACTION —");
{
  const page = await open({ ...ME_MEMBER, __summary: { show: true, confirmPending: true, signPending: 1, link: "career.html#confirm" } }, "home.html");
  await page.waitForTimeout(400);
  const t = await page.locator("#career-ask").innerText().catch(() => "");
  check(t.includes("契約・キャリアの確認があります") && t.includes("現在の契約内容と今後のキャリアプラン"), "ホームに「契約・キャリアの確認があります」");
  check(await page.locator('#career-ask a:has-text("確認する")').getAttribute("href") === "career.html#confirm", "［確認する］で確認画面へ");
  await page.close();
}

console.log("\n— 管理：入社〜育成（採用決定 → 契約 → 入社 → キャリア → 育成） —");
{
  posted = [];
  const page = await open(ME_OWNER, "admin-career.html?tab=journey");
  check(await page.locator("#pane-journey").isVisible(), "?tab=journey で進行一覧");
  const on = await page.locator(".kp-subnav .kp-subtab.on").allInnerTexts();
  check(on.join("").includes("入社〜育成"), "「入社〜育成」のタブが選ばれている");
  const heads = (await page.locator("#pane-journey thead th").allInnerTexts()).map((x) => x.trim());
  check(heads.join("/") === "氏名/現在状態/NEXT ACTION/担当/入社予定日/更新日", `列（いま ${heads.join("/")}）`);
  check(await page.locator("#j-rows tr[data-id]").count() === 2, "通常評価に移った人は既定で隠す");
  await page.check("#j-all");
  check(await page.locator("#j-rows tr[data-id]").count() === 3, "「通常評価に移った人も表示」");
  check(await page.locator('#j-rows tr[data-id="e-sign"] .jb-mini i.now').count() === 1, "一覧にも小さなステータスバー");
  const sign = await page.locator('#j-rows tr[data-id="e-sign"]').innerText();
  check(sign.includes("本人署名待ち") && sign.includes("本人の署名完了を待っています") && sign.includes("本人") && sign.includes("2026/10/01"),
    "現在状態・NEXT ACTION・担当・入社予定日");
  // 社員：右ドロワー（入社手続きタブ）
  await page.click('#j-rows tr[data-id="e-sign"]');
  await page.waitForTimeout(400);
  const dtabs = (await page.locator(".cr-tabs button").allInnerTexts()).map((x) => x.trim());
  check(dtabs.join("/") === "概要/契約/入社手続き/キャリア/育成/履歴", `ドロワーのタブ（いま ${dtabs.join("/")}）`);
  check((await page.locator("#cr-next").innerText()).includes("本人の署名完了を待っています"), "NEXT ACTION は進行の状態");
  check(await page.locator("#cr-cta").innerText() === "署名状況を見る" && await page.locator(".cr-drawer .btn-primary").count() === 1, "Primary CTA は1つ");
  check((await page.locator("#jr-bar li.now .jb-l").innerText()) === "契約", "共通ステータスバー：いま「契約」");
  check(await page.locator("#jr-bar li").count() === 6 && await page.locator("#jr-bar li.done").count() === 1, "6段階・完了は ✓（採用決定）");
  const adm = await page.locator("#jb-admin").innerText();
  check(adm.includes("本人の対応待ち") && adm.includes("現在の担当") && adm.includes("本人"), "管理者：いまの担当（本人の対応待ち）");
  const order = await page.locator(".cr-drawer").evaluate((d) => ["#jr-bar", "#cr-sum", "#cr-next", ".cr-tabs"]
    .map((q) => d.querySelector(q)?.getBoundingClientRect().top ?? -1));
  check(order.every((y, i) => y >= 0 && (i === 0 || y > order[i - 1])), "並び：ステータスバー → 現在 → NEXT ACTION → タブ");
  await page.click('.cr-tabs button[data-tab="onboarding"]');
  const ob = await page.locator("#cr-tab-body").innerText();
  check(ob.includes("締結") && ob.includes("署名待ち") && ob.includes("署名後に入力") && ob.includes("署名後に提出"), "入社手続き：署名前は入力・提出へ進まない表示");
  check(await page.locator('#cr-tab-body a[href="admin-hr.html?id=p1"]').count() === 1, "既存の入社手続き画面へ");
  await page.screenshot({ path: shotPath("career-journey-drawer.png") });
  await page.click(".cr-drawer button:has-text('閉じる')");
  // 採用決定：まだ社員でない人
  await page.click('#j-rows tr[data-id="a-ok"]');
  await page.waitForTimeout(400);
  const ad = await page.locator(".cr-drawer").innerText();
  check(ad.includes("契約条件を設定してください") && ad.includes("入社予定者"), "採用決定の人：NEXT ACTION");
  check((await page.locator("#jr-bar li.now .jb-l").innerText()) === "採用決定", "共通ステータスバー：いま「採用決定」");
  await page.click('.cr-tabs button[data-tab="contract"]');
  const cond = await page.locator("#ap-cond").innerText();
  check(cond.includes("正社員") && cond.includes("250,000円") && cond.includes("本社"), "提示する契約条件（採用HRのもの）");
  check(await page.locator("#cr-cta").innerText() === "契約条件を設定", "CTA「契約条件を設定」");
  await page.close();
}

console.log("\n— 本人：共通ステータスバー（home / career / onboarding） —");
{
  const E = { id: "e-taro" }, P = { id: "p1", status: "in_progress" };
  const full = (x) => journeyOf({ links: {}, today: "2026-09-28", employee: E, procedure: P, ...x });
  const pub = (j) => ({ state: j.state, step: j.step, total: j.total, phases: j.phases, phase: j.phase, who: j.who,
    whoText: j.whoText.member, member: j.member, inProgress: j.state !== "active" });
  const DOCS = pub(full({ stage: { key: "intake" }, facts: { profile: { status: "submitted" }, items: [{ owner: "employee", status: "todo", item_key: "doc_id" }] } }));
  const REVIEW = pub(full({ stage: { key: "intake" }, facts: { profile: { status: "submitted" }, items: [{ owner: "admin", status: "todo" }] } }));

  // ホーム：本人の対応（必要書類）
  let page = await open({ ...ME_MEMBER, __summary: { show: false, journey: DOCS } }, "home.html");
  await page.waitForTimeout(400);
  let t = await page.locator("#journey-card").innerText();
  check((await page.locator("#journey-card #jr-bar li.now .jb-l").innerText()) === "本人手続き", "ホーム：いま「本人手続き」");
  check(t.includes("あなたの対応です") && t.includes("次にすること") && t.includes("必要書類の提出"), "ホーム：現在・あなたの対応です・次にすること");
  check((await page.locator("#jb-cta").innerText()) === "必要書類を提出する" && (await page.locator("#jb-cta").getAttribute("href")) === "onboarding.html",
    "ホーム：CTA「必要書類を提出する」");
  check(!t.includes("担当：") && !t.includes("社労士確認待ち"), "本人には管理用語を出さない");
  await page.screenshot({ path: shotPath("journey-member-home.png") });
  await page.close();

  // スマホ：6段階の文字がつぶれない・ページが横にはみ出さない
  page = await open({ ...ME_MEMBER, __summary: { show: false, journey: DOCS } }, "home.html", 390);
  await page.waitForTimeout(400);
  const squashed = await page.locator("#jr-bar .jb-l").evaluateAll((ns) => ns.filter((n) => n.scrollWidth > n.clientWidth + 1).length);
  check(squashed === 0, "スマホ：6段階の文字がつぶれない");
  check(await page.locator("#jr-bar .jb-l").count() === 6, "スマホ：6段階すべて表示（横スクロール）");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `スマホ：ページが横にはみ出さない（${overflow}px）`);
  await page.screenshot({ path: shotPath("journey-member-home-sp.png") });
  await page.close();

  // キャリア：会社の対応中なら、操作は要らない・CTAを出さない
  page = await open({ ...ME_MEMBER, __career: { ...MY, journey: REVIEW } }, "career.html");
  t = await page.locator("#journey-card").innerText();
  check((await page.locator("#journey-card #jr-bar li.now .jb-l").innerText()) === "会社確認", "キャリア：いま「会社確認」");
  check(t.includes("会社が対応中です") && t.includes("現在、あなたの操作は必要ありません"), "自分の対応でないときは「操作は必要ありません」");
  check(await page.locator("#jb-cta").count() === 0, "不要なCTAは出さない");
  await page.close();
}

console.log("\n— 管理：評価履歴・マスタ —");
{
  const page = await open(ME_OWNER, "admin-career.html?tab=history");
  check(await page.locator("#pane-history").isVisible(), "?tab=history で評価履歴");
  const tabs = await page.locator(".kp-subnav .kp-subtab.on").allInnerTexts();
  check(tabs.join("") .includes("評価履歴"), "評価履歴のタブが選ばれている");
  await page.close();
}

check(!errs.length, `画面のエラーなし${errs.length ? `: ${errs.slice(0, 3).join(" / ")}` : ""}`);
await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
