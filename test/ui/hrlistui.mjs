// 採用HR：応募者一覧の「選考パイプライン」と「書類」列を、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR応募者一覧・詳細画面 UI/UX改善）
//   1. 上部は選考段階（stage）ごとの人数つき。「すべて」は全員の数。取得したデータから数える
//      押すとその段階だけに絞る。0人の段階も出す（薄く）。細かい状態（status）は上に出さない
//   2. 「書類」列：書類の種類ごとにアイコン（description / work_history …）。登録済み・未提出は色（状態）とツールチップで分かる
//      押すとその書類だけを画面内のプレビュー（#pdf-preview-root）で開き、応募者の対応モーダル・詳細は開かない
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
  try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" })); } catch { /* sandbox付きiframe */ }
});
// 書類の表示用URL（プレビューは https / blob だけを受け付ける。js/hr-modal-ui.js）
const FILE = "https://files.example.test/r.svg";
await ctx.route("https://files.example.test/**", (route) => route.fulfill({ status: 200, contentType: "image/svg+xml",
  body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' }));
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
  if (/\/api\/hr\/documents/.test(url)) {
    const q = new URL(url).searchParams;
    // 一覧（applicantId だけ）→ その応募者の書類の最新版。id つき → 表示用URL
    if (!q.get("id")) {
      const d = applicants.find((a) => a.id === q.get("applicantId"))?.docs || {};
      calls.push(["docs", url]);
      return send({ documents: [d.resume && { docType: "resume", latest: { id: d.resumeId, filename: "r.pdf", mimeType: "image/svg+xml" } },
        d.workHistory && { docType: "work_history", latest: { id: d.workHistoryId, filename: "w.pdf", mimeType: "image/svg+xml" } }].filter(Boolean) });
    }
    calls.push(["doc", url]);
    return send({ url: `${FILE}?sign=1`, mimeType: "image/svg+xml", docTypeLabel: "履歴書", applicantName: "高木 沙綾", filename: "r.pdf" });
  }
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
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
// 選考タブは現在の8段階（事前選考→…→OFFICE）。旧6段階（新規応募／社長推薦／社長面談／内定／入社予定）を置き換えた。
// 新規応募 → 事前選考、社長面談 → 代表面談 に数えられる
for (const [key, label, n] of [["screening", "事前選考", 1], ["interview", "カジュアル面談", 0], ["final", "代表面談", 3],
  ["offer", "合格通知", 0], ["trial", "トライアル", 0], ["terms", "条件通知書", 0], ["agreement", "合意", 0], ["office", "OFFICE", 0]]) {
  check(await tabText(key) === `${label} ${n}`, `${label} ${n}（いま ${await tabText(key)}）`);
}
check(await page.locator('#stage-tabs button[data-stage="offer"].zero').count() === 1, "0人の段階は薄く（.zero）");
check(await page.locator('#stage-tabs button[data-stage="final"].zero').count() === 0, "人のいる段階は薄くしない");
// アイコンは自分の枠からはみ出さない（字のまま表示されても、隣のアイコンを押してしまわない）
// 書類アイコンは a ではなく button（.hr-doc-state）になった
check(await page.locator(".hr-docs button").evaluateAll((as) => as.length > 0 && as.every((a) => getComputedStyle(a).overflow === "hidden")), "書類アイコンは枠の中に収まる");
const heights = await page.locator("#stage-tabs button").evaluateAll((bs) => [...new Set(bs.map((b) => Math.round(b.getBoundingClientRect().height)))]);
check(heights.length === 1, `0人の段階でもボタンの高さがそろう（${heights.join(",")}px）`);
const toolbar = await page.locator(".hr-toolbar").innerText();
check(!/日程調整中|評価入力待ち|社長判断待ち|承諾待ち/.test(toolbar), "細かい状態（status）は上部に出さない");

await page.locator('#stage-tabs button[data-stage="final"]').click();
await page.waitForTimeout(200);
check(await page.locator("#rows tr.click").count() === 3, "代表面談で絞ると3人");
await page.locator('#stage-tabs button[data-stage="screening"]').click();
await page.waitForTimeout(200);
check(await page.locator("#rows tr.click").count() === 1 && (await page.locator("#rows").innerText()).includes("テスト"), "事前選考で絞ると1人");
await page.locator('#stage-tabs button[data-stage="offer"]').click();
await page.waitForTimeout(200);
check((await page.locator("#rows").innerText()).includes("対象がありません"), "0人の段階は「対象がありません」");
await page.locator('#stage-tabs button[data-stage="all"]').click();
await page.waitForTimeout(200);
check(await page.locator("#rows tr.click").count() === 4, "すべてに戻すと4人");

console.log("\n— 書類列 —");
const heads = (await page.locator(".hr-table thead th").allInnerTexts()).map((s) => s.trim()).filter(Boolean);
check(heads.join("/") === "登録日時/応募者・職種/プロフィール/現在の状態/書類/社内メモ/NEXT/担当者", `列（いま ${heads.join("/")}）`);
const row = (id) => page.locator(`#rows tr.click[data-applicant="${id}"]`);
const doc = (id, kind) => row(id).locator(`.hr-docs [data-doc-kind="${kind}"]`);
// 書類列は「登録済みだけアイコン」ではなく、種類ごとのアイコンを常に出し、状態（未提出／確認待ち）で分ける形に変わった。
// 「未登録は登録済みに見せない」「登録済みは登録済みと分かる」を、状態のクラスとツールチップで確かめる
check(await row("a0").locator(".hr-docs [data-doc-kind]").count() === 5, "書類は種類ごとに5つ（履歴書・職務経歴書・スキルシート・通知書・契約書）");
check(await doc("a0", "resume").evaluate((b) => b.classList.contains("missing")) && await doc("a0", "work_history").evaluate((b) => b.classList.contains("missing"))
  && await doc("a0", "resume").getAttribute("title") === "履歴書：未提出", "書類なし → 未提出（登録済みに見せない）");
check(await doc("a1", "resume").evaluate((b) => b.classList.contains("pending")) && await doc("a1", "work_history").evaluate((b) => b.classList.contains("pending")),
  "履歴書・職務経歴書あり → 2つとも登録済み（確認待ち）");
check(await doc("a3", "resume").evaluate((b) => b.classList.contains("pending")) && await doc("a3", "work_history").evaluate((b) => b.classList.contains("missing")),
  "履歴書だけ → 履歴書だけ登録済み・職務経歴書は未提出");
const r1 = doc("a1", "resume");
check(await r1.locator(".material-symbols-outlined").innerText() === "description"
  && await doc("a1", "work_history").locator(".material-symbols-outlined").innerText() === "work_history", "Material Symbols：description / work_history");
check(await r1.getAttribute("title") === "履歴書：確認待ち" && await r1.getAttribute("aria-label") === "履歴書：確認待ち"
  && await doc("a1", "work_history").getAttribute("title") === "職務経歴書：確認待ち", "ツールチップ：書類名と状態");
// スキルシートのアイコン名（assignment_ind）が "sign" を含むので、URLそのもの（https / sign=）で見る
check(!/https?:\/\/|sign=|doc-r1-v2/.test(await page.locator("#rows").innerHTML()), "一覧に表示用URL（署名付き）・書類IDを持たない");

// 押すと別タブではなく、画面内のプレビュー（#pdf-preview-root）で、その種類の最新版だけを開く
calls.length = 0;
await r1.click();
await page.locator("#pdf-preview-root .hr-pdf-modal").waitFor();
check((await page.locator("#pdf-preview-root h2").innerText()).includes("履歴書"), "履歴書のプレビューが画面内で開く");
check(calls.some(([k, u]) => k === "docs" && u.includes("applicantId=a1")), "押してから、その応募者の書類を取りにいく");
check(calls.some(([k, u]) => k === "doc" && u.includes("id=doc-r1-v2") && u.includes("applicantId=a1")), "最新版の書類IDで、表示用URLを取りにいく（応募者ID付き）");
check(!calls.some(([k, u]) => k === "doc" && !u.includes("doc-r1-v2")), "別の書類のURLは取りにいかない");
check((await page.locator("#pdf-preview-root img.hr-document-image").getAttribute("src") || "").startsWith(FILE), "取得したURLの書類を表示する");
check(await page.locator("#hr-detail-box, .hr-detail").count() === 0 && !calls.some(([k]) => k === "detail"), "アイコンを押しても応募者の対応モーダル・詳細は開かない");
await page.locator("#pdf-preview-root button", { hasText: "閉じる" }).click();
check(await page.locator("#pdf-preview-root .hr-pdf-modal").count() === 0, "プレビューを閉じると一覧に戻る");

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
