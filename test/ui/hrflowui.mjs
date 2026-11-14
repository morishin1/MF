// 採用HR：応募者追加から採用までの運用フロー（HRフロー仕様）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//   1. 一覧：対応期限（期限超過は赤の時計）と、毎日の確認順（対応優先順：期限超過 → 今日 → 新規 → その他）
//   2. 応募者を追加すると、その人の対応モーダルが開く（メール未登録でも面談設定へ進める。メール登録は補助の操作）
//   3. メールを登録すると、次にすることが「日程調整を送る」へ。日程調整は「メールひな型で送る」が主の導線
//   4. 対応モーダルは上から 氏名 → 現在の状態 → 次にすること → 主ボタン → 補助リンク。
//      応募者詳細は上から 応募者 → 進捗（8段）→ タブ（応募者情報/面談・評価/書類・契約/連絡・履歴）
//   5. 面談・評価タブ（面談＋評価）・連絡・履歴タブ（メールの記録）
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
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" })); } catch { /* sandbox付きiframe */ }
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

// アイコン（Material Symbols の名前）を除いた文字
const plain = (loc) => loc.evaluateAll((els) => els.map((e) => {
  const c = e.cloneNode(true); c.querySelectorAll(".material-symbols-outlined").forEach((x) => x.remove()); return c.textContent.trim();
}));

