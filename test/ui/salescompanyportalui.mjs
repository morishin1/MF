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
import { shotPath } from "../_shot.mjs";

const CO = "cccccccc-0000-4000-8000-00000000000a";
const JOB="eeeeeeee-0000-4000-8000-000000000001";
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
let singleCompanyScenario=false,companyAiDone=false;
const salesAttributes={status:"新規",tags:["source:external-import","role:end_client","flag:dispatch_license"]};
try {
  const page = await br.newPage({ viewport: { width: 1360, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp", expires_at: 4102444800 })));
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => /AI企業分析|商談用に準備|現在のパスワードを無効/.test(d.message())?d.accept():d.dismiss());
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (p === "/api/public-config") return send({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" });
    if (p === "/api/me") return send({ email: "sales@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, gw: { employee: { id: "e1", display_name: "営業A" }, roles: ["sales"], apps: ["sales"], isAdmin: false, tenantId: "t1" } });
    if (p === "/api/sales/company-lifecycle") return send({ complete: true, rows: [row(), row({ id: "sales-only", companyId: null, salesOnly: true, salesId: "s1", name: "営業DBだけの企業" })], selectedCount: 2, observedAt: new Date().toISOString(),
      counts: { current: 2, activityNames: 0, past: 0, pastCandidates: 0, futureCandidates: 0, pending: 0, total: 2, broadcast: 0 } });
    if (p === "/api/sales/enger-company-detail") return send({ company: { id: CO, name: "株式会社テスト企業", status:salesAttributes.status,tags:[...salesAttributes.tags],relationshipStatus: "unknown",contactName:"田中",contactEmail:"tanaka@example.test",phone:"03-1234-5678" }, evidence: { touchpointCount:2,touchpoints:[
      {id:"meeting-1",occurredAt:"2026-11-10T01:00:00Z",kind:"商談",summary:"商談後の提案確認",detail:"結果を確認",nextAction:"候補を確認"},
      {id:"phone-1",occurredAt:"2026-11-09T01:00:00Z",kind:"電話",summary:"電話連絡",detail:"既存の電話履歴"},
    ], proposalCount: 0 } });
    if (p === "/api/sales/company-workbench" && req.method() === "GET") return send({activities:[],nextBefore:null,override:{}});
    if (p === "/api/sales/company-workbench" && req.method() === "PATCH") {
      const b=body();calls.push({kind:"sales-attributes",body:b});
      if(b.patch.status)salesAttributes.status=b.patch.status;
      if(Array.isArray(b.patch.roles))salesAttributes.tags=[...salesAttributes.tags.filter(tag=>!tag.startsWith("role:")),...b.patch.roles.map(role=>"role:"+role)];
      if(typeof b.patch.dispatchLicense==="boolean")salesAttributes.tags=[...salesAttributes.tags.filter(tag=>tag!=="flag:dispatch_license"),...(b.patch.dispatchLicense?["flag:dispatch_license"]:[])];
      return send({saved:true,result:{id:CO}});
    }
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
      usage: { logins30: 3, searches30: 12, views30: 5, saves30: 1 }, usageComplete: true, canEnable: true, canIssue: true, roles: { admin: "管理者", member: "一般" },
      mail: { configured: false, reason: "ENGER_PORTAL_MAIL_FROM が設定されていません" }, portal: { loginUrl: "https://enger.jp/business/login", resetUrl: "https://enger.jp/business/forgot", displayId: "008854" } });
    }
    if (p === "/api/sales/company-portal" && req.method() === "POST") {
      const b = body(); calls.push({ kind: "portal", body: b });
      if (b.action === "invite") return send({ ok: true, member: { displayName: b.displayName }, inviteUrl: "https://enger.jp/business/invite?token=" + "T".repeat(43), expiresAt: "2026-11-13T00:00:00Z", mail: "skipped" });
      if(b.action==="generate_password")return send({ok:true,email:"tanaka@client.example",temporaryPassword:"TEST-ONCE-ONLY-SECURE-12345",oneTime:true});
      return send({ ok: true, authBan: { applied: true } });
    }
    if (p === "/api/sales/company-meeting-brief") return send({
      company:{id:CO,name:"株式会社テスト企業"},source:{},suggestions:{
        basis:"公式HPのAI需要仮説（未確認）",verified:false,skills:["Java"],
        talents:[{id:TALENTS[0].id,talentNo:"P-000001",title:"Javaエンジニア",
          skills:["Java","AWS"],matchedSkills:["Java","AWS"],availability:"即日"}],
        jobs:[{id:JOB,jobNo:"J-000100",title:"バックエンド案件",
          skills:["Java","AWS"],matchedSkills:["Java"],remote:"一部リモート"}]
      }
    });
    if (p === "/api/sales/company-shortlist"){
      if(req.method()==="GET"){
        if(url.searchParams.get("mode")==="search"){
          calls.push({kind:"search-jobs",q:url.searchParams.get("q")});
          return send({rows:[{id:JOB,jobNo:"J-000100",displayTitle:"バックエンド案件",
              skills:["Java","AWS"],remote:"一部リモート"}],truncated:false});
        }
        return send({items:[],canShare:true});
      }
      calls.push({kind:"publish",body:body()});
      return send({ok:true,status:"published"});
    }
    if (p === "/api/sales/company-ai-batch" && req.method()==="GET")
      return send({enabled:true,canRun:true,batch:null,limit:10});
    if (p === "/api/sales/company-ai-batch" && req.method()==="POST"){
      calls.push({kind:"ai-batch",body:body()});
      return send({ok:true,batch:{salesCompanyIds:[CO],companyIds:[CO]}});
    }
    if (p === "/api/sales/company-ai-pilot" && req.method()==="POST"){
      calls.push({kind:"ai-run",mode:"bulk",body:body()});
      return send({ok:true});
    }
    if (p === "/api/sales/company-ai-single" && req.method()==="POST"){
      calls.push({kind:"ai-run",mode:"single",body:body()});
      if(singleCompanyScenario){await new Promise(resolve=>setTimeout(resolve,120));companyAiDone=true;}
      return send({ok:true});
    }
    if (p === "/api/sales/company-workflow-status"){
      const done=!singleCompanyScenario||companyAiDone;
      return send({
        companyId:CO,
        analysis:{source:done?"cloud":"none",summary:done?"AI分析済みの企業サマリー":"",hasCorporateNumber:true,hasWebsite:true,generatedAt:null},
        steps:{info:{state:"done",label:"基本情報登録済み"},analysis:done?{state:"done",label:"AI分析済み"}:{state:"pending",label:"AI分析待ち"},proposal:{state:"done",label:"商談用候補 1件"}},
        proposal:{publishedCount:1,portalAccounts:1,staffMeetingUrl:"/sales/company-meeting.html?companyId="+CO,
          clientLoginUrl:"https://enger.jp/business/login?next=%2Fbusiness%2Fmeeting",ready:true},
        pilot:{eligible:true,selected:done,canRun:true,salesCompanyId:done?CO:null,status:done?"completed":"unstarted",attemptCount:0,registeredCount:0},
        single:{eligible:true,canRun:true,salesCompanyId:done?CO:null,status:done?"completed":"unstarted",attemptCount:0,mode:"single"}
      });
    }
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
  // Separate single-company one-click AI scenario from the bulk-selection case.
  singleCompanyScenario=true;
  await page.click('#lc-rows tr[data-id="' + CO + '"] td:nth-child(3)');
  await page.waitForSelector("#lc-dialog[open]");
  const stages = await page.locator("nav.lc-stage-bar [data-modal-tab]").evaluateAll( (b) => b.map((x) => [x.querySelector("strong")?.textContent.trim(), x.disabled]));
  assert.deepEqual(stages, [["企業基本情報",false],["AI分析",false],["マッチング・提案",false]]);
  assert.equal(await page.getAttribute('[data-modal-tab="info"]',"aria-current"),"step");
  await page.waitForFunction(() => document.querySelector('[data-step-label="info"]')?.textContent.includes("基本情報登録済み"));
  assert.equal(await page.isVisible("#lc-detail .lc-workbench"), true, "company basics remain first");
  assert.equal(await page.isVisible("#lc-detail .lc-action-pane"),true,"telephone, email and form controls restored");
  assert.equal(await page.isVisible("#lc-detail .lc-history-pane"),true,"sales activity history restored");
  assert.equal(await page.isVisible('#lc-dialog [data-channel="phone"]'),true);
  assert.equal(await page.isVisible('#lc-dialog [data-channel="email"]'),true);
  assert.equal(await page.isVisible("#lc-history-list"),true);
  assert.equal(await page.inputValue("#lc-sales-status"),"新規");
  assert.equal(await page.isChecked('input[name="company-role"][value="end_client"]'),true);
  assert.equal(await page.isChecked("#lc-dispatch-license"),true);
  assert.equal((await page.textContent("#lc-meeting-history-count")).trim(),"1件");
  assert.match(await page.textContent("#lc-meeting-history-list"),/商談後の提案確認/);
  assert.match(await page.textContent("#lc-history-list"),/電話連絡/);
  assert.doesNotMatch(await page.textContent("#lc-history-list"),/商談後の提案確認/);
  await page.selectOption("#lc-sales-status","既存");
  await page.check('input[name="company-role"][value="ses"]');
  await page.click("#lc-save-sales-attributes");
  await page.waitForFunction(()=>document.querySelector("#lc-sales-status")?.value==="既存"&&document.querySelector('input[name="company-role"][value="ses"]')?.checked);
  const savedAttributes=calls.find(x=>x.kind==="sales-attributes");
  assert.deepEqual(savedAttributes?.body.patch,{status:"既存",roles:["end_client","ses"]});
  assert.deepEqual(savedAttributes?.body.expected,{status:"新規",tags:["source:external-import","role:end_client","flag:dispatch_license"]});
  assert.match(savedAttributes?.body.requestKey||"",/^[0-9a-f-]{36}$/i);
  assert.equal(salesAttributes.tags.includes("source:external-import"),true,"unrelated ENGER tags survive the Sales edit");
  assert.equal(salesAttributes.tags.includes("flag:dispatch_license"),true,"the staffing license flag survives an unrelated Sales edit");
  assert.equal(await page.isVisible('#lc-dialog [data-channel="phone"]'),true,"telephone actions remain available after saving Sales attributes");
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/tab-info.png" : shotPath("tab-info.png") }).catch(() => {});

  await page.waitForFunction(()=>!document.getElementById("lc-go-to-prep")?.disabled);
  await page.click("#lc-go-to-prep");
  assert.equal(await page.getAttribute('[data-modal-tab="analysis"]',"aria-current"),"step");
  assert.equal(await page.isVisible("#lc-stage-analyze"),true);
  await page.click("#lc-stage-analyze");
  await page.waitForFunction(()=>document.querySelector('[data-step-label="analysis"]')?.textContent==="AI分析済み");
  assert.equal(await page.isVisible("#lc-stage-next"),true,
    "next matching button appears only after analysis completes");
  assert.equal(companyAiDone,true);
  assert.equal(calls.filter(x=>x.kind==="ai-run").length,2,
    "both batch and single-company AI calls are separately observable");
  assert.deepEqual(calls.find(x=>x.kind==="ai-run"&&x.mode==="single")?.body,{companyId:CO});
  await page.waitForSelector("#lc-panel-analysis .lc-analysis-wrap");
  assert.match(await page.textContent("#lc-panel-analysis"),/AI企業サマリー/);
  await page.click("#lc-stage-next");
  await page.waitForSelector(".lp-compact-search");
  await page.waitForSelector(".lp-compact-item input[type=checkbox]");
  assert.equal(await page.locator("#lc-panel-prep .lp-compact-columns .lp-compact-col").count(),2);
  assert.equal(await page.locator(".lp-compact-item input[type=checkbox]").count(),2,
    "AI matching proposes one talent and one job, not a thousand-row table");
  assert.equal(await page.isVisible("#lc-detail"),false);
  const positions=await page.evaluate(()=>{
    const search=document.querySelector(".lp-compact-search").getBoundingClientRect();
    const recommendation=document.querySelector(".lp-compact-item").getBoundingClientRect();
    return {search:search.top,recommendation:recommendation.top};
  });
  assert.ok(positions.search<positions.recommendation,"search appears above AI candidate rows");
  assert.equal(await page.locator("#lp-rows").count(),0,"old long table is absent");
  const bounded=await page.locator(".lp-compact-scroll").first().evaluate(el=>({
    height:el.clientHeight,scrollHeight:el.scrollHeight
  }));
  assert.ok(bounded.height>0&&bounded.height<=430,
    "recommended candidates remain in a bounded scroll area, not a long whole-page table");
  const checks=page.locator(".lp-compact-item input[type=checkbox]");
  await checks.nth(0).check();
  await checks.nth(1).check();
  assert.match(await page.textContent(".lp-compact-footer"),/2件選択/);
  await page.waitForFunction(()=>!document.querySelector(".lp-compact-go")?.disabled);
  assert.equal(await page.isEnabled(".lp-compact-go"),true);
  assert.equal(await page.isVisible(".lc-credential-card"),true,"company login ID appears after candidate selection");
  assert.match(await page.textContent(".lc-credential-card"),/企業ログイン情報/);
  assert.match(await page.textContent(".lc-credential-card"),/008854/,"visible company login ID");
  assert.match(await page.textContent(".lc-credential-card"),/既存パスワードは再表示できません/);
  await page.locator(".lc-credential-secondary").click();
  await page.waitForFunction(()=>document.querySelector(".lc-credential-secret")?.textContent==="TEST-ONCE-ONLY-SECURE-12345");
  assert.equal(calls.some(x=>x.kind==="portal"&&x.body.action==="generate_password"),true);
  await page.click('[data-modal-tab="analysis"]');
  assert.equal(await page.locator(".lc-credential-secret").count(),0,
    "the one-time temporary password is cleared when leaving the matching step");
  await page.click('[data-modal-tab="proposal"]');
  assert.equal(await page.locator(".lc-credential-secret").count(),0);

  await page.screenshot({path:process.env.SHOT_DIR?process.env.SHOT_DIR+"/compact-proposal.png":shotPath("compact-proposal.png")}).catch(()=>{});
  await page.locator(".lp-compact-detail").first().click();
  await page.waitForSelector("#lc-talent-dialog[open] [data-talent-panel=summary]");
  assert.equal(await page.isVisible("[data-talent-panel=summary]"),true,"talent summary remains available");
  await page.click('[data-talent-view="sheet"]');
  assert.match(await page.textContent("#lc-talent-body"),/ENGER 公開用スキルシート/);
  await page.click("#lc-talent-close");
  await page.locator('.lp-compact-search input[type=search]').fill("AWS");
  await page.locator(".lp-compact-search button[type=submit]").click();
  await page.waitForFunction(()=>document.querySelector(".lp-compact-message")?.textContent.includes("検索は直近"));
  assert.equal(calls.some(x=>x.kind==="search-jobs"&&x.q==="AWS"),true);
  await page.locator(".lp-compact-secondary").click();
  assert.match(await page.textContent(".lp-compact-footer"),/2件選択/,"selection persists after searching");
  await page.context().route("https://enger.jp/**",route=>route.fulfill({
    status:200,contentType:"text/html",body:"<html><body>Enterprise login preview</body></html>"
  }));
  const opened=page.waitForEvent("popup");
  await page.locator(".lp-compact-go").click();
  const popup=await opened;
  await popup.waitForURL(/business\/login\?next=/, {timeout:12000});
  const loginUrl=new URL(popup.url());
  assert.equal(loginUrl.pathname,"/business/login");
  const next=new URL(loginUrl.searchParams.get("next"),loginUrl.origin);
  assert.equal(next.pathname,"/business/meeting");
  assert.equal(next.searchParams.get("companyId"),CO);
  const selection=next.searchParams.get("selection")||"";
  assert.ok(selection.includes("talent:"+TALENTS[0].id));
  assert.ok(selection.includes("job:"+JOB));
  assert.equal(calls.filter(x=>x.kind==="publish").length,2,
    "only the two checked candidates are published");
  await popup.close();

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
  await page.waitForSelector('.lp-compact-wrap');
  const overflow = await page.evaluate(() => document.getElementById("lc-dialog").scrollWidth - document.getElementById("lc-dialog").clientWidth);
  assert.ok(overflow <= 1, "dialog does not overflow horizontally on phones: " + overflow);
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + "/mobile-prep.png" : shotPath("mobile-prep.png") }).catch(() => {});

  assert.deepEqual(errs, [], "no page errors");
  console.log("PASS Sales company: compact search, AI talent/job suggestions, checked meeting-only popup, safe publication, company basics and mobile");
} finally {
  await br.close();
}
