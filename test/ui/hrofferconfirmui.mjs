// 採用HR：合格通知（内定通知書・労働条件通知書PDF）をメールで送る前の「送信内容の確認」を、実際のブラウザで通す（PC 1280px・スマホ 390px）。
// サーバは偽物（page.route）。confirmDigest は本物の lib/hr-offer-confirm.js と同じ作り方かを確かめる。
//
// ■ 何を守るテストか
//   1. 入力画面からは直接送れない。［送信内容を確認する］で 送信元・宛先（CC/BCC なし）・件名・本文・添付PDF を見せる
//   2. 添付PDFは、確認が済む（作れる・開ける）まで送れない。作れないPDFがあれば送れない
//   3. 給与を見られない人には条件通知書の中身を出さず、「作れることは確認済み」とだけ出す
//   4. 確認の途中で内容が変わった（要約が違う）・サーバーが 409 を返した → 送れない。戻ると最新を読み直す
//   5. 送るのは確認した件名・本文と confirmDigest。二度押しでも1回
//   6. 390px で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { confirmDigestOf } from "../../lib/hr-offer-confirm.js";
import { shapeApplicant, shapeOffer } from "../../lib/hr.js";
import { OFFER_TYPES_PUBLIC, publicOfferItems, offerMail, OFFER_URL_TAG, defaultRespondBy } from "../../lib/hr-offer-types.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shotPath } from "../_shot.mjs";

// 画面写真：既定は _shot.mjs の置き場所（CI でも書ける）。SHOT_DIR を渡せばそこへ（確認用に人へ渡すとき）
const SHOTS = process.env.SHOT_DIR || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shotFile = (name) => (SHOTS ? join(SHOTS, `${name}.png`) : shotPath(`${name}.png`));
const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const PDF = Buffer.from("%PDF-1.7\n% test\n");
const BASE1 = "1".repeat(64), BASE2 = "2".repeat(64);
const ME = (roles) => ({ email: "hr@example.test", appRole: "member", isAdmin: false, shows: {}, access: { recruit: true },
  gw: { employee: { id: "e-hr", display_name: "採用 花子" }, roles, isAdmin: false, tenantId: "t1", stage: null } });

function makeState(over = {}) {
  return {
    row: { id: "a1", tenant_id: "t1", name: "架空 候補者", email: "kakuu@example.test", job_title: "エンジニア", source: "テスト",
      stage: "offer", status: "offer_review_pending", rank: "A", decision: "hired", lead_category: "recruitment", offer_type: "executive_employee" },
    offer: { id: "o1", version: 1, applicant_id: "a1", offer_type: "executive_employee", respond_by: defaultRespondBy(), job_title: "エンジニア",
      join_date: "2026-12-01", work_location: "東京（架空）", created_at: "2026-10-20T01:00:00Z" },
    salaryVisible: true, base: BASE1, checkBase: BASE1, failKind: null, sendStatus: 200, calls: [], ...over,
  };
}
const DOCS = [
  { kind: "offer", title: "内定通知書", stored: false, file: "previewOffer", docId: null, size: null, salary: false, note: null },
  { kind: "notice", title: "労働条件通知書", stored: false, file: "preview", docId: null, size: null, salary: true, note: null },
];

