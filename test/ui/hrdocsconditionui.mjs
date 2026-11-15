// 採用HR：応募者詳細の「書類・契約」タブ（応募書類 4 種＋採用条件書類 3 種と、書類ごとの状態）を、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR → Office 切替ルール §7）
//   1. 書類・契約タブは1つの一覧。必要な応募書類（履歴書・職務経歴書）→ 採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）の順。
//      任意の書類（スキルシート・その他）は「その他の書類（任意）」の折りたたみの中
//   2. 応募書類は 未提出・必要／任意／確認待ち の状態つき。スキルシートをアップロードできる（種類に出る）。db/135 が未適用なら案内が出る
//   3. 採用条件書類は、オファーから自動で並ぶ（内定の前は出さない）。未作成 → 登録済み → 送付済み → 本人確認済み → 承諾済み
//   4. 労働条件通知書・承諾済みPDF は、給与を見られる人にだけ［PDFを見る］。見られない人には理由を出す
//   5. 採用条件書類の行にはファイル選択を置かない（作成済みPDFのアップロードは、給与・契約を管理できる人の「書類をアップロード」1つだけ）
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
  offer: null,   // 内定以降の応募者にするとき、その status（例 "offer_sent"）。null は選考中（カジュアル面談）
};
// 一覧・詳細で同じ応募者
const applicantOf = () => ({ id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "Wantedly", email: "yamada@example.com", rank: null,
  recruiterName: "採用 花子", docs: { resume: false, workHistory: false },
  ...(S.offer
    ? { stage: "offer", stageLabel: "内定", decision: "hired", status: S.offer, statusLabel: "合格通知", nextAction: "合格通知を確認してください", nextActionCta: null, nextActionKey: null }
    : { stage: "casual_interview", status: "eval_pending", statusLabel: "カジュアル面談済み", nextAction: "面談評価を入力してください", nextActionCta: "評価を入力", nextActionKey: "evaluate" }) });
const calls = [];
const TYPES = [["resume", "履歴書", "description"], ["work_history", "職務経歴書", "work_history"], ["skill_sheet", "スキルシート", "assignment_ind"], ["other", "その他", "attach_file"]];
const condRows = (states) => ({
  // 現在の API（lib/hr-condition-docs.js）と同じ形：内定通知書も別PDF（offerPdfReady）で、作ってあれば file:"offer"
  offerId: "of1", version: 1, offerType: "executive_employee", offerPdfReady: true, docsReady: true, progress: "none",
  rows: [
    { key: "offer", label: "内定通知書", state: states[0], stateLabel: LABEL[states[0]], at: states[0] === "none" ? null : "2026-10-10T01:00:00Z", file: states[0] === "none" ? null : "offer", note: states[0] === "none" ? "送るときに作ります" : null, applicable: true },
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
  page.setDefaultTimeout(8000);
  await page.context().addInitScript(() => { try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" })); } catch { /* sandbox付きiframe */ } });
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
        applicant: applicantOf(),
        interviews: [], interviewers: [], timeline: [], offers: [], salaryVisible: S.salaryVisible,
        ranks: ["A", "B", "C", "D"], rankLabel: {}, evalItems: [], evalScale: [], interviewKinds: [],
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [applicantOf()], employees: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForSelector("#rows tr.click", { timeout: 8000 });
  // 行クリックで開くのは対応モーダル。書類・契約タブは、その補助リンク「書類・契約」から開く
  await page.locator("#rows tr.click .hr-nm").first().click();
  await page.locator("#hr-detail-box.hr-work-modal #hr-work-link-docs").click();
  await page.waitForSelector(".hr-detail #hr-docs-app");
  return { page, errs };
}
const texts = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => { const c = e.cloneNode(true); c.querySelectorAll(".material-symbols-outlined").forEach((i) => i.remove()); return c.textContent.replace(/\s+/g, " ").trim(); }));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || (document.querySelector(".hr-detail")?.scrollWidth || 0) > (document.querySelector(".hr-detail")?.clientWidth || 0) + 1);
const keys = (page, sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.dataset.doc));
const row = (page, key) => page.locator(`#hr-detail-tab .hr-file-row[data-doc="${key}"]`);
const condStates = (page) => texts(page, "#hr-detail-tab .hr-file-row[data-cond] .hr-file-state");

