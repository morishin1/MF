// AI営業（/sales/ai.html）を、実際のブラウザで通す（API は偽物）。
//
// ■ 何を守るテストか
//   1. 企業を選ぶ → 「選択した企業を分析する」 → 分析完了（5社ずつ API を呼ぶ。50社まで）
//   2. 止まっているときは分析ボタンを押せず、理由を出す
//   3. 詳細：事実（出典つき）・推測・商材別の点・送信可否。要確認 → 「確認した」で確認済み
//   4. 営業文：作る → 承認を依頼する。承認待ち：承認者は承認・差し戻し（理由必須）。自分が関わったものは承認ボタンを出さない
//   5. 費用・設定：経営者は開始・停止・保存できる。営業担当は見るだけ
//   6. 1280・768・390 の幅で横にはみ出さない。JS エラーなし
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const NOW = new Date().toISOString();

const companies = Array.from({ length: 12 }, (_, i) => ({ id: `c${i + 1}`, name: `株式会社テスト${i + 1}`, industry: "製造", region: "東京都",
  siteUrl: i === 11 ? null : `https://t${i + 1}.example/`, status: "untouched" }));
const analysis = (cid, over = {}) => ({
  id: `an-${cid}`, companyId: cid, status: "ok", summary: "法人向けにPCを導入している会社", score: 72, bestService: "8EC・8RENT",
  services: [{ service: "8EC・8RENT", score: 72, reason: "PCの大量導入" }, { service: "ENGER", score: 30, reason: "" }],
  facts: [{ text: "社員120名", url: `https://x.example/company/` }], hypotheses: ["入替の時期"], uncertainties: ["売上は不明"],
  formUrl: "https://x.example/contact/", sendCheck: "manual_review", sendCheckLabel: "要確認",
  sendCheckReasons: [{ key: "confirm", label: "フォームの受付目的を確認してください" }], effective: true, effectiveReasons: [],
  pages: [{ kind: "top", url: "https://x.example/" }], createdAt: NOW, ...over,
});

