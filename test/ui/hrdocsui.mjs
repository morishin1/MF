// 採用HR：応募者詳細のドロワー・モーダル整理と、履歴書・職務経歴書のアップロードを、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR 応募者詳細UI改善）
//   1. 行を押すと対応モーダル1枚（主ボタンは1つ）。応募者詳細は「応募者情報」から開き、タブは 応募者情報 / 面談・評価 / 書類・契約 / 連絡・履歴
//   2. 応募者情報に NEXT ACTION と、CTA は1つ
//   3. 評価の入力は中央モーダル（600〜720px・中だけスクロール）。モーダルは同時に1枚だけ見える
//      背景を押すと評価モーダルだけ閉じ、対応モーダルは残る。保存後も対応モーダルは開いたまま反映
//   4. 書類・契約タブ：履歴書・職務経歴書。未登録なら「未提出・必要」「ファイルを選ぶ」
//      アップロードは中央モーダル（応募者名・種類・ドラッグ&ドロップ）。登録後すぐ反映
//      ⋮ メニュー：確認済み／不備／差し替え／過去の版／保存／削除。削除は確認モーダル。赤い削除ボタンを常時置かない
//      プレビューは画面内のモーダル（#pdf-preview-root）。書類専用ページ（hr/document.html）は直接開いて確かめる
//   5. 一覧の書類列：種類ごとのアイコン。未提出と登録済みが状態で分かる（未登録を登録済みに見せない）
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false,
  gw: { employee: { id: "emp-r1", display_name: "採用 花子", status: "active" }, roles: ["recruiter"], tenantId: "t1", stage: null },
  access: { recruit: true, sell: false } };

const PDF = Buffer.from("%PDF-1.4\n%%EOF");
const state = {
  applicant: {
    id: "a1", name: "山田 太郎", jobTitle: "エンジニア", source: "Wantedly", email: "yamada@example.com",
    stage: "casual_interview", status: "eval_pending", statusLabel: "カジュアル面談済み",
    nextAction: "面談評価を入力してください", nextActionCta: "評価を入力", nextActionKey: "evaluate",
    rank: null, recruiterName: "採用 花子", docs: { resume: false, workHistory: false },
  },
  interview: {
    id: "iv1", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談",
    scheduledAt: "2026-09-27T05:00:00Z", conductedAt: "2026-09-27T05:30:00Z", done: true, canceled: false,
    scores: {}, rank: null, recommendReason: null, notes: null,
  },
  docs: [],
};
const calls = [];
let detailFetches = 0;

function docsBody() {
  const TYPES = [["resume", "履歴書", "description"], ["work_history", "職務経歴書", "work_history"], ["other", "その他", "attach_file"]];
  return {
    applicant: { id: "a1", name: "山田 太郎" },
    documents: TYPES.map(([k, label, icon]) => {
      const list = state.docs.filter((d) => d.docType === k && !d.deleted).reverse();
      return { docType: k, label, icon, latest: list[0] || null, history: list.slice(1) };
    }),
    types: TYPES.map(([key, label]) => ({ key, label })),
    limits: { maxBytes: 10 * 1024 * 1024 },
  };
}

const page = await br.newPage({ viewport: { width: 1360, height: 900 }, timezoneId: "Asia/Tokyo" });
// プレビューは別タブ（window.open）で開くので、ログイン状態と API の差し替えはタブ全体（context）に掛ける
const ctxB = page.context();
await ctxB.addInitScript(() => {
  try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" })); } catch { /* sandbox付きiframe */ }
});
page.setDefaultTimeout(8000);
// 書類の表示用URL（画面内プレビューは https / blob だけを受け付ける。js/hr-modal-ui.js）
const FILES = "https://files.example.test";
// 本物の一覧 API と同じ形（そろい具合＋最新版の書類ID）
const syncDocs = () => {
  const latest = (t) => state.docs.filter((x) => x.docType === t && !x.deleted).at(-1) || null;
  state.applicant.docs = { resume: Boolean(latest("resume")), resumeId: latest("resume")?.id || null,
    workHistory: Boolean(latest("work_history")), workHistoryId: latest("work_history")?.id || null };
};
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("dialog", (d) => d.accept());
await ctxB.route("**/__upload/**", (route) => { calls.push({ put: route.request().headers()["content-type"] }); return route.fulfill({ status: 200, body: "{}" }); });
await ctxB.route("**/__file/**", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: PDF,
  headers: { "access-control-allow-origin": "*" } }));