console.log("\n=== 書類・契約タブ：必要な応募書類 →（内定後）採用条件書類 の順。応募書類は4つの枠 ===");
{
  S.docs = []; S.salaryVisible = true; S.skillNotReady = false; S.offer = null; S.cond = condRows(["none", "none", "none"]);
  const { page, errs } = await open({ width: 1360, height: 1000 });
  // 見出しは「応募書類／採用条件書類」の2つから、「書類・契約」1つ＋件数に変わった
  const sum = (await texts(page, "#hr-detail-tab .hr-document-summary"))[0] || "";
  check(sum.startsWith("書類・契約") && sum.includes("登録済み 0件") && sum.includes("未提出 2件"), `見出しは 書類・契約＋件数（いま ${sum}）`);
  // 応募書類の4つの枠：必要なもの（履歴書・職務経歴書）は一覧に、任意（スキルシート・その他）は折りたたみに分かれた
  const main = await keys(page, "#hr-docs-app .hr-file-row"), opt = await keys(page, "#hr-docs-optional .hr-file-row");
  check(main.join(",") === "resume,work_history" && opt.join(",") === "skill_sheet,other", `並び（いま ${main.join(",")} ／ 任意 ${opt.join(",")}）`);
  check((await texts(page, "#hr-docs-optional summary"))[0] === "その他の書類（任意・2種類）", "任意の書類は「その他の書類（任意・2種類）」にまとめる");
  const app = await texts(page, "#hr-docs-app .hr-file-row .hr-file-name b, #hr-docs-app .hr-file-row .hr-file-state");
  check(app.join("|") === "履歴書|未提出・必要|職務経歴書|未提出・必要", `必要な応募書類は2つとも「未提出・必要」（いま ${app.join("|")}）`);
  const optText = await texts(page, "#hr-docs-optional .hr-file-row .hr-file-name b, #hr-docs-optional .hr-file-row .hr-file-state");
  check(optText.join("|") === "スキルシート|任意|その他|任意", `任意の書類は「任意」（いま ${optText.join("|")}）`);
  // 採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）は、内定の前は並べない（「未登録」3行 → 案内1行）
  check(await page.locator("#hr-detail-tab .hr-file-row[data-cond]").count() === 0
    && (await page.locator("#hr-detail-tab .hr-doc-help").innerText()).includes("内定が決まってから準備します"), "内定の前は、採用条件書類を並べず「内定が決まってから準備します」と出す");
  check(await page.locator("#hr-detail-tab [data-cond-open]").count() === 0, "ファイルがまだ無いものには［PDFを見る］を出さない");
  // 主のボタン：必要な応募書類の［ファイルを選ぶ］2つと、作成済みPDFの「書類をアップロード」1つ
  const primary = await texts(page, "#hr-detail-tab .btn-primary");
  check(primary.join("|") === "書類をアップロード|ファイルを選ぶ|ファイルを選ぶ", `主のボタンは、必要な応募書類の［ファイルを選ぶ］と「書類をアップロード」だけ（いま ${primary.join("|")}）`);
  check(await page.locator("#hr-docs-optional .btn-primary").count() === 0, "任意の書類の［ファイルを選ぶ］は主のボタンにしない");
  check(!(await overflow(page)), "横にはみ出さない（PC）");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}
{
  // 内定後・まだ何も作っていない：内定通知書・労働条件通知書は「未作成」。承諾済みPDFは、できるまで並べない
  S.docs = []; S.salaryVisible = true; S.offer = "offer_draft_pending"; S.cond = condRows(["none", "none", "none"]);
  const { page, errs } = await open({ width: 1360, height: 1000 });
  const order = await keys(page, "#hr-docs-app .hr-file-row");
  check(order.join(",") === "resume,work_history,offer,notice", `応募書類 → 採用条件書類の順（いま ${order.join(",")}）`);
  const cond = await texts(page, "#hr-detail-tab .hr-file-row[data-cond] .hr-file-name b, #hr-detail-tab .hr-file-row[data-cond] .hr-file-state");
  check(cond.join("|") === "内定通知書|未作成|労働条件通知書|未作成", `採用条件書類は「未作成」（いま ${cond.join("|")}）`);
  // 「送るときに作ります」の注記は出なくなった。代わりに、作成待ちの内定通知書に［PDFを作成する］を出す
  check(await row(page, "offer").locator("button", { hasText: "PDFを作成する" }).count() === 1, "作成待ちの内定通知書に［PDFを作成する］");
  // 採用条件書類の行に、ファイル選択（アップロード）は置かない（オファーから自動で並ぶ・二重に持たない）
  check(await page.locator("#hr-detail-tab .hr-file-row[data-cond] button", { hasText: /ファイルを選ぶ|アップロード/ }).count() === 0, "採用条件書類の行にアップロードの導線を置かない");
  check(await page.locator("#hr-detail-tab [data-cond-open]").count() === 0, "ファイルがまだ無いものには［PDFを見る］を出さない");
  check(await page.locator("#hr-detail-tab .hr-doc-help").count() === 0, "内定後は「内定が決まってから」の案内を出さない");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== スキルシートをアップロードする ===");
{
  S.docs = []; S.skillNotReady = false; S.offer = null; calls.length = 0; S.cond = condRows(["none", "none", "none"]);
  const { page } = await open({ width: 1360, height: 1000 });
  await page.locator("#hr-docs-optional summary").click();
  await row(page, "skill_sheet").locator("button", { hasText: "ファイルを選ぶ" }).click();
  await page.waitForSelector("#action-root .hr-modal");
  const types = await texts(page, '#action-root label:has(input[name="doc-type"])');
  check(types.join("|") === "履歴書|職務経歴書|スキルシート|その他", `種類の選択肢に スキルシート（いま ${types.join("|")}）`);
  check(await page.locator('#action-root input[name="doc-type"][value="skill_sheet"]').isChecked(), "押した枠（スキルシート）が選ばれている");
  await page.setInputFiles("#doc-file", { name: "山田太郎_スキルシート.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.locator("#doc-save").click();
  await page.waitForFunction(() => !document.querySelector("#action-root .hr-modal"));
  check(calls.some((c) => c.action === "attach" && c.docType === "skill_sheet" && c.filename === "山田太郎_スキルシート.pdf"), "スキルシートとして登録する");
  // 登録すると、任意の折りたたみから一覧へ移り、状態は「確認待ち」（登録済み・未確認）になる
  await page.waitForFunction(() => document.querySelector('#hr-docs-app .hr-file-row[data-doc="skill_sheet"]')?.dataset.state === "pending");
  const card = row(page, "skill_sheet");
  const t = await card.innerText();
  check(t.includes("確認待ち") && t.includes("山田太郎_スキルシート.pdf") && !t.includes("任意") && !t.includes("未提出"), "枠が登録済み（確認待ち）に変わる");
  check(await card.evaluate((e) => e.dataset.state) === "pending" && await page.locator("#hr-docs-optional .hr-file-row[data-doc='skill_sheet']").count() === 0, "状態は pending・任意の折りたたみからは外れる");
  check(((await texts(page, "#hr-detail-tab .hr-document-summary"))[0] || "").includes("登録済み 1件"), "見出しの件数に反映（登録済み 1件）");
  check(await card.locator("button", { hasText: "PDFを見る" }).count() === 1 && await card.locator(".hr-menu-pop button", { hasText: "ファイルを差し替える" }).count() === 1, "［PDFを見る］とメニューの［ファイルを差し替える］が出る");
  check((await row(page, "resume").innerText()).includes("未提出"), "ほかの枠は未提出のまま");
  await page.close();
}
{
  // db/135 が未適用
  S.docs = []; S.skillNotReady = true; calls.length = 0;
  const { page } = await open({ width: 1360, height: 1000 });
  await page.locator("#hr-docs-optional summary").click();
  await row(page, "skill_sheet").locator("button", { hasText: "ファイルを選ぶ" }).click();
  await page.setInputFiles("#doc-file", { name: "s.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.locator("#doc-save").click();
  await page.waitForFunction(() => /db\/135_hr_document_skill_sheet\.sql/.test(document.getElementById("doc-msg")?.textContent || ""));
  check(true, "db/135 が未適用なら、流す SQL を案内する");
  check(await page.locator("#action-root .hr-modal").isVisible(), "モーダルは開いたまま（入力を失わない）");
  check(await page.locator("#hr-docs-optional .hr-file-row[data-doc='skill_sheet'][data-state='na']").count() === 1
    && await page.locator("#hr-docs-app .hr-file-row[data-doc='skill_sheet']").count() === 0, "登録はされていない");
  await page.close();
}

console.log("\n=== 採用条件書類：未作成 → 登録済み → 送付済み → 本人確認済み → 承諾済み ===");
// 承諾済みPDFは、できるまで行を出さない。ファイルの無い労働条件通知書は「未作成」。
// 状態の属性は 一覧の3段階（missing＝未作成／pending＝作成済み・進行中／done＝本人確認・承諾済み）になった
for (const [states, expect, attrs] of [
  [["registered", "none", "none"], "登録済み|未作成", "pending|missing"],
  [["sent", "sent", "none"], "送付済み|送付済み", "pending|pending"],
  [["confirmed", "confirmed", "none"], "本人確認済み|本人確認済み", "done|done"],
  [["accepted", "accepted", "accepted"], "承諾済み|承諾済み|承諾済み", "done|done|done"],
]) {
  S.docs = []; S.salaryVisible = true; S.offer = "offer_sent"; S.cond = condRows(states);
  const { page } = await open({ width: 1360, height: 1000 });
  const chips = await condStates(page);
  check(chips.join("|") === expect, `状態の表示：${expect}（いま ${chips.join("|")}）`);
  const stAttr = await page.locator("#hr-detail-tab .hr-file-row[data-cond]").evaluateAll((els) => els.map((e) => e.dataset.state));
  check(stAttr.join("|") === attrs, `状態の属性：${attrs}（いま ${stAttr.join("|")}）`);
  await page.close();
}
{
  // 承諾済み：PDF を見る（給与を見られる人）
  S.docs = []; S.salaryVisible = true; S.offer = "offer_sent"; calls.length = 0; S.cond = condRows(["accepted", "accepted", "accepted"]);
  const { page } = await open({ width: 1360, height: 1000 });
  check(await page.locator('[data-cond="notice"] [data-cond-open="notice"]').count() === 1 && await page.locator('[data-cond="accepted"] [data-cond-open="accepted"]').count() === 1, "労働条件通知書・承諾済みPDFに［PDFを見る］");
  // 内定通知書も別のPDFになった（旧：PDFは無く［オファーを見る］で概要へ）
  check(await page.locator('[data-cond="offer"] [data-cond-open="offer"]').count() === 1, "内定通知書にも［PDFを見る］");
  // PDF は保存（ダウンロード）ではなく、画面内のプレビュー（#pdf-preview-root）で開く
  await page.locator('[data-cond-open="accepted"]').click();
  await page.locator("#pdf-preview-root .hr-pdf-modal").waitFor();
  check(calls.some((c) => c.offerFile === "accepted" && c.id === "of1"), "承諾済みPDFを、既存のオファー API（権限・監査つき）から取る");
  check((await page.locator("#pdf-preview-root iframe.hr-pdf-viewer").getAttribute("src") || "").startsWith("blob:")
    && await page.locator("#pdf-preview-root a[download]", { hasText: "PDFを保存する" }).count() === 1, "PDF を画面内で開き、保存もできる");
  await page.locator("#pdf-preview-root button", { hasText: "戻る" }).click();
  check(await page.locator("#hr-tab-docs").getAttribute("aria-selected") === "true" && await page.locator(".hr-detail").isVisible(), "戻ると書類・契約タブのまま");
  await page.locator('[data-cond-open="offer"]').click();
  await page.locator("#pdf-preview-root .hr-pdf-modal").waitFor();
  check(calls.some((c) => c.offerFile === "offer" && c.id === "of1"), "内定通知書のPDFも、オファー API から取る");
  await page.close();
}
{
  // 給与を見られない人（責任者・採用担当で給与権限なし）
  S.docs = []; S.salaryVisible = false; S.offer = "offer_sent"; calls.length = 0; S.cond = condRows(["accepted", "accepted", "accepted"]);
  const { page } = await open({ width: 1360, height: 1000 });
  check(await page.locator('#hr-detail-tab [data-cond-open="notice"], #hr-detail-tab [data-cond-open="accepted"]').count() === 0, "給与を見られない人には、労働条件通知書・承諾済みPDFの［PDFを見る］を出さない");
  check(/閲覧権限が必要です/.test(await page.locator('[data-cond="notice"]').innerText()) && /閲覧権限が必要です/.test(await page.locator('[data-cond="accepted"]').innerText()), "理由を出す（閲覧権限が必要）");
  check((await condStates(page)).join("|") === "承諾済み|承諾済み|承諾済み", "状態は見える");
  check(await page.locator("#hr-detail-tab button", { hasText: "書類をアップロード" }).count() === 0, "給与を見られない人には「書類をアップロード」（作成済みPDFの登録）を出さない");
  check(!calls.some((c) => c.offerFile === "notice" || c.offerFile === "accepted"), "給与の入るPDFは取りにいかない");
  await page.close();
}

console.log("\n=== スマホ幅（390px）===");
{
  S.docs = []; S.salaryVisible = true; S.offer = "offer_sent"; S.cond = condRows(["accepted", "accepted", "accepted"]);
  const { page, errs } = await open({ width: 390, height: 844 });
  await page.locator("#hr-docs-optional summary").click();
  check(!(await overflow(page)), "横にはみ出さない");
  const w = await page.locator("#hr-detail-tab .hr-file-row").evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
  check(w <= 390, `書類の行が画面幅に収まる（右端 ${Math.round(w)}px）`);
  const lefts = await page.locator("#hr-detail-tab .hr-file-row").evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))]);
  check(await page.locator("#hr-detail-tab .hr-file-row").count() === 7 && lefts.length === 1, "7行（応募書類4＋採用条件書類3）が1列で並ぶ");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 NG` : "すべて通過");
process.exit(bad ? 1 : 0);
