// 採用HR：応募者一覧の「選考パイプライン」と「書類」列を、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR応募者一覧・詳細画面 UI/UX改善）
//   1. 上部は選考段階（stage）ごとの人数つき。「すべて」は全員の数。取得したデータから数える
//      押すとその段階だけに絞る。0人の段階も出す（薄く）。細かい状態（status）は上に出さない
//   2. 「書類」列：登録済みの履歴書・職務経歴書だけアイコン（description / work_history）。未登録は何も出さない
//      ツールチップ「履歴書をプレビュー」。押すと hr/document.html を別タブで開き、応募者詳細は開かない
//   3. 一覧の複数選択 → 一括ステータス変更は、これまでどおり使える
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-r1", display_name: "採用 花子" }, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

const A = (id, name, stage, stageLabel, status, statusLabel, docs) => ({
  id, name, jobTitle: "エンジニア", source: "Wantedly", stage, stageLabel, status, statusLabel,
  nextAction: "面談を実施してください", nextActionCta: "面談を実施済みにする", nextActionKey: "conduct",
  rank: null, decision: null, recruiterName: "池永", docs,
});
const NODOCS = { resume: false, resumeId: null, workHistory: false, workHistoryId: null };
const applicants = [
  A("a0", "テスト", "applied", "新規応募", "todo", "未対応", NODOCS),
  A("a1", "高木 沙綾", "ceo_interview", "社長面談", "interview_scheduled", "面談予定",
    { resume: true, resumeId: "doc-r1-v2", workHistory: true, workHistoryId: "doc-w1" }),
  A("a2", "宮崎 優作", "ceo_interview", "社長面談", "interview_scheduled", "面談予定",
    { resume: true, resumeId: "doc-r2", workHistory: true, workHistoryId: "doc-w2" }),
  A("a3", "魚住 かよ", "ceo_interview", "社長面談", "interview_scheduled", "面談予定",
    { resume: true, resumeId: "doc-r3", workHistory: false, workHistoryId: null }),
];

const ctx = await br.newContext({ viewport: { width: 1300, height: 900 }, timezoneId: "Asia/Tokyo" });
await ctx.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
});
const calls = [];
await ctx.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (/\/api\/me\b/.test(url)) return send(ME);
  if (/\/api\/hr\/applicants\/bulk/.test(url)) {
    const b = JSON.parse(req.postData() || "{}"); calls.push(["bulk", b]);
    for (const a of applicants) if (b.ids.includes(a.id)) Object.assign(a, { status: b.status, statusLabel: "社長判断待ち" });
    return send({ updated: b.ids.length });
  }
  if (/\/api\/hr\/applicants\/detail/.test(url)) { calls.push(["detail"]); return send({ applicant: applicants[1], interviews: [], timeline: [] }); }
  if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants, employees: [] });
  if (/\/api\/hr\/documents/.test(url)) { calls.push(["doc", url]); return send({ url: `${BASE}/img/logo.svg`, mimeType: "image/svg+xml",
    docTypeLabel: "履歴書", applicantName: "高木 沙綾", filename: "r.pdf" }); }
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(`${BASE}/hr/applicants.html`);
await page.waitForTimeout(1000);

console.log("\n— 選考パイプライン（段階ごとの人数） —");
// ボタンの字（段階名）と人数（.n）を分けて読む
const tabText = async (key) => {
  const b = page.locator(`#stage-tabs button[data-stage="${key}"]`);
  return `${(await b.innerText()).replace(await b.locator(".n").innerText(), "").trim()} ${await b.locator(".n").innerText()}`;
};
check(await tabText("all") === "すべて 4", `すべて 4（いま ${await tabText("all")}）`);
for (const [key, label, n] of [["applied", "新規応募", 1], ["casual_interview", "カジュアル面談", 0], ["ceo_recommend", "社長推薦", 0],
  ["ceo_interview", "社長面談", 3], ["offer", "内定", 0], ["joining_scheduled", "入社予定", 0]]) {
  check(await tabText(key) === `${label} ${n}`, `${label} ${n}（いま ${await tabText(key)}）`);
}
check(await page.locator('#stage-tabs button[data-stage="offer"].zero').count() === 1, "0人の段階は薄く（.zero）");
check(await page.locator('#stage-tabs button[data-stage="ceo_interview"].zero').count() === 0, "人のいる段階は薄くしない");
// アイコンは自分の枠からはみ出さない（字のまま表示されても、隣のアイコンを押してしまわない）
check(await page.locator(".hr-docs a").evaluateAll((as) => as.every((a) => getComputedStyle(a).overflow === "hidden")), "書類アイコンは枠の中に収まる");
const heights = await page.locator("#stage-tabs button").evaluateAll((bs) => [...new Set(bs.map((b) => Math.round(b.getBoundingClientRect().height)))]);
check(heights.length === 1, `0人の段階でもボタンの高さがそろう（${heights.join(",")}px）`);
const toolbar = await page.locator(".hr-toolbar").innerText();
check(!/日程調整中|評価入力待ち|社長判断待ち|承諾待ち/.test(toolbar), "細かい状態（status）は上部に出さない");

