// 採用HR Stage 3：面談・評価の一連の流れを、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   応募者登録 → 面談予定登録 → 今日の面談へ表示 → 面談実施
//   → NEXT ACTIONが「面談結果入力」へ変化 → 5項目評価入力 → ランクA
//   → 社長推薦 → GOOD CANDIDATESへ表示、まで通す。
//
//   あわせて、Bランク／Cランク／Dランクで NEXT ACTION のボタンが変わること
//   （ランクだけで自動的に採用判断を確定しないこと）も見る。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

const EVAL_ITEMS = [
  { key: "communication", label: "コミュニケーション" }, { key: "experience", label: "経験・スキル" },
  { key: "orientation", label: "志向性" }, { key: "culture_fit", label: "カルチャーフィット" },
  { key: "potential", label: "期待値／ポテンシャル" },
];
const EVAL_SCALE = [{ key: "great", label: "◎" }, { key: "good", label: "○" }, { key: "fair", label: "△" }, { key: "bad", label: "×" }];
const RANKS = ["A", "B", "C", "D"];
const RANK_LABEL = { A: "ぜひ社長に会わせたい", B: "社長に会わせてもよい", C: "もう少し確認したい", D: "今回は見送り" };

function nextActionOf(a) {
  if (a.status === "todo") return { label: "カジュアル面談の日程を調整してください", cta: "日程調整を送る", action: "sendSchedulingLink" };
  if (a.status === "scheduling") return { label: "候補者の日程調整を待っています", cta: "手動で面談を設定", action: "schedule" };
  if (a.status === "interview_scheduled") return { label: "面談を実施してください", cta: "面談を実施済みにする", action: "conduct" };
  if (a.status === "eval_pending") return { label: "面談結果を入力してください", cta: "評価を入力", action: "evaluate" };
  if (a.status === "ceo_recommend_pending") {
    return a.rank === "B"
      ? { label: "追加確認が必要です", cta: "次回面談を設定", action: "schedule" }
      : { label: "社長に会ってほしい候補です", cta: "社長推薦する", action: "recommend" };
  }
  if (a.status === "next_scheduling_pending") return { label: "保留中です", cta: "判断を更新", action: "evaluate" };
  if (a.status === "passed") return a.decision === "rejected"
    ? { label: "対応は不要です", cta: null, action: null }
    : { label: "見送り候補です", cta: "見送りを確定", action: "reject" };
  return { label: "対応を進めてください", cta: null, action: null };
}

function shape(a) {
  const n = nextActionOf(a);
  return { ...a, nextAction: n.label, nextActionCta: n.cta, nextActionKey: n.action, overdue: false, recruiterName: null };
}

