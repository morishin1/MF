// 採用HR：応募者一覧の「すべて／採用／無限道場」と、無限道場リードの詳細（/hr/applicants.html）を実際のブラウザで通す。
//
// ■ 何を守るテストか（無限道場LP → グループウェアHR リード連携 STEP E）
//   1. 区分のタブに人数が出て、切り替えられる（?category= で開ける・URLにも残る）
//   2. 無限道場タブは専用の列（流入元・興味・適性診断・面談日時・登録日・最終接触）と、無限道場の段階
//   3. 採用タブには無限道場リードが出ない。すべてタブでは「無限道場」の印が付く
//   4. 詳細：LP で本人が入れた内容・UTM・面談・次のアクション。書類タブは出さない
//   5. 次のアクションを選ぶと PATCH（action: leadNextAction）が送られる
//   6. 通知先（運営担当）を選んで保存できる
//   表示する応募者は、本物の shapeApplicant（lib/hr.js）で作る（API と同じ言い方になる）
import { launch, BASE } from "../_browser.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { shapeApplicant } = await import(join(ROOT, "lib/hr.js"));
const { LEAD_NEXT_ACTIONS } = await import(join(ROOT, "lib/hr-lead-flow.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const EMPLOYEES = [{ id: "emp-r1", display_name: "採用 花子" }, { id: "emp-2", display_name: "道場 運営" }];

const lead = shapeApplicant({
  id: "md1", name: "山田 太郎", email: "taro@example.jp", phone: null, source: "無限道場LP", job_title: "無限道場 カジュアル面談",
  stage: "casual_interview", status: "eval_pending", lead_category: "mugendojo",
  utm_source: "instagram", utm_medium: "social", utm_campaign: "2026autumn",
  attribution: { first: { utm_source: "instagram", utm_medium: "social", utm_campaign: "2026autumn", referrer: "https://www.instagram.com/",
    landing_page: "https://mugendojo.jp/?utm_source=instagram", source_url: "https://mugendojo.jp/shindan" },
    last: { utm_source: "instagram", source_url: "https://mugendojo.jp/shindan" }, touches: 1 },
  lead_profile: { occupation: "会社員", prefecture: "東京都", ai_experience: "少し使ったことがある", it_experience: "未経験",
    interests: ["副業", "AIを仕事で活用"], challenge_text: "AIを使ったサービスを作りたい", diagnosis_label: "事業・サービスづくりタイプ" },
  last_contacted_at: "2026-10-01T03:00:00Z", created_at: "2026-09-30T03:00:00Z",
});
const rec = shapeApplicant({
  id: "r1", name: "田中 一郎", source: "Wantedly", job_title: "エンジニア", stage: "applied", status: "todo",
  lead_category: "recruitment", created_at: "2026-09-29T03:00:00Z",
});

const page = await br.newPage({ viewport: { width: 1400, height: 1000 }, timezoneId: "Asia/Tokyo" });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
});
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
const posted = [];
const listUrls = [];
let watchers = [];

await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  const body = () => JSON.parse(req.postData() || "{}");
  if (/\/api\/me\b/.test(url)) {
    return send({ email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
      gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } });
  }
  if (/\/api\/hr\/lead-watchers/.test(url)) {
    if (req.method() === "PUT") { const b = body(); posted.push({ watchers: b }); watchers = b.employeeIds; return send({ category: "mugendojo", employeeIds: watchers }); }
    return send({ category: "mugendojo", employeeIds: watchers, employees: EMPLOYEES });
  }
  if (/\/api\/hr\/applicants\/detail/.test(url)) {
    if (req.method() === "PATCH") {
      const b = body(); posted.push(b);
      if (b.action === "leadNextAction") Object.assign(lead, { leadNextAction: b.nextAction, stage: "md_trial", stageLabel: "体験案内",
        status: "todo", statusLabel: "対応中", nextAction: "体験の案内を進めてください" });
      return send({ applicant: lead });
    }
    const id = new URL(url).searchParams.get("id");
    const a = id === "md1" ? lead : rec;
    return send({
      applicant: a,
      interviews: id === "md1" ? [{ id: "iv1", kind: "casual", kindLabel: "カジュアル面談", scheduledAt: "2026-10-01T05:00:00Z",
        conductedAt: "2026-10-01T06:00:00Z", done: true, canceled: false, memo: "副業の時間は週10時間", scores: {} }] : [],
      timeline: [{ id: "t1", eventKey: "applied", label: "無限道場LPからカジュアル面談の申込", detail: "流入: instagram / social / 2026autumn", occurredAt: "2026-09-30T03:00:00Z" }],
      offers: [], interviewers: EMPLOYEES, statusOptions: [],
      leadNextActions: id === "md1" ? LEAD_NEXT_ACTIONS.map(({ key, label }) => ({ key, label })) : [],
      schedulingUrl: null, schedulingUrlEnv: "TIMEREX_MUGENDOJO_CASUAL_URL",
    });
  }
  if (/\/api\/hr\/applicants\b/.test(url)) {
    listUrls.push(url);
    return send({ applicants: [lead, rec].map((a) => ({ ...a, nextInterviewAt: a.id === "md1" ? "2026-10-01T05:00:00Z" : null })),
      employees: EMPLOYEES, meEmployeeId: RECRUITER.id, category: "all", leadReady: true });
  }
  if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});

console.log("\n=== 区分のタブ ===");
await page.goto(`${BASE}/hr/applicants.html`);
await page.waitForTimeout(1000);
check(listUrls.some((u) => /category=all/.test(u)), "一覧は category=all で取る（この画面で区分を切り替える）");
const tabs = await page.locator("#cat-tabs button").allInnerTexts();
check(tabs.length === 3 && /すべて\s*2/.test(tabs[0]) && /採用\s*1/.test(tabs[1]) && /無限道場\s*1/.test(tabs[2]),
  `すべて2／採用1／無限道場1（いま ${tabs.join(" | ")}）`);
