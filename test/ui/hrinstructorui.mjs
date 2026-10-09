// 採用HR：無限道場HPからの講師・メンター応募（lead_type = mugendojo_instructor）を、応募者一覧・詳細（/hr/applicants.html）で実際のブラウザに通す。
//
// ■ 何を守るテストか（LMS V2 Phase4｜講師・メンター募集ページ＋採用HR連携）
//   1. 講師応募者は「採用」タブに出て、募集職種「無限道場 講師・メンター」・応募経路「無限道場HP」で判別できる
//   2. 無限道場（無料カウンセリング）タブには出ない
//   3. 詳細に「講師・メンター応募の内容」（専門分野・経歴・応募理由・任意項目・流入）が出る
//   4. 書類タブなど、採用の応募者としての画面はそのまま
//   表示する応募者は、本物の shapeApplicant（lib/hr.js）で作る（API と同じ言い方になる）
import { launch, BASE } from "../_browser.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { shapeApplicant } = await import(join(ROOT, "lib/hr.js"));
const { INSTRUCTOR_JOB_TITLE, INSTRUCTOR_SOURCE } = await import(join(ROOT, "lib/hr-leads.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const EMPLOYEES = [{ id: "emp-r1", display_name: "採用 花子" }];

const ins = shapeApplicant({
  id: "in1", name: "講師 太郎", email: "teach@example.jp", phone: null, source: INSTRUCTOR_SOURCE, job_title: INSTRUCTOR_JOB_TITLE,
  stage: "applied", status: "todo", lead_category: "recruitment", profile_url: "https://example.com/profile",
  attribution: { lead_type: "mugendojo_instructor", source_type: "recruitment",
    first: { utm_source: "e2e", utm_medium: "test", utm_campaign: "phase4", source_url: "https://mugendojo.jp/instructors/recruit" },
    last: { source_url: "https://mugendojo.jp/instructors/recruit" }, touches: 1 },
  lead_profile: { kind: "instructor", occupation: "SIerでシステム開発のPM", company: "株式会社テスト",
    specialties: ["生成AI", "地方創生"], career_text: "業務システムの開発10年\n生成AIの社内研修", motivation_text: "地方でAIを使う人を増やしたい",
    teaching_experience: "社内研修の講師を3年", availability: "平日夜", work_styles: ["オンライン", "対面"],
    profile_url: "https://example.com/profile", website_url: "https://example.com/", note_text: "土日も可" },
  created_at: "2026-10-09T03:00:00Z",
});
const md = shapeApplicant({
  id: "md1", name: "山田 花子", email: "hana@example.jp", source: "無限道場LP", job_title: "無限道場 カジュアル面談",
  stage: "applied", status: "todo", lead_category: "mugendojo", lead_profile: { occupation: "会社員" }, created_at: "2026-10-08T03:00:00Z",
});

const page = await br.newPage({ viewport: { width: 1400, height: 1000 }, timezoneId: "Asia/Tokyo" });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
});
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

await page.route("**/api/**", (route) => {
  const url = route.request().url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (/\/api\/me\b/.test(url)) {
    return send({ email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
      gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } });
  }
  if (/\/api\/hr\/lead-watchers/.test(url)) return send({ category: "mugendojo", employeeIds: [], employees: EMPLOYEES });
  if (/\/api\/hr\/applicants\/detail/.test(url)) {
    return send({
      applicant: ins, interviews: [],
      timeline: [{ id: "t1", eventKey: "applied", label: "無限道場HPから講師・メンターに応募", detail: "流入: e2e / test / phase4", occurredAt: "2026-10-09T03:00:00Z" }],
      offers: [], interviewers: EMPLOYEES, statusOptions: [], leadNextActions: [],
      schedulingUrl: null, schedulingUrlEnv: "TIMEREX_CASUAL_INTERVIEW_URL",
    });
  }
  if (/\/api\/hr\/applicants\b/.test(url)) {
    return send({ applicants: [ins, md].map((a) => ({ ...a, nextInterviewAt: null })),
      employees: EMPLOYEES, meEmployeeId: RECRUITER.id, category: "all", leadReady: true });
  }
  if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});

console.log("\n=== 一覧 ===");
await page.goto(`${BASE}/hr/applicants.html`);
await page.waitForTimeout(1000);
await page.locator("#cat-tabs button", { hasText: "採用" }).click();
await page.waitForTimeout(300);
{
  const rows = await page.locator("#rows").innerText();
  check(rows.includes("講師 太郎") && !rows.includes("山田 花子"), "講師応募者は採用タブに出る（無料カウンセリングのリードは出ない）");
  check(rows.includes(INSTRUCTOR_JOB_TITLE), `募集職種「${INSTRUCTOR_JOB_TITLE}」で判別できる`);
}
await page.locator("#cat-tabs button", { hasText: "無限道場" }).click();
await page.waitForTimeout(300);
check(!(await page.locator("#rows").innerText()).includes("講師 太郎"), "無限道場（無料カウンセリング）タブには出ない");

console.log("\n=== 詳細 ===");
await page.locator("#cat-tabs button", { hasText: "採用" }).click();
await page.waitForTimeout(300);
await page.locator(".hr-table tr.click", { hasText: "講師 太郎" }).first().click();
await page.waitForTimeout(600);
{
  const d = await page.locator(".hr-detail").innerText();
  check(d.includes("講師・メンター応募の内容"), "「講師・メンター応募の内容」が出る");
  check(d.includes(INSTRUCTOR_SOURCE), `応募経路「${INSTRUCTOR_SOURCE}」が出る`);
  for (const [label, want] of [["現在の仕事・肩書き", "SIerでシステム開発のPM"], ["会社・所属", "株式会社テスト"], ["専門分野", "地方創生"],
    ["経歴・実績・できること", "生成AIの社内研修"], ["応募理由", "地方でAIを使う人を増やしたい"], ["講師・メンター経験", "社内研修の講師を3年"],
    ["対応可能な曜日・時間", "平日夜"], ["オンライン／対面", "オンライン・対面"], ["プロフィールURL", "https://example.com/profile"],
    ["SNS／Webサイト", "https://example.com/"], ["その他", "土日も可"], ["流入（UTM）", "e2e / test / phase4"]]) {
    check(d.includes(label) && d.includes(want), `${label}：${want}`);
  }
  const tabNames = await page.locator(".hr-tabs button").allInnerTexts();
  check(tabNames.some((t) => t.includes("書類")), "採用の応募者なので書類タブはそのまま");
}
await page.locator(".hr-tabs button", { hasText: "履歴" }).click();
await page.waitForTimeout(300);
check((await page.locator(".hr-detail").innerText()).includes("無限道場HPから講師・メンターに応募"), "履歴タブに応募の履歴");
check(!errs.length, `画面のエラーが無い（${errs.join(" / ")}）`);
await br.close();
if (bad) { console.log(`\n${bad} 件 NG`); process.exit(1); }
console.log("\nすべて通過");