let viewAs = ME;   // 別タブでの /api/me（権限の無い人で直接開くテスト用）
await ctxB.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
  const body = req.postData() ? JSON.parse(req.postData()) : {};
  if (/\/api\/me\b/.test(url)) return send(viewAs);
  if (/\/api\/hr\/documents/.test(url)) {
    if (req.method() === "POST") {
      calls.push(body);
      if (body.action === "upload") return send({ path: `t1/recruit/a1/x${calls.length}.pdf`, uploadUrl: `${BASE}/__upload/x` });
      const d = { id: `d${state.docs.length + 1}`, docType: body.docType, docTypeLabel: body.docType === "resume" ? "履歴書" : "職務経歴書",
        filename: body.filename, mimeType: "application/pdf", sizeBytes: 2048, uploadedAt: "2026-09-28T01:00:00Z", uploadedByName: "採用 花子" };
      state.docs.push(d);
      syncDocs();
      return send({ document: d });
    }
    if (req.method() === "DELETE") {
      const id = new URL(url).searchParams.get("id");
      calls.push({ delete: id });
      state.docs.find((d) => d.id === id).deleted = true;
      syncDocs();
      return send({ ok: true });
    }
    const id = new URL(url).searchParams.get("id");
    if (id) {
      calls.push({ fileUrl: id, applicantId: new URL(url).searchParams.get("applicantId"), download: /download=1/.test(url) });
      if (viewAs !== ME) return send({ error: "forbidden" }, 403);
      const d = state.docs.find((x) => x.id === id);
      return send({ url: `${FILES}/__file/${id}.pdf`, mimeType: "application/pdf", filename: d?.filename || "x.pdf",
        applicantId: "a1", applicantName: "山田 太郎", docType: d?.docType || "resume", docTypeLabel: d?.docTypeLabel || "履歴書" });
    }
    return send(docsBody());
  }
  if (/\/api\/hr\/interviews\b/.test(url) && req.method() !== "GET") {
    calls.push(body);
    state.interview.rank = body.rank; state.interview.scores = body.scores || {};
    state.applicant = { ...state.applicant, rank: body.rank, status: "ceo_recommend_pending", statusLabel: "社長推薦待ち",
      nextAction: "社長に会ってほしい候補です", nextActionCta: "社長推薦する", nextActionKey: "recommend" };
    return send({ interview: state.interview });
  }
  if (/\/api\/hr\/applicants\/detail/.test(url)) {
    detailFetches++;
    return send({
      applicant: state.applicant, interviews: [state.interview], interviewers: [], timeline: [
        { occurredAt: "2026-09-20T00:00:00Z", label: "応募" }, { occurredAt: "2026-09-27T05:30:00Z", label: "カジュアル面談を実施" }],
      offers: [], ranks: ["A", "B", "C", "D"], rankLabel: { A: "社長推薦", B: "追加確認", C: "保留", D: "見送り" },
      evalItems: [
        { key: "communication", label: "コミュニケーション" }, { key: "experience", label: "経験・スキル" },
        { key: "orientation", label: "志向性" }, { key: "culture_fit", label: "カルチャーフィット" },
        { key: "potential", label: "期待値／ポテンシャル" }],
      evalScale: [{ key: "great", label: "◎" }, { key: "good", label: "○" }, { key: "fair", label: "△" }, { key: "bad", label: "×" }],
      interviewKinds: [],
    });
  }
  if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [state.applicant], employees: [] });
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  return send({});
});

await page.goto(`${BASE}/hr/applicants.html`);
await page.waitForTimeout(900);

