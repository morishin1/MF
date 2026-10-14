// 採用HR：応募者ドロワー（短く）・メールのその場登録／編集・条件通知書PDF・電子承諾・LegalSign を、実際のブラウザで通す。
//
// ■ 何を守るテストか（応募者ドロワー・条件通知書PDF・電子承諾・LegalSign 連携・メール編集 UI/UX 改善仕様 §48）
//   ドロワー … NEXT ACTION の枠が短い・主のボタンは1つ・空欄は出さない（［詳細を表示］）・社長面談の評価は1行・
//              PC 620〜720px・390px はフル幅1列で横にはみ出さない
//   メール   … ドロワーで登録・編集（その場で。モーダルを開かない）・形の確認（その場で出す）・保存してもドロワーは閉じない
//              送信画面で未登録なら「登録して続ける」・送信先の確認と［変更］・変更後の送信先が最新
//   条件通知書 … 入力 →［PDFをプレビュー］→ プレビュー画面（PC は画面内に PDF・スマホは［PDFを開く］）→［条件を修正］で直して再プレビュー →
//              ［この内容で本人へ送る］・HR のオファーに条件通知書PDF／承諾済みPDF
//   HR       … 条件承諾済み → 正式契約（LegalSign）：URL 登録（https:// だけ）→ 本人へ案内 → 正式契約済みにする
//   本人     … ［条件通知書PDFを保存］・同意のチェックが無ければ［条件を承諾する］を押せない・承諾後の案内・
//              承諾済みPDF・［LegalSignで正式契約を行う］（https:// のときだけ）
//
// 応答は lib/hr.js・lib/hr-offer-types.js・lib/hr-offer-docs.js の本物の関数で組み立てる（文言をテスト側で作らない）
import { launch, BASE } from "../_browser.mjs";
import { shapeApplicant, shapePublicOffer, shapeOffer, normalizeApplicant } from "../../lib/hr.js";
import { OFFER_TYPES_PUBLIC, publicOfferItems, offerMail, OFFER_URL_TAG, acceptFactsOf, formalRequiredOf } from "../../lib/hr-offer-types.js";
import { checkLegalSignUrl, noticeTitleOf } from "../../lib/hr-offer-docs.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const PDF = Buffer.from("%PDF-1.7\n% test\n");

const OWNER_ME = { email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "e-owner", display_name: "社長 一郎" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };
const DOC_NULLS = { notice_title: null, notice_pdf_path: null, notice_pdf_sha256: null, accept_name: null, accept_email: null, accept_ip: null,
  accept_ua: null, accept_text: null, accepted_pdf_path: null, accepted_pdf_sha256: null, legalsign_url: null,
  formal_sent_at: null, formal_sent_by: null, formal_signed_at: null, formal_signed_by: null };

function makeState(over = {}, offers = []) {
  return {
    row: {
      id: "a1", tenant_id: "t1", name: "テスト 候補者", email: null, job_title: "カスタマーサクセス", source: "Wantedly",
      stage: "ceo_interview", status: "ceo_decision_pending", rank: "B", decision: null, lead_category: "recruitment",
      employment_type: null, wage_type: null, wage_amount: null, work_location: null, phone: null, join_date: null, offer_type: null, ...over,
    },
    offers, calls: [], mailConfigured: true,
    interviews: [{ id: "i1", kind: "ceo", done: true, canceled: false, rank: "B", scores: { personality: "good" }, notes: "前向き", scheduledAt: "2026-10-08T05:00:00Z" }],
  };
}
const formalOf = (st) => { const o = st.offers.find((x) => x.accepted_at); return o?.formal_signed_at ? "signed" : o?.formal_sent_at ? "sent" : null; };