console.log("\n=== 面談 → 評価 → 社長推薦 まで、一続きで通す ===");
{
  const state = {
    applicant: { id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル",
      stage: "applied", status: "todo", rank: null, decision: null, decisionDueOn: null },
    interviews: [],
  };
  let nextIvId = 1;
  const posted = [];

  const page = await br.newPage({ viewport: { width: 1300, height: 1100 }, timezoneId: "Asia/Tokyo" });
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

    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/interviews\/today/.test(url)) {
      return send({
        interviews: state.interviews.filter((i) => !i.done).map((i) => ({
          id: i.id, applicantId: state.applicant.id, kind: i.kind, kindLabel: "カジュアル面談",
          scheduledAt: i.scheduledAt, done: i.done, interviewerName: i.interviewerName || null,
          name: state.applicant.name, jobTitle: state.applicant.jobTitle,
          statusLabel: state.applicant.statusLabel || "面談予定",
        })),
      });
    }
    if (/\/api\/hr\/interviews\b/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      posted.push(b);
      if (req.method() === "POST") {
        const iv = { id: `iv${nextIvId++}`, kind: b.kind, scheduledAt: b.scheduledAt, done: false,
          interviewerName: b.interviewerId ? "面接 一郎" : null, meetingUrl: b.meetingUrl || null,
          scores: {}, rank: null, kindLabel: b.kind === "ceo" ? "社長面談" : "カジュアル面談" };
        state.interviews.push(iv);
        state.applicant.status = "interview_scheduled";
        state.applicant.stage = "casual_interview";
        return send({ interview: iv });
      }
      // PATCH
      const iv = state.interviews.find((x) => x.id === b.id);
      if (b.action === "conduct") {
        iv.done = true; iv.conductedAt = "2026-09-25T05:00:00Z";
        state.applicant.status = "eval_pending";
        return send({ interview: iv, status: "eval_pending" });
      }
      if (b.action === "evaluate") {
        iv.scores = b.scores || {}; iv.rank = b.rank; iv.recommendReason = b.recommendReason || null;
        state.applicant.rank = b.rank;
        state.applicant.status = b.rank === "A" || b.rank === "B" ? "ceo_recommend_pending"
          : b.rank === "C" ? "next_scheduling_pending" : "passed";
        return send({ interview: iv, status: state.applicant.status });
      }
      return send({ interview: iv });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = JSON.parse(req.postData() || "{}");
        posted.push(b);
        Object.assign(state.applicant, b);
        return send({ applicant: shape(state.applicant) });
      }
      return send({
        applicant: shape(state.applicant),
        interviews: state.interviews.map((i) => ({
          ...i, applicantId: "a1", scoresLabel: null, createdAt: "2026-09-24T00:00:00Z",
        })),
        interviewers: [{ id: "e2", display_name: "面接 一郎" }],
        evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: RANKS, rankLabel: RANK_LABEL,
        interviewKinds: [{ key: "casual", label: "カジュアル面談" }, { key: "ceo", label: "社長面談" }],
        timeline: [{ id: "t1", eventKey: "applied", label: "応募", occurredAt: "2026-09-20T00:00:00Z" }],
        offers: [],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [shape(state.applicant)] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);

  console.log("\n— 面談前：TimeRex未設定なら、手動で面談を設定する —");
  check((await page.locator(".hr-next").innerText()).includes("カジュアル面談の日程を調整してください"), "NEXT ACTION");
  await page.locator(".hr-next button", { hasText: "日程調整を送る" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer", { hasText: "TimeRexの日程調整URLが未設定です" }).isVisible(),
    "TimeRex未設定時は、手動設定へ誘導する");
  await page.locator(".hr-drawer button", { hasText: "手動で面談を設定" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer", { hasText: "面談を予定する" }).isVisible(), "予定フォームが開く");
  const when = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
  await page.fill("#iv-when", when);
  await page.selectOption("#iv-who", "e2");
  await page.locator(".hr-drawer button", { hasText: "予定する" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.kind === "casual" && p.applicantId === "a1"), "予定がサーバへ送られる");

  console.log("\n— 今日の面談へ表示 —");
  await page.goto(`${BASE}/hr/`);
  await page.waitForTimeout(1000);
  check((await page.locator("#todayiv").innerText()).includes("山田 太郎"), "今日の面談に出る");
  check((await page.locator("#todayiv").innerText()).includes("面接 一郎"), "面談担当が出る");

  console.log("\n— 面談を実施済みにする —");
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  check((await page.locator(".hr-next").innerText()).includes("面談を実施済みにする")
    || (await page.locator(".hr-next").innerText()).includes("実施してください"), "NEXT ACTION：面談前");
  await page.locator(".hr-next button", { hasText: "面談を実施済みにする" }).click();
  await page.waitForTimeout(700);
  check((await page.locator(".hr-next").innerText()).includes("面談結果を入力してください"), "NEXT ACTIONが面談結果入力へ変化");

  console.log("\n— 5項目評価・ランクA —");
  await page.locator(".hr-next button", { hasText: "評価を入力" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "評価フォームが開く");
  const labels = await page.locator(".hr-drawer label").allInnerTexts();
  for (const l of ["コミュニケーション", "経験・スキル", "志向性", "カルチャーフィット", "期待値／ポテンシャル"]) {
    check(labels.some((x) => x.includes(l)), `評価項目：${l}`);
  }
  await page.locator('input[name="ev-communication"][value="great"]').check();
  await page.selectOption("#ev-rank", "A");
  await page.fill("#ev-reason", "即戦力です");
  await page.locator(".hr-drawer button", { hasText: "保存する" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.action === "evaluate" && p.rank === "A"), "評価がサーバへ送られる");

  console.log("\n— Aランク：社長推薦する —");
  check((await page.locator(".hr-next").innerText()).includes("社長に会ってほしい候補です"), "NEXT ACTION：Aランク");
  await page.locator(".hr-next button", { hasText: "社長推薦する" }).click();
  await page.waitForTimeout(400);
  check(await page.locator(".hr-drawer").isVisible(), "推薦理由を書く欄が開く");
  await page.fill("#rc-note", "営業経験が強く、事業立ち上げ経験あり。報酬条件のみ社長面談で確認したい。");
  await page.locator(".hr-drawer button", { hasText: "社長推薦する" }).click();
  await page.waitForTimeout(700);
  check(posted.some((p) => p.stage === "ceo_recommend" && p.recommendNote), "推薦理由つきで社長推薦がサーバへ送られる");

  console.log("\n— GOOD CANDIDATESへ表示 —");
  await page.goto(`${BASE}/hr/`);
  await page.waitForTimeout(1000);
  check((await page.locator("#good").innerText()).includes("山田 太郎"), "GOOD CANDIDATESに出る");

  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== ランクごとに NEXT ACTION のボタンが変わる ===");
{
  async function checkFor(rank, wantLabel, wantCta) {
    const applicant = { id: "a2", name: "鈴木 花子", jobTitle: "デザイナー", source: "Wantedly",
      stage: "casual_interview", status: rank === "A" || rank === "B" ? "ceo_recommend_pending"
        : rank === "C" ? "next_scheduling_pending" : "passed",
      rank, decision: null, decisionDueOn: null };
    const page = await br.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "Asia/Tokyo" });
    await page.addInitScript(() => {
      localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
    });
    await page.route("**/api/**", (route) => {
      const url = route.request().url();
      const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (/\/api\/me\b/.test(url)) return send(ME);
      if (/\/api\/hr\/applicants\/detail/.test(url)) {
        return send({ applicant: shape(applicant), interviews: [], interviewers: [],
          evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: RANKS, rankLabel: RANK_LABEL,
          interviewKinds: [], timeline: [], offers: [] });
      }
      if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [] });
      if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
      return send({});
    });
    await page.goto(`${BASE}/hr/applicants.html?id=a2`);
    await page.waitForTimeout(900);
    const box = await page.locator(".hr-next").innerText();
    check(box.includes(wantLabel), `ランク${rank}：${wantLabel}`);
    check(await page.locator(".hr-next button", { hasText: wantCta }).count() === 1, `ランク${rank}のボタン：${wantCta}`);
    await page.close();
  }

  await checkFor("B", "追加確認が必要です", "次回面談を設定");
  await checkFor("C", "保留中です", "判断を更新");
  await checkFor("D", "見送り候補です", "見送りを確定");
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
