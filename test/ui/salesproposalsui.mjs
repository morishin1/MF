// /sales/proposals.html（提案管理）を、本物の API ハンドラ（api/sales/proposals/*）と偽の Supabase（test/_memdb.mjs）につないで開く。
//
// ■ 何を守るテストか
//   1. dx.enger から届いた提案が一覧に出る（企業・提案・営業担当・進捗・次の行動・期限・電話の状況）
//   2. 期限超過は赤で、「期限超過」の件数と絞り込みに出る
//   3. 詳細を開いて「電話の結果を記録」：結果を選ばないと記録できない → 不通を記録すると、メールのタスクができる
//   4. 「確認メールを送った」は自己申告として残り、回答確認のタスクができる
//   5. 営業担当には担当未割当・連携エラー・設定が出ない。管理側には出る
//   6. スマホ幅（390px）では表ではなくカード。横にはみ出さない
//   7. マッチング確定（db/140）の提案は「マッチング済み・提案待ち」：電話は「提案前」（赤くしない）・電話の記録ボタンを出さない。
//      「企業へ提案した」を記録すると電話待ちになり、初回電話のタスクができる。管理側の設定に Slack のメンバーID
//   PC・スマホの画面を PNG で残す（test/_shot.mjs の置き場所。PR の確認用・判定には使わない）
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMemDb } from "../_memdb.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const atRoot = (p) => join(ROOT, p);

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T1 = uid(1), E_MGR = uid(12), E_S1 = uid(13), E_S2 = uid(14);
const nowIso = () => new Date().toISOString();
const mem = createMemDb({
  schema: {
    gw_sales_proposals: { unique: [["tenant_id", "source_system", "source_proposal_id"]], defaults: () => ({ status: "call_wait", contact_stop: false, created_at: nowIso(), updated_at: nowIso() }) },
    gw_sales_proposal_activities: { unique: [["proposal_id", "source_event"]], defaults: () => ({ occurred_at: nowIso(), created_at: nowIso() }) },
    gw_sales_proposal_tasks: { unique: [["proposal_id", "source_event"]], defaults: () => ({ status: "open", auto: false, created_at: nowIso() }) },
    gw_sales_proposal_sync_log: { unique: [["tenant_id", "source_system", "event_id"]], defaults: () => ({ attempts: 1, received_at: nowIso() }) },
  },
});
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async () => ({ created: 0 }) } });
const REAL_GW = await import(atRoot("lib/gw.js"));
let who = null;
mock.module(atRoot("lib/gw.js"), { namedExports: { gwContext: async () => who, canSell: REAL_GW.canSell } });
process.env.ENGER_SALES_SECRET = "ui-test-secret-0123456789abcdef-0123456789";
process.env.SALES_PROPOSAL_TENANT_ID = T1;

const handlers = {
  "/api/sales/proposals/detail": (await import(atRoot("api/sales/proposals/detail.js"))).default,
  "/api/sales/proposals/settings": (await import(atRoot("api/sales/proposals/settings.js"))).default,
  "/api/sales/proposals/sync": (await import(atRoot("api/sales/proposals/sync.js"))).default,
  "/api/sales/proposals/intake": (await import(atRoot("api/sales/proposals/intake.js"))).default,
  "/api/sales/proposals": (await import(atRoot("api/sales/proposals/index.js"))).default,
};
const { signGwRequest } = await import(atRoot("lib/sales-proposal-intake.js"));

const ctxOf = (id, name, roles) => ({ tenantId: T1, isAdmin: false, isHr: false, roles, apps: ["sales"], employee: { id, display_name: name } });
const MANAGER = ctxOf(E_MGR, "管理 職", ["manager"]);
const S1 = ctxOf(E_S1, "営業 一郎", ["sales"]);

async function callHandler(path, { method, body, headers = {} }) {
  const h = handlers[path];
  const out = { statusCode: 0, body: null, headers: {} };
  out.setHeader = (k, v) => { out.headers[k.toLowerCase()] = v; };
  out.end = (b) => { out.body = b; };
  await h({ method, url: path + (headers.__qs || ""), headers, body }, out);
  return out;
}

