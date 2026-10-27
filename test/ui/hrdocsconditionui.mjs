// 採用HR：応募者詳細の「書類」タブ（応募書類 4 種＋採用条件書類 3 種と、書類ごとの状態）を、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR → Office 切替ルール §7）
//   1. 書類タブは「応募書類（履歴書・職務経歴書・スキルシート・その他）」→「採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）」の順
//   2. 応募書類は 未登録／登録済み の状態つき。スキルシートをアップロードできる（種類に出る）。db/135 が未適用なら案内が出る
//   3. 採用条件書類は、オファーから自動で並ぶ（ここでは登録しない）。未登録 → 登録済み → 送付済み → 本人確認済み → 承諾済み
//   4. PDF は、給与を見られる人にだけ［PDFを開く］。見られない人には理由を出す
//   5. 同じファイルを二重に持たない（条件書類にアップロードの導線を置かない）
//   6. スマホ幅（390px）でも横にはみ出さない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false,
  gw: { employee: { id: "emp-r1", display_name: "採用 花子", status: "active" }, roles: ["recruiter"], tenantId: "t1", stage: null },
  access: { recruit: true, sell: false } };
const PDF = Buffer.from("%PDF-1.4\n%%EOF");

const S = {
  docs: [], salaryVisible: true, skillNotReady: false,
  cond: null,    // conditionDocs
};
const calls = [];
const TYPES = [["resume", "履歴書", "description"], ["work_history", "職務経歴書", "work_history"], ["skill_sheet", "スキルシート", "assignment_ind"], ["other", "その他", "attach_file"]];
const condRows = (states) => ({
  offerId: "of1", version: 1, offerType: "executive_employee", docsReady: true, progress: "none",
  rows: [
    { key: "offer", label: "内定通知書", state: states[0], stateLabel: LABEL[states[0]], at: states[0] === "none" ? null : "2026-10-10T01:00:00Z", file: null, note: null, applicable: true },
    { key: "notice", label: "労働条件通知書", state: states[1], stateLabel: LABEL[states[1]], at: states[1] === "none" ? null : "2026-10-10T01:00:00Z", file: states[1] === "none" ? null : "notice", note: states[1] === "none" ? "送るときに作ります" : null, applicable: true },
    { key: "accepted", label: "承諾済みPDF", state: states[2], stateLabel: LABEL[states[2]], at: states[2] === "none" ? null : "2026-10-12T01:00:00Z", file: states[2] === "none" ? null : "accepted", note: states[2] === "none" ? "本人が承諾すると作ります" : null, applicable: true },
  ],
});
const LABEL = { none: "未登録", registered: "登録済み", sent: "送付済み", confirmed: "本人確認済み", accepted: "承諾済み" };
S.cond = condRows(["none", "none", "none"]);

function docsBody() {
  return {
    applicant: { id: "a1", name: "山田 太郎" },
    conditionDocs: S.cond,
    documents: TYPES.map(([k, label, icon]) => {
      const list = S.docs.filter((d) => d.docType === k).reverse();
      return { docType: k, label, icon, latest: list[0] || null, history: list.slice(1) };
    }),
    types: TYPES.map(([key, label]) => ({ key, label })),
    limits: { maxBytes: 10 * 1024 * 1024 },
  };
}