// アイコン（Material Symbols の名前）を除いた文字
const plain = (loc) => loc.evaluateAll((els) => els.map((e) => {
  const c = e.cloneNode(true); c.querySelectorAll(".material-symbols-outlined").forEach((x) => x.remove()); return c.textContent.trim();
}));
const listDoc = (kind) => page.locator(`#rows [data-doc-kind="${kind}"]`);
const fileRow = (kind) => page.locator(`#hr-detail-tab .hr-file-row[data-doc="${kind}"]`);
const workModal = page.locator("#hr-detail-box.hr-work-modal");

console.log("— 一覧：書類のそろい具合 —");
{
  // 書類列は、種類ごとのアイコンを常に出し、状態で分ける形になった（旧：未登録は何も出さない）。
  // 守ることは同じ：未登録の書類を、登録済みに見せない
  check(await listDoc("resume").evaluate((b) => b.classList.contains("missing")) && await listDoc("work_history").evaluate((b) => b.classList.contains("missing")),
    "未登録なら「未提出」の状態で出す（登録済みに見せない）");
  check(await listDoc("resume").getAttribute("title") === "履歴書：未提出" && await page.locator("#rows .hr-doc-state.pending, #rows .hr-doc-state.done").count() === 0,
    "登録済み（確認待ち・確認済み）の印は1つも出さない");
}

console.log("\n— 行を押すと対応モーダル1枚。応募者詳細のタブは4つ —");
await page.locator("#rows tr.click .hr-nm").first().click();
await workModal.locator("#hr-work-primary").waitFor();
{
  // 行クリックで開くのは右ドロワーではなく対応モーダル。主ボタンは1つ
  check(await workModal.count() === 1 && await page.locator(".hr-detail").count() === 0, "対応モーダルが開く（詳細は重ねない）");
  check(await workModal.locator(".hr-work-primary").count() === 1 && (await page.locator("#hr-work-primary").innerText()).includes("評価を入力"),
    "対応モーダルの主ボタンは「評価を入力」1つ");
  check((await page.locator(".hr-work-task").innerText()).includes("評価を記録してください"), "次にすること：評価を記録");
  check((await page.locator(".hr-work-state b").innerText()).trim().length > 0, "いまの状態が出る");

  // 応募者詳細は「応募者情報」から
  await page.locator("#hr-work-link-info").click();
  await page.locator(".hr-detail #hr-detail-next").waitFor();
  check(await page.locator(".hr-detail").count() === 1 && await page.locator(".hr-work-modal").count() === 0, "応募者詳細が1枚で開く");
  const tabs = await plain(page.locator('.hr-detail-tabs [role="tab"]'));
  check(tabs.join("/") === "応募者情報/面談・評価/書類・契約/連絡・履歴", `タブ（いま ${tabs.join("/")}）`);
  const ov = await page.locator("#hr-detail-tab").innerText();
  // 概要は値のある項目だけ（空欄は［詳細を表示］の中。応募者ドロワー改善 §6）。メールは未登録でも出す（送信に直結）
  for (const x of ["応募経路", "応募職種", "担当", "メール", "詳細を表示"]) {
    check(ov.includes(x), `概要に「${x}」`);
  }
  check((await page.locator("#hr-detail-next").innerText()).includes("面談評価を入力してください"), "NEXT ACTION に「面談評価を入力してください」");
  check(await page.locator("#hr-status").isVisible(), "いまの状態が出る");
  await page.locator("#hr-more-info summary").click();
  const more = await page.locator("#hr-more-info").innerText();
  check(["選考段階"].every((x) => more.includes(x)), "［詳細を表示］で、ほかの項目（選考段階など）も見られる");
  await page.locator("#hr-more-info summary").click();
  // NEXT ACTION（#hr-detail-next）は応募者情報タブの中に入った。主のボタンはその中の1つだけ
  check(await page.locator("#hr-detail-next .btn-primary").count() === 1 && await page.locator("#hr-detail-tab .btn-primary").count() === 1, "主のボタン（CTA）は NEXT ACTION の1つだけ");
  check(ov.includes("履歴書・職務経歴書が未登録です"), "未登録の案内（控えめ）");
  await page.locator("#hr-dr-person button", { hasText: "閉じる" }).click();
}