// dx.enger から3件届いたことにする（1件は担当未割当、1件は期限超過）
mem.rows.gw_employees = [
  { id: E_MGR, tenant_id: T1, display_name: "管理 職", email: "mgr@eight.example", status: "active" },
  { id: E_S1, tenant_id: T1, display_name: "営業 一郎", email: "s1@eight.example", status: "active", manager_id: E_MGR },
  { id: E_S2, tenant_id: T1, display_name: "営業 二郎", email: "s2@eight.example", status: "active", manager_id: E_MGR },
];
mem.rows.gw_role_grants = [{ tenant_id: T1, employee_id: E_MGR, role: "manager" }];
mem.rows.gw_app_grants = [E_MGR, E_S1, E_S2].map((e) => ({ tenant_id: T1, employee_id: e, app_key: "sales" }));
mem.rows.gw_sales_companies = [{ id: uid(100), tenant_id: T1, name: "株式会社サンプル商事", domain: "sample.example.jp", status: "attacked" }];
const seed = [
  { id: "p-1", company: "株式会社サンプル商事", website: "https://sample.example.jp", job: "Java 開発（金融）", ini: "T.K.", owner: "s1@eight.example", ago: 20 },
  { id: "p-2", company: "テスト工業株式会社", website: null, job: "PM（製造業DX）", ini: "S.Y.", owner: "s1@eight.example", ago: 60 * 26 },
  // 10分前に送った（いつ流しても30分の期限を過ぎていない。以前は90分前で、営業時間内に流すと期限超過が2件になっていた）
  { id: "p-3", company: "株式会社ミライ", website: null, job: "インフラ運用", ini: "A.A.", owner: "unknown@eight.example", ago: 10 },
];
for (const s of seed) {
  const body = {
    event_id: `enger:proposal.sent:${s.id}:1`, event_type: "proposal.sent", occurred_at: nowIso(),
    proposal: { id: s.id, code: `P-${s.id.slice(2).padStart(4, "0")}`, url: `https://agent.enger.jp/proposals/${s.id}`, stage: "提案中",
      sent_at: new Date(Date.now() - s.ago * 60000).toISOString(), service: "ENGER", job_title: s.job, talent_initials: s.ini,
      company: { id: null, name: s.company, website: s.website, phone: "03-1234-5678" },
      contact: { name: "窓口 花子", email: "madoguchi@example.jp" },
      matching_owner: { name: "マッチ 太郎", email: "match@eight.example" }, sales_owner: { name: null, email: s.owner } },
  };
  const ts = Math.floor(Date.now() / 1000);
  const r = await callHandler("/api/sales/proposals/intake", { method: "POST", body,
    headers: { "x-gw-timestamp": String(ts), "x-gw-signature": signGwRequest(process.env.ENGER_SALES_SECRET, "proposal", ts, body) } });
  if (r.statusCode !== 200) throw new Error(`seed failed ${r.statusCode} ${r.body}`);
}
// p-4：マッチングが確定しただけ（まだ企業へ提案していない）。営業 一郎の担当
{
  const body = {
    event_id: "enger:proposal.matched:p-4:fixed01", event_type: "proposal.matched", occurred_at: nowIso(),
    proposal: { id: "p-4", code: "P-0004", url: "https://agent.enger.jp/proposals/p-4", stage: "提案中",
      matched_at: new Date(Date.now() - 15 * 60000).toISOString(), sent_at: null, service: "ENGER", job_title: "React 開発（EC）", talent_initials: "M.N.",
      company: { id: null, name: "株式会社マッチ確定", website: null, phone: "03-9999-0000" },
      contact: { name: null, email: "partner@example.jp" },
      matching_owner: { name: "マッチ 太郎", email: "match@eight.example" }, sales_owner: { name: null, email: "s1@eight.example" } },
  };
  const ts = Math.floor(Date.now() / 1000);
  const r = await callHandler("/api/sales/proposals/intake", { method: "POST", body,
    headers: { "x-gw-timestamp": String(ts), "x-gw-signature": signGwRequest(process.env.ENGER_SALES_SECRET, "proposal", ts, body) } });
  if (r.statusCode !== 200) throw new Error(`seed failed ${r.statusCode} ${r.body}`);
}
// p-2 の初回電話は、きのうの期限のまま（期限超過）
for (const t of mem.rows.gw_sales_proposal_tasks) {
  const p = mem.rows.gw_sales_proposals.find((x) => x.id === t.proposal_id);
  if (p.source_proposal_id === "p-2") t.due_at = new Date(Date.now() - 20 * 3600000).toISOString();
}

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const br = await launch();
async function openAs(ctx, viewport = { width: 1360, height: 1000 }, mode = "dashboard") {
  who = ctx;
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp" })));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === "/api/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        email: "sales@8grp.co.jp", isAdmin: false, access: { sell: true },
        gw: { employee: who.employee, roles: who.roles, isAdmin: false, tenantId: T1 } }) });
    }
    if (handlers[u.pathname]) {
      const body = req.method() === "GET" ? undefined : JSON.parse(req.postData() || "{}");
      const r = await callHandler(u.pathname, { method: req.method(), body, headers: { __qs: u.search } });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: r.body });
    }
    if (u.pathname === "/api/sales/companies") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ companies: [
        { id: uid(100), name: "株式会社サンプル商事", domain: "sample.example.jp", statusLabel: "アタック済" }] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(`${BASE}/sales/proposals.html${mode === "dashboard" ? "?mode=dashboard" : ""}`);
  await page.waitForSelector("#rows tr.click, #cards .pp-card", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { page, errs };
}