check((await page.locator("#rows").innerText()).includes("無限道場"), "すべてタブでは無限道場リードに印が付く");

await page.locator("#cat-tabs button", { hasText: "採用" }).click();
await page.waitForTimeout(300);
{
  const rows = await page.locator("#rows").innerText();
  check(rows.includes("田中 一郎") && !rows.includes("山田 太郎"), "採用タブに無限道場リードは出ない");
  check((await page.locator("#thead").innerText()).includes("書類"), "採用タブはいつもの列");
}

console.log("\n=== 無限道場タブ ===");
await page.locator("#cat-tabs button", { hasText: "無限道場" }).click();
await page.waitForTimeout(300);
{
  const head = await page.locator("#thead").innerText();
  check(["流入元", "興味・目的", "適性診断", "面談日時", "担当", "登録日", "最終接触"].every((h) => head.includes(h)),
    `無限道場の列（いま ${head.replace(/\s+/g, " ")}）`);
  const rows = await page.locator("#rows").innerText();
  check(rows.includes("山田 太郎") && !rows.includes("田中 一郎"), "無限道場リードだけ");
  check(rows.includes("instagram / social") && rows.includes("2026autumn"), "流入元（UTM）が出る");
  check(rows.includes("副業") && rows.includes("AIを仕事で活用"), "興味・目的が出る");
  check(rows.includes("事業・サービスづくりタイプ"), "適性診断が出る");
  check(rows.includes("カジュアル面談済"), "状態は無限道場の言い方（カジュアル面談済）");
  check(rows.includes("2026/10/1"), "最終接触・面談日時が日付で出る");
  check(new URL(page.url()).searchParams.get("category") === "mugendojo", "URL に ?category=mugendojo が残る");
  const stages = await page.locator("#stage-tabs").innerText();
  check(["新規リード", "体験案内", "参加検討", "申込", "参加"].every((x) => stages.includes(x)), "段階のタブは無限道場の段階");
  check(await page.locator("#lead-tools button", { hasText: "通知先" }).isVisible(), "通知先（運営担当）の設定が出る");
}

console.log("\n=== 無限道場リードの詳細 ===");
await page.locator(".hr-table tr.click").first().click();
await page.waitForTimeout(500);
{
  const d = await page.locator(".hr-detail").innerText();
  check(d.includes("無限道場"), "印が付く");
  for (const [label, want] of [["現在の状況", "会社員"], ["AI経験", "少し使ったことがある"], ["IT経験", "未経験"],
    ["挑戦してみたいこと", "AIを使ったサービスを作りたい"], ["適性診断", "事業・サービスづくりタイプ"],
    ["UTM（最初）", "source=instagram"], ["参照元", "https://www.instagram.com/"], ["面談", "副業の時間は週10時間"]]) {
    check(d.includes(label) && d.includes(want), `${label}：${want}`);
  }
  const tabNames = await page.locator(".hr-tabs button").allInnerTexts();
  check(!tabNames.some((t) => t.includes("書類")), `書類タブは出さない（いま ${tabNames.join(" / ")}）`);
  check((await page.locator(".hr-next").innerText()).includes("面談後の次のアクションを選んでください"), "NEXT ACTION：次のアクションを選ぶ");
}

await page.locator(".hr-next button", { hasText: "次のアクションを選ぶ" }).click();
await page.waitForTimeout(300);
{
  const labels = await page.locator('#hr-modal-root input[name="lead-next"]').count();
  check(labels === 9, `次のアクションの選択肢は9つ（いま ${labels}）`);
  await page.locator('#hr-modal-root input[name="lead-next"][value="trial"]').check();
  await page.fill("#lead-next-note", "来週の体験会を案内");
  await page.locator("#hr-modal-root button", { hasText: "保存する" }).click();
  await page.waitForTimeout(600);
  const p = posted.find((x) => x.action === "leadNextAction");
  check(p && p.id === "md1" && p.nextAction === "trial" && p.note === "来週の体験会を案内", "PATCH（leadNextAction・trial・メモ）が送られる");
  check((await page.locator(".hr-detail").innerText()).includes("体験の案内を進めてください"), "保存後、NEXT ACTION がすぐ変わる");
}
await page.locator(".hr-detail button", { hasText: "閉じる" }).first().click();
await page.waitForTimeout(300);
check(new URL(page.url()).searchParams.get("category") === "mugendojo", "詳細を閉じても無限道場タブの URL に戻る");

console.log("\n=== 通知先（運営担当） ===");
await page.locator("#lead-tools button", { hasText: "通知先" }).click();
await page.waitForTimeout(400);
await page.locator('#hr-modal-root input[name="lead-watch"][value="emp-2"]').check();
await page.locator("#hr-modal-root button", { hasText: "保存する" }).click();
await page.waitForTimeout(400);
{
  const w = posted.find((x) => x.watchers);
  check(w && w.watchers.category === "mugendojo" && w.watchers.employeeIds.join() === "emp-2", "選んだ人が PUT で送られる");
}

console.log("\n=== ?category=mugendojo で直接開く ===");
await page.goto(`${BASE}/hr/applicants.html?category=mugendojo`);
await page.waitForTimeout(900);
check((await page.locator("#cat-tabs button.on").innerText()).includes("無限道場"), "無限道場タブが選ばれた状態で開く");

check(!errs.length, `画面のエラーが無い（${errs.join(" / ")}）`);
await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\nすべて通過");
