// 分析（/sales/analytics.html）の実画面：タブを押すとすぐグラフ／棒・凡例から根拠へ／タブの行き来で取り直さない／
// 読込中・取得失敗・未設定・0件の区別／390px で横にはみ出さない。
// API はすべて架空データの差し替え（本物のDB・アカウント・送信には触れない）。
// 画面写真（「架空データ」の表示つき）は _shot.mjs の置き場所へ。SHOTS_DIR を指定したらそこへ。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const SHOTS = process.env.SHOTS_DIR || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const now = new Date().toISOString();

// 架空の40社：20社は反応待ち、12社はクリック止まり、3社は返信止まり、3社は商談まで、2社は成約
const STATUS = (i) => (i <= 20 ? "attacked" : i <= 32 ? "clicked" : i <= 35 ? "replied" : i <= 38 ? "meeting" : "won");
const approaches = Array.from({ length: 40 }, (_, k) => {
  const i = k + 1, status = STATUS(i);
  return { id: `a${i}`, companyId: `k${i}`, companyName: i === 1 ? '<img src=x onerror="window.bad=1">架空商事01' : `架空商事${String(i).padStart(2, "0")}`,
    companyStatus: status, clickCount: status === "attacked" ? 0 : 1, sentAt: now,
    channelLabel: "お問い合わせフォーム", templateName: i % 2 ? "架空テンプレートA" : "架空テンプレートB",
    service: "架空サービス", industry: "架空業種", employeeName: "架空 営業A" };
});
const deal = (d) => ({ approachId: null, ownerName: "架空 営業A", probability: null, lostReason: null, wonOn: null, lostOn: null, createdAt: now,
  stageLabel: { proposal: "提案", won: "成約" }[d.stage], open: d.stage === "proposal", expected: d.stage === "proposal" ? d.amount / 2 : 0, ...d });
const deals = [
  deal({ id: "d1", companyId: "k36", approachId: "a36", title: "架空案件（提案中）", stage: "proposal", amount: 1000000 }),
  deal({ id: "d2", companyId: "k39", approachId: "a39", title: "架空案件（成約）", stage: "won", amount: 1500000, wonOn: today }),
  deal({ id: "d3", companyId: "k40", approachId: "a40", title: "架空案件（成約2）", stage: "won", amount: 800000, wonOn: today }),
];
const journey = {
  days: 30, since: `${today}T00:00:00+09:00`, until: now, cohortCount: 24,
  counts: { sent: 24, adjusted: 9, scheduled: 7, held: 5, accepted: 2, won: 1, working: 1 },
  rates: { heldFromSent: 20.8, acceptedFromHeld: null },
  coverage: { acceptedUnknown: 22, activityTruncated: false, proposalTruncated: false },
  bottlenecks: { awaitingHeld: 12, awaitingHeldMedianDays: 6, awaitingAcceptedEvidence: 3, heldMedianDays: 5, heldMeasured: 5 },
  byCurrentOwner: [{ ownerId: "e1", ownerName: "架空 営業A", sent: 14, held: 3, heldRate: 21.4, heldMedianDays: 5, heldMeasured: 3, accepted: 1, acceptedUnknown: 13 }],
  byCompany: [{ companyKey: "sales:k1", companyName: "架空商事01", sent: 3, held: 1, accepted: 0, acceptedUnknown: 3, lost: 1, reasons: [], unknownReason: 1,
    collectionCounts: { not_asked: 1, no_answer: 0, vague: 0, specific: 0, unclassified: 0 } }],
  rows: Array.from({ length: 24 }, (_, i) => ({ id: `p${i + 1}`, title: `架空提案${i + 1}`, companyName: `架空商事${String(i + 1).padStart(2, "0")}`,
    sentAt: now, companyKey: `sales:k${i + 1}`, ownerId: "e1", ownerName: "架空 営業A",
    adjustedAt: i < 9 ? now : null, scheduledAt: i < 7 ? now : null, heldAt: i < 5 ? now : null,
    acceptedEvidence: i < 2 ? "sync" : null, acceptedAt: i < 2 ? now : null, wonEvidence: i < 1 ? "activity" : null, wonAt: i < 1 ? now : null,
    workingEvidence: i < 1 ? "sync" : null })),
  notice: "架空データです。",
};

