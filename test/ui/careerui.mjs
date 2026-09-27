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
const LIST = {
  today: "2026-09-27",
  tracks: [{ id: "t-eng", name: "エンジニア" }],
  levels: LEVELS,
  canDecide: true, canEditMaster: true,
  people: [
    { employee: { id: "e-new", name: "新人 花子" }, career: null, nextAction: { rank: 0, key: "setup", label: "キャリア設定が必要です" },
      suggestion: { trackId: "t-eng", trackName: "エンジニア", levelId: "l1" } },
    { employee: { id: "e-taro", name: "森田 太郎", department: "開発" },
      career: { trackId: "t-eng", trackName: "エンジニア", currentLevel: LEVELS[0], nextLevel: LEVELS[1], nextReviewOn: "2026-10-05" },
      nextAction: { rank: 3, key: "review", label: "評価面談を実施してください" } },
    { employee: { id: "e-yama", name: "山田 次郎" },
      career: { trackId: "t-eng", trackName: "エンジニア", currentLevel: LEVELS[1], nextLevel: null, nextReviewOn: "2026-12-31" },
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
  contractLinks: { order: "admin-esign.html?tab=order&employeeId=e-taro" },
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
      return send(me.__career || MY);
    }
    if (/\/api\/career/.test(url)) {
      if (req.method() === "POST") {
        posted.push(body);
        if (body.action === "saveReview") return send({ review: { id: "rv1", status: "draft" }, systemJudgement: {} });
        if (body.action === "confirmReview") {
          return send({ review: { id: "rv1" }, newLevel: body.result === "level_up" ? LEVELS[1] : null,
            contractNext: body.salaryDecision === "raise" ? { message: "新しい給与条件は、労働条件通知書の更新と電子署名で確定します",
              order: "admin-esign.html?tab=order&employeeId=e-taro" } : null });
        }
        return send({ ok: true });
      }
      if (/evidence=/.test(url)) return send(EVIDENCE);
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
  check(first.includes("キャリア設定が必要です") && first.includes("候補：エンジニア"), "未設定と職種の候補");
  const tabs = (await page.locator(".kp-subnav .kp-subtab").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "キャリア/3か月育成/自走レベル/評価履歴", `上部タブ（いま ${tabs.join("/")}）`);
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
  check(dr.includes("NEXT ACTION") && dr.includes("評価面談を実施してください"), "ドロワー：NEXT ACTION");
  check(dr.includes("240,000円") && dr.includes("260,000円〜300,000円"), "現在給与と次のレンジ");
  check(dr.includes("実際の昇給・昇格は"), "レンジの注記");
  check(await page.locator(".cr-drawer .btn-primary").count() === 1, "Primary CTA は1つ");
  await page.screenshot({ path: shotPath("career-admin-drawer.png") });

  await page.click(".cr-drawer button:has-text('評価を開始')");
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