console.log("\n— 評価の入力は中央モーダル（モーダルは同時に1枚） —");
await page.locator("#rows tr.click .hr-list-cta").first().click();
await workModal.locator("#hr-work-primary").waitFor();
await page.locator("#hr-work-primary").click();
await page.locator("#ev-rank").waitFor();
{
  check(await page.locator(".hr-drawer").count() === 0, "右ドロワーを重ねない");
  const m = page.locator("#action-root .hr-modal");
  check(await m.isVisible(), "評価は中央モーダル");
  // モーダルは同時に1枚だけ見える（js/hr-modal-ui.js）。評価の間、下の対応モーダルは隠れる
  check(await page.locator("#modal-root").evaluate((n) => n.hidden) && !(await workModal.isVisible()), "評価の間、下の対応モーダルは見せない（1枚だけ）");
  const box = await m.boundingBox();
  const vw = 1360, vh = 900;
  check(box.width >= 600 && box.width <= 720, `幅 600〜720px（いま ${Math.round(box.width)}）`);
  check(Math.abs(box.x + box.width / 2 - vw / 2) < 4, "画面の中央");
  check(box.height <= vh * 0.9 + 1, `高さは画面の9割まで（いま ${Math.round(box.height)} / ${vh}）`);
  const scrolls = await m.evaluate((n) => getComputedStyle(n).overflowY);
  check(scrolls === "auto", "中だけスクロールする");
  const text = await m.innerText();
  for (const x of ["コミュニケーション", "経験・スキル", "志向性", "カルチャーフィット", "期待値／ポテンシャル", "ランク",
    "良かった点・推薦理由", "気になる点・次に確認したいこと", "次回確認事項の期限"]) {
    check(text.includes(x), `項目「${x}」`);
  }
  await page.screenshot({ path: shotPath("hr-eval-modal.png") });

  // 背景を押すと、評価モーダルだけ閉じる
  await page.mouse.click(40, 450);
  await page.waitForTimeout(200);
  check(await page.locator("#action-root .hr-modal").count() === 0, "背景クリックで評価モーダルだけ閉じる");
  check(await workModal.isVisible(), "対応モーダルは残る");

  // 保存 → モーダルを閉じ、開いたままの対応モーダルへ反映
  await page.locator("#hr-work-primary").click();
  await page.locator("#ev-rank").waitFor();
  await page.locator('#action-root input[name="ev-communication"][value="great"]').check();
  await page.selectOption("#ev-rank", "A");
  const before = detailFetches;
  await page.locator("#action-root .hr-modal button", { hasText: "保存する" }).click();
  await page.locator("#hr-work-primary", { hasText: "社長推薦する" }).waitFor();
  check(calls.some((c) => c.rank === "A" && c.scores?.communication === "great"), "評価を保存（既存の API のまま）");
  check(await page.locator("#action-root .hr-modal").count() === 0, "保存後にモーダルを閉じる");
  check(await workModal.isVisible(), "保存後も対応モーダルは開いたまま");
  check(detailFetches > before, "応募者詳細を取り直す");
  check((await page.locator("#hr-work-primary").innerText()).includes("社長推薦する") && (await page.locator(".hr-work-state b").innerText()).includes("社長推薦待ち"),
    "対応モーダルに反映（次にすることが進む）");
  await page.locator("#hr-work-link-info").click();
  await page.locator(".hr-detail .hr-next").waitFor();
  check((await page.locator(".hr-next").innerText()).includes("社長に会ってほしい候補です"), "応募者詳細にも反映（NEXT ACTION が進む）");
  check((await page.locator("#hr-detail-tab").innerText()).includes("カジュアル面談：A"), "最新評価に反映");
}