await page.locator('#stage-tabs button[data-stage="ceo_interview"]').click();
await page.waitForTimeout(200);
check(await page.locator("#rows tr.click").count() === 3, "社長面談で絞ると3人");
await page.locator('#stage-tabs button[data-stage="applied"]').click();
await page.waitForTimeout(200);
check(await page.locator("#rows tr.click").count() === 1 && (await page.locator("#rows").innerText()).includes("テスト"), "新規応募で絞ると1人");
await page.locator('#stage-tabs button[data-stage="offer"]').click();
await page.waitForTimeout(200);
check((await page.locator("#rows").innerText()).includes("対象がありません"), "0人の段階は「対象がありません」");
await page.locator('#stage-tabs button[data-stage="all"]').click();
await page.waitForTimeout(200);
check(await page.locator("#rows tr.click").count() === 4, "すべてに戻すと4人");

console.log("\n— 書類列 —");
const heads = (await page.locator(".hr-table thead th").allInnerTexts()).map((s) => s.trim()).filter(Boolean);
check(heads.join("/") === "応募者/書類/選考/状態/NEXT/担当", `列（いま ${heads.join("/")}）`);
const row = (id) => page.locator("#rows tr.click").nth(applicants.findIndex((a) => a.id === id));
check(await row("a0").locator("[data-docs] a").count() === 0 && !(await row("a0").locator("[data-docs]").innerText()).trim(), "書類なし → アイコンも「なし」も出さない");
check(await row("a1").locator('[data-doc-link="description"]').count() === 1 && await row("a1").locator('[data-doc-link="work_history"]').count() === 1, "履歴書・職務経歴書あり → 2つのアイコン");
check(await row("a3").locator('[data-doc-link="description"]').count() === 1 && await row("a3").locator('[data-doc-link="work_history"]').count() === 0, "履歴書だけ → 履歴書アイコンだけ");
const r1 = row("a1").locator('[data-doc-link="description"]');
check(await r1.locator(".material-symbols-outlined").innerText() === "description"
  && await row("a1").locator('[data-doc-link="work_history"] .material-symbols-outlined').innerText() === "work_history", "Material Symbols：description / work_history");
check(await r1.getAttribute("title") === "履歴書をプレビュー"
  && await row("a1").locator('[data-doc-link="work_history"]').getAttribute("title") === "職務経歴書をプレビュー", "ツールチップ：〇〇をプレビュー");
check(await r1.getAttribute("href") === "/hr/document.html?applicant=a1&doc=doc-r1-v2", "最新版の書類IDでプレビューを開く");
check(await r1.getAttribute("target") === "_blank" && /noopener/.test(await r1.getAttribute("rel") || ""), "別タブ（noopener）");
check(!(await page.locator("#rows").innerHTML()).includes("sign"), "一覧に表示用URL（署名付き）を持たない");

calls.length = 0;
const [tab] = await Promise.all([ctx.waitForEvent("page"), r1.click()]);
await tab.waitForLoadState("domcontentloaded");
await tab.waitForTimeout(800);
check(new URL(tab.url()).pathname === "/hr/document.html" && tab.url().includes("applicant=a1") && tab.url().includes("doc=doc-r1-v2"), "hr/document.html が別タブで開く");
check(calls.some(([k, u]) => k === "doc" && u.includes("doc-r1-v2")), "プレビュー画面が開いてから書類の表示用URLを取りにいく");
check(await page.locator(".hr-detail").count() === 0 && !calls.some(([k]) => k === "detail"), "アイコンを押しても応募者詳細ドロワーは開かない");
await tab.close();

console.log("\n— 一括ステータス変更（これまでどおり） —");
await row("a2").locator('input[type="checkbox"]').check();
await page.locator("#bulkbar button", { hasText: "ステータス変更" }).click();
await page.waitForTimeout(300);
await page.selectOption("#bs-status", "ceo_decision_pending");
await page.locator(".hr-modal button", { hasText: "変更する" }).click();
await page.waitForTimeout(800);
const bulk = calls.find(([k]) => k === "bulk")?.[1];
check(bulk?.action === "setStatus" && bulk.status === "ceo_decision_pending" && bulk.ids.join() === "a2", "一括ステータス変更が送られる");
check((await row("a2").innerText()).includes("社長判断待ち"), "一覧に反映される");

check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
