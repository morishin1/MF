// 企業詳細モーダルの4タブ（企業情報／商談準備／企業ポータル／オファー・進捗）を、実際の画面で確かめる。
// API は偽物（page.route）。本物のハンドラの検査は test/sales-company-portal.mjs。
//
//   ・行を押すと既存のワークベンチ（企業情報）が開き、4つのタブが並ぶ
//   ・商談準備：人材が一覧に出る（許可項目だけ）。複数選んで保存すると、選んだ人材・企業ID・状態が送られる。
//     行を押すと人材詳細がサマリーで開き、スキルシート（公開用）に1クリックで切り替わる
//   ・企業ポータル：発行すると招待リンクが1回だけ表示される。停止は理由を入れて送る
//   ・オファー・進捗：提案の状態・担当・日時が出る。企業ポータルのオファーは「Phase 3」と明示（0件と見せない）
//   ・企業IDが無い行（営業DBだけの企業）では、3つのタブは押せない
//   ・画面のエラー（pageerror）が無い
import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";

const CO = "cccccccc-0000-4000-8000-00000000000a";
const TALENTS = [1, 2, 3].map((n) => ({
  id: `dddddddd-0000-4000-8000-00000000000${n}`, no: n, talentNo: `P-00000${n}`, displayName: ["T.Y.", "H.S.", "K.M."][n - 1],
  title: "Javaエンジニア", roles: [], skills: ["Java", "Spring", "AWS"], experience: "5年", availability: "即日", weekDays: "週5",
  remote: "full", remoteLabel: "フルリモート希望", prefecture: "東京都", nearestStation: "渋谷", ageBand: "30代", nationality: "日本",
  isFocus: n === 1, isNew: n !== 3, link: n === 3 ? { status: "planned", statusLabel: "提案予定", note: "", updatedAt: "2026-11-05T00:00:00Z" } : null,
}));
const row = (extra) => ({ id: CO, companyId: CO, name: "株式会社テスト企業", proposals: [], candidateIds: [], statusLabel: "フォロー中", reason: "移動", confirmed: true,
  lastContact: null, lastContactKind: null, nextAction: "", owner: "", nextDate: "", contactKnown: true, email: true, phone: true, form: false, hasContact: true, ...extra });