console.log("\n— 書類・契約タブ：未登録 → アップロード —");
await page.locator("#hr-tab-docs").click();
await page.waitForTimeout(300);
{
  const t = await page.locator("#hr-detail-tab").innerText();
  check(t.includes("履歴書") && t.includes("職務経歴書") && !/経歴書/.test(t.replace(/職務経歴書/g, "")), "「職務経歴書」の表記で出す");
  check((await fileRow("resume").innerText()).includes("未提出") && await fileRow("resume").getAttribute("data-state") === "missing", "履歴書：未提出");
  check(await fileRow("resume").locator("button", { hasText: "ファイルを選ぶ" }).count() === 1, "履歴書：ファイルを選ぶ（アップロード）");
  check(await page.locator("#hr-detail-tab .danger:visible").count() === 0, "赤い削除ボタンを常に置かない");

  await fileRow("resume").locator("button", { hasText: "ファイルを選ぶ" }).click();
  await page.waitForTimeout(200);
  const m = page.locator("#action-root .hr-modal");
  const mt = await m.innerText();
  check(mt.includes("山田 太郎さん"), "応募者名を上に出す");
  check(["履歴書", "職務経歴書", "その他"].every((x) => mt.includes(x)), "種類：履歴書・職務経歴書・その他");
  check(await page.locator('#action-root input[name="doc-type"][value="resume"]').isChecked(), "押した種類が選ばれている");
  check(mt.includes("ドラッグ"), "ドラッグ&ドロップの案内");
  check((await page.locator("#doc-file").getAttribute("accept")) === ".pdf,.doc,.docx,.jpg,.jpeg,.png", "対応形式");

  // 形式違い・大きすぎは、置く前に止める
  await page.setInputFiles("#doc-file", { name: "a.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  check((await page.locator("#doc-msg").innerText()).includes("PDF"), "GIF は止める");
  await page.setInputFiles("#doc-file", { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  check((await page.locator("#doc-msg").innerText()).includes("10MB"), "10MB 超は止める");

  // ドラッグ&ドロップで選ぶ
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4"], "山田太郎_履歴書.pdf", { type: "application/pdf" }));
    document.getElementById("doc-drop").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  });
  check((await page.locator("#doc-drop-text").innerText()).includes("山田太郎_履歴書.pdf"), "ドロップしたファイルが選ばれる");
  await page.screenshot({ path: shotPath("hr-doc-upload.png") });
  await page.locator("#doc-save").click();
  await page.waitForTimeout(700);
  check(calls.some((c) => c.action === "upload" && c.docType === "resume" && c.mimeType === "application/pdf"), "置き場所をもらう");
  check(calls.some((c) => c.put === "application/pdf"), "PUT で置く");
  check(calls.some((c) => c.action === "attach" && c.filename === "山田太郎_履歴書.pdf"), "登録する");
  check(await page.locator("#action-root .hr-modal").count() === 0, "モーダルを閉じる");
  check(await page.locator(".hr-detail").isVisible() && await page.locator("#hr-tab-docs").getAttribute("aria-selected") === "true", "応募者詳細は開いたまま（書類・契約タブ）");
  const r = await fileRow("resume").innerText();
  check(r.includes("山田太郎_履歴書.pdf") && r.includes("登録") && r.includes("確認待ち"), "書類タブへすぐ反映（ファイル名・登録日・確認待ち）");
  check((await page.locator("#hr-detail-tab .hr-document-feedback").innerText()).includes("山田太郎_履歴書.pdf を登録しました"), "登録したことを知らせる");
  check(await fileRow("resume").locator("button", { hasText: "PDFを見る" }).count() === 1
    && await fileRow("resume").locator(".hr-menu-pop button", { hasText: "ファイルを差し替える" }).count() === 1, "［PDFを見る］と、メニューに［ファイルを差し替える］");
  check(await listDoc("resume").evaluate((b) => b.classList.contains("pending")) && await listDoc("resume").getAttribute("title") === "履歴書：確認待ち",
    "一覧の書類列で履歴書が登録済み（確認待ち）になる");
  check(await listDoc("work_history").evaluate((b) => b.classList.contains("missing")), "職務経歴書は未登録なので未提出のまま");
}

console.log("\n— ⋮ メニュー・プレビュー・削除の確認 —");
{
  const more = fileRow("resume").locator(".hr-file-more");
  check(await more.getAttribute("aria-label") === "履歴書のその他の操作", "メニューのボタンに名前がある");
  await more.click();
  const items = (await fileRow("resume").locator(".hr-menu-pop:not(.hidden) button").allInnerTexts()).map((s) => s.trim());
  // メニューは、確認（確認済み・不備）が加わり、プレビューは行のボタン（PDFを見る）へ出た
  check(items.join("/") === "確認済みにする/不備を記録する/ファイルを差し替える/過去の版を見る/ファイルを保存する/削除する", `メニュー（いま ${items.join("/")}）`);
  check(await more.getAttribute("aria-expanded") === "true", "開いていることが分かる（aria-expanded）");
  await page.screenshot({ path: shotPath("hr-doc-menu.png") });
  await fileRow("resume").locator(".hr-menu-pop button.danger").click();
  await page.waitForTimeout(200);
  check(await page.locator("#confirm-root .hr-modal").isVisible(), "削除は確認モーダルを挟む");
  check(!calls.some((c) => c.delete), "確認するまで消さない");
  await page.locator("#confirm-root button", { hasText: "やめる" }).click();
  check(!calls.some((c) => c.delete), "やめると消えない");
  await more.click();
  await fileRow("resume").locator(".hr-menu-pop button.danger").click();
  await page.locator("#confirm-root button", { hasText: "削除する" }).click();
  await page.waitForTimeout(700);
  check(calls.some((c) => c.delete === "d1"), "確認後に削除");
  check((await fileRow("resume").innerText()).includes("未提出"), "削除が書類タブに反映");
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細は開いたまま");

  // プレビューは別タブではなく、画面内のモーダル（#pdf-preview-root）。応募者IDつきで表示用URLを取り直す
  await fileRow("work_history").locator("button", { hasText: "ファイルを選ぶ" }).click();
  await page.setInputFiles("#doc-file", { name: "山田太郎_職務経歴書.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.locator("#doc-save").click();
  await page.waitForTimeout(700);
  const wh = state.docs.filter((d) => d.docType === "work_history").pop();
  const before = { status: state.applicant.statusLabel, pages: ctxB.pages().length };
  await fileRow("work_history").locator("button", { hasText: "PDFを見る" }).click();
  const viewer = page.locator("#pdf-preview-root .hr-pdf-modal");
  await viewer.waitFor();
  check(calls.some((c) => c.fileUrl === wh.id && c.applicantId === "a1" && !c.download), "応募者IDつきで表示用URLを取り直す");
  check((await viewer.locator("iframe.hr-pdf-viewer").getAttribute("src") || "").startsWith(`${FILES}/__file/${wh.id}.pdf`), "その書類のPDFを画面内のプレビューで開く");
  check((await viewer.locator("h2").innerText()).includes("山田太郎_職務経歴書.pdf") && await viewer.locator("a[download]", { hasText: "PDFを保存する" }).count() === 1,
    "プレビュー：ファイル名・PDFを保存する");
  check(ctxB.pages().length === before.pages, "別タブは開かない");
  check(!(await page.locator(".hr-detail").isVisible()), "プレビューの間、下の応募者詳細は見せない（1枚だけ）");
  await viewer.locator("button", { hasText: "戻る" }).click();
  check(await page.locator("#pdf-preview-root .hr-pdf-modal").count() === 0 && await page.locator(".hr-detail").isVisible(), "戻ると応募者詳細は閉じていない");
  check(await page.locator("#hr-tab-docs").getAttribute("aria-selected") === "true", "書類・契約タブのまま");
  check(state.applicant.statusLabel === before.status, "選考ステータスは変わらない");

  // 書類専用ページ（hr/document.html）。応募者画面からは開かなくなったので、URL を直接開いて確かめる
  const [tab] = await Promise.all([ctxB.waitForEvent("page"),
    page.evaluate((u) => { window.open(u, "_blank"); }, `${BASE}/hr/document.html?applicant=a1&doc=${wh.id}`)]);
  await tab.waitForLoadState();
  await tab.waitForTimeout(900);
  const head = await tab.locator("#dp-head").innerText();
  check(head.includes("山田 太郎") && head.includes("職務経歴書") && head.includes("ダウンロード"), "書類ページ：氏名・書類の種類・ダウンロード");
  check((await tab.locator(".hr-logo").innerText()).includes("HR"), "書類ページ：EIGHT / HR の帯");
  const frame = await tab.locator("#dp-frame").boundingBox();
  check(frame && frame.width >= 1300 && frame.height >= 600, `PDF を画面いっぱいに（${Math.round(frame?.width)}×${Math.round(frame?.height)}）`);
  const frameUrl = await tab.locator("#dp-frame").getAttribute("src") || "";
  check(frameUrl.startsWith("blob:"), "署名URLを画面に直結せず、認証済みのPDFを一時blob URLで表示");
  check((await tab.locator("#dp-direct").getAttribute("href") || "").startsWith("blob:"),
    "別タブで開くも表示できたPDFを使う");
  check(calls.filter((c) => c.fileUrl === wh.id && c.applicantId === "a1").length >= 2, "書類ページ側でも応募者IDつきで URL を取り直す");
  await tab.screenshot({ path: shotPath("hr-doc-preview.png") });
  await tab.close();

  // 権限の無い人が URL を直接開いても見られない
  viewAs = { ...ME, gw: { ...ME.gw, roles: ["sales"] }, access: { recruit: false, sell: true } };
  const fetchedBefore = calls.filter((c) => c.fileUrl).length;
  const [intruder] = await Promise.all([ctxB.waitForEvent("page"),
    page.evaluate((u) => { window.open(u, "_blank"); }, `${BASE}/hr/document.html?applicant=a1&doc=${wh.id}`)]);
  await intruder.waitForTimeout(1200);
  check(!/\/hr\/document\.html/.test(new URL(intruder.url()).pathname), `権限の無い人は入れない（${new URL(intruder.url()).pathname} へ）`);
  check(calls.filter((c) => c.fileUrl).length === fetchedBefore, "権限の無い人には signed URL を取りに行かない");
  await intruder.close();
  viewAs = ME;
}

console.log("\n— 連絡・履歴タブ —");
{
  // 履歴タブは「連絡・履歴」に統合された（選考・操作の履歴は折りたたみの中）
  await page.locator("#hr-tab-activity").click();
  await page.locator("#hr-detail-tab .hr-doc-fold summary").click();
  check((await page.locator("#hr-detail-tab .hr-tl").innerText()).includes("カジュアル面談を実施"), "選考タイムラインは連絡・履歴タブ");
}

console.log("\n— 一覧の書類アイコン：その種類の最新版を画面内で開く —");
{
  await page.locator("#hr-dr-person button", { hasText: "閉じる" }).click();
  const wh = state.docs.filter((d) => d.docType === "work_history").pop();
  check(await listDoc("work_history").evaluate((b) => b.classList.contains("pending")) && await listDoc("resume").evaluate((b) => b.classList.contains("missing")),
    "一覧：職務経歴書は登録済み・削除した履歴書は未提出に戻る");
  const n = calls.filter((c) => c.fileUrl === wh.id).length;
  await listDoc("work_history").click();
  await page.locator("#pdf-preview-root .hr-pdf-modal").waitFor();
  check(calls.filter((c) => c.fileUrl === wh.id && c.applicantId === "a1").length === n + 1, "アイコンは登録した書類（最新版）のプレビューを開く");
  check(await page.locator("#hr-detail-box").count() === 0, "アイコンでは対応モーダル・詳細を開かない");
  await page.locator("#pdf-preview-root button", { hasText: "閉じる" }).click();
}

check(!errs.length, `画面のエラーなし${errs.length ? `: ${errs.slice(0, 3).join(" / ")}` : ""}`);
await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