async function open(viewport) {
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.context().addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" })); });
  await page.route("**/__upload/**", (route) => route.fulfill({ status: 200, body: "{}" }));
  await page.route("**/api/**", (route) => {
    const req = route.request(); const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/offers/.test(url) && req.method() === "GET") {
      calls.push({ offerFile: new URL(url).searchParams.get("file"), id: new URL(url).searchParams.get("id") });
      return route.fulfill({ status: 200, contentType: "application/pdf", headers: { "content-disposition": "attachment; filename*=UTF-8''x.pdf" }, body: PDF });
    }
    if (/\/api\/hr\/documents/.test(url)) {
      if (req.method() === "POST") {
        calls.push(body);
        if (body.action === "upload") return send({ path: `t1/recruit/a1/x${calls.length}.pdf`, uploadUrl: `${BASE}/__upload/x` });
        if (body.docType === "skill_sheet" && S.skillNotReady) return send({ error: "not_ready", message: "スキルシートを登録するには、db/135_hr_document_skill_sheet.sql を Supabase に流してください" }, 503);
        const d = { id: `d${S.docs.length + 1}`, docType: body.docType, docTypeLabel: "スキルシート", filename: body.filename, mimeType: "application/pdf", sizeBytes: 2048, uploadedAt: "2026-10-13T01:00:00Z", uploadedByName: "採用 花子" };
        S.docs.push(d);
        return send({ document: d });
      }
      return send(docsBody());
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({
        applicant: { id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "Wantedly", email: "yamada@example.com", stage: "casual_interview", status: "eval_pending",
          statusLabel: "カジュアル面談済み", nextAction: "面談評価を入力してください", nextActionCta: "評価を入力", nextActionKey: "evaluate", rank: null, recruiterName: "採用 花子", docs: { resume: false, workHistory: false } },
        interviews: [], interviewers: [], timeline: [], offers: [], salaryVisible: S.salaryVisible,
        ranks: ["A", "B", "C", "D"], rankLabel: {}, evalItems: [], evalScale: [], interviewKinds: [],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [{ id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "Wantedly", stage: "casual_interview", status: "eval_pending", statusLabel: "カジュアル面談済み",
      nextAction: "面談評価を入力してください", nextActionCta: "評価を入力", nextActionKey: "evaluate", docs: { resume: false, workHistory: false }, recruiterName: "採用 花子" }], employees: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForSelector("#rows tr.click", { timeout: 8000 });
  await page.locator("#rows tr.click .hr-nm").first().click();
  await page.waitForSelector(".hr-detail");
  await page.locator('.hr-tabs button[data-tab="docs"]').click();
  await page.waitForSelector("#hr-docs-app");
  return { page, errs };
}
const texts = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => { const c = e.cloneNode(true); c.querySelectorAll(".material-symbols-outlined").forEach((i) => i.remove()); return c.textContent.replace(/\s+/g, " ").trim(); }));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || (document.querySelector(".hr-detail")?.scrollWidth || 0) > (document.querySelector(".hr-detail")?.clientWidth || 0) + 1);

console.log("\n=== 書類タブ：応募書類 → 採用条件書類 の順。応募書類は4つの枠 ===");
{
  S.docs = []; S.salaryVisible = true; S.skillNotReady = false; S.cond = condRows(["none", "none", "none"]);
  const { page, errs } = await open({ width: 1360, height: 1000 });
  const heads = await texts(page, "#hr-detail-tab .hr-doc-h");
  check(heads.length === 2 && heads[0].startsWith("応募書類") && heads[1].startsWith("採用条件書類"), `見出しは 応募書類 → 採用条件書類（いま ${heads.join(" | ")}）`);
  const order = await page.evaluate(() => [...document.querySelectorAll("#hr-detail-tab .hr-doc-h, #hr-detail-tab .hr-doc")].map((e) => e.dataset.doc || e.dataset.cond || e.id));
  check(order.join(",") === "hr-docs-app,resume,work_history,skill_sheet,other,hr-docs-cond,offer,notice,accepted", `並び（いま ${order.join(",")}）`);
  const app = await texts(page, '#hr-detail-tab .hr-doc[data-doc] .t');
  check(app.join("|") === "履歴書未登録|職務経歴書未登録|スキルシート未登録|その他の書類未登録", `応募書類は 4つとも「未登録」（いま ${app.join("|")}）`);
  const cond = await texts(page, '#hr-detail-tab .hr-doc[data-cond] .t');
  check(cond.join("|") === "内定通知書未登録|労働条件通知書未登録|承諾済みPDF未登録", `採用条件書類は 3つとも「未登録」（いま ${cond.join("|")}）`);
  check(await page.locator('#hr-detail-tab .hr-doc[data-cond] button', { hasText: "アップロード" }).count() === 0, "採用条件書類にアップロードの導線を置かない（オファーから自動で並ぶ・二重に持たない）");
  check(/送るときに作ります/.test(await page.locator('.hr-doc[data-cond="notice"]').innerText()) && /本人が承諾すると作ります/.test(await page.locator('.hr-doc[data-cond="accepted"]').innerText()), "未登録の理由（いつ作られるか）を出す");
  check(await page.locator("#hr-detail-tab [data-cond-open]").count() === 0, "ファイルがまだ無いものには［PDFを開く］を出さない");
  check(await page.locator("#hr-detail-tab .btn-primary").count() === 3, "主のボタンは、決まった枠（履歴書・職務経歴書・スキルシート）の［アップロード］だけ。採用条件書類には無い");
  check(!(await overflow(page)), "横にはみ出さない（PC）");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== スキルシートをアップロードする ===");
{
  S.docs = []; S.skillNotReady = false; calls.length = 0; S.cond = condRows(["none", "none", "none"]);
  const { page } = await open({ width: 1360, height: 1000 });
  await page.locator('.hr-doc[data-doc="skill_sheet"] button', { hasText: "アップロード" }).click();
  await page.waitForSelector("#action-root .hr-modal");
  const types = await texts(page, '#action-root label:has(input[name="doc-type"])');
  check(types.join("|") === "履歴書|職務経歴書|スキルシート|その他", `種類の選択肢に スキルシート（いま ${types.join("|")}）`);
  check(await page.locator('#action-root input[name="doc-type"][value="skill_sheet"]').isChecked(), "押した枠（スキルシート）が選ばれている");
  await page.setInputFiles("#doc-file", { name: "山田太郎_スキルシート.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.locator("#doc-save").click();
  await page.waitForFunction(() => !document.querySelector("#action-root .hr-modal"));
  check(calls.some((c) => c.action === "attach" && c.docType === "skill_sheet" && c.filename === "山田太郎_スキルシート.pdf"), "スキルシートとして登録する");
  await page.waitForFunction(() => document.querySelector('.hr-doc[data-doc="skill_sheet"]')?.dataset.state === "registered");
  const card = page.locator('.hr-doc[data-doc="skill_sheet"]');
  const t = await card.innerText();
  check(t.includes("登録済み") && t.includes("山田太郎_スキルシート.pdf") && !t.includes("未登録"), "枠が「登録済み」に変わる");
  check(await card.evaluate((e) => e.dataset.state) === "registered", "状態は registered");
  check(await card.locator("button", { hasText: "プレビュー" }).count() >= 1 && await card.locator("button", { hasText: "差し替え" }).count() >= 1, "［プレビュー］［差し替え］が出る");
  check((await page.locator('.hr-doc[data-doc="resume"]').innerText()).includes("未登録"), "ほかの枠は未登録のまま");
  await page.close();
}
{
  // db/135 が未適用
  S.docs = []; S.skillNotReady = true; calls.length = 0;
  const { page } = await open({ width: 1360, height: 1000 });
  await page.locator('.hr-doc[data-doc="skill_sheet"] button', { hasText: "アップロード" }).click();
  await page.setInputFiles("#doc-file", { name: "s.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.locator("#doc-save").click();
  await page.waitForFunction(() => /db\/135_hr_document_skill_sheet\.sql/.test(document.getElementById("doc-msg")?.textContent || ""));
  check(true, "db/135 が未適用なら、流す SQL を案内する");
  check(await page.locator("#action-root .hr-modal").isVisible(), "モーダルは開いたまま（入力を失わない）");
  check((await page.locator('.hr-doc[data-doc="skill_sheet"]').innerText()).includes("未登録"), "登録はされていない");
  await page.close();
}

console.log("\n=== 採用条件書類：未登録 → 登録済み → 送付済み → 本人確認済み → 承諾済み ===");
for (const [states, expect] of [
  [["registered", "none", "none"], "登録済み|未登録|未登録"],
  [["sent", "sent", "none"], "送付済み|送付済み|未登録"],
  [["confirmed", "confirmed", "none"], "本人確認済み|本人確認済み|未登録"],
  [["accepted", "accepted", "accepted"], "承諾済み|承諾済み|承諾済み"],
]) {
  S.docs = []; S.salaryVisible = true; S.cond = condRows(states);
  const { page } = await open({ width: 1360, height: 1000 });
  const chips = await texts(page, "#hr-detail-tab .hr-doc[data-cond] .hr-dst");
  check(chips.join("|") === expect, `状態の表示：${expect}（いま ${chips.join("|")}）`);
  const stAttr = await page.locator("#hr-detail-tab .hr-doc[data-cond]").evaluateAll((els) => els.map((e) => e.dataset.state));
  check(stAttr.join("|") === states.join("|"), `状態の属性（${stAttr.join("|")}）`);
  await page.close();
}
{
  // 承諾済み：PDF を開く（給与を見られる人）
  S.docs = []; S.salaryVisible = true; calls.length = 0; S.cond = condRows(["accepted", "accepted", "accepted"]);
  const { page } = await open({ width: 1360, height: 1000 });
  check(await page.locator('[data-cond="notice"] [data-cond-open="notice"]').count() === 1 && await page.locator('[data-cond="accepted"] [data-cond-open="accepted"]').count() === 1, "労働条件通知書・承諾済みPDFに［PDFを開く］");
  check(await page.locator('[data-cond="offer"] [data-cond-open]').count() === 0 && await page.locator('[data-cond="offer"] button', { hasText: "オファーを見る" }).count() === 1, "内定通知書には［オファーを見る］（PDFは無い）");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-cond-open="accepted"]').click()]);
  check(calls.some((c) => c.offerFile === "accepted" && c.id === "of1"), "承諾済みPDFを、既存のオファー API（権限・監査つき）から取る");
  check(!!dl.suggestedFilename(), "PDF が保存される");
  await page.locator('[data-cond="offer"] button', { hasText: "オファーを見る" }).click();
  check(await page.locator('.hr-tabs button.on').getAttribute("data-tab") === "overview", "［オファーを見る］で概要タブへ");
  await page.close();
}
{
  // 給与を見られない人（責任者・採用担当で給与権限なし）
  S.docs = []; S.salaryVisible = false; calls.length = 0; S.cond = condRows(["accepted", "accepted", "accepted"]);
  const { page } = await open({ width: 1360, height: 1000 });
  check(await page.locator("#hr-detail-tab [data-cond-open]").count() === 0, "給与を見られない人には［PDFを開く］を出さない");
  check(/給与を見られる方が確認します/.test(await page.locator('[data-cond="notice"]').innerText()), "理由を出す（給与・報酬が入るため）");
  check((await texts(page, "#hr-detail-tab .hr-doc[data-cond] .hr-dst")).join("|") === "承諾済み|承諾済み|承諾済み", "状態は見える");
  await page.close();
}

console.log("\n=== スマホ幅（390px）===");
{
  S.docs = []; S.salaryVisible = true; S.cond = condRows(["accepted", "accepted", "accepted"]);
  const { page, errs } = await open({ width: 390, height: 844 });
  check(!(await overflow(page)), "横にはみ出さない");
  const w = await page.locator("#hr-detail-tab .hr-doc").evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
  check(w <= 390, `書類カードが画面幅に収まる（右端 ${Math.round(w)}px）`);
  check(await page.locator("#hr-detail-tab .hr-doc").count() === 7, "7枚（応募書類4＋採用条件書類3）が1列で並ぶ");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 NG` : "すべて通過");
process.exit(bad ? 1 : 0);