async function open(st, { width = 1300 } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" })));
  const errs = [];
  const shaped = () => ({ ...shapeApplicant({ ...st.row, ...acceptFactsOf(st.offers.find((x) => x.accepted_at)), formal_state: formalOf(st) }),
    recruiterName: "採用 花子", contact: { state: "none" } });
  await ctx.route("**/api/**", (route) => {
    const req = route.request(), url = req.url(), m = req.method();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (m === "PATCH") {
        const b = body(); st.calls.push(["applicant", b]);
        const r = normalizeApplicant(b, { partial: true });
        if (r.error) return send(r, 400);
        Object.assign(st.row, r.value);
        return send({ applicant: shaped() });
      }
      return send({
        applicant: shaped(), interviews: st.interviews, interviewers: [], offers: st.offers.map((o) => ({ ...shapeOffer(o), handoffByName: o.handoff_by ? "社長 一郎" : null })), timeline: [],
        evalItems: [{ key: "personality", label: "人柄" }], evalScale: [{ key: "good", label: "良い" }], ranks: [], rankLabel: { B: "標準" },
        interviewKinds: [], statusOptions: [], offerTypes: OFFER_TYPES_PUBLIC, offerTypeReady: true, salaryVisible: true,
      });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [shaped()], employees: [] });
    if (/\/api\/hr\/offers\b/.test(url)) {
      const q = new URL(url).searchParams;
      const o = st.offers[0];
      if (m === "GET" && q.get("file")) {
        st.calls.push(["file", q.get("file")]);
        return route.fulfill({ status: 200, contentType: "application/pdf", body: PDF,
          headers: { "content-disposition": `attachment; filename="offer.pdf"; filename*=UTF-8''${encodeURIComponent("育成参加条件通知書_第1版.pdf")}` } });
      }
      if (m === "GET") {
        const title = noticeTitleOf(o);
        const mail = offerMail(o, { name: st.row.name, company: "株式会社エイト", attachment: title });
        return send({ offer: shapeOffer(o), items: publicOfferItems(o), to: st.row.email, candidateName: st.row.name,
          subject: mail.subject, body: mail.body, urlTag: OFFER_URL_TAG,
          mail: { configured: Boolean(st.row.email) && st.mailConfigured, reason: st.row.email ? null : "候補者のメールアドレスが登録されていません" },
          canSend: true, notice: { ready: true, title, stored: false, salaryVisible: true }, formalRequired: formalRequiredOf(o) });
      }
      const b = body(); st.calls.push([b.action, b]);
      if (b.action === "setLegalSign") {
        const c = checkLegalSignUrl(b.url);
        if (c.error) return send({ error: "invalid_body", hint: c.error }, 400);
        o.legalsign_url = c.url; return send({ offer: shapeOffer(o) });
      }
      if (b.action === "sendFormal" && b.preview) {
        return send({ subject: "【株式会社エイト】正式なご契約のお手続きのご案内", body: "テスト 候補者 様\n\n［正式契約の手続きへ］\n{{正式契約URL}}", urlTag: "{{正式契約URL}}",
          to: st.row.email, mail: { configured: true } });
      }
      if (b.action === "sendFormal") { o.formal_sent_at = o.formal_sent_at || "2026-10-12T02:00:00Z"; return send({ status: "sent", channel: b.channel, offer: shapeOffer(o) }); }
      if (b.action === "markFormalSigned") { o.formal_signed_at = "2026-10-12T05:00:00Z"; return send({ offer: shapeOffer(o) }); }
      if (b.action === "handoff") { o.handoff_at = o.handoff_at || "2026-10-12T06:00:00Z"; o.handoff_by = "u-owner"; return send({ offer: shapeOffer(o) }); }
      if (b.action === "update" || b.action === undefined) {
        if (typeof b.formalContractRequired === "boolean" && !o.sent_at) o.formal_contract_required = b.formalContractRequired;
      }
      return send({ offer: shapeOffer(o) });
    }
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], types: [], limits: {} });
    return send({});
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1100);
  return { ctx, page, errs };
}
const drawerOverflow = (page) => page.evaluate(() => {
  const d = document.querySelector(".hr-detail");
  const r = Math.max(...[d, ...d.querySelectorAll("*")].map((e) => e.getBoundingClientRect().right));
  return Math.max(0, Math.round(r - innerWidth), d.scrollWidth - d.clientWidth);
});

