// 採用HR：応募者追加から採用までの運用フロー（HRフロー仕様）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//   1. 一覧：期限・警告（起きてはいけない状態）の列、毎日の確認順（期限超過 → 今日 → 新規 → その他）
//   2. 応募者を追加すると、その人の詳細ドロワーが開く（NEXT ACTION：メール未登録なら「メールアドレスを登録」）
//   3. メールを登録すると NEXT ACTION が「日程調整を送る」へ。日程調整は「メールひな型で送る」が主の導線
//   4. ドロワーは上から 応募者 → 選考・状態 → NEXT ACTION → 選考ステップ（6段）→ タブ（概要/面談/評価/書類/メール/履歴）
//   5. 評価タブ・メールタブ
//   6. 社長推薦すると、選考は社長面談（stage=ceo_interview）で送る
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const EMPLOYEES = [{ id: "emp-r1", display_name: "採用 花子" }];
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

const ap = (o) => ({
  stage: "applied", stageLabel: "新規応募", status: "todo", statusLabel: "未対応", source: "Wantedly", jobTitle: "エンジニア",
  email: "x@example.com", phone: null, rank: null, decision: null, decisionDueOn: null, overdue: false, interviewCount: 0,
  recruiterId: "emp-r1", recruiterName: "採用 花子", createdAt: "2026-10-01T00:00:00Z", alerts: [], priority: 3,
  nextAction: "カジュアル面談の日程を調整してください", nextActionCta: "日程調整を送る", nextActionKey: "sendSchedulingLink", ...o,
});