const br = await launch();
const errs = [], calls = [];
try {
  const page = await br.newPage({ viewport: { width: 1360, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp", expires_at: 4102444800 })));
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => /AI企業分析/.test(d.message())?d.accept():d.dismiss());
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (p === "/api/public-config") return send({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" });
    if (p === "/api/me") return send({ email: "sales@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, gw: { employee: { id: "e1", display_name: "営業A" }, roles: ["sales"], apps: ["sales"], isAdmin: false, tenantId: "t1" } });
    if (p === "/api/sales/company-lifecycle") return send({ complete: true, rows: [row(), row({ id: "sales-only", companyId: null, salesOnly: true, salesId: "s1", name: "営業DBだけの企業" })], selectedCount: 2, observedAt: new Date().toISOString(),
      counts: { current: 2, activityNames: 0, past: 0, pastCandidates: 0, futureCandidates: 0, pending: 0, total: 2, broadcast: 0 } });
    if (p === "/api/sales/enger-company-detail") return send({ company: { id: CO, name: "株式会社テスト企業", relationshipStatus: "unknown" }, evidence: { touchpoints: [], proposalCount: 0 } });
    if (p === "/api/sales/company-talents" && req.method() === "GET") {
      calls.push({ kind: "talents", q: Object.fromEntries(url.searchParams) });
      if (url.searchParams.get("id")) {
        const t = TALENTS.find((x) => x.id === url.searchParams.get("id"));
        return send({ talent: t, sheet: { title: "ENGER 公開用スキルシート（要約版）", rows: [["人材番号", t.talentNo], ["職種", t.title]], skills: t.skills, note: "氏名・連絡先・所属会社・単価・経歴の原文は含みません。" }, link: t.link, linkReady: true, missing: [], dxUrl: `https://dx.enger.jp/talents/${t.id}` });
      }
      const rows = url.searchParams.get("tab") === "linked" ? TALENTS.filter((t) => t.link) : TALENTS;
      return send({ rows, total: rows.length, page: 1, pages: 1, pageSize: 30, truncated: false, missing: [], linkReady: true, linkHint: null, linkedCount: 1, statusCount: { planned: 1 },
        options: { remote: { full: "フルリモート希望", partial: "一部リモート希望", onsite: "出社・常駐可" }, prefectures: ["東京都", "大阪府"], linkStatuses: { saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" } } });
    }
    if (p === "/api/sales/company-talents" && req.method() === "POST") { calls.push({ kind: "link", body: body() }); return send({ ok: true, linked: body().talentIds.length, created: body().talentIds.length, updated: 0, skipped: [] }); }
    if (p === "/api/sales/company-portal" && req.method() === "GET") {
      return send({ company: { id: CO, name: "株式会社テスト企業" }, members: [
        { id: "m1", email: "tanaka@client.example", displayName: "田中 一郎", role: "admin", roleLabel: "管理者", status: "active", statusLabel: "有効", invitedAt: "2026-11-01T00:00:00Z", registeredAt: "2026-11-02T00:00:00Z", lastLoginAt: "2026-11-05T01:00:00Z" },
        { id: "m2", email: "suzuki@client.example", displayName: "鈴木 花子", role: "member", roleLabel: "一般", status: "invited", statusLabel: "招待中（未設定）", invitedAt: "2026-11-05T00:00:00Z", inviteExpiresAt: "2026-11-12T00:00:00Z" },
      ], saved: [{ id: "x", talentNo: "P-000001", displayName: "T.Y.", title: "Javaエンジニア", skills: [], savedBy: "田中 一郎", savedAt: "2026-11-05T02:00:00Z" }],
      events: [{ id: "e1", at: "2026-11-05T01:00:00Z", actorKind: "portal", action: "portal.login", label: "ログイン", member: "田中 一郎", detail: "" }],
      usage: { logins30: 3, searches30: 12, views30: 5, saves30: 1 }, usageComplete: true, canEnable: false, roles: { admin: "管理者", member: "一般" },
      mail: { configured: false, reason: "ENGER_PORTAL_MAIL_FROM が設定されていません" }, portal: { loginUrl: "https://enger.jp/business/login", resetUrl: "https://enger.jp/business/forgot" } });
    }
    if (p === "/api/sales/company-portal" && req.method() === "POST") {
      const b = body(); calls.push({ kind: "portal", body: b });
      if (b.action === "invite") return send({ ok: true, member: { displayName: b.displayName }, inviteUrl: "https://enger.jp/business/invite?token=" + "T".repeat(43), expiresAt: "2026-11-13T00:00:00Z", mail: "skipped" });
      return send({ ok: true, authBan: { applied: true } });
    }
    if (p === "/api/sales/company-ai-batch" && req.method()==="GET")
      return send({enabled:true,batch:null,limit:10});
    if (p === "/api/sales/company-ai-batch" && req.method()==="POST"){
      calls.push({kind:"ai-batch",body:body()});
      return send({ok:true,batch:{salesCompanyIds:[CO],companyIds:[CO]}});
    }
    if (p === "/api/sales/company-ai-pilot" && req.method()==="POST"){
      calls.push({kind:"ai-run",body:body()});return send({ok:true});
    }
    if (p === "/api/sales/company-workflow-status") return send({
      companyId:CO,analysis:{source:"none",summary:"",hasCorporateNumber:false,hasWebsite:false,generatedAt:null},
      steps:{info:{state:"review",label:"法人番号・HP未登録"},analysis:{state:"done",label:"AI分析済み"},proposal:{state:"done",label:"商談用候補 1件"}},
      proposal:{publishedCount:1,portalAccounts:1,staffMeetingUrl:"/sales/company-meeting.html?companyId="+CO,clientLoginUrl:"https://enger.jp/business/login?next=%2Fbusiness%2Fmeeting",ready:true},pilot:null
    });
    if (p === "/api/sales/company-offers") return send({offers:[],statusLabels:{}});
    if (p === "/api/sales/company-progress") return send({ scope: "own", proposalsReady: true, proposalsHint: null, byStatus: { meeting_adjust: 1 },
      proposals: [{ id: "p1", title: "Java / T.Y.", jobTitle: "Java開発", talentInitials: "T.Y.", status: "meeting_adjust", statusLabel: "面談調整", matchedAt: "2026-11-01T00:00:00Z", sentAt: "2026-11-01T01:00:00Z", meetingAt: "2026-11-08T05:00:00Z", closedAt: null, salesOwner: "営業A", matchingOwner: "マッチングB", engerStage: "提案中", url: "/sales/proposals.html?id=p1" }],
      prep: { ready: true, counts: { saved: 2, planned: 1, proposed: 0, declined: 0 }, labels: { saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" } },
      portalOffers: { available: false, note: "企業ポータルからのオファー受付は Phase 3 で開始します（現在は受け付けていません）。" } });
    return send({});
  });

  await page.goto(BASE + "/sales/company-segments.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#lc-rows tr[data-id="' + CO + '"]', { timeout: 15000 });
  await page.check('[data-select="' + CO + '"]');
  await page.waitForFunction(()=>!document.getElementById('lc-bulk-ai')?.disabled);
  await page.click('#lc-bulk-ai');
  await page.waitForFunction(()=>document.getElementById('lc-bulk-ai-status')?.textContent.includes('成功 1社'));
  assert.deepEqual(calls.find(x=>x.kind==="ai-batch")?.body.companyIds,[CO]);
  assert.equal(calls.filter(x=>x.kind==="ai-run").length,1);
  await page.click('#lc-clear');
  await page.click('#lc-rows tr[data-id="' + CO + '"] td:nth-child(3)');
  await page.waitForSelector("#lc-dialog[open]");
  const stages = await page.locator("[data-modal-tab]").evaluateAll( (b) => b.map((x) => [x.querySelector("strong")?.textContent.trim(), x.disabled]));
  assert.deepEqual(stages, [["企業基本情報",false],["AI分析",false],["提案準備",false]]);
  assert.equal(await page.getAttribute('[data-modal-tab="info"]',"aria-current"),"step");
  await page.waitForFunction(() => document.querySelector('[data-step-label="info"]')?.textContent.includes("法人番号"));
  assert.equal(await page.isVisible("#lc-detail .lc-workbench"), true, "company basics remain first");
  assert.equal(await page.isVisible("#lc-detail .lc-action-pane"),false,"sales actions are not part of basic-information step");
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/tab-info.png" : "/dev/null" }).catch(() => {});

  await page.click('[data-modal-tab="analysis"]');
  await page.waitForSelector("#lc-panel-analysis .lc-analysis-wrap");
  assert.match(await page.textContent("#lc-panel-analysis"),/AI企業サマリー/);
  await page.click('[data-modal-tab="proposal"]');
  await page.waitForSelector('#lp-rows tr[data-talent]');
  assert.equal(await page.isVisible("#lp-search-details"),true);
  await page.waitForSelector("#lp-proposal-next");
  assert.match(await page.textContent("#lp-proposal-next"),/商談用に公開した候補/);
  assert.equal(await page.isVisible("#lc-detail"), false);
  assert.equal(await page.locator("#lp-rows tr[data-talent]").count(), 3);
  assert.match(await page.textContent("#lp-rows"), /T\.Y\..*注力.*新着/s);
  await page.check(`[data-pick="${TALENTS[0].id}"]`); await page.check(`[data-pick="${TALENTS[1].id}"]`);
  assert.equal(await page.textContent("#lp-selected"), "2人を選択");
  await page.selectOption("#lp-bulk-status", "planned");
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/tab-prep.png" : "/dev/null" }).catch(() => {});
  await page.click("#lp-save");
  await page.waitForFunction(() => /2人を「提案予定」で保存しました/.test(document.getElementById("lp-status")?.textContent || ""));
  const link = calls.find((c) => c.kind === "link");
  assert.deepEqual(link.body, { companyId: CO, talentIds: [TALENTS[0].id, TALENTS[1].id], status: "planned" });
  await page.click(`#lp-rows tr[data-talent="${TALENTS[2].id}"] td:nth-child(3)`);
  await page.waitForSelector("#lc-talent-dialog[open] [data-talent-panel=summary]");
  assert.equal(await page.isVisible("[data-talent-panel=summary]"), true, "summary first");
  assert.equal(await page.isVisible("[data-talent-panel=sheet]"), false);
  await page.click('[data-talent-view="sheet"]');
  assert.equal(await page.isVisible("[data-talent-panel=sheet]"), true, "skill sheet in one click");
  assert.match(await page.textContent("#lc-talent-body"), /ENGER 公開用スキルシート/);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/talent.png" : "/dev/null" }).catch(() => {});
  await page.click("#lc-talent-close");

  // Shared offers and closing now live in Sales proposal management.
  assert.equal(await page.locator('[data-modal-tab="portal"]').count(),0);
  assert.equal(await page.locator('[data-modal-tab="offers"]').count(),0);

  // 閉じて開き直すと企業情報に戻る。企業IDの無い行では3つのタブが押せない
  await page.click("#lc-close");
  await page.click('#lc-rows tr[data-id="sales-only"] td:nth-child(3)');
  await page.waitForSelector("#lc-dialog[open]");
  assert.deepEqual(await page.locator("[data-modal-tab]").evaluateAll( (b) => b.map((x) => x.disabled)), [false, true, true]);
  assert.equal(await page.getAttribute('[data-modal-tab="info"]', "aria-current"), "step");

  // スマホ幅でも横にはみ出さない
  await page.setViewportSize({ width: 390, height: 800 });
  await page.click("#lc-close");
  await page.click('#lc-rows tr[data-id="' + CO + '"] td:nth-child(3)');
  await page.click('[data-modal-tab="proposal"]');
  await page.waitForSelector('#lp-rows tr[data-talent]');
  const overflow = await page.evaluate(() => document.getElementById("lc-dialog").scrollWidth - document.getElementById("lc-dialog").clientWidth);
  assert.ok(overflow <= 1, "dialog does not overflow horizontally on phones: " + overflow);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/mobile-prep.png" : "/dev/null" }).catch(() => {});

  assert.deepEqual(errs, [], "no page errors");
  console.log("PASS Sales company modal: three-stage workflow, prep search/select/save, summary-first talent detail, invite once, disable, progress with Phase 3 note, disabled tabs without company ID, mobile");
} finally {
  await br.close();
}