for (const width of [1300, 768, 390]) {
  console.log(`\n=== ドロワー（${width}px）：短い NEXT ACTION・空欄を出さない・評価は1行・メールをその場で登録 ===`);
  const st = makeState();
  const { ctx, page, errs } = await open(st, { width });
  const dw = await page.locator(".hr-detail").evaluate((d) => d.getBoundingClientRect().width);
  if (width === 1300) check(dw >= 620 && dw <= 720, `PC のドロワーは 620〜720px（${Math.round(dw)}px）`);
  if (width === 390) check(Math.round(dw) === 390, `390px はフル幅（${Math.round(dw)}px）`);
  const card = page.locator(".hr-next");
  const h = (await card.boundingBox()).height;
  check(h <= 120, `[${width}] NEXT ACTION の枠は短い（${Math.round(h)}px）`);
  check(await card.locator(".btn-primary").count() === 1, `[${width}] 主のボタンは1つ`);
  const bg = await card.evaluate((n) => getComputedStyle(n).backgroundColor);
  check(bg !== "rgb(230, 240, 80)", `[${width}] 強い黄色ではない（${bg}）`);
  const basic = await page.locator("#hr-basic").innerText();
  check(basic.includes("Wantedly") && basic.includes("カスタマーサクセス") && basic.includes("採用 花子"), `[${width}] 値のある項目（応募経路・応募職種・担当）`);
  check(!/電話|雇用形態|入社予定日|勤務地/.test(basic), `[${width}] 空欄の項目は出さない`);
  check(!(await page.locator("#hr-more-info").evaluate((d) => d.open)), `[${width}] ［詳細を表示］は閉じている`);
  check((await page.locator("[data-ceo-brief]").innerText()).includes("社長面談の評価") && await page.locator("#hr-detail-tab [data-ceo-eval]").count() === 0,
    `[${width}] 社長面談の評価は1行（B［見る］）`);
  check((await page.locator("#hr-head-mail").innerText()) === "メール未登録", `[${width}] 名前の下に小さく「メール未登録」`);
  check((await page.locator("#hr-email-row").innerText()).includes("未登録"), `[${width}] メール：未登録［メールを登録］`);
  if (width === 390) {
    const lefts = await page.locator("#hr-basic > div").evaluateAll((ds) => new Set(ds.map((d) => Math.round(d.getBoundingClientRect().left))).size);
    check(lefts === 1, "390px：基本情報は1列");
  }
  check((await drawerOverflow(page)) <= 1, `[${width}] ドロワーは横にはみ出さない`);

  // メールをその場で登録（大きなモーダルは開かない）
  await page.locator("#hr-email-row button", { hasText: "メールを登録" }).click();
  check(await page.locator("#hr-email-input").isVisible() && await page.locator("#action-root .hr-modal").count() === 0, `[${width}] その場で入力（モーダルを開かない）`);
  await page.fill("#hr-email-input", "candidate@");
  await page.locator("#hr-email-save").click();
  await page.waitForTimeout(300);
  check((await page.locator("#hr-email-msg").innerText()).includes("メールアドレスの形式を確認してください"), `[${width}] 形が違えば、その場でエラー`);
  check(!st.calls.some(([k]) => k === "applicant"), `[${width}] 形が違えば保存しない`);
  await page.fill("#hr-email-input", "  test.candidate@example.test  ");
  await page.locator("#hr-email-save").click();
  await page.waitForTimeout(500);
  const saved = st.calls.find(([k]) => k === "applicant")?.[1];
  check(saved?.email === "test.candidate@example.test", `[${width}] 前後の空白を除いて保存`);
  check(await page.locator(".hr-detail").isVisible() && (await page.locator("#hr-email").innerText()) === "test.candidate@example.test",
    `[${width}] 保存後もドロワーは閉じず、その場で表示が変わる`);
  check((await page.locator("#hr-head-mail").innerText()) === "test.candidate@example.test", `[${width}] 名前の下のメールも変わる`);
  await page.locator("#hr-email-row button", { hasText: "編集" }).click();
  check((await page.locator("#hr-email-input").inputValue()) === "test.candidate@example.test", `[${width}] 登録済みは［編集］で直せる`);
  await page.locator("#hr-email-row button", { hasText: "キャンセル" }).click();
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 送信画面（プレビュー）：メール未登録 → 登録して続ける → 送信先の確認と［変更］・条件通知書PDF ===");
for (const width of [1300, 390]) {
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "training", join_date: "2026-11-01", wage_type: "時給", wage_amount: 1500,
    respond_by: "2026-10-15", offer_terms: { course: "無限道場", trainingPeriod: "3か月", paidDuringTraining: "あり" }, ...DOC_NULLS };
  const st = makeState({ stage: "offer", status: "offer_send_pending", decision: "hired", offer_type: "training" }, [offer]);
  const { ctx, page, errs } = await open(st, { width });
  await page.locator(".hr-next button", { hasText: "条件通知書を確認して送る" }).click();
  await page.waitForTimeout(800);
  check((await page.locator("#sm-title").innerText()) === "育成参加条件通知書のプレビュー", `[${width}] 見出しは「育成参加条件通知書のプレビュー」`);
  check((await page.locator("#sm-box .hr-sub").first().innerText()).includes("まだ本人には送っていません"), `[${width}] まだ送っていない（確定していない）ことを書く`);
  if (width === 1300) {
    check(await page.locator("#sm-pdf-frame").isVisible(), `[${width}] PC は画面の中に PDF を表示`);
    check((await page.locator("#sm-pdf-frame").getAttribute("src")).startsWith("blob:"), `[${width}] PDF はログインの鍵つきで取ってから表示（URL に鍵を載せない）`);
    check(st.calls.some(([k, f]) => k === "file" && f === "preview"), `[${width}] プレビュー用の PDF を開いた時点で読み込む`);
    const fh = await page.locator("#sm-pdf-frame").evaluate((f) => f.getBoundingClientRect().height);
    check(fh >= 400, `[${width}] PDF の表示は十分な高さ（${Math.round(fh)}px）`);
  } else {
    check(await page.locator("#sm-pdf-frame").count() === 0 && await page.locator("#sm-pdf-open").isVisible(), `[${width}] スマホは画面の中に出さず［PDFを開く］`);
  }
  check(await page.locator("#sm-email-need").isVisible(), `[${width}] 「本人のメールアドレスが未登録です」`);
  check(await page.locator("#sm-send").count() === 0, `[${width}] 未登録のうちは送れない`);
  check((await page.locator("#sm-notice").innerText()).includes("育成参加条件通知書"), `[${width}] 条件通知書（PDF）を添付する案内`);
  await page.fill("#sm-email-new", "bad-mail");
  await page.locator("#sm-email-need button", { hasText: "登録して続ける" }).click();
  await page.waitForTimeout(300);
  check((await page.locator("#sm-email-msg").innerText()).includes("形式を確認"), `[${width}] 形が違えばその場でエラー`);
  await page.fill("#sm-email-new", "first@example.test");
  await page.locator("#sm-email-need button", { hasText: "登録して続ける" }).click();
  await page.waitForTimeout(800);
  check(await page.locator("#sm-box").isVisible() && (await page.locator("#sm-to").innerText()) === "first@example.test", `[${width}] 登録して、そのまま送信確認へ（画面は閉じない）`);
  check(await page.locator("#sm-send").isVisible() && (await page.locator("#sm-send").innerText()) === "この内容で本人へ送る", `[${width}] ［この内容で本人へ送る］で送れるようになる`);
  if (width === 1300) check(await page.locator("#sm-pdf-frame").isVisible(), `[${width}] 登録したあとも PDF の表示は残る`);
  await page.locator("#sm-to-change").click();
  await page.fill("#sm-to-input", "second@example.test");
  await page.locator("#sm-box button", { hasText: "保存" }).click();
  await page.waitForTimeout(800);
  check((await page.locator("#sm-to").innerText()) === "second@example.test", `[${width}] 送信先を［変更］すると最新のメールになる`);
  check(st.row.email === "second@example.test", `[${width}] 応募者のメールも変わる`);
  const before = st.calls.filter(([k]) => k === "file").length;
  await page.locator("#sm-pdf-open").click();
  await page.waitForTimeout(500);
  const files = st.calls.filter(([k]) => k === "file");
  check(files.length === before + 1 && files.at(-1)[1] === "preview", `[${width}] ［PDFを開く］で送る前の条件通知書を開ける`);
  check(!st.calls.some(([k]) => k === "send"), `[${width}] プレビューでは送らない（確定しない）`);
  const over = await page.evaluate(() => { const m = document.querySelector("#action-root .hr-modal"); return m ? m.scrollWidth - m.clientWidth : 0; });
  check(over <= 1, `[${width}] 送信画面は横にはみ出さない`);
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== プレビュー →［条件を修正］→ 直して［PDFをプレビュー］（作り直す・まだ送らない） ===");
{
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "training", join_date: "2026-11-01", wage_type: "時給", wage_amount: 1500,
    respond_by: "2099-10-15", offer_terms: { course: "無限道場", trainingPeriod: "3か月", paidDuringTraining: "あり" }, ...DOC_NULLS };
  const st = makeState({ stage: "offer", status: "offer_review_pending", decision: "hired", offer_type: "training", email: "c@example.test" }, [offer]);
  const { ctx, page, errs } = await open(st);
  await page.locator(".hr-next button", { hasText: "条件通知書を確認して送る" }).click();
  await page.waitForTimeout(500);
  check(await page.locator("#of-fields").isVisible() && (await page.locator("#of-send").innerText()) === "PDFをプレビュー", "下書きは入力画面で開く（下に［PDFをプレビュー］）");
  await page.locator("#of-send").click();
  await page.waitForTimeout(900);
  check(await page.locator("#sm-title").isVisible() && await page.locator("#sm-edit").isVisible(), "プレビューに［条件を修正］");
  check((await page.locator("#sm-edit").innerText()) === "条件を修正" && (await page.locator("#sm-send").innerText()) === "この内容で本人へ送る", "［条件を修正］［この内容で本人へ送る］");
  await page.locator("#sm-edit").click();
  await page.waitForTimeout(400);
  check(await page.locator("#of-fields").isVisible() && (await page.locator("#of-send").innerText()) === "PDFをプレビュー", "入力画面に戻る（下に［PDFをプレビュー］）");
  await page.fill("#of-f-wageAmount", "1600");
  const n0 = st.calls.filter(([k]) => k === "file").length;
  await page.locator("#of-send").click();
  await page.waitForTimeout(900);
  const upd = st.calls.filter(([k]) => k === "update").at(-1)?.[1];
  check(upd?.wageAmount === "1600", "直した内容を下書きとして保存");
  check(await page.locator("#sm-title").isVisible() && st.calls.filter(([k]) => k === "file").length === n0 + 1, "直したあと、もう一度プレビュー（PDF を作り直す）");
  check(!st.calls.some(([k]) => k === "send"), "まだ送っていない");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 正式契約（LegalSign）の 必要／不要 をオファーごとに決める → プレビューにも出す ===");
{
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "contractor", join_date: "2026-11-01", wage_type: "月額", wage_amount: 200000,
    respond_by: "2099-10-15", offer_terms: { duties: "営業" }, ...DOC_NULLS, formal_contract_required: null, handoff_at: null, handoff_by: null };
  const st = makeState({ stage: "offer", status: "offer_review_pending", decision: "hired", offer_type: "contractor", email: "c@example.test" }, [offer]);
  const { ctx, page, errs } = await open(st);
  await page.locator(".hr-next button", { hasText: "条件通知書を確認して送る" }).click();
  await page.waitForTimeout(500);
  await page.locator("#of-more summary").click();
  const seg = page.locator('[data-field="formal"] .hr-opt button');
  check((await seg.allInnerTexts()).join("/") === "必要/不要", "正式契約（LegalSign）は［必要］［不要］で選ぶ");
  check((await page.locator('[data-field="formal"] .hr-opt button.on').innerText()) === "必要", "業務委託の既定は「必要」");
  await page.locator('[data-field="formal"] .hr-opt button', { hasText: "不要" }).click();
  await page.locator("#of-send").click();
  await page.waitForTimeout(900);
  const upd = st.calls.filter(([k]) => k === "update").at(-1)?.[1];
  check(upd?.formalContractRequired === false, "オファーごとに「不要」を保存する（区分だけで固定しない）");
  check((await page.locator("#sm-formal").innerText()).includes("不要"), "プレビューにも 正式契約 不要 と出す");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 正式契約 不要のオファー：条件承諾済み →［承諾内容を確認してOfficeへ引き渡す］（最終確認のあと。承諾だけでは渡らない） ===");
for (const width of [1300, 390]) {
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "contractor", join_date: "2026-11-01", wage_type: "月額", wage_amount: 200000,
    respond_by: "2026-10-15", offer_terms: { duties: "営業" }, sent_at: "2026-10-11T02:00:00Z", viewed_at: "2026-10-11T03:00:00Z",
    accepted_at: "2026-10-11T04:00:00Z", expires_at: "2026-10-15T14:59:59Z", ...DOC_NULLS,
    notice_title: "業務委託条件通知書", notice_pdf_path: "t1/offers/a1/o1/notice-v1-x.pdf", notice_pdf_sha256: "a".repeat(64),
    accepted_pdf_path: "t1/offers/a1/o1/accepted-v1-x.pdf", accepted_pdf_sha256: "b".repeat(64), accept_name: "テスト 候補者",
    formal_contract_required: false, handoff_at: null, handoff_by: null };
  const st = makeState({ stage: "offer", status: "accepted", decision: "hired", offer_type: "contractor", email: "c@example.test" }, [offer]);
  const { ctx, page, errs } = await open(st, { width });
  const acc = await page.locator("#hr-accepted").innerText();
  check(acc.includes("条件承諾済み") && !acc.includes("契約完了"), `[${width}] 大きく「条件承諾済み」（「契約完了」とは書かない）`);
  const ttl = await page.locator('#hr-accepted [data-acc="title"]').evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  check(ttl >= 18, `[${width}] 見出しは大きい（${ttl}px）`);
  check((await page.locator('#hr-accepted [data-acc="accepted"]').innerText()).includes("2026/10/11 13:00（第1版）"), `[${width}] 承諾日（日本時間・版）`);
  check((await page.locator('#hr-accepted [data-acc="etype"]').innerText()).includes("業務委託"), `[${width}] 採用区分`);
  check((await page.locator('#hr-accepted [data-acc="join"]').innerText()).includes("2026年11月1日"), `[${width}] 入社予定日`);
  check((await page.locator('#hr-accepted [data-acc="notice"]').innerText()).includes("確認済み"), `[${width}] 条件通知書 確認済み`);
  check((await page.locator('#hr-accepted [data-acc="formal-required"]').innerText()).includes("不要"), `[${width}] 正式契約：不要`);
  check(await page.locator('#hr-accepted [data-acc="formal"]').count() === 0, `[${width}] 不要のときは正式契約の状況（未対応・署名済み）を出さない`);
  check(await page.locator("#hr-accepted").getAttribute("data-handoff") === "ready", `[${width}] 引き渡せる状態`);
  check((await page.locator('#hr-accepted [data-acc="next"]').innerText()).includes("承諾内容を確認して Office へ引き渡す"), `[${width}] 次の手続き：Office へ引き渡す`);
  check((await page.locator(".hr-offer-card").innerText()).includes("正式契約（LegalSign）：不要") && await page.locator(".hr-offer-card button", { hasText: "正式契約（LegalSign）" }).count() === 0,
    `[${width}] 不要のオファーには LegalSign のボタンを出さない`);
  const cta = page.locator(".hr-next button", { hasText: "承諾内容を確認してOfficeへ引き渡す" });
  check(await cta.count() === 1 && await page.locator(".hr-next button.btn-primary").count() === 1, `[${width}] NEXT ACTION は［承諾内容を確認してOfficeへ引き渡す］の1つだけ`);
  check(!st.calls.some(([k]) => k === "handoff"), `[${width}] 承諾しただけでは Office へ渡っていない`);
  await cta.click();
  await page.waitForTimeout(400);
  // 押しただけでは渡さない：最終確認（内容・取り消せない旨・チェック）
  check(!st.calls.some(([k]) => k === "handoff"), `[${width}] ボタンを押しても、まだ渡さない（最終確認が先）`);
  const dlg = await page.locator('#action-root [role="dialog"]').innerText();
  const box = await page.locator("#ho-box").innerText();
  check(box.includes("承諾日") && box.includes("入社予定日") && box.includes("条件通知書") && box.includes("正式契約") && box.includes("不要"), `[${width}] 最終確認に 承諾日・入社予定日・条件通知書・正式契約`);
  check(dlg.includes("取り消せません") && dlg.includes("引き渡した人と日時が記録され"), `[${width}] 最終確認に「引き渡した人と日時が記録され、取り消せません」`);
  check(await page.locator("#hd-go").isDisabled(), `[${width}] 内容を確認したチェックが無ければ押せない`);
  await page.locator("#hd-pdf").click();
  await page.waitForTimeout(400);
  check(st.calls.some(([k, f]) => k === "file" && f === "accepted"), `[${width}] 引き渡す前に承諾済みPDFを開ける`);
  await page.locator("#hd-check").check();
  await page.locator("#hd-go").click();
  await page.waitForTimeout(900);
  check(st.calls.some(([k, b]) => k === "handoff" && b.id === "o1"), `[${width}] 最終確認のあと、Office へ引き渡す`);
  check((await page.locator("#hr-status").innerText()) === "Office引き渡し済み", `[${width}] 状態：Office引き渡し済み`);
  const done = await page.locator("#hr-accepted").innerText();
  check(await page.locator("#hr-accepted").getAttribute("data-handoff") === "done" && done.includes("引き渡し済み"), `[${width}] 条件承諾済みの欄に「引き渡し済み」`);
  check((await page.locator('#hr-accepted [data-acc="handoff"]').innerText()).includes("2026/10/12 15:00")
    && (await page.locator('#hr-accepted [data-acc="handoff"]').innerText()).includes("社長 一郎"), `[${width}] 誰が・いつ引き渡したか`);
  check(await page.locator("#hr-accepted-office").count() === 1, `[${width}] ［Office で確認する］`);
  check(await page.locator(".hr-next button.btn-primary").count() === 0, `[${width}] 引き渡したあとは HR の主のボタンを出さない（社員登録は Office）`);
  check((await drawerOverflow(page)) <= 1, `[${width}] 横にはみ出さない`);
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 正式契約 必要のオファー：署名済みになるまで［Officeへ引き渡す］を出さない → 署名済みで出る（LegalSign は HR で終える） ===");
for (const width of [1300, 390]) {
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "contractor", join_date: "2026-11-01", wage_type: "月額", wage_amount: 200000,
    respond_by: "2026-10-15", offer_terms: { duties: "営業" }, sent_at: "2026-10-11T02:00:00Z", viewed_at: "2026-10-11T03:00:00Z",
    accepted_at: "2026-10-11T04:00:00Z", expires_at: "2026-10-15T14:59:59Z", ...DOC_NULLS,
    notice_title: "業務委託条件通知書", notice_pdf_path: "t1/offers/a1/o1/notice-v1-x.pdf", notice_pdf_sha256: "a".repeat(64),
    accepted_pdf_path: "t1/offers/a1/o1/accepted-v1-x.pdf", accepted_pdf_sha256: "b".repeat(64), accept_name: "テスト 候補者",
    formal_contract_required: true, handoff_at: null, handoff_by: null };
  const st = makeState({ stage: "offer", status: "accepted", decision: "hired", offer_type: "contractor", email: "c@example.test" }, [offer]);
  const { ctx, page, errs } = await open(st, { width });
  const fr = async () => (await page.locator('#hr-accepted [data-acc="formal"]').innerText());
  check((await page.locator('#hr-accepted [data-acc="formal-required"]').innerText()).includes("必要"), `[${width}] 正式契約：必要`);
  check((await fr()).includes("未対応"), `[${width}] 正式契約の状況：未対応`);
  check(await page.locator("#hr-accepted").getAttribute("data-handoff") === "formal", `[${width}] まだ引き渡せない（正式契約が先）`);
  check(await page.locator("button", { hasText: "承諾内容を確認してOfficeへ引き渡す" }).count() === 0, `[${width}] 署名済みになるまで［Officeへ引き渡す］を出さない`);
  check(await page.locator(".hr-next button", { hasText: "正式契約へ" }).count() === 1, `[${width}] NEXT ACTION は HR の［正式契約へ］（LegalSign は HR で行う）`);
  await page.locator(".hr-next button", { hasText: "正式契約へ" }).click();
  await page.waitForTimeout(400);
  await page.fill("#fc-url", "https://sign.example.test/contracts/abc");
  await page.locator("#fc-url-save").click();
  await page.waitForTimeout(500);
  await page.locator("#fc-guide").click();
  await page.waitForTimeout(500);
  await page.locator("#fc-send").click();
  await page.waitForTimeout(700);
  check((await fr()).includes("案内済み"), `[${width}] 正式契約の状況：案内済み`);
  check(await page.locator("button", { hasText: "承諾内容を確認してOfficeへ引き渡す" }).count() === 0, `[${width}] 案内しただけではまだ引き渡せない`);
  await page.locator("#fc-signed").click();
  await page.waitForTimeout(700);
  check((await fr()).includes("署名済み"), `[${width}] 正式契約の状況：署名済み`);
  check(await page.locator("#hr-accepted").getAttribute("data-handoff") === "ready", `[${width}] 署名済み → 引き渡せる`);
  check(await page.locator("#fc-box button", { hasText: "承諾内容を確認してOfficeへ引き渡す" }).count() === 1, `[${width}] 正式契約の画面にも［承諾内容を確認してOfficeへ引き渡す］`);
  await page.locator("#fc-box button", { hasText: "承諾内容を確認してOfficeへ引き渡す" }).click();
  await page.waitForTimeout(400);
  const box = await page.locator("#ho-box").innerText();
  check(box.includes("正式契約") && box.includes("署名済み"), `[${width}] 最終確認に「正式契約：署名済み」`);
  check(!st.calls.some(([k]) => k === "handoff"), `[${width}] まだ渡していない`);
  await page.locator("#hd-check").check();
  await page.locator("#hd-go").click();
  await page.waitForTimeout(800);
  check(st.calls.some(([k, b]) => k === "handoff" && b.id === "o1"), `[${width}] 署名済みのあと、Office へ引き渡す`);
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 育成枠：Office へは渡さない（正式契約の要否に関わらず LMS・育成開始） ===");
for (const formal of [false, true]) {
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "training", join_date: "2026-11-01", wage_type: "時給", wage_amount: 1500,
    respond_by: "2026-10-15", offer_terms: { course: "無限道場", trainingPeriod: "3か月", paidDuringTraining: "あり" }, sent_at: "2026-10-11T02:00:00Z",
    viewed_at: "2026-10-11T03:00:00Z", accepted_at: "2026-10-11T04:00:00Z", expires_at: "2026-10-15T14:59:59Z", ...DOC_NULLS,
    notice_title: "育成参加条件通知書", notice_pdf_path: "t1/offers/a1/o1/notice-v1-x.pdf", notice_pdf_sha256: "a".repeat(64),
    formal_contract_required: formal, handoff_at: null, handoff_by: null };
  const st = makeState({ stage: "offer", status: "accepted", decision: "hired", offer_type: "training", email: "c@example.test" }, [offer]);
  const { ctx, page, errs } = await open(st);
  const acc = await page.locator("#hr-accepted").innerText();
  check(acc.includes("条件承諾済み") && acc.includes("育成枠は Office へ引き渡さず"), `[formal=${formal}] 育成枠は Office へ渡さない旨`);
  check(await page.locator("#hr-accepted").getAttribute("data-handoff") === "training", `[formal=${formal}] 引き渡せる状態にしない`);
  check(await page.locator("button", { hasText: "Officeへ引き渡す" }).count() === 0, `[formal=${formal}] ［Officeへ引き渡す］を出さない`);
  check((await page.locator('#hr-accepted [data-acc="next"]').innerText()).includes("LMS・育成開始") || (await page.locator('#hr-accepted [data-acc="next"]').innerText()).includes("育成"), `[formal=${formal}] 次の手続きは HR の LMS・育成開始`);
  check(!st.calls.some(([k]) => k === "handoff"), `[formal=${formal}] 引き渡しの呼び出しをしない`);
  check(!errs.length, `[formal=${formal}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== HR：条件承諾済み → 正式契約（LegalSign）：URL → 案内 → 正式契約済み ===");
{
  const offer = { id: "o1", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "contractor", join_date: "2026-11-01", wage_type: "月額", wage_amount: 200000,
    respond_by: "2026-10-15", offer_terms: { duties: "営業" }, sent_at: "2026-10-11T02:00:00Z", viewed_at: "2026-10-11T03:00:00Z",
    accepted_at: "2026-10-11T04:00:00Z", expires_at: "2026-10-15T14:59:59Z", ...DOC_NULLS,
    notice_title: "業務委託条件通知書", notice_pdf_path: "t1/offers/a1/o1/notice-v1-x.pdf", notice_pdf_sha256: "a".repeat(64),
    accepted_pdf_path: "t1/offers/a1/o1/accepted-v1-x.pdf", accepted_pdf_sha256: "b".repeat(64), accept_name: "テスト 候補者" };
  const st = makeState({ stage: "offer", status: "accepted", decision: "hired", offer_type: "contractor", email: "c@example.test" }, [offer]);
  const { ctx, page, errs } = await open(st);
  check((await page.locator("#hr-status").innerText()) === "条件承諾済み", "状態：条件承諾済み（「契約完了」と言わない）");
  const acc = await page.locator("#hr-accepted").innerText();
  check(acc.includes("条件承諾済み") && acc.includes("2026/10/11 13:00（第1版）"), "承諾のあと：条件承諾済み・承諾日時（日本時間）・版");
  check(acc.includes("正式契約") && acc.includes("必要") && acc.includes("未対応"), "正式契約：必要・未対応も同じ場所に");
  check(!acc.includes("契約完了"), "「契約完了」とは出さない");
  await page.locator("#hr-accepted-pdf").click();
  await page.waitForTimeout(400);
  check(st.calls.filter(([k, f]) => k === "file" && f === "accepted").length === 1, "［承諾済みPDFを確認する］で承諾済みPDFを開ける");
  const card = await page.locator(".hr-offer-card").innerText();
  check(card.includes("業務委託条件通知書（PDF）") && card.includes("承諾済みPDF"), "オファーの版に条件通知書PDF・承諾済みPDF");
  await page.locator(".hr-offer-card button", { hasText: "承諾済みPDF" }).click();
  await page.waitForTimeout(400);
  check(st.calls.some(([k, f]) => k === "file" && f === "accepted"), "承諾済みPDFを開ける");
  await page.locator(".hr-next button", { hasText: "正式契約へ" }).click();
  await page.waitForTimeout(400);
  check((await page.locator("#fc-box").innerText()).includes("条件の承諾は、正式な契約ではありません"), "条件承諾と正式契約を分けて説明");
  await page.fill("#fc-url", "javascript:alert(1)");
  await page.locator("#fc-url-save").click();
  await page.waitForTimeout(200);
  check((await page.locator("#fc-url-msg").innerText()).includes("https://"), "https:// 以外はその場で断る");
  check(!st.calls.some(([k]) => k === "setLegalSign"), "保存しない");
  await page.fill("#fc-url", "https://sign.example.test/contracts/abc");
  await page.locator("#fc-url-save").click();
  await page.waitForTimeout(600);
  check(offer.legalsign_url === "https://sign.example.test/contracts/abc", "URL を登録");
  await page.locator("#fc-guide").click();
  await page.waitForTimeout(500);
  check((await page.locator("#fc-body").inputValue()).includes("{{正式契約URL}}"), "案内メールの下書き（URL の場所つき）");
  await page.locator("#fc-send").click();
  await page.waitForTimeout(700);
  check(st.calls.some(([k, b]) => k === "sendFormal" && b.channel === "email" && /^[0-9a-f]{32}$/.test(b.requestKey)), "メールで案内（二重送信を防ぐ鍵つき）");
  check((await page.locator("#hr-status").innerText()) === "正式契約待ち", "状態：正式契約待ち");
  check((await page.locator('#hr-accepted [data-acc="formal"]').innerText()).includes("案内済み"), "承諾の欄にも「案内済み」");
  check((await page.locator("#fc-box").innerText()).includes("本人へ案内したため、変えられません"), "案内したあとは URL を変えられない");
  await page.locator("#fc-signed").click();
  await page.waitForTimeout(700);
  check((await page.locator("#hr-status").innerText()) === "正式契約済み", "状態：正式契約済み");
  const fl = await page.locator('#hr-accepted [data-acc="formal"]').innerText();
  check(fl.includes("✓") && fl.includes("署名済み"), "承諾の欄に「✓ 署名済み」");
  check(await page.locator("#fc-box button", { hasText: "稼働開始準備へ進む" }).count() === 1, "正式契約済みのあと：業務委託は［稼働開始準備へ進む］");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 本人：条件通知書PDFを保存 → 同意のチェック → 条件を承諾 → 承諾済みPDF・LegalSign ===");
for (const width of [1100, 768, 390]) {
  const offer = { offer_type: "training", employment_type: "育成枠", join_date: "2026-11-01", wage_type: "時給", wage_amount: 1500, respond_by: "2026-10-15",
    offer_terms: { course: "無限道場", trainingPeriod: "3か月", paidDuringTraining: "あり" }, accepted_at: null, declined_at: null, ...DOC_NULLS,
    notice_title: "育成参加条件通知書", notice_pdf_path: "p" };
  const base = shapePublicOffer(offer, { name: "テスト 候補者" }, { name: "株式会社エイト" }, { display_name: "採用 花子", email: "hr@example.test" });
  const view = { ...base, noticePdf: true, acceptedPdf: false, formal: null };
  const ctx = await br.newContext({ viewport: { width, height: 1000 } });
  const posted = [];
  await ctx.route("**/api/**", (route) => {
    const req = route.request();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (req.method() === "POST") { posted.push(JSON.parse(req.postData() || "{}")); return send({ ok: true, responseStatus: "accepted", acceptedPdf: true }); }
    return send(view);
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${BASE}/hr/offer.html?token=${"a".repeat(43)}`);
  await page.waitForTimeout(900);
  const pdfLink = page.locator("#ho-notice-pdf");
  check((await pdfLink.innerText()).includes("育成参加条件通知書PDFを保存") && (await pdfLink.getAttribute("href")).includes("file=notice"),
    `[${width}] ［条件通知書PDFを保存］`);
  check((await page.locator("#ho-agree-box").innerText()).includes("上記の条件通知書の内容を確認し、この条件に同意します"), `[${width}] 同意の文言`);
  const btn = page.locator("#ho-accept");
  check((await btn.innerText()) === "条件を承諾する" && await btn.isDisabled(), `[${width}] チェックしないと［条件を承諾する］を押せない`);
  check((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, `[${width}] 横にはみ出さない`);
  await page.locator("#ho-agree").check();
  await btn.click();
  await page.waitForTimeout(500);
  check(posted[0]?.action === "accept" && posted[0].agreed === true, `[${width}] 承諾（agreed: true）`);
  const done = await page.locator("#ho-complete").innerText();
  check(done.includes("条件の承諾を受け付けました。") && done.includes("育成参加の手続きについて") && !done.includes("正式な契約"),
    `[${width}] 承諾後の案内（育成枠は正式契約 不要：次の手続きを案内）`);
  check(!done.includes("契約手続きが完了"), `[${width}] 「契約完了」とは言わない`);
  check((await page.locator("#ho-accepted-pdf").getAttribute("href")).includes("file=accepted"), `[${width}] 承諾済みPDFを保存できる`);
  check(!errs.length, `[${width}] 画面のエラーなし${errs.length ? `：${errs[0].slice(0, 160)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 本人：正式契約の案内 → ［LegalSignで正式契約を行う］（https:// のときだけ） ===");
for (const [label, url, expect] of [["https", "https://sign.example.test/contracts/abc", true], ["javascript", "javascript:alert(1)", false]]) {
  const offer = { offer_type: "contractor", employment_type: "業務委託", join_date: "2026-11-01", respond_by: "2026-10-15",
    offer_terms: { duties: "営業" }, accepted_at: "2026-10-11T04:00:00Z", declined_at: null, ...DOC_NULLS, notice_title: "業務委託条件通知書", notice_pdf_path: "p" };
  const base = shapePublicOffer(offer, { name: "テスト 候補者" }, { name: "株式会社エイト" }, null);
  const view = { ...base, noticePdf: true, acceptedPdf: true, formal: { url, sent: true, signed: false } };
  const ctx = await br.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(view) }));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/hr/offer.html?token=${"a".repeat(43)}`);
  await page.waitForTimeout(800);
  const n = await page.locator("#ho-legalsign").count();
  if (expect) {
    const a = page.locator("#ho-legalsign");
    check(n === 1 && (await a.innerText()) === "LegalSignで正式契約を行う" && (await a.getAttribute("href")) === url
      && (await a.getAttribute("target")) === "_blank" && (await a.getAttribute("rel")).includes("noopener"), "［LegalSignで正式契約を行う］は外部ページとして開く");
  } else check(n === 0, "https:// でない URL はリンクにしない");
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
