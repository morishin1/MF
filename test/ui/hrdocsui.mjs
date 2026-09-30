// 採用HR：応募者詳細のドロワー・モーダル整理と、履歴書・職務経歴書のアップロードを、実際のブラウザで通す。
//
// ■ 何を守るテストか（HR 応募者詳細UI改善）
//   1. 応募者詳細は右ドロワー1枚。タブは 概要 / 面談 / 書類 / 履歴
//   2. 概要に NEXT ACTION と、CTA は1つ
//   3. 評価の入力は中央モーダル（600〜720px・中だけスクロール）。右ドロワーを2枚重ねない
//      背景を押すと評価モーダルだけ閉じ、応募者詳細は残る。保存後もドロワーは開いたまま反映
//   4. 書類タブ：履歴書・職務経歴書。未登録なら「未登録」「アップロード」
//      アップロードは中央モーダル（応募者名・種類・ドラッグ&ドロップ）。登録後すぐ反映
//      … メニュー：プレビュー／ダウンロード／差し替え／履歴を見る／削除。削除は確認モーダル。赤い削除ボタンを常時置かない
//   5. 一覧に「履歴書 ✓ 職務経歴書 —」が小さく出る
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
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
});
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("dialog", (d) => d.accept());
await ctxB.route("**/__upload/**", (route) => { calls.push({ put: route.request().headers()["content-type"] }); return route.fulfill({ status: 200, body: "{}" }); });
await ctxB.route("**/__file/**", (route) => route.fulfill({ status: 200, contentType: "application/pdf", body: PDF }));
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
      state.applicant.docs = { resume: state.docs.some((x) => x.docType === "resume" && !x.deleted),
        workHistory: state.docs.some((x) => x.docType === "work_history" && !x.deleted) };
      return send({ document: d });
    }
    if (req.method() === "DELETE") {
      const id = new URL(url).searchParams.get("id");
      calls.push({ delete: id });
      state.docs.find((d) => d.id === id).deleted = true;
      return send({ ok: true });
    }
    const id = new URL(url).searchParams.get("id");
    if (id) {
      calls.push({ fileUrl: id, applicantId: new URL(url).searchParams.get("applicantId"), download: /download=1/.test(url) });
      if (viewAs !== ME) return send({ error: "forbidden" }, 403);
      const d = state.docs.find((x) => x.id === id);
      return send({ url: `${BASE}/__file/${id}.pdf`, mimeType: "application/pdf", filename: d?.filename || "x.pdf",
        applicantId: "a1", applicantName: "山田 太郎", docType: d?.docType || "resume", docTypeLabel: d?.docTypeLabel || "履歴書" });
    }
    return send(docsBody());
  }
  if (/\/api\/hr\/interviews\b/.test(url)) {
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

console.log("— 一覧：書類のそろい具合 —");
{
  const t = await page.locator("#rows [data-docs]").first().innerText();
  check(t.includes("履歴書 —") && t.includes("職務経歴書 —"), `未登録が小さく出る（いま ${t}）`);
}

console.log("\n— 応募者詳細は右ドロワー1枚・タブは4つ —");
await page.locator("#rows tr.click").first().click();
await page.waitForTimeout(700);
{
  check(await page.locator(".hr-detail").count() === 1, "応募者詳細ドロワーが開く");
  const tabs = (await page.locator(".hr-tabs button").allInnerTexts()).map((s) => s.trim());
  check(tabs.join("/") === "概要/面談/書類/履歴", `タブ（いま ${tabs.join("/")}）`);
  const ov = await page.locator("#hr-detail-tab").innerText();
  for (const x of ["NEXT ACTION", "面談評価を入力してください", "応募経路", "応募職種", "現在ステータス", "担当", "メール", "最新評価", "ランク"]) {
    check(ov.includes(x), `概要に「${x}」`);
  }
  check(await page.locator("#hr-detail-tab .btn-primary").count() === 1, "概要の CTA は1つ");
  check(ov.includes("履歴書・職務経歴書が未登録です"), "未登録の案内（控えめ）");
}

console.log("\n— 評価の入力は中央モーダル（2枚目のドロワーを出さない） —");
await page.locator(".hr-next button", { hasText: "評価を入力" }).click();
await page.waitForTimeout(300);
{
  check(await page.locator(".hr-drawer").count() === 0, "右ドロワーを重ねない");
  const m = page.locator("#action-root .hr-modal");
  check(await m.isVisible(), "評価は中央モーダル");
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
  check(await page.locator(".hr-detail").isVisible(), "応募者詳細ドロワーは残る");

  // 保存 → モーダルを閉じ、開いたままのドロワーへ反映
  await page.locator(".hr-next button", { hasText: "評価を入力" }).click();
  await page.waitForTimeout(200);
  await page.locator('#action-root input[name="ev-communication"][value="great"]').check();
  await page.selectOption("#ev-rank", "A");
  const before = detailFetches;
  await page.locator("#action-root .hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(700);
  check(calls.some((c) => c.rank === "A"), "評価を保存（既存の API のまま）");
  check(await page.locator("#action-root .hr-modal").count() === 0, "保存後にモーダルを閉じる");
  check(await page.locator(".hr-detail").isVisible(), "保存後もドロワーは開いたまま");
  check(detailFetches > before, "応募者詳細を取り直す");
  check((await page.locator(".hr-next").innerText()).includes("社長に会ってほしい候補です"), "ドロワーに反映（NEXT ACTION が進む）");
  check((await page.locator("#hr-detail-tab").innerText()).includes("カジュアル面談：A"), "最新評価に反映");
}

console.log("\n— 書類タブ：未登録 → アップロード —");
await page.locator('.hr-tabs button[data-tab="docs"]').click();
await page.waitForTimeout(300);
{
  const t = await page.locator("#hr-detail-tab").innerText();
  check(t.includes("履歴書") && t.includes("職務経歴書") && !/経歴書/.test(t.replace(/職務経歴書/g, "")), "「職務経歴書」の表記で出す");
  check((await page.locator('.hr-doc[data-doc="resume"]').innerText()).includes("未登録"), "履歴書：未登録");
  check(await page.locator('.hr-doc[data-doc="resume"] button', { hasText: "アップロード" }).count() === 1, "履歴書：アップロード");
  check(await page.locator("#hr-detail-tab .danger:visible").count() === 0, "赤い削除ボタンを常に置かない");

  await page.locator('.hr-doc[data-doc="resume"] button', { hasText: "アップロード" }).click();
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
  check(await page.locator(".hr-detail").isVisible(), "ドロワーは開いたまま");
  const r = await page.locator('.hr-doc[data-doc="resume"]').innerText();
  check(r.includes("山田太郎_履歴書.pdf") && r.includes("アップロード"), "書類タブへすぐ反映（ファイル名・日付）");
  check(await page.locator('.hr-doc[data-doc="resume"] button', { hasText: "プレビュー" }).count() >= 1
    && await page.locator('.hr-doc[data-doc="resume"] button', { hasText: "差し替え" }).count() >= 1, "［プレビュー］［差し替え］");
  const listDocs = await page.locator("#rows [data-docs]").first().innerText();
  check(listDocs.includes("履歴書 ✓"), "一覧も「履歴書 ✓」に変わる");
}

console.log("\n— … メニュー・プレビュー・削除の確認 —");
{
  await page.locator('.hr-doc[data-doc="resume"] button[aria-label="その他の操作"]').click();
  const items = (await page.locator('.hr-doc[data-doc="resume"] .hr-menu-pop:not(.hidden) button').allInnerTexts()).map((s) => s.trim());
  check(items.join("/") === "プレビュー/ダウンロード/差し替え/履歴を見る/削除", `メニュー（いま ${items.join("/")}）`);
  await page.screenshot({ path: shotPath("hr-doc-menu.png") });
  await page.locator('.hr-doc[data-doc="resume"] .hr-menu-pop button', { hasText: "削除" }).click();
  await page.waitForTimeout(200);
  check(await page.locator("#confirm-root .hr-modal").isVisible(), "削除は確認モーダルを挟む");
  check(!calls.some((c) => c.delete), "確認するまで消さない");
  await page.locator("#confirm-root button", { hasText: "やめる" }).click();
  check(!calls.some((c) => c.delete), "やめると消えない");
  await page.locator('.hr-doc[data-doc="resume"] button[aria-label="その他の操作"]').click();
  await page.locator('.hr-doc[data-doc="resume"] .hr-menu-pop button', { hasText: "削除" }).click();
  await page.locator("#confirm-root button", { hasText: "削除する" }).click();
  await page.waitForTimeout(700);
  check(calls.some((c) => c.delete === "d1"), "確認後に削除");
  check((await page.locator('.hr-doc[data-doc="resume"]').innerText()).includes("未登録"), "削除が書類タブに反映");
  check(await page.locator(".hr-detail").isVisible(), "ドロワーは開いたまま");

  // プレビューは別タブの書類専用ページ。この画面には PDF を出さない
  await page.locator('.hr-doc[data-doc="work_history"] button', { hasText: "アップロード" }).click();
  await page.setInputFiles("#doc-file", { name: "山田太郎_職務経歴書.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.locator("#doc-save").click();
  await page.waitForTimeout(700);
  const wh = state.docs.filter((d) => d.docType === "work_history").pop();
  await page.evaluate(() => { window.scrollTo(0, 0); });
  const before = { tab: await page.locator(".hr-tabs button.on").innerText(), status: state.applicant.statusLabel };
  const [tab] = await Promise.all([
    ctxB.waitForEvent("page"),
    page.locator('.hr-doc[data-doc="work_history"] button', { hasText: "プレビュー" }).first().click(),
  ]);
  await tab.waitForLoadState();
  await tab.waitForTimeout(900);
  check(new URL(tab.url()).pathname === "/hr/document.html"
    && new URL(tab.url()).searchParams.get("doc") === wh.id && new URL(tab.url()).searchParams.get("applicant") === "a1",
    `別タブで書類プレビューを開く（${new URL(tab.url()).pathname}?applicant=…&doc=…）`);
  check(await page.locator(".kp-viewer, .kp-viewer-frame, iframe").count() === 0, "元の画面には PDF ビューア・iframe を出さない");
  check(await page.locator(".hr-detail").isVisible(), "応募者ドロワーは閉じない");
  check((await page.locator(".hr-tabs button.on").innerText()) === before.tab, "書類タブのまま");
  check(state.applicant.statusLabel === before.status, "選考ステータスは変わらない");
  const head = await tab.locator("#dp-head").innerText();
  check(head.includes("山田 太郎") && head.includes("職務経歴書") && head.includes("ダウンロード"), "プレビュー：氏名・書類の種類・ダウンロード");
  check((await tab.locator(".hr-logo").innerText()).includes("HR"), "プレビュー：EIGHT / HR の帯");
  const frame = await tab.locator("#dp-frame").boundingBox();
  check(frame && frame.width >= 1300 && frame.height >= 600, `PDF を画面いっぱいに（${Math.round(frame?.width)}×${Math.round(frame?.height)}）`);
  check((await tab.locator("#dp-frame").getAttribute("src")).includes("__file"), "短時間の signed URL で表示");
  check(calls.some((c) => c.fileUrl === wh.id && c.applicantId === "a1"), "別タブ側で応募者IDつきで URL を取り直す");
  await tab.screenshot({ path: shotPath("hr-doc-preview.png") });
  await tab.close();

  // 履歴書でも同じ
  const rs = state.docs.filter((d) => d.docType === "resume" && !d.deleted).pop();
  if (rs) {
    const [tab2] = await Promise.all([ctxB.waitForEvent("page"),
      page.locator('.hr-doc[data-doc="resume"] button', { hasText: "プレビュー" }).first().click()]);
    await tab2.waitForLoadState();
    await tab2.waitForTimeout(700);
    check((await tab2.locator("#dp-head").innerText()).includes("履歴書"), "履歴書も別タブで開く");
    await tab2.close();
  }

  // 権限の無い人が URL を直接開いても見られない
  viewAs = { ...ME, gw: { ...ME.gw, roles: ["sales"] }, access: { recruit: false, sell: true } };
  const fetchedBefore = calls.filter((c) => c.fileUrl).length;
  const [intruder] = await Promise.all([ctxB.waitForEvent("page"),
    page.evaluate((u) => window.open(u, "_blank"), `${BASE}/hr/document.html?applicant=a1&doc=${wh.id}`)]);
  await intruder.waitForTimeout(1200);
  check(!/\/hr\/document\.html/.test(new URL(intruder.url()).pathname), `権限の無い人は入れない（${new URL(intruder.url()).pathname} へ）`);
  check(calls.filter((c) => c.fileUrl).length === fetchedBefore, "権限の無い人には signed URL を取りに行かない");
  await intruder.close();
  viewAs = ME;
}

console.log("\n— 履歴タブ —");
{
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator('.hr-tabs button[data-tab="history"]').click();
  check((await page.locator("#hr-detail-tab").innerText()).includes("カジュアル面談を実施"), "選考タイムラインは履歴タブ");
}

check(!errs.length, `画面のエラーなし${errs.length ? `: ${errs.slice(0, 3).join(" / ")}` : ""}`);
await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