const browser = await launch();
async function open({ width = 1280, hash = "", mode = {} } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = { approaches: 0, journey: 0 }, errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@example.com" })));
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send({ email: "sales@example.com", appRole: "member", isAdmin: false, shows: {},
      gw: { employee: { id: "e1", display_name: "架空 営業A" }, roles: ["sales"], isAdmin: false, tenantId: "t1", stage: null } });
    if (/\/api\/sales\/approaches\/counts/.test(url)) return send({ period: { key: "this_week", label: "今週", from: today, to: today },
      rows: [{ name: "架空 営業A", count: 40 }], total: 40 });
    if (/\/api\/sales\/approaches\b/.test(url)) {
      calls.approaches++;
      const m = typeof mode.approaches === "function" ? mode.approaches(calls.approaches) : mode.approaches;
      if (m === "error") return send({ error: "db_failed", message: "架空の通信エラー" }, 500);
      if (m === "notReady") return send({ approaches: [], notReady: true, message: "管理者に db/xxx の実行を依頼してください（架空）" });
      if (m === "empty") return send({ since: today, approaches: [] });
      return send({ since: today, approaches });
    }
    if (/\/api\/sales\/deals\b/.test(url)) return send({ deals, truncated: false });
    if (/\/api\/sales\/proposals\/journey/.test(url)) { calls.journey++; return send(journey); }
    return send({});
  });
  await page.goto(`${BASE}/sales/analytics.html${hash}`);
  // 写真が実績に見えないよう、画面の上に「架空データ」と出す
  await page.evaluate(() => {
    const b = document.createElement("div");
    b.id = "fixture-label";
    b.textContent = "架空データ（テスト用の表示です。実際の実績ではありません）";
    b.style.cssText = "background:#b3261e;color:#fff;font-weight:700;font-size:13px;padding:6px 12px;border-radius:6px;margin:0 0 10px;";
    document.querySelector(".wrap")?.prepend(b);
  });
  return { page, calls, errors };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const shot = (page, name) => page.screenshot({ path: SHOTS ? join(SHOTS, name) : shotPath(`sales-analytics-${name}`), fullPage: true });

