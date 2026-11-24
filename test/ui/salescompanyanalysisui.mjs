// Read-only company analysis: evidence, source links, escaping, and responsive use.
// All company/proposal records below are test fixtures, never operational data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const source = await readFile(new URL("../../js/sales-proposal-company-analysis.js", import.meta.url), "utf8");
const css = await readFile(new URL("../../css/sales-proposal-company-analysis.css", import.meta.url), "utf8");
const design = await readFile(new URL("../../css/sales-design.css", import.meta.url), "utf8");
const uid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const unsafe = '<img src=x onerror="window.__unsafe=true">';
const historical = {
  key: "enger:" + uid(1), name: "過去実績のテスト企業 " + unsafe,
  identity: { kind: "name", label: "企業名で照合" }, history: { total: 8, active: 0, passed: 3, won: 1, lost: 4, unknownSent: 8 },
  metrics: { sent: 0, meetings: 0, passed: 0, failed: 0, resultKnown: 0, resultDue: 0, resultPending: 0, meetingRate: null, passRate: null, resultCoverage: null },
  causes: [{ code: "skill", label: "スキル不一致 " + unsafe, count: 2 }], phases: [{ code: "interview", label: "面談後", count: 2 }],
  sides: [{ code: "job", label: "案件側", count: 2 }], latest: { at: "2026-11-20T02:00:00Z", label: "合格の履歴" },
  next: { label: "見送り理由を確認", detail: "記録の補足をENGERで確認", sourceProposalId: uid(11) },
};
const current = {
  ...historical, key: "enger:" + uid(2), name: "進行中のテスト企業", identity: { kind: "id", label: "企業IDで照合" },
  history: { total: 10, active: 3, passed: 2, won: 0, lost: 2, unknownSent: 0 },
  metrics: { sent: 10, meetings: 4, passed: 2, failed: 1, resultKnown: 3, resultDue: 4, resultPending: 1, meetingRate: 40, passRate: 66.7, resultCoverage: 75 },
};
const linkedProposal = {
  key: "enger:" + uid(11), sourceProposalId: uid(11), source: "enger", jobTitle: "履歴の案件 " + unsafe, talentName: "A.A.",
  sentAt: null, proposedAt: "2025-09-01", currentStage: "合格", meetingLabel: "面談実施", resultLabel: "合格",
  lossReason: "未確認", lossPhase: "未確認", lossSide: "未確認", ownerName: "テスト担当", unknownSent: true,
  identity: { kind: "name", label: "企業名の完全一致で照合" },
  href: "https://dx.enger.jp/proposals/" + uid(11),
};
const invalidLink = { ...linkedProposal, key: "enger:" + uid(12), sourceProposalId: uid(12), jobTitle: "不正なリンクの記録",
  currentStage: "提案中", lossIsCurrent: false, lossReason: "開始日不一致", lossPhase: "提案後", lossSide: "案件側", href: "javascript:window.__unsafe=true" };