console.log("\n=== 提案管理：全提案の閲覧 ===");
{
  const { page } = await openAs(MANAGER, {width:1360,height:900}, "proposals");
  check((await page.locator(".sl-nav a.on").innerText()).includes("提案管理"), "提案管理が独立メニュー");
  check(await page.locator("#sum").isHidden(), "全件管理に今日の対応カードを重複表示しない");
  check((await page.locator("#f-sort").inputValue()) === "sent", "全件管理は提案の新しい順");
  check((await page.locator("#rows tr.click").count()) >= 4, "全提案を一覧表示");
  await page.close();
}

console.log("\n=== 管理側：一覧 ===");
{
  const { page, errs } = await openAs(MANAGER);
  const nav = await page.locator(".sl-nav a.on").innerText();
  check(nav.includes("ダッシュボード"), `日常画面はダッシュボードのタブが選ばれる（${nav}）`);
  // ダッシュボードは8カードを1行にし、クリックしたカテゴリの根拠だけを表示する。
  const tiles=page.locator("#sum button[data-work-key]");
  check(await tiles.count()===8,"管理者は8つの小型KPIカードを表示");
  const tileBoxes=await tiles.evaluateAll(nodes=>nodes.map(n=>({top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height})));
  check(tileBoxes.every(b=>Math.abs(b.top-tileBoxes[0].top)<2),"PCで全KPIが1行に収まる");
  check(tileBoxes.every(b=>b.height<=80),"KPIカードは高さ80px以内");
  check(await page.locator("#pp-view-list").isHidden(),"ダッシュボードは全件提案一覧を重複表示しない");
  check(await page.locator("#pp-work-open").count()===0,"旧リスト操作の重複ボタンはない");
  const quickRow=page.locator("#pp-work-body .pp-work-open").first();
  check(await quickRow.count()>0,"選択カードの根拠一覧がある");
  await quickRow.click();
  await page.waitForSelector("#pp-quick-root [role=dialog]");
  const quickText=await page.locator("#pp-quick-root").innerText();
  check(quickText.includes("次にやること")&&quickText.includes("状況・理由の確認"),"クイックモーダルでアクションと原因の確認");
  check(quickText.includes("タスク担当")&&quickText.includes("最近の対応記録"),"担当と実際の対応記録をクイック確認");
  await page.keyboard.press("Escape");
  check(await page.locator("#pp-quick-root [role=dialog]").count()===0,"Escapeでクイックモーダルを閉じられる");
  await page.screenshot({path:shotPath("dashboard-compact-kpi-pc.png"),fullPage:true});
  // 旧提案管理機能の回帰確認は、テスト上だけ折りたたんだ管理画面を表示して続ける。
  await page.evaluate(()=>document.body.classList.remove("pp-dashboard-mode"));
  const rows = await page.locator("#rows tr.click").count();
  check(rows === 4, `対応中の提案が4件（いま ${rows}）`);
  const text = await page.locator("#rows").innerText();
  check(text.includes("株式会社サンプル商事") && text.includes("Java 開発（金融） / T.K.") && text.includes("マッチ 太郎"), "企業・提案（案件／イニシャル）・マッチング担当");
  check(text.includes("未割当"), "担当が決まらない提案は「未割当」");
  check((await page.locator("#pp-column-head").innerText()).includes("CS担当") && (await page.locator("#pp-column-head").innerText()).includes("クロージング担当"), "一覧にCS・クロージング担当の列がある");
  const waitRow = await page.locator("#rows tr.click", { hasText: "株式会社マッチ確定" }).innerText();
  check(waitRow.includes("マッチング済み・提案待ち") && waitRow.includes("未提案"), `提案待ちの行：状態・未提案を表示（${waitRow.replace(/\s+/g, " ")}）`);
  check(!(await page.locator("#rows tr.click", { hasText: "株式会社マッチ確定" }).locator(".pp-over").count()), "提案待ちの電話を赤くしない");
  check((await page.locator("#sum").innerText()).includes("電話未実施"), "今日やることに「電話未実施」");

  // KPIの数値をクリックすると、同じ数の根拠行と担当/期限/詳細リンクを確認できる。
  const overdueCard=page.locator('#sum button[data-work-key="overdue"]');
  check(await overdueCard.count()===1,"期限超過KPIは根拠を開くカード");
  const overdueCount=Number((await overdueCard.locator(".v").innerText()).replace(/[^0-9]/g,""));
  await overdueCard.click();
  check(await page.locator("#pp-work-evidence").isVisible(),"期限超過の根拠パネルを表示");
  check(await page.locator("#pp-work-body .pp-work-item").count()===overdueCount,"カードの期限超過件数と根拠行が一致");
  check((await page.locator("#pp-work-body").innerText()).includes("タスク担当"),"期限超過の担当者を明示");
  check((await page.locator("#pp-work-body").innerText()).includes("提案詳細を開く"),"根拠から提案管理へ移動できる");
  const firstLink=await page.locator("#pp-work-body .pp-work-item a").first().getAttribute("href");
  check(firstLink?.startsWith("/sales/proposals.html?id="),"根拠から提案IDを指定して直接開く");
  const phoneCard=page.locator('#sum button[data-work-key="no_call"]');
  const phoneCount=Number((await phoneCard.locator(".v").innerText()).replace(/[^0-9]/g,""));
  await phoneCard.click();
  check(await page.locator("#pp-work-body .pp-work-item").count()===phoneCount,"電話未実施のKPI件数と根拠行が一致");
  check(new URL(page.url()).searchParams.get("focus")==="no_call","選択した根拠はURLで共有可能");

  const slackInputs = await page.locator("#st-slack [data-slack]").count();
  check(slackInputs === 3, `設定に Slack のメンバーIDの欄（Sales を使える3人。いま ${slackInputs}）`);
  const overdueRow = page.locator("#rows tr.overdue");
  check(await overdueRow.count() === 1, "期限超過の行が1件（赤い印）");
  check((await overdueRow.innerText()).includes("テスト工業"), "期限超過は テスト工業");
  check((await page.locator("#sum").innerText()).includes("担当未割当"), "管理側には「担当未割当」の件数");
  check(await page.locator("#f-proposal-owner").isVisible() && await page.locator("#f-closing-owner").isVisible(), "管理側は提案・クロージング担当を別々に絞れる");
  check((await page.locator("#admin-sec").innerText()).includes("dx.enger 連携の確認"), "連携エラー・設定が出る");
  const first = await page.locator("#rows tr.click").first().innerText();
  check((await page.locator("#f-sort").inputValue()) === "due", "初期並びは期限超過・期限順");
  await page.screenshot({ path: shotPath("proposals-list-pc.png"), fullPage: true });

  // 画面をタブで分割。管理画面とKPIを縦に積まない。
  check(await page.locator("#pp-view-list").isVisible(), "初期表示は提案一覧");
  check(await page.locator("#pp-view-kpi").isHidden(), "KPIは一覧の下に表示しない");
  check(await page.locator("#pp-view-admin").isHidden(), "連携履歴は一覧の下に表示しない");
  check(await page.locator("#pp-tab-kpi").isHidden(), "重複KPIタブは通常のダッシュボードから非表示");
  check(await page.locator(".pp-analysis-link").count() === 0, "重複リンクを設けず上部のPDCAメニューを使用");
  await page.locator("#pp-tab-admin").click();
  check(await page.locator("#pp-view-admin").isVisible(), "管理者は連携・設定を開ける");
  await page.locator("#pp-tab-list").click();
  check(await page.locator("#pp-view-list").isVisible(), "提案一覧へ戻れる");

  // DBを変更せず45件の画面データを作り、20/50件ページ切替を検証。
  await page.evaluate(() => {
    window.__ppTestOriginal = data.proposals;
    data.proposals = Array.from({ length:45 }, (_, i) =>
      ({ ...window.__ppTestOriginal[i % window.__ppTestOriginal.length], id:"test-compact-" + i }));
    ppPage = 1;
    renderRows(data.proposals);
    ppBulkState();
  });
  check(await page.locator("#rows tr.click").count() === 20, "初期表示は20件");
  check((await page.locator("#pp-page-info").innerText()).includes("全45件"), "全件数を表示");
  await page.locator("#pp-page-next").click();
  check(await page.locator("#rows tr.click").count() === 20, "次のページも20件");
  await page.locator("#pp-page-next").click();
  check(await page.locator("#rows tr.click").count() === 5, "最終ページは5件");
  check(await page.locator("#pp-page-next").isDisabled(), "最終ページの次へは無効");
  await page.locator("#pp-page-size").selectOption("50");
  check(await page.locator("#rows tr.click").count() === 45, "50件表示へ変更できる");
  await page.evaluate(() => {
    data.proposals = window.__ppTestOriginal;
    ppPageSize = 20;
    ppPage = 1;
    renderRows(data.proposals);
    ppBulkState();
  });
  check(await page.locator("#rows tr.click").count() === 4, "元の4件へ復帰できる");

  await page.locator("#filters button", { hasText: "期限超過" }).click();
  await page.waitForTimeout(400);
  check(await page.locator("#rows tr.click").count() === 1, "「期限超過」で絞ると1件");
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 営業担当：詳細で電話・メールを記録 ===");
{
  const { page, errs } = await openAs(S1, undefined, "proposals");
  check(await page.locator("#rows tr.click").count() === 4, "営業担当もチーム全件4件を閲覧できる");
  const readonlySelection = page.locator("#rows tr.click", { hasText: "株式会社ミライ" }).locator("input[type=checkbox]");
  await readonlySelection.check();
  check(await readonlySelection.isChecked(), "他の担当・未割当の案件も選択できる");
  for (const id of ["pp-bulk-edit", "pp-bulk-archive", "pp-bulk-restore"]) {
    check(await page.locator("#" + id).isDisabled(), "閲覧専用案件の選択で操作権限は増えない：" + id);
  }
  await readonlySelection.uncheck();
  check(await page.locator("#pp-bulk").isHidden(), "選択解除で一括操作を閉じる");
  check(!(await page.locator("#sum").innerText()).includes("担当未割当"), "営業担当には「担当未割当」を出さない");
  check(!(await page.locator("#admin-sec").innerText()).includes("連携"), "営業担当には連携エラー・設定を出さない");
  await page.locator("#rows tr.click", { hasText: "株式会社サンプル商事" }).click();
  await page.waitForSelector("#pp-detail .sl-next");
  const d = await page.locator("#pp-detail").innerText();
  check(d.includes("企業へ電話する"), "次の操作は電話");
  check(await page.locator("#pp-detail .pp-compact-overview .pp-quick-card").count() === 3, "必要な情報を3カードで表示");
  check(await page.locator("#pp-detail .pp-task-box").count() === 0, "詳細モーダルにタスクを出さない");
  check(await page.locator("#pp-detail .pp-checklist-box").count() === 0, "詳細モーダルにチェックリストを出さない");
  check(await page.locator("#pp-detail .pp-memo-cta").count() === 1, "メモボタンを上部に表示");
  check(d.includes("03-1234-5678"), "電話番号が押せる形で出る");
  check(await page.locator('#pp-detail a[href^="tel:"]').count() === 1, "tel: のリンク");
  await page.screenshot({ path: shotPath("proposals-detail-pc.png") });

  await page.locator("#pp-detail button", { hasText: "電話の結果を記録" }).click();
  await page.locator("#m-ok").click();
  check((await page.locator("#m-msg").innerText()).includes("結果を選んでください"), "結果を選ばないと記録できない");
  check(await page.locator("#kp-action-feedback").isVisible(), "未入力の理由をアラートに表示");
  await page.locator("#kp-action-feedback .btn-secondary").click();
  await page.locator('input[name="m-result"][value="no_answer"]').check();
  await page.screenshot({ path: shotPath("proposals-call-modal-pc.png") });
  await page.locator("#m-ok").click();
  await page.waitForTimeout(500);
  const after = await page.locator("#pp-detail").innerText();
  check(after.includes("記録しました：電話：不通"), "記録したことがその場で分かる");
  check(after.includes("不通のため確認メールを送る"), "メールのタスクができる");
  check(after.includes("メール待ち"), "状態はメール待ち");

  await page.locator("#pp-detail details.pp-more-actions summary").click();
  await page.locator("#pp-detail button", { hasText: "確認メールを送った" }).click();
  check((await page.locator(".sl-modal").innerText()).includes("自己申告"), "メールは自己申告と明示");
  await page.locator("#m-ok").click();
  await page.waitForTimeout(500);
  const after2 = await page.locator("#pp-detail").innerText();
  check(after2.includes("返信を確認する"), "回答確認のタスクができる");
  check(after2.includes("メール：送信（自己申告）"), "履歴にメール（自己申告）");
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 営業担当：提案待ち → 企業へ提案した → 電話待ち ===");
{
  const { page, errs } = await openAs(S1, undefined, "proposals");
  await page.locator("#filters button", { hasText: "マッチング済み" }).click();
  await page.waitForTimeout(400);
  check(await page.locator("#rows tr.click").count() === 1, "「マッチング済み」（提案待ち）で絞ると1件");
  await page.locator("#rows tr.click", { hasText: "株式会社マッチ確定" }).click();
  await page.waitForSelector("#pp-detail .sl-next");
  const d = await page.locator("#pp-detail").innerText();
  check(d.includes("企業への送信を確認"), "未送信は送信確認を次の操作に表示");
  check(d.includes("企業へはまだ提案していません"), "まだ企業へ提案していないと出る");
  check(await page.locator("#pp-detail button", { hasText: "電話の結果を記録" }).count() === 0, "提案待ちには電話の記録ボタンを出さない");
  check(await page.locator("#pp-detail button", { hasText: "企業へ提案した" }).count() === 1, "主ボタンは「企業へ提案した」");
  await page.screenshot({ path: shotPath("proposals-waiting-pc.png") });
  await page.locator("#pp-detail button", { hasText: "企業へ提案した" }).click();
  await page.locator("#m-ch").selectOption("phone");
  await page.locator("#m-ok").click();
  await page.waitForTimeout(500);
  const after = await page.locator("#pp-detail").innerText();
  check(after.includes("電話待ち"), "電話待ちに進む");
  check(after.includes("初回電話（提案から30分以内）"), "初回電話のタスクができる");
  check(after.includes("提案送信（Sales で記録）"), "履歴に提案送信（Sales で記録）");
  check(await page.locator("#pp-detail button", { hasText: "電話の結果を記録" }).count() === 1, "送ったあとは電話を記録できる");
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== スマホ：カード1行横スクロールと理由モーダル ===");
{
  const {page,errs}=await openAs(S1,{width:390,height:844},"dashboard");
  const kpis=page.locator("#sum button[data-work-key]");
  check(await kpis.count()===7,"営業担当は担当未割当を除く7枚のカード");
  const metrics=await kpis.evaluateAll(nodes=>nodes.map(x=>({
    top:x.getBoundingClientRect().top,height:x.getBoundingClientRect().height
  })));
  check(metrics.every(x=>Math.abs(x.top-metrics[0].top)<2),"スマホでもKPIは1行で横スクロール");
  check(await page.locator("#pp-view-list").isHidden(),"スマホでも根拠一覧のみ表示");
  const first=page.locator("#pp-work-body .pp-work-open").first();
  check(await first.count()>0,"スマホで根拠一覧からクイック表示できる");
  await first.click();
  await page.waitForSelector("#pp-quick-root [role=dialog]");
  check((await page.locator("#pp-quick-root").innerText()).includes("状況・理由の確認"),"スマホで原因・理由を確認");
  await page.screenshot({path:shotPath("dashboard-quick-mobile.png"),fullPage:false});
  await page.keyboard.press("Escape");
  const over=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  check(over<=1,"スマホで画面全体が横にはみ出さない");
  check(!errs.length,"スマホの新ダッシュボードにJSエラーがない: "+errs.join(" / "));
  await page.close();
}

console.log("\n=== スマホ（390px） ===");
{
  const { page, errs } = await openAs(S1, { width: 390, height: 844 }, "proposals");
  check(await page.locator(".pp-tablewrap").isHidden(), "表は隠れる");
  check(await page.locator("#cards .pp-card").count() === 4, "カードでもチーム全件4件が閲覧可能");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 1, `横にはみ出さない（${over}px）`);
  await page.screenshot({ path: shotPath("proposals-list-mobile.png"), fullPage: true });
  await page.locator("#cards .pp-card").first().click();
  await page.waitForSelector("#pp-detail .sl-next");
  await page.screenshot({ path: shotPath("proposals-detail-mobile.png") });
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\n提案管理の画面は動いています");
process.exit(bad ? 1 : 0);