async function open({ roles = ["sales"], apps = ["sales"], canApprove = false, canManage = false, enabled = true, width = 1280, pending = [] } = {}) {
  const calls = [];
  const state = { analyses: new Map(), drafts: new Map(), enabled, pending: pending.map((p) => ({ ...p })) };
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "s@8grp.co.jp" })));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "誤判定のため" : undefined));
  const settings = () => ({ enabled: state.enabled, stopLabel: state.enabled ? null : "AI営業は管理者が停止しています", pausedReason: state.enabled ? null : "manual",
    monthlyTargetUsd: 50, monthlyCapUsd: 100, dailyCapUsd: 10, dailyCompanyLimit: 100, effectiveThreshold: 60, signature: "株式会社エイト {{sender}}", bannedPhrases: [] });
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    const p = url.pathname;
    if (p === "/api/me") return send({ email: "s@8grp.co.jp", isAdmin: false, shows: {}, access: { sell: true },
      gw: { employee: { id: "e1", display_name: "営業 一郎", status: "active" }, roles, apps, isAdmin: false, tenantId: "t1" } });
    if (p === "/api/sales/ai/admin") {
      if (req.method() === "PATCH") {
        const b = body(); calls.push({ kind: "admin", body: b });
        if (b.action === "pause") state.enabled = false;
        if (b.action === "start") state.enabled = true;
        return send({ settings: settings() });
      }
      return send({ ready: true, configured: true, canManage, canApprove, models: { light: "claude-haiku-5-5", standard: "claude-sonnet-5-5" },
        costNote: "ここに出す費用は AI のトークン代だけです。Vercel・Supabase の費用は、それぞれの管理画面で確認してください",
        settings: settings(), pendingCount: state.pending.length, recentErrors: [],
        usage: { month: { committedUsd: 1.23, reservedUsd: 0.05, calls: 40, failures: 1, byPurpose: { analysis: { calls: 35, usd: 0.4, inputTokens: 300000, outputTokens: 60000 } } },
          today: { committedUsd: 0.2, reservedUsd: 0, calls: 5, failures: 0, byPurpose: { analysis: { calls: 5, usd: 0.02, inputTokens: 1, outputTokens: 1 } } } } });
    }
    if (p === "/api/sales/campaigns") return send({ campaigns: [{ id: "cp1", name: "PC販売・レンタル 秋" }] });
    if (p === "/api/sales/companies") { calls.push({ kind: "companies", q: Object.fromEntries(url.searchParams) }); return send({ companies, total: companies.length, page: 1, totalPages: 1 }); }
    if (p === "/api/sales/ai/analyze") {
      if (req.method() === "POST") {
        const b = body(); calls.push({ kind: "analyze", ids: b.companyIds });
        return send({ results: b.companyIds.map((cid) => { const a = analysis(cid); state.analyses.set(cid, a);
          return { companyId: cid, companyName: companies.find((c) => c.id === cid)?.name, result: "ok", analysis: a }; }), stopped: null });
      }
      if (req.method() === "PATCH") {
        const b = body(); calls.push({ kind: "sendcheck", body: b });
        const a = [...state.analyses.values()].find((x) => x.id === b.id);
        if (b.action === "send_check") { a.sendCheck = b.decision; a.sendCheckLabel = "確認済み"; }
        return send({ analysis: a });
      }
      if (url.searchParams.get("list")) {
        return send({ ready: true, analyses: [...state.analyses.values()].map((a) => ({ ...a, company: companies.find((c) => c.id === a.companyId),
          draft: state.drafts.get(a.companyId) ? { id: "d1", status: state.drafts.get(a.companyId).status } : null })) });
      }
      const cid = url.searchParams.get("companyId");
      return send({ ready: true, canApprove, canManage, meId: "u-me", analysis: state.analyses.get(cid) || null,
        drafts: state.drafts.get(cid) ? [state.drafts.get(cid)] : [] });
    }
    if (p === "/api/sales/ai/drafts") {
      if (req.method() === "POST") {
        const b = body(); calls.push({ kind: "draft", body: b });
        const d = { id: "d1", companyId: b.companyId, service: b.service, subject: "PCの入替のご相談", body: "{{company}} ご担当者様\n{{sender}}です。\n{{url}}",
          rationale: "PC導入の事実から", status: "draft", createdBy: "u-me", requestedBy: null };
        state.drafts.set(b.companyId, d);
        return send({ draft: d, warnings: [] });
      }
      if (req.method() === "PATCH") {
        const b = body(); calls.push({ kind: "draftAct", body: b });
        if (b.action === "reject" && !b.note) return send({ error: "note_required", hint: "差し戻す理由を書いてください" }, 400);
        for (const d of state.drafts.values()) if (d.id === b.id) d.status = { request: "pending", approve: "approved", reject: "rejected", edit: "draft" }[b.action] || d.status;
        state.pending = state.pending.filter((x) => x.id !== b.id);
        return send({ draft: { id: b.id } });
      }
      return send({ ready: true, canApprove, meId: "u-me", drafts: state.pending });
    }
    if (/\/api\/notifications/.test(p)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  return { page, calls, errs, state };
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

console.log("\n=== 企業を選ぶ → 分析する → 分析完了 ===");
{
  const { page, calls, errs } = await open();
  await page.goto(`${BASE}/sales/ai.html`);
  await page.locator("#c-rows tr", { hasText: "株式会社テスト12" }).waitFor();
  check((await page.locator("#c-rows tr").count()) === 12, "アタックする企業を一覧に出す");
  check(calls.some((c) => c.kind === "companies" && c.q.queue === "attack"), "アタックする企業（queue=attack）から選ぶ");
  check(await page.locator("#run-btn").isDisabled(), "選ぶまでは分析ボタンを押せない");
  check(await page.locator("#c-rows tr").nth(11).locator("input[type=checkbox]").isDisabled(), "サイトURLの無い企業は選べない");
  await page.locator("button", { hasText: "表示中をすべて選ぶ" }).click();
  check((await page.locator("#run-label").innerText()).includes("11社"), "選んだ社数がボタンに出る");
  await page.locator("#run-btn").click();
  await page.locator("#progress", { hasText: "分析完了" }).waitFor();
  const batches = calls.filter((c) => c.kind === "analyze");
  check(batches.length === 3 && batches.every((b) => b.ids.length <= 5), `5社ずつ API を呼ぶ（${batches.map((b) => b.ids.length).join(",")}）`);
  check((await page.locator("#run-results tbody tr").count()) === 11, "結果を一覧で出す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);

  console.log("\n=== 詳細：要確認 → 確認した → 営業文を作る → 承認を依頼する ===");
  await page.locator("#run-results button", { hasText: "詳細・営業文" }).first().click();
  await page.locator(".ai-detail h2").waitFor();
  check((await page.locator(".ai-detail").innerText()).includes("社員120名"), "事実を出す");
  check(await page.locator(".ai-detail a", { hasText: "出典" }).count() >= 1, "出典のリンク");
  check((await page.locator(".ai-detail").innerText()).includes("（推測）入替の時期"), "推測は分けて出す");
  await page.locator(".ai-detail button", { hasText: "受付目的・禁止の記載を確認した" }).click();
  await page.waitForTimeout(300);
  check(calls.some((c) => c.kind === "sendcheck" && c.body.decision === "ok_manual"), "確認した → 確認済み");
  await page.locator(".ai-detail button", { hasText: "AI で営業文を作る" }).click();
  await page.locator("#d-body").waitFor();
  check(calls.some((c) => c.kind === "draft" && c.body.service === "8EC・8RENT"), "合う商材で営業文を作る");
  check((await page.locator("#d-body").inputValue()).includes("{{url}}"), "差し込み前の本文を出す");
  await page.locator(".ai-detail button", { hasText: "承認を依頼する" }).click();
  await page.waitForTimeout(400);
  check(calls.some((c) => c.kind === "draftAct" && c.body.action === "request"), "承認を依頼する");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 止まっているとき ===");
{
  const { page, errs } = await open({ enabled: false });
  await page.goto(`${BASE}/sales/ai.html`);
  await page.locator("#c-rows tr", { hasText: "株式会社テスト1" }).first().waitFor();
  check((await page.locator("#ai-stopped").innerText()).includes("停止"), "止まっている理由を出す");
  await page.locator("#c-rows input[type=checkbox]").first().check();
  check(await page.locator("#run-btn").isDisabled(), "選んでも分析ボタンは押せない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 承認待ち：承認者は承認・差し戻し（理由必須）。自分が関わったものは承認できない ===");
const PENDING = [
  { id: "p1", status: "pending", service: "8EC・8RENT", requestedByName: "営業 一郎", selfInvolved: false, rationale: "理由",
    company: { id: "c1", name: "株式会社テスト1", siteUrl: "https://t1.example/" }, warnings: ["「必ず」を含んでいます"],
    preview: { subject: "件名", body: "株式会社テスト1 ご担当者様\n（送る担当者の名前）です。\nhttps://…/r/（専用URL）\n\n株式会社エイト" },
    analysis: { score: 72, sendCheckLabel: "要確認", summary: "概要", facts: [{ text: "社員120名", url: "https://t1.example/" }] } },
  { id: "p2", status: "pending", service: "ENGER", requestedByName: "責任 花子", selfInvolved: true,
    company: { id: "c2", name: "株式会社テスト2" }, warnings: [], preview: { subject: null, body: "本文" }, analysis: null },
];
{
  const { page, calls, errs } = await open({ roles: ["manager"], canApprove: true, pending: PENDING });
  await page.goto(`${BASE}/sales/ai.html?tab=approve`);
  await page.locator("#ap-p1").waitFor();
  check((await page.locator("#ap-p1").innerText()).includes("株式会社エイト"), "署名つきの見本を出す");
  check((await page.locator("#ap-p1").innerText()).includes("「必ず」を含んでいます"), "注意の言い回しを出す");
  check(!(await page.locator("#ap-p2 button", { hasText: "承認する" }).count()), "自分が関わった営業文には承認ボタンを出さない");
  check((await page.locator("#ap-p2").innerText()).includes("承認できません"), "理由を出す");
  await page.locator("#ap-p1 button", { hasText: "差し戻す" }).click();
  check((await page.locator("#msg-p1").innerText()).includes("理由"), "差し戻しは理由が必須");
  check(!calls.some((c) => c.kind === "draftAct"), "理由が無ければ送らない");
  await page.locator("#ap-p1 button", { hasText: "承認する" }).click();
  await page.waitForTimeout(400);
  check(calls.some((c) => c.kind === "draftAct" && c.body.action === "approve" && c.body.id === "p1"), "承認する");
  check(!(await page.locator("#ap-p1").count()), "承認したら一覧から消える");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}
{
  const { page, errs } = await open({ pending: PENDING });
  await page.goto(`${BASE}/sales/ai.html?tab=approve`);
  await page.locator("#ap-p1").waitFor();
  check(!(await page.locator("button", { hasText: "承認する" }).count()), "営業担当には承認ボタンを出さない");
  check((await page.locator(".banner.info").innerText()).includes("経営者・営業責任者"), "承認できる人を案内する");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 費用・設定 ===");
{
  const { page, calls, errs } = await open({ roles: ["owner"], canManage: true, canApprove: true });
  await page.goto(`${BASE}/sales/ai.html?tab=admin`);
  await page.locator("#s-cap").waitFor();
  check((await page.locator("#kpi-month").innerText()) === "$1.28", "今月の費用（確定＋予約中）");
  check((await page.locator("#panel").innerText()).includes("Vercel・Supabase の費用は"), "AI 以外の費用は別と書く");
  await page.locator("button", { hasText: "停止する" }).click();
  await page.waitForTimeout(400);
  check(calls.some((c) => c.kind === "admin" && c.body.action === "pause"), "停止する");
  await page.locator("#s-cap").fill("80");
  await page.locator("button", { hasText: "設定を保存する" }).click();
  await page.waitForTimeout(400);
  check(calls.some((c) => c.kind === "admin" && c.body.action === "settings" && c.body.monthlyCapUsd === 80), "設定を保存する");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}
{
  const { page, errs } = await open();
  await page.goto(`${BASE}/sales/ai.html?tab=admin`);
  await page.locator("#s-cap").waitFor();
  check(await page.locator("#s-cap").isDisabled(), "営業担当は設定を変えられない");
  check(!(await page.locator("button", { hasText: "停止する" }).count()), "営業担当には停止ボタンを出さない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 幅（1280・768・390）で横にはみ出さない ===");
for (const width of [1280, 768, 390]) {
  for (const tab of ["analyze", "results", "approve", "admin"]) {
    const { page, errs } = await open({ width, canApprove: true, pending: PENDING });
    await page.goto(`${BASE}/sales/ai.html?tab=${tab}`);
    await page.waitForTimeout(600);
    check(await noOverflow(page), `${width}px ${tab}：横にはみ出さない`);
    check(!errs.length, `${width}px ${tab}：JSエラーなし ${errs.join(" / ")}`);
    await page.close();
  }
}

await br.close();
console.log(bad ? `\nNG ${bad} 件` : "\nAI営業の画面は期待どおりです");
process.exit(bad ? 1 : 0);