const manualProposal = { ...linkedProposal, source: "sales", sourceProposalId: null, salesProposalId: uid(21), key: "sales:" + uid(21), jobTitle: "手入力の過去記録", href: "/sales/proposals.html?id=" + uid(21) };
const model = {
  companies: [historical, current], summary: { companies: 2, proposals: 18, sent: 10, meetings: 4, passed: 5, won: 1, lost: 6, resultPending: 1, unknownSent: 8 },
  filters: { services: ["SES", "unknown"], owners: [{ id: uid(40), name: "テスト担当" }] }, period: { key: "this_month", label: "今月" },
  pagination: { page: 1, pageSize: 20, total: 2, pages: 1 },
  dataStatus: { engerAvailable: true, notes: ["送信日未確認の過去履歴を区別しています。"], observedAt: "2026-11-24T01:00:00Z" },
};
const browser = await launch();
let page;
try {
  page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("http://sales.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="sales-page"><div class="wrap"><div id="host"></div></div></body></html>' }));
  await page.goto("http://sales.test/");
  await page.addStyleTag({ content: design + "\n" + css });
  await page.addScriptTag({ content: source });
  await page.evaluate(({ model, linkedProposal, invalidLink, manualProposal }) => {
    window.__calls = []; window.__states = []; window.__manual = []; window.__failList = false;
    window.SalesProposalCompanyAnalysis.mount(document.getElementById("host"), {
      api: async url => {
        window.__calls.push(url);
        const params = new URL(url, location.origin).searchParams;
        if (window.__failList === "forbidden" && !params.has("company")) throw Object.assign(new Error("forbidden"), { status: 403 });
        if (window.__failList && !params.has("company")) throw new Error("確認用の読取エラー");
        if (window.__empty) return { ...model, companies: [], summary: Object.fromEntries(Object.keys(model.summary).map(key => [key, 0])), pagination: { page: 1, pageSize: 20, total: 0, pages: 0 } };
        if (params.has("company")) {
          const company = model.companies.find(item => item.key === params.get("company"));
          const nextPage = Number(params.get("page") || 1);
          return { ...model, company: { ...company,
            proposals: nextPage === 1 ? [linkedProposal, invalidLink] : [manualProposal],
            interactions: [{ key: "note", at: "2026-11-20T02:00:00Z", label: "企業からの回答", detail: '<svg onload="window.__unsafe=true">回答内容</svg>', sourceProposalId: linkedProposal.sourceProposalId }],
            interactionsLimited: false, interactionsTotal: 1,
            detailPagination: { page: nextPage, pageSize: 2, total: 3, pages: 2 } } };
        }
        return { ...model, period: { ...model.period, key: params.get("period") || "all" } };
      },
      onStateChange: state => window.__states.push(state),
      onOpenProposal: id => window.__manual.push(id),
    });
  }, { model, linkedProposal, invalidLink, manualProposal });
  await page.evaluate(() => window.SalesProposalCompanyAnalysis.load({ period: "this_month" }));
  assert.equal(await page.locator(".spca-table tbody tr").count(), 2, "企業ごとに表示する");
  const pastRow = page.locator(".spca-table tbody tr").first();
  assert.match(await pastRow.innerText(), /合格\s+3件/, "送信日不明の過去合格を表示する");
  assert.match(await pastRow.locator(".spca-metric").first().innerText(), /対象なし/, "分母0を対象なしとして区別する");
  assert.ok(!(await pastRow.locator(".spca-metric").first().innerText()).includes("0%"), "未確認の率を0%にしない");
  assert.match(await page.locator(".spca-period-note").innerText(), /送信日未確認 8件/, "率の対象外を明示する");
  assert.match(await page.locator(".spca-period-note").innerText(), /送信前の検討・見送りも含みます/, "全履歴を企業への送信済み件数と誤認させない");
  assert.equal(await page.locator("#host img").count(), 0, "企業名のHTMLを実行しない");
  await page.screenshot({ path: shotPath("sales-company-analysis-pc.png"), fullPage: true });
  await page.locator(".spca-extra summary").click();
  assert.ok(await page.locator(".spca-extra").evaluate(element => element.open), "サービス・担当の絞り込みを開ける");
  for (const label of ["送信した期間", "絞り込み", "並び順", "サービス", "担当"]) {
    assert.equal(await page.getByLabel(label, { exact: true }).count(), 1, label + "の選択欄をラベルで一意に識別できる");
  }
  const serviceFilter = page.getByLabel("サービス", { exact: true });
  assert.ok(await serviceFilter.isVisible(), "絞り込みを開くとサービスを選択できる");
  await serviceFilter.selectOption({ label: "事業未確認" });
  await page.waitForFunction(() => document.getElementById("host").getAttribute("aria-busy") === "false" && window.__states.at(-1)?.service === "unknown");
  assert.equal(await serviceFilter.locator("option:checked").textContent(), "事業未確認", "選択中の事業未確認を日本語で表示する");
  assert.equal(await page.evaluate(() => new URL(window.__calls.at(-1), location.origin).searchParams.get("service")), "unknown", "事業未確認の選択を企業分析APIに渡す");
  await serviceFilter.selectOption("");
  await page.waitForFunction(() => document.getElementById("host").getAttribute("aria-busy") === "false" && window.__states.at(-1)?.service === "");
  await page.locator(".spca-extra summary").click();
  await pastRow.getByRole("button").click();
  await page.locator(".spca-proposal").first().waitFor();
  assert.ok(await page.locator(".spca-dialog").isVisible(), "企業行から分析を開く");
  assert.match(await page.locator(".spca-all-history summary").innerText(), /合格 3件/, "モーダルでも過去合格を常時表示する");
  await page.locator(".spca-proposal summary").first().click();
  assert.match(await page.locator(".spca-proposal").first().innerText(), /企業の照合\s*企業名の完全一致で照合/, "個別提案にも企業名で照合した根拠を表示する");
  assert.equal(await page.locator(".spca-proposal").first().getByRole("link", { name: "ENGERで確認" }).getAttribute("href"), linkedProposal.href, "確認先は元のENGER提案");
  await page.locator(".spca-proposal summary").nth(1).click();
  assert.equal(await page.locator(".spca-proposal").nth(1).getByRole("link").count(), 0, "不正な確認リンクを表示しない");
  assert.match(await page.locator(".spca-proposal").nth(1).innerText(), /過去の見送り理由/, "再開済みの提案では過去の見送り記録と分ける");
  assert.equal(await page.locator(".spca-dialog img").count(), 0, "詳細の案件名もHTMLとして解釈しない");
  const causeTab = page.getByRole("tab", { name: "見送り理由", exact: true });
  await causeTab.click();
  assert.match(await page.locator("#spca-panel-causes").innerText(), /スキル不一致/, "記録された原因を読める");
  assert.equal(await page.locator("#spca-panel-causes img").count(), 0, "原因のHTMLを実行しない");
  await causeTab.press("ArrowRight");
  assert.equal(await page.getByRole("tab", { name: "やり取り", exact: true }).getAttribute("aria-selected"), "true", "矢印キーで企業詳細のタブを切り替える");
  await page.locator(".spca-interaction summary").click();
  assert.equal(await page.locator(".spca-dialog svg").count(), 0, "連絡履歴をHTMLとして解釈しない");
  await page.getByRole("tab", { name: "提案履歴", exact: true }).click();
  await page.locator(".spca-dialog").getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByText("手入力の過去記録", { exact: true }).waitFor();
  const detailCalls = await page.evaluate(() => window.__calls.filter(url => new URL(url, location.origin).searchParams.has("company")));
  assert.equal(new URL(detailCalls.at(-1), "http://sales.test").searchParams.get("page"), "2", "企業の履歴を次ページへ進める");
  assert.equal(new URL(detailCalls.at(-1), "http://sales.test").searchParams.get("period"), "this_month", "履歴ページでも対象期間を維持する");
  await page.locator(".spca-proposal summary").click();
  await page.getByRole("button", { name: "Salesの記録を確認", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__manual), [manualProposal.salesProposalId], "手入力の旧記録は既存の確認先へ渡す");
  assert.ok(!(await page.locator(".spca-dialog").isVisible()), "旧記録を開く前に分析モーダルを閉じる");
  await page.evaluate(key => window.SalesProposalCompanyAnalysis.load({ company: key }), historical.key);
  await page.locator(".spca-proposal").first().waitFor();
  assert.ok(await page.locator(".spca-dialog").isVisible(), "company付きの初期状態から企業分析を開ける");
  await page.keyboard.press("Escape");
  assert.ok(!(await page.locator(".spca-dialog").isVisible()), "Escapeで閉じる");
  assert.equal(await page.evaluate(() => window.__states.at(-1).company), "", "閉じた企業をURL同期状態から外す");
  await page.locator('[data-spca-filter="q"]').fill('React & "条件"');
  await page.waitForFunction(() => window.__calls.some(url => new URL(url, location.origin).searchParams.get("q") === 'React & "条件"'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator(".spca-company-cards").isVisible(), "390pxでは企業カードを表示する");
  assert.ok(!(await page.locator(".spca-table-wrap").isVisible()), "390pxでは横長の表を隠す");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "企業一覧が横にはみ出さない");
  await page.screenshot({ path: shotPath("sales-company-analysis-mobile.png"), fullPage: true });
  await page.locator(".spca-company-card").first().getByRole("button").click();
  await page.locator(".spca-proposal").first().waitFor();
  assert.ok(await page.locator(".spca-dialog").evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), "企業分析モーダルが390px幅に収まる");
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false, "データ内のスクリプトは実行されない");
  await page.screenshot({ path: shotPath("sales-company-analysis-detail-mobile.png") });
  await page.getByRole("button", { name: "企業分析を閉じる" }).click();
  await page.evaluate(async () => { window.__failList = true; await window.SalesProposalCompanyAnalysis.refresh(); });
  assert.match(await page.locator(".spca-error").innerText(), /読取エラー/, "読取エラーを空の実績に置き換えない");
  assert.equal(await page.locator(".spca-summary").innerText(), "", "エラー時に前条件の実績を表示し続けない");
  await page.evaluate(() => { window.__failList = false; });
  await page.getByRole("button", { name: "再読み込み", exact: true }).click();
  await page.locator(".spca-company-card").first().waitFor();
  await page.evaluate(async () => { window.__failList = "forbidden"; await window.SalesProposalCompanyAnalysis.refresh(); });
  assert.match(await page.locator(".spca-error").innerText(), /閲覧する権限がありません/, "403を日本語で説明する");
  await page.evaluate(async () => { window.__failList = false; window.__empty = true; await window.SalesProposalCompanyAnalysis.refresh(); });
  assert.match(await page.locator(".spca-results").innerText(), /条件に合う企業がありません/, "実績が空の場合と読取失敗を分ける");
  assert.deepEqual(errors, [], "実行時エラーなし");
  assert.ok((await page.evaluate(() => window.__calls)).every(url => url.startsWith("/api/sales/proposals/company-analysis?")), "分析画面は読み取りAPIだけを呼ぶ");
  console.log("PASS sales company analysis UI: evidence, source links, XSS, pagination, keyboard, mobile, and errors");
} catch (error) {
  if (page && !page.isClosed()) {
    console.error("Company analysis UI state:", await page.evaluate(() => ({
      filtersOpen: document.querySelector(".spca-extra")?.open,
      filters: [...document.querySelectorAll("[data-spca-filter]")].map(element => ({ key: element.dataset.spcaFilter, label: element.getAttribute("aria-label"), value: element.value })),
      dialogOpen: document.querySelector(".spca-dialog")?.open,
    })).catch(() => null));
    await page.screenshot({ path: shotPath("sales-company-analysis-failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await page?.close();
  await browser.close();
}