async function open(state, { width = 1280, roles = ["owner"] } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, timezoneId: "Asia/Tokyo" });
  await ctx.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@example.test" })));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await ctx.route("**/api/**", (route) => {
    const req = route.request(), url = req.url(), q = new URL(url).searchParams;
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME(roles));
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      return send({ applicant: { ...shapeApplicant(state.row), recruiterName: "採用 花子", alerts: [] }, interviews: [], interviewers: [],
        offers: [shapeOffer(state.offer)], timeline: [], offerTypes: OFFER_TYPES_PUBLIC, offerTypeReady: true, salaryVisible: state.salaryVisible });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [{ ...shapeApplicant(state.row), alerts: [], priority: 1 }], employees: [] });
    if (/\/api\/hr\/offers\b/.test(url)) {
      if (req.method() === "GET" && q.get("file")) {
        state.calls.push(["file", q.get("file")]);
        if (state.failKind === "fetch" && q.get("file") === "preview") return send({ error: "pdf_failed", hint: "PDFを用意できませんでした" }, 500);
        return route.fulfill({ status: 200, contentType: "application/pdf", body: PDF });
      }
      if (req.method() === "GET" && q.get("check")) {
        state.calls.push(["check"]);
        return send({ base: state.checkBase, documents: DOCS.map((d) => (state.failKind === "notice" && d.kind === "notice"
          ? { kind: d.kind, title: d.title, ok: false, hint: "PDFを作れませんでした。時間をおいて、もう一度確認してください" } : { kind: d.kind, title: d.title, ok: true })) });
      }
      if (req.method() === "GET") {
        state.calls.push(["draft"]);
        const o = state.offer;
        const mail = offerMail(o, { name: state.row.name, company: "株式会社テスト", attachments: DOCS.map((d) => d.title) });
        return send({ offer: shapeOffer(o), items: publicOfferItems(o), to: state.row.email, candidateName: state.row.name,
          subject: mail.subject, body: mail.body, urlTag: OFFER_URL_TAG, mail: { configured: true, reason: null, from: "株式会社テスト 採用 <recruit@example.test>" },
          canSend: true, offerLetter: { ready: true, title: "内定通知書", stored: false },
          notice: { ready: true, title: "労働条件通知書", stored: false, salaryVisible: state.salaryVisible, warnings: [] },
          confirm: { base: state.base, from: "株式会社テスト 採用 <recruit@example.test>", replyTo: "hr@example.test", to: state.row.email,
            toName: state.row.name, cc: [], bcc: [], issuedOn: "2026-10-24", documents: DOCS } });
      }
      const b = JSON.parse(req.postData() || "{}");
      state.calls.push([b.action, b]);
      if (b.action === "send") {
        if (state.sendStatus === 409) return send({ error: "confirm_mismatch", hint: "確認したあとで、宛先・件名・本文・添付PDFのどれかが変わりました。もう一度、送信内容を確認してください（メールは送っていません）" }, 409);
        if (b.confirmDigest !== confirmDigestOf(state.base, b.subject, b.body)) return send({ error: "confirm_mismatch", hint: "不一致" }, 409);
        state.row.status = "offer_sent";
        return send({ status: "sent", offer: shapeOffer({ ...state.offer, sent_at: "2026-10-24T01:00:00Z" }), send: { id: "s1", status: "sent" } });
      }
      return send({ offer: shapeOffer(state.offer) });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForSelector(".hr-detail #hr-detail-next", { timeout: 15000 });
  await page.evaluate(() => openOfferSend("o1"));
  await page.waitForSelector("#sm-review", { timeout: 8000 });
  return { ctx, page, errs };
}
const settled = (page) => page.waitForFunction(() => ![...document.querySelectorAll("#sc-docs li")].some((li) => li.dataset.state === "loading"), null, { timeout: 8000 });
const docStates = (page) => page.locator("#sc-docs li").evaluateAll((ls) => ls.map((l) => `${l.dataset.docKind}:${l.dataset.state}`).join(","));
const overflowOf = (page) => page.evaluate(() => {
  const m = document.querySelector("#action-root .hr-modal");
  const r = m ? m.getBoundingClientRect() : { left: 0, right: 0 };
  return Math.max(document.documentElement.scrollWidth - innerWidth, r.right - innerWidth, -r.left);
});
const shot = (page, name) => page.screenshot({ path: shotFile(name) });

for (const width of [1280, 390]) {
  console.log(`\n=== [${width}px] 内定通知書＋労働条件通知書：確認してから送る ===`);
  const state = makeState();
  const { ctx, page, errs } = await open(state, { width });
  check(await page.locator("#sm-send").count() === 0, `[${width}] 入力画面からは直接送れない`);
  await page.fill("#sm-subject", "【株式会社テスト】内定のご連絡（架空）");
  await page.locator("#sm-review").click();
  await page.waitForSelector("#sm-confirm");
  check((await page.locator("#sc-from").innerText()).includes("recruit@example.test"), `[${width}] 送信元`);
  check((await page.locator("#sc-reply").innerText()).includes("hr@example.test"), `[${width}] 返信先`);
  check((await page.locator("#sc-to").innerText()).includes("架空 候補者 様") && (await page.locator("#sc-to").innerText()).includes("kakuu@example.test"), `[${width}] 宛先（To）`);
  check((await page.locator("#sc-cc").innerText()) === "なし" && (await page.locator("#sc-bcc").innerText()) === "なし", `[${width}] CC・BCC はなし`);
  check((await page.locator("#sc-subject").innerText()) === "【株式会社テスト】内定のご連絡（架空）", `[${width}] 確認するのは直した件名`);
  await settled(page);
  check(await docStates(page) === "offer:ok,notice:ok", `[${width}] 添付2点とも確認済み（${await docStates(page)}）`);
  check(await page.locator("#sc-docs [data-sc-open]").count() === 2, `[${width}] 2点とも［PDFを開く］で実物を見られる`);
  check(state.calls.some(([k, f]) => k === "file" && f === "previewOffer") && state.calls.some(([k, f]) => k === "file" && f === "preview"), `[${width}] 実際に送るPDFを取ってくる`);
  check(await page.locator("#sm-send").isDisabled(), `[${width}] 確認のチェックが無いと送れない`);
  await page.locator("#sc-check").check();
  check(await page.locator("#sm-send").isEnabled(), `[${width}] チェックで送れる`);
  await shot(page, `send-confirm-${width}`);
  const over = await overflowOf(page);
  check(over <= 1, `[${width}] 横にはみ出さない（${over}px）`);
  await page.locator("#sm-send").click();
  await page.locator("#sm-send").click({ force: true, timeout: 400 }).catch(() => {});
  await page.waitForSelector("#sm-done", { timeout: 8000 });
  const sends = state.calls.filter(([k]) => k === "send");
  check(sends.length === 1, `[${width}] 二度押しでも1回（${sends.length}回）`);
  const b = sends[0][1];
  check(b.subject === "【株式会社テスト】内定のご連絡（架空）" && b.confirmDigest === confirmDigestOf(BASE1, b.subject, b.body), `[${width}] 確認した件名・本文と confirmDigest で送る`);
  check(errs.length === 0, `[${width}] 画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n=== 作れないPDFがある：送れない ===");
{
  const state = makeState({ failKind: "notice" });
  const { ctx, page } = await open(state);
  await page.locator("#sm-review").click();
  await settled(page);
  check(await docStates(page) === "offer:ok,notice:failed", `作れないPDFを出す（${await docStates(page)}）`);
  check((await page.locator('#sc-docs li[data-doc-kind="notice"]').innerText()).includes("PDFを作れませんでした"), "理由を出す");
  await page.locator("#sc-check").check();
  check(await page.locator("#sm-send").isDisabled(), "チェックしても送れない");
  await shot(page, "send-confirm-docfail-1280");
  await ctx.close();
}
{
  const state = makeState({ failKind: "fetch" });
  const { ctx, page } = await open(state);
  await page.locator("#sm-review").click();
  await settled(page);
  check((await docStates(page)).includes("notice:failed"), "PDFを開けないときも送れない（未確認のまま送らない）");
  await page.locator("#sc-check").check();
  check(await page.locator("#sm-send").isDisabled(), "開けないPDFがあれば送れない");
  await ctx.close();
}

console.log("\n=== 給与を見られない人：条件通知書の中身は出さず、作れることだけ確認 ===");
{
  const state = makeState({ salaryVisible: false });
  const { ctx, page } = await open(state, { roles: ["recruiter"] });
  await page.locator("#sm-review").click();
  await settled(page);
  check(await docStates(page) === "offer:ok,notice:ok", `どちらも確認済み（${await docStates(page)}）`);
  check(await page.locator('#sc-docs li[data-doc-kind="notice"] [data-sc-open]').count() === 0, "条件通知書は開けない（給与が入る）");
  check((await page.locator('#sc-docs li[data-doc-kind="notice"]').innerText()).includes("給与を見られる方が確認します"), "誰が中身を確認するかを出す");
  check(!state.calls.some(([k, f]) => k === "file" && f === "preview"), "条件通知書のPDFは取りに行かない");
  await ctx.close();
}

console.log("\n=== 確認の途中で内容が変わった／サーバーが 409：送らない・戻ると読み直す ===");
{
  const state = makeState({ checkBase: BASE2 });
  const { ctx, page } = await open(state);
  await page.locator("#sm-review").click();
  await settled(page);
  check(await page.locator("#sc-changed").isVisible(), "内容が変わったことを出す");
  await page.locator("#sc-check").check();
  check(await page.locator("#sm-send").isDisabled(), "変わったままでは送れない");
  const drafts = state.calls.filter(([k]) => k === "draft").length;
  await page.locator("#sm-back").click();
  await page.waitForSelector("#sm-review");
  check(state.calls.filter(([k]) => k === "draft").length === drafts + 1, "戻ると最新の内容を読み直す");
  await ctx.close();
}
{
  const state = makeState({ sendStatus: 409 });
  const { ctx, page } = await open(state);
  await page.locator("#sm-review").click();
  await settled(page);
  await page.locator("#sc-check").check();
  await page.locator("#sm-send").click();
  await page.waitForSelector("#sc-changed");
  check((await page.locator("#sm-msg").innerText()).includes("メールは送っていません"), "409：送っていないことと、確認し直すことを出す");
  check(await page.locator("#sm-done").count() === 0 && await page.locator("#sm-send").isDisabled(), "送信済みにしない・もう押せない");
  await ctx.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}件` : "\nすべて通過");
process.exit(bad ? 1 : 0);