console.log("\n=== 一覧：対応期限と、毎日の確認順 ===");
{
  const { page, errs } = await openPage();
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.locator(".hr-table tr.click").first().waitFor({ timeout: 15000 });
  // 対応期限・警告の独立した列は無くなった。期限は「現在の状態」の横の時計アイコン、
  // 毎日の確認順は並び順（#list-sort）の「対応優先順」で見る。旧「期限・警告の列がある」を置き換えた
  const heads = (await page.locator("#thead th").allInnerTexts()).map((h) => h.trim()).filter(Boolean);
  check(heads.join("/") === "登録日時/応募者・職種/プロフィール/現在の状態/書類/社内メモ/NEXT/担当者", `一覧の列（${heads.join(" / ")}）`);
  const nameList = async () => (await page.locator(".hr-table tr.click .hr-nm").allInnerTexts()).map((n) => n.trim()).join("|");
  check(await nameList() === "その他 太郎|新規 次郎|推薦 四郎|今日 三郎|期限超過 花子", `既定は新着順（${await nameList()}）`);
  await page.selectOption("#list-sort", "priority");
  check(await nameList() === "期限超過 花子|今日 三郎|新規 次郎|その他 太郎|推薦 四郎",
    `対応優先順：期限超過 → 今日対応 → 新規応募 → その他（${await nameList()}）`);
  const row = page.locator(".hr-table tr.click", { hasText: "期限超過 花子" });
  check((await row.locator(".hr-clock").getAttribute("title")).includes("2026-10-01"), "行に対応期限（時計アイコンの説明）");
  check(await row.locator(".hr-clock.over").count() === 1 && (await row.locator(".hr-clock.over").getAttribute("aria-label")).includes("期限超過"), "期限超過は赤（.over）");
  const today = page.locator(".hr-table tr.click", { hasText: "今日 三郎" });
  check(await today.locator(".hr-clock").count() === 1 && await today.locator(".hr-clock.over").count() === 0
    && (await today.locator(".hr-clock").getAttribute("title")) === `対応期限：${TODAY}`, "今日が期限の人は、超過ではない期限の印");
  check(await page.locator(".hr-table tr.click", { hasText: "その他 太郎" }).locator(".hr-clock").count() === 0, "期限の無い人には印を出さない");
  // 警告の列（評価未入力・メール未登録）は無くなった。同じことは「現在の状態」と NEXT で分かる
  check((await row.locator("[data-current-state]").innerText()).trim() === "評価入力待ち" && (await row.locator(".hr-list-cta").innerText()).includes("評価を入力"),
    "評価が未入力の人：現在の状態「評価入力待ち」・NEXT「評価を入力」");
  // メール未登録は、対応モーダルの補助操作（メールアドレスを登録する）で分かる
  await page.locator(".hr-table tr.click", { hasText: "新規 次郎" }).locator(".hr-list-cta").click();
  await page.locator("#hr-detail-box.hr-work-modal #hr-work-secondary-action").waitFor();
  check((await page.locator("#hr-work-secondary-action").innerText()).includes("メールアドレスを登録する"), "メール未登録の人：対応モーダルに「メールアドレスを登録する」");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 追加すると対応モーダルが開く → メールを登録 → 日程調整を送る ===");
{
  const { page, posted, errs } = await openPage();
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.locator(".hr-table tr.click").first().waitFor({ timeout: 15000 });
  // ヘッダーの「応募者追加」は 1340px 以下では文字を畳んだアイコンのボタン（.hr-add）
  await page.locator(".hr-bar .hr-add").click();
  await page.locator("#a-name").waitFor();
  await page.fill("#a-name", "追加 五郎");
  // 応募職種はプルダウン（候補＋その他）。候補に無い職種は「その他」で入力する
  check(await page.locator("#a-job-other").isHidden(), "職種名の入力欄は、その他を選ぶまで出ない");
  await page.selectOption("#a-job", "__other");
  await page.fill("#a-job-other", "営業");
  await page.locator('input[name="a-source"]').first().check();
  await page.locator("button", { hasText: "追加する" }).click();
  // 登録後に開くのは詳細ドロワーではなく対応モーダル
  await page.locator("#hr-detail-box.hr-work-modal #hr-work-primary").waitFor({ timeout: 15000 });
  check(posted.some((p) => p.name === "追加 五郎" && p.jobTitle === "営業"), "その他で入力した職種で登録する");
  check((await page.locator("#hr-detail-box .hr-work-heading h2").innerText()).trim() === "追加 五郎", "追加した人の対応モーダルが自動で開く");
  // メール未登録でも面談設定へ進める（主ボタン）。メール登録は補助の操作になった
  check((await page.locator("#hr-work-primary").innerText()).includes("面談を設定する"), "メール未登録なら、主ボタンは「面談を設定する」");
  check((await page.locator("#hr-work-secondary-action").innerText()).includes("メールアドレスを登録する"), "補助の操作に「メールアドレスを登録する」");
  await page.locator("#hr-work-secondary-action").click();
  await page.locator("#work-email").waitFor({ timeout: 5000 });
  check(await page.locator("#work-email").isVisible(), "押すと、その場でメールを入力できる");
  await page.fill("#work-email", "goro@example.com");
  await page.locator("#action-root button", { hasText: "登録する" }).click();
  await page.locator("#hr-work-primary", { hasText: "日程調整を送る" }).waitFor();
  check(posted.some((p) => p.id === "a9" && p.email === "goro@example.com"), "メールを保存");
  check((await page.locator("#hr-work-primary").innerText()).includes("日程調整を送る") && await page.locator("#hr-work-secondary-action").count() === 0,
    "保存すると、主ボタンは「日程調整を送る」（メール登録の補助操作は消える）");
  check(await page.locator("#hr-detail-box .hr-work-primary").count() === 1, "主ボタンは1つだけ");
  await page.locator("#hr-work-primary").click();
  await page.locator("#sc-send-mail").waitFor({ timeout: 5000 });
  check((await page.locator("#sc-send-mail").getAttribute("class")).includes("btn-primary"), "日程調整は「メールひな型で送る」が主のボタン");
  await page.locator("#hr-modal-root .hr-modal button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(600);
  check(posted.some((p) => p.id === "a9" && p.stage === "casual_interview" && p.status === "scheduling"), "別の方法で送ったときも、カジュアル面談・日程調整中へ");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 対応モーダル・応募者詳細の順番・進捗・面談・評価タブ・連絡・履歴タブ・社長推薦 ===");
{
  const { page, posted, errs } = await openPage();
  await page.goto(`${BASE}/hr/applicants.html?id=a5`);
  // ?id= で開くのは対応モーダル。旧ドロワーの「応募者 → 選考・状態 → NEXT ACTION」の順は、対応モーダルの並びで見る
  await page.locator("#hr-detail-box.hr-work-modal #hr-work-primary").waitFor({ timeout: 15000 });
  const workOrder = await page.evaluate(() => {
    const box = document.getElementById("hr-detail-box");
    const all = [...box.querySelectorAll("*")];
    return [".hr-work-heading h2", "#hr-work-meta", ".hr-work-state", ".hr-work-task", "#hr-work-primary", "#hr-work-links"].map((s) => all.indexOf(box.querySelector(s)));
  });
  check(workOrder.every((v, i) => v >= 0 && (i === 0 || v > workOrder[i - 1])), `対応モーダルは上から 氏名 → 現在の状態 → 次にすること → 主ボタン → 補助リンク（${workOrder.join(",")}）`);
  check((await page.locator("#hr-work-meta").innerText()).includes("Wantedly"), "応募媒体が見える");
  check((await page.locator(".hr-work-state b").innerText()).includes("社長推薦待ち"), "現在の状態が見える");
  check((await page.locator("#hr-work-primary").innerText()).includes("社長推薦する") && await page.locator("#hr-detail-box .hr-work-primary").count() === 1, "主ボタンは「社長推薦する」1つ");

  // 応募者詳細は、対応モーダルの「応募者情報」から開く
  await page.locator("#hr-work-link-info").click();
  await page.locator(".hr-detail #hr-detail-next").waitFor();
  const order = await page.evaluate(() => {
    const box = document.getElementById("hr-detail-box");
    const all = [...box.querySelectorAll("*")];
    return ["#hr-dr-person", ".hr-progress-detail", ".hr-detail-tabs", "#hr-detail-tab", "#hr-detail-next"].map((s) => all.indexOf(box.querySelector(s)));
  });
  check(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), `詳細は上から 応募者 → 進捗 → タブ → 内容（NEXT ACTION）（${order.join(",")}）`);
  // 選考ステップは6段から、事前選考〜OFFICE の8段（進捗）になった。社長推薦・社長面談は「代表面談」にまとまる
  await page.locator(".hr-progress-detail summary").click();
  const steps = (await page.locator(".hr-progress-detail .hr-agreement-flow li").allInnerTexts()).map((t) => t.trim());
  check(steps.join("→") === "事前選考→カジュアル面談→代表面談→合格通知→トライアル→条件通知書→合意→OFFICE", `進捗8段（${steps.join("→")}）`);
  check((await page.locator(".hr-agreement-flow li.now").innerText()).includes("代表面談")
    && await page.locator('.hr-agreement-flow li[aria-current="step"]').count() === 1, "いまは代表面談（社長推薦の段階）");
  const tabs = await plain(page.locator('.hr-detail-tabs [role="tab"]'));
  check(tabs.join("/") === "応募者情報/面談・評価/書類・契約/連絡・履歴", `タブ（${tabs.join("/")}）`);
  check((await page.locator("#hr-basic").innerText()).includes("Wantedly"), "詳細にも応募媒体が見える");
  check((await page.locator("#hr-detail-next .btn-primary").innerText()).includes("社長推薦する"), "応募者情報タブにも NEXT ACTION（社長推薦する）");

  await page.locator("#hr-tab-interviews").click();
  const ev = await page.locator("#hr-detail-tab").innerText();
  check(ev.includes("総合：A") && ev.includes("コミュニケーション") && ev.includes("◎") && ev.includes("即戦力です"), "面談・評価タブに面談＋5項目評価・総合ランク・推薦理由");
  check(await page.locator("#hr-tab-interviews").getAttribute("aria-selected") === "true", "選んだタブが選択中になる");

  // メールタブと履歴タブは「連絡・履歴」に統合された
  await page.locator("#hr-tab-activity").click();
  await page.locator("[data-mail-tab]").waitFor({ timeout: 5000 });
  await page.locator("#hr-mail-history", { hasText: "面談日程のご案内" }).waitFor();
  check((await page.locator("#hr-detail-tab").innerText()).includes("面談日程のご案内"), "連絡・履歴タブに送ったメール");
  check((await page.locator("#hr-detail-tab .hr-doc-fold summary").innerText()).includes("履歴（1件）"), "連絡・履歴タブに選考・操作の履歴");

  // NEXT ACTION は詳細のどのタブにも出すのではなく、対応モーダルが受け持つ（旧「タブを変えても NEXT ACTION は見える」を置き換え）。
  // 詳細を閉じて、一覧の NEXT から対応モーダルを開き、主ボタンで社長推薦する
  await page.locator("#hr-dr-person button", { hasText: "閉じる" }).click();
  await page.locator('#rows tr[data-applicant="a5"] .hr-list-cta').click();
  await page.locator("#hr-detail-box.hr-work-modal #hr-work-primary").waitFor();
  await page.locator("#hr-work-primary").click();
  await page.locator("#rc-note").waitFor({ timeout: 5000 });
  await page.fill("#rc-note", "ぜひ会ってほしい");
  await page.locator("#action-root .btn-primary").last().click();
  await page.waitForTimeout(800);
  check(posted.some((p) => p.id === "a5" && p.stage === "ceo_interview" && p.status === "ceo_interview_pending" && p.recommendNote === "ぜひ会ってほしい"),
    "社長推薦すると 選考：社長面談・状態：社長面談設定待ち");
  check(await page.locator("#rc-note").count() === 0 && await page.locator("#hr-detail-box.hr-work-modal").count() === 1, "推薦のフォームが閉じて、対応モーダルに戻る");
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