try {
  for (const width of [1280, 390]) {
    const tag = width === 390 ? "phone" : "pc";
    const { page, calls, errors } = await open({ width });
    // アタック分析（既定）：タブを開いた時点でグラフ
    await page.locator("#funnel [data-chart-key]").first().waitFor();
    assert.equal(await page.locator("#funnel [data-chart-key]").count(), 5);
    const vals = await page.locator("#funnel .sc-val").allInnerTexts();
    assert.deepEqual(vals.map((v) => v.replace(/\s/g, "")), ["40社", "20社", "8社", "5社", "2社"]);
    const subs = (await page.locator("#funnel .sc-sub").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    assert.match(subs[1], /前の段から 50%（20 \/ 40社）/);
    assert.match(subs[3], /62\.5%（5 \/ 8社）参考値/, "集計対象10社未満は参考値");
    assert.equal(await page.locator("#stop-chart .sc-leg").count(), 5);
    assert.match(await page.locator("#stop-chart svg").getAttribute("aria-label"), /反応待ち（アタックのみ） 20社（50%）/);
    const hypo = (await page.locator("#attack-hypothesis").innerText()).replace(/\s+/g, " ");
    assert.match(hypo, /仮説（未検証）：いちばん減っているのは「クリック→返信」/);
    assert.match(hypo, /クリックした 20社のうち、次の段に進んだ記録があるのは 8社（40%）/);
    assert.equal(await page.locator('#funnel [data-chart-key="reply"]').getAttribute("class"), "sc-row sc-warn");
    assert.ok(await noOverflow(page), `${tag}: アタック分析で横にはみ出さない`);
    await shot(page, `attack-${tag}.png`);
    // 棒・凡例・仮説のボタンから、対象の企業へ
    await page.locator('#funnel [data-chart-key="meeting"]').click();
    assert.match(await page.locator(".sl-drawer h2").innerText(), /商談した企業/);
    await page.keyboard.press("Escape");
    await page.locator('#stop-chart button[data-chart-key="stop-click"]').click();
    assert.match(await page.locator(".sl-drawer h2").innerText(), /クリック止まりの企業/);
    assert.equal(await page.locator(".sl-drawer tbody tr").count(), 12);
    await page.keyboard.press("Escape");
    await page.locator('#attack-hypothesis [data-chart-key]').click();
    assert.match(await page.locator(".sl-drawer h2").innerText(), /クリック止まりの企業/);
    await page.keyboard.press("Escape");
    await page.locator('#stop-chart button[data-chart-key="stop-attack"]').click();
    assert.equal(await page.locator(".sl-drawer img").count(), 0, "企業名の <img> をエスケープ");
    await page.keyboard.press("Escape");
    await page.locator("#revenue-btn").click();
    assert.match(await page.locator(".sl-drawer").innerText(), /架空案件（成約）/);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => !!window.bad), false);

    // 提案分析：押した直後にグラフ
    await page.locator("#ah-tab-proposal").click();
    await page.locator("#pj-chart [data-chart-key]").first().waitFor();
    assert.equal(await page.locator("#pj-chart [data-chart-key]").count(), 7);
    assert.match(await page.locator("#proposal-journey").innerText(), /期間内に送信した提案/);
    assert.doesNotMatch(await page.locator("body").innerText(), /コホート|母数/);
    assert.ok(await noOverflow(page), `${tag}: 提案分析で横にはみ出さない`);
    await shot(page, `proposal-${tag}.png`);
    // 同じタブをもう一度押しても、取り直さない・グラフを重ねない
    await page.locator("#ah-tab-proposal").click();
    // 行き来しても取り直さない（アタックは1回だけ・提案は読めていれば1回だけ）
    await page.locator("#ah-tab-attack").click();
    assert.equal(await page.locator("#attack-charts").count(), 1);
    await page.locator("#ah-tab-proposal").click();
    assert.equal(await page.locator("#pj-chart").count(), 1);
    assert.deepEqual(calls, { approaches: 1, journey: 1 });
    // 棒を押すと根拠の表へ
    await page.locator('#pj-chart [data-chart-key="held"]').click();
    assert.equal(await page.locator(".pj-records tbody tr").count(), 5);
    // マッチング分析：未接続（グラフ・0件を出さない）
    await page.locator("#ah-tab-matching").click();
    assert.equal(await page.locator('#matching-chart[data-state="not-connected"]').isVisible(), true);
    assert.equal(await page.locator("#ah-panel-matching svg").count(), 0);
    assert.ok(await noOverflow(page), `${tag}: マッチング分析で横にはみ出さない`);
    await shot(page, `matching-${tag}.png`);
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 状態：取得失敗 → 再試行で回復／未設定／0件。どれも「0社」とは出さない
  {
    const { page, calls, errors } = await open({ width: 390, mode: { approaches: (n) => (n === 1 ? "error" : "ok") } });
    await page.locator('#kpi [data-state="error"]').waitFor();
    assert.match(await page.locator("#kpi").innerText(), /取得できませんでした。0社ではありません/);
    assert.equal(await page.locator("#funnel").count(), 0);
    assert.match(await page.locator("#by-channel").innerText(), /取得できなかったため表示していません/);
    await shot(page, "attack-error-phone.png");
    await page.locator("#kpi [data-chart-retry]").click();
    await page.locator("#funnel [data-chart-key]").first().waitFor();
    assert.equal(calls.approaches, 2);
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { page, errors } = await open({ width: 390, mode: { approaches: "notReady" } });
    await page.locator('#kpi [data-state="not-ready"]').waitFor();
    assert.match(await page.locator("#kpi").innerText(), /未設定/);
    assert.match(await page.locator("#kpi").innerText(), /0社ではありません/);
    await shot(page, "attack-notready-phone.png");
    assert.deepEqual(errors, []);
    await page.close();
  }
  {
    const { page, errors } = await open({ width: 1280, mode: { approaches: "empty" } });
    await page.locator('#kpi [data-state="empty"]').waitFor();
    assert.match(await page.locator("#kpi").innerText(), /取得できました：直近90日のアタックは0件です/);
    assert.equal(await page.locator("#funnel").count(), 0, "0件で空の棒を描かない");
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS sales analytics charts UI: graphs on tab click (PC/390px), bar/legend → evidence, no refetch on tab return, error/not-ready/empty, escaping");
} finally {
  await browser.close();
}