async function openPage() {
  const posted = [];
  const applicants = [
    ap({ id: "a1", name: "その他 太郎", status: "scheduling", statusLabel: "日程調整中", stage: "casual_interview", stageLabel: "カジュアル面談",
      nextAction: "予約待ち：候補者が TimeRex で予約するのを待っています", nextActionCta: "手動で面談を設定", nextActionKey: "schedule", priority: 3,
      createdAt: "2026-10-05T00:00:00Z" }),
    ap({ id: "a2", name: "期限超過 花子", status: "eval_pending", statusLabel: "評価入力待ち", stage: "casual_interview", stageLabel: "カジュアル面談",
      decisionDueOn: "2026-10-01", overdue: true, priority: 0, nextAction: "面談結果を入力してください", nextActionCta: "評価を入力", nextActionKey: "evaluate",
      alerts: [{ key: "overdue", label: "期限超過", level: "danger" }, { key: "eval", label: "評価未入力", level: "danger" }], createdAt: "2026-09-01T00:00:00Z" }),
    ap({ id: "a3", name: "新規 次郎", email: null, priority: 2, nextAction: "日程調整を送る前に、メールアドレスを登録してください",
      nextActionCta: "メールアドレスを登録", nextActionKey: "registerEmail", alerts: [{ key: "email", label: "メール未登録", level: "warn" }],
      createdAt: "2026-10-04T00:00:00Z" }),
    ap({ id: "a4", name: "今日 三郎", status: "ceo_decision_pending", statusLabel: "社長判断待ち", stage: "ceo_interview", stageLabel: "社長面談",
      decisionDueOn: TODAY, priority: 1, nextAction: "社長判断をしてください", nextActionCta: "採用判断", nextActionKey: "decide", createdAt: "2026-09-10T00:00:00Z" }),
    ap({ id: "a5", name: "推薦 四郎", status: "ceo_recommend_pending", statusLabel: "社長推薦待ち", stage: "ceo_recommend", stageLabel: "社長推薦", rank: "A",
      nextAction: "社長に会ってほしい候補です", nextActionCta: "社長推薦する", nextActionKey: "recommend", priority: 3, createdAt: "2026-09-12T00:00:00Z" }),
  ];
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
        gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    if (/\/api\/hr\/applicants\/mail/.test(url)) {
      return send({ applicant: { id: "a1", name: "x", email: "x@example.com" }, templates: [], rendered: null, mail: { configured: true }, fields: [],
        sends: [{ id: "s1", status: "sent", subject: "面談日程のご案内", templateName: "応募受付・事前質問・面談案内", createdAt: "2026-10-05T01:00:00Z", toEmail: "x@example.com" }] });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = body();
        posted.push(b);
        const t = applicants.find((x) => x.id === b.id);
        if ("email" in b) {
          Object.assign(t, { email: b.email, nextAction: "カジュアル面談の日程を調整してください", nextActionCta: "日程調整を送る", nextActionKey: "sendSchedulingLink", alerts: [] });
        }
        if (b.stage) Object.assign(t, { stage: b.stage, status: b.status });
        return send({ applicant: t });
      }
      const id = new URL(url).searchParams.get("id");
      const a = applicants.find((x) => x.id === id);
      return send({
        applicant: { ...a },
        interviews: id === "a5" ? [{ id: "iv1", kind: "casual", kindLabel: "カジュアル面談", done: true, canceled: false, rank: "A",
          scores: { communication: "great", experience: "good" }, recommendReason: "即戦力です", notes: "とても話しやすい", scheduledAt: "2026-10-03T05:00:00Z" }] : [],
        timeline: [{ id: "t1", eventKey: "applied", label: "応募", occurredAt: "2026-09-20T00:00:00Z" }], offers: [],
        evalItems: [{ key: "communication", label: "コミュニケーション" }, { key: "experience", label: "経験・スキル" }],
        evalScale: [{ key: "great", label: "◎" }, { key: "good", label: "○" }], ranks: ["A", "B", "C", "D"],
        rankLabel: { A: "ぜひ社長に会わせたい", B: "追加確認したい", C: "もう少し確認したい", D: "今回は見送り" },
        schedulingUrl: "https://timerex.net/s/x/casual?applicant_id=" + id,
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) {
      if (req.method() === "POST") {
        const b = body();
        posted.push(b);
        const made = ap({ id: "a9", name: b.name, jobTitle: b.jobTitle, source: b.source, email: null, priority: 2,
          nextAction: "日程調整を送る前に、メールアドレスを登録してください", nextActionCta: "メールアドレスを登録", nextActionKey: "registerEmail",
          alerts: [{ key: "email", label: "メール未登録", level: "warn" }], createdAt: new Date().toISOString() });
        applicants.push(made);
        return send({ applicant: made });
      }
      return send({ applicants, employees: EMPLOYEES, meEmployeeId: RECRUITER.id });
    }
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  return { page, posted, errs };
}

console.log("\n=== 一覧：期限・警告の列と、毎日の確認順 ===");
{
  const { page, errs } = await openPage();
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.locator(".hr-table tr.click").first().waitFor({ timeout: 15000 });
  const heads = await page.locator("#thead th").allInnerTexts();
  check(heads.includes("期限") && heads.includes("警告"), `期限・警告の列がある（${heads.join(" / ")}）`);
  const names = await page.locator(".hr-table tr.click .hr-nm").allInnerTexts();
  check(names.map((n) => n.trim()).join("|") === "期限超過 花子|今日 三郎|新規 次郎|その他 太郎|推薦 四郎",
    `期限超過 → 今日対応 → 新規応募 → その他（${names.join(" / ")}）`);
  const row = page.locator(".hr-table tr.click", { hasText: "期限超過 花子" });
  check((await row.locator('[data-col="due"]').innerText()).includes("2026-10-01"), "期限の列に対応期限");
  check(await row.locator('[data-col="due"] .hr-due.over').count() === 1, "期限超過は赤");
  const alerts = await row.locator(".hr-alert").allInnerTexts();
  check(alerts.join() === "期限超過,評価未入力", `警告の列（${alerts.join(" / ")}）`);
  check((await page.locator(".hr-table tr.click", { hasText: "新規 次郎" }).locator(".hr-alert").innerText()).includes("メール未登録"), "メール未登録の警告");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 追加するとドロワーが開く → メールを登録 → 日程調整を送る ===");
{
  const { page, posted, errs } = await openPage();
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.locator(".hr-table tr.click").first().waitFor({ timeout: 15000 });
  await page.locator("button", { hasText: "応募者追加" }).click();
  await page.fill("#a-name", "追加 五郎");
  await page.fill("#a-job", "営業");
  await page.locator('input[name="a-source"]').first().check();
  await page.locator("button", { hasText: "追加する" }).click();
  await page.locator(".hr-detail #hr-detail-next").waitFor({ timeout: 15000 });
  check((await page.locator(".hr-detail").innerText()).includes("追加 五郎"), "追加した人の詳細が自動で開く");
  check((await page.locator("#hr-detail-next .btn-primary").innerText()).includes("メールアドレスを登録"), "メール未登録なら NEXT ACTION は「メールアドレスを登録」");
  await page.locator("#hr-detail-next .btn-primary").click();
  await page.locator("#hr-email-input").waitFor({ timeout: 5000 });
  check(await page.locator("#hr-email-input").isVisible(), "押すと、その場でメールを入力できる");
  await page.fill("#hr-email-input", "goro@example.com");
  await page.locator("#hr-email-save").click();
  await page.waitForTimeout(800);
  check(posted.some((p) => p.id === "a9" && p.email === "goro@example.com"), "メールを保存");
  check((await page.locator("#hr-detail-next .btn-primary").innerText()).includes("日程調整を送る"), "保存すると NEXT ACTION は「日程調整を送る」");
  await page.locator("#hr-detail-next .btn-primary").click();
  await page.locator("#sc-send-mail").waitFor({ timeout: 5000 });
  check((await page.locator("#sc-send-mail").getAttribute("class")).includes("btn-primary"), "日程調整は「メールひな型で送る」が主のボタン");
  await page.locator(".hr-modal button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(600);
  check(posted.some((p) => p.id === "a9" && p.stage === "casual_interview" && p.status === "scheduling"), "別の方法で送ったときも、カジュアル面談・日程調整中へ");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== ドロワーの順番・選考ステップ・評価タブ・メールタブ・社長推薦 ===");
{
  const { page, posted, errs } = await openPage();
  await page.goto(`${BASE}/hr/applicants.html?id=a5`);
  await page.locator(".hr-detail #hr-detail-next").waitFor({ timeout: 15000 });
  const order = await page.evaluate(() => {
    const box = document.getElementById("hr-detail-box");
    const ids = ["hr-dr-person", "hr-dr-sel", "hr-detail-next", "hr-stage-steps"];
    const pos = ids.map((id) => [...box.querySelectorAll("*")].indexOf(document.getElementById(id)));
    const tabs = [...box.querySelectorAll("*")].indexOf(box.querySelector(".hr-tabs"));
    return [...pos, tabs];
  });
  check(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `上から 応募者 → 選考・状態 → NEXT ACTION → 選考ステップ → タブ（${order.join(",")}）`);
  const steps = await page.locator("#hr-stage-steps li .l").allInnerTexts();
  check(steps.join("→") === "新規応募→カジュアル面談→社長推薦→社長面談→内定→入社予定", `選考ステップ6段（${steps.join("→")}）`);
  check((await page.locator("#hr-stage-steps li.now").innerText()).includes("社長推薦"), "いまは社長推薦");
  const tabs = await page.locator(".hr-tabs button").allInnerTexts();
  check(tabs.join("/") === "概要/面談/評価/書類/メール/履歴", `タブ（${tabs.join("/")}）`);
  check((await page.locator("#hr-head-meta").innerText()).includes("Wantedly"), "応募媒体が見える");

  await page.locator('.hr-tabs button[data-tab="eval"]').click();
  const ev = await page.locator("#hr-detail-tab").innerText();
  check(ev.includes("総合：A") && ev.includes("コミュニケーション") && ev.includes("◎") && ev.includes("即戦力です"), "評価タブに5項目・総合ランク・推薦理由");
  check(await page.locator("#hr-detail-next").isVisible(), "タブを変えても NEXT ACTION は見える");

  await page.locator('.hr-tabs button[data-tab="mail"]').click();
  await page.locator("[data-mail-tab]").waitFor({ timeout: 5000 });
  check((await page.locator("#hr-detail-tab").innerText()).includes("面談日程のご案内"), "メールタブに送ったメール");

  await page.locator("#hr-detail-next .btn-primary").click();
  await page.locator("#rc-note").waitFor({ timeout: 5000 });
  await page.fill("#rc-note", "ぜひ会ってほしい");
  await page.locator("#action-root .btn-primary").last().click();
  await page.waitForTimeout(800);
  check(posted.some((p) => p.id === "a5" && p.stage === "ceo_interview" && p.status === "ceo_interview_pending"), "社長推薦すると 選考：社長面談・状態：社長面談設定待ち");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `390px で画面が横にはみ出さない（${over}px）`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通りました");
process.exit(bad ? 1 : 0);
