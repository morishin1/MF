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
import { adminWithProgress } from "../_sales-progress-rpc.mjs";
import { createMemDb } from "../_memdb.mjs";
import { assessReadiness, evidenceFor, engagementCompatibility } from "../../lib/sales-proposal-readiness.js";
import { launch, BASE, jstToday } from "../_browser.mjs";
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
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => adminWithProgress(mem), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async () => ({ created: 0 }) } });
const REAL_GW = await import(atRoot("lib/gw.js"));
let who = null;
mock.module(atRoot("lib/gw.js"), { namedExports: { gwContext: async () => who, canSell: REAL_GW.canSell } });
process.env.ENGER_SALES_SECRET = "ui-test-secret-0123456789abcdef-0123456789";
process.env.SALES_PROPOSAL_TENANT_ID = T1;

const handlers = {
  "/api/sales/proposals/company-analysis": async (_req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({
      companies: [], summary: { companies: 0, proposals: 0, sent: 0, meetings: 0, passed: 0, won: 0, lost: 0, resultPending: 0, unknownSent: 0 },
      filters: { services: [], owners: [] }, period: { key: "all", label: "全期間" },
      pagination: { page: 1, pageSize: 20, total: 0, pages: 0 },
      dataStatus: { engerAvailable: true, notes: [], observedAt: nowIso() }, company: null,
    }));
  },
  "/api/sales/proposals/entity": async (_req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({
      talent: { title: "T.K.", fields: [{ label: "スキル", value: "Java / SQL" }],
        sheet: { rows: [["経験年数", "5年"]], skills: ["Java", "SQL"] } },
      job: { jobTitle: "Java基幹システム開発", fields: [{ label: "スキル", value: "Java / PostgreSQL" }] },
      affiliation: { sent: 6, meetings: 2, won: 1, limited: false },
    }));
  },
  "/api/sales/proposals/detail": (await import(atRoot("api/sales/proposals/detail.js"))).default,
  "/api/sales/proposals/settings": (await import(atRoot("api/sales/proposals/settings.js"))).default,
  "/api/sales/proposals/sync": (await import(atRoot("api/sales/proposals/sync.js"))).default,
  "/api/sales/proposals/status": (await import(atRoot("api/sales/proposals/status.js"))).default,
  "/api/sales/proposals/intake": (await import(atRoot("api/sales/proposals/intake.js"))).default,
  "/api/sales/proposals": (await import(atRoot("api/sales/proposals/index.js"))).default,
};
const { signGwRequest } = await import(atRoot("lib/sales-proposal-intake.js"));

const ctxOf = (id, name, roles) => ({ tenantId: T1, isAdmin: false, isHr: false, roles, apps: ["sales"], employee: { id, display_name: name } });
const MANAGER = ctxOf(E_MGR, "管理 職", ["manager"]);
const S1 = ctxOf(E_S1, "営業 一郎", ["sales"]);
let coordinationRecord = null;
let readinessFacts = {};
let readinessRevision = 0;
const readinessFit = evidenceFor({skills:['Java'],detail:'【必須スキル】\n・Javaでの開発経験'}, {skills:['Java']});

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
mem.rows.gw_sales_proposals.find(p => p.source_proposal_id === "p-1").talent_company_name = "所属テスト社";
// p-2 の初回電話は、きのうの期限のまま（期限超過）
for (const t of mem.rows.gw_sales_proposal_tasks) {
  const p = mem.rows.gw_sales_proposals.find((x) => x.id === t.proposal_id);
  if (p.source_proposal_id === "p-2") t.due_at = new Date(Date.now() - 20 * 3600000).toISOString();
}

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function openDetailTools(page) {
  await page.locator('#pp-detail').getByRole('tab',{name:'履歴',exact:true}).click();
}
const br = await launch();
async function openAs(ctx, viewport = { width: 1360, height: 1000 }, initialQuery = "?view=list") {
  who = ctx;
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp" })));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.pathname === "/api/sales/proposals/readiness") {
      if (req.method() === "POST") {
        const input = req.postDataJSON();
        if (input.revision !== readinessRevision) return route.fulfill({ status:409, json:{error:'assessment_changed'} });
        readinessFacts = input.facts;
        readinessRevision++;
      }
      return route.fulfill({json:{
        facts:readinessFacts, revision:readinessRevision, canEdit:true, canAnalyze:false, fit:readinessFit,
        compatibility:engagementCompatibility({facts:readinessFacts,source:{},today:jstToday()}),
        history:{basis:'同じ提案先企業名',sent:8,meetings:2,passed:1,won:1,lost:{条件不一致:2}},
        conditions:{}, assessment:assessReadiness({facts:readinessFacts,fit:readinessFit,source:{},today:jstToday()}),
      }});
    }
    if (u.pathname === "/api/sales/proposals/coordination") {
      if (req.method() === "POST") {
        const input = req.postDataJSON();
        coordinationRecord = { decision: input.decision, nextStep: input.nextStep, revision: 1 };
      }
      return route.fulfill({ json: {
        canSave: true, canConfirm: false, record: coordinationRecord,
        source: { id: "p-1", revision: "fixture", line: {}, companyResponse: "開始日を確認中", candidateResponse: "進めたい",
          companyDue: "2026-11-24", contacts: [{ label: "人材側へメール", text: "開始日を照会", at: nowIso() }] },
      } });
    }
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
  // Preserve the individual workflow tests and separately verify the new entry tab.
  await page.goto(`${BASE}/sales/proposals.html${initialQuery}`);
  if (initialQuery) await page.waitForSelector("#rows tr.click, #cards .pp-card", { timeout: 10000 }).catch(() => {});
  else await page.getByText("条件に合う企業がありません。期間や絞り込み条件を変えてください。", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  return { page, errs };
}

console.log("\n=== 企業分析を入口にする ===");
{
  const { page, errs } = await openAs(S1, { width: 1360, height: 1000 }, "");
  check(await page.locator("#pp-view-companies").isVisible(), "通常の提案リンクは企業分析を開く");
  check(await page.locator("#pp-view-list").isHidden(), "個別の営業操作を初期画面に並べない");
  check(await page.locator("#pp-tab-companies").getAttribute("aria-selected") === "true", "企業分析タブが選択される");
  check(await page.locator("#pp-tab-admin").isHidden(), "営業担当のタブ移動先に管理設定を含めない");
  await page.locator("#pp-tab-companies").press("ArrowRight");
  check(await page.locator("#pp-view-list").isVisible(), "右矢印で提案履歴へ移動できる");
  check(new URL(page.url()).searchParams.get("view") === "list", "履歴タブの選択をURLに残す");
  await page.locator("#pp-tab-list").press("Home");
  check(await page.locator("#pp-view-companies").isVisible(), "Homeで企業分析へ戻れる");
  check(new URL(page.url()).searchParams.get("view") === "companies", "企業分析の選択をURLに残す");
  check(!errs.length, `企業分析の初期表示で実行時エラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 管理側：一覧 ===");
{
  const { page, errs } = await openAs(MANAGER);
  const nav = await page.locator(".sl-nav a.on").innerText();
  check(nav.includes("提案"), `ナビの「提案」が選ばれている（${nav}）`);
  const rows = await page.locator("#rows tr.click").count();
  check(rows === 4, `対応中の提案が4件（いま ${rows}）`);
  const text = await page.locator("#rows").innerText();
  check(text.includes("株式会社サンプル商事") && text.includes("Java 開発（金融）") && text.includes("T.K."), "企業・案件名・人材イニシャル");
  check(text.includes("未割当"), "担当が決まらない提案は「未割当」");
  check((await page.locator('#pp-column-head th').count()) === 6, 'チェック列と5つの業務列だけを表示');
  check(!(await page.locator('#pp-column-head').innerText()).includes('CS担当'), '役割ごとの担当は詳細へ集約');
  const waitRow = await page.locator("#rows tr.click", { hasText: "株式会社マッチ確定" }).innerText();
  check(waitRow.includes("提案中") && waitRow.includes("提案前"), `提案待ちの行：状態・未提案を表示（${waitRow.replace(/\s+/g, " ")}）`);
  check(!(await page.locator("#rows tr.click", { hasText: "株式会社マッチ確定" }).locator(".pp-over").count()), "提案待ちの電話を赤くしない");
  await page.getByText("今日の対応件数・契約の確認",{exact:true}).click();
  check((await page.locator("#sum").innerText()).includes("提案準備"), "今日やることに「提案準備」");
  const slackInputs = await page.locator("#st-slack [data-slack]").count();
  check(slackInputs === 3, `設定に Slack のメンバーIDの欄（Sales を使える3人。いま ${slackInputs}）`);
  const overdueRow = page.locator("#rows tr.overdue");
  check(await overdueRow.count() === 1, "期限超過の行が1件（赤い印）");
  check((await overdueRow.innerText()).includes("テスト工業"), "期限超過は テスト工業");
  check((await page.locator("#sum").innerText()).includes("担当未割当"), "管理側には「担当未割当」の件数");
  await page.getByText("詳しい条件・表示設定",{exact:true}).click();
  check(await page.locator("#f-proposal-owner").isVisible() && await page.locator("#f-closing-owner").isVisible(), "管理側は提案・クロージング担当を別々に絞れる");
  check((await page.locator("#admin-sec").innerText()).includes("dx.enger 連携の確認"), "連携エラー・設定が出る");
  const first = await page.locator("#rows tr.click").first().innerText();
  check((await page.locator("#f-sort").inputValue()) === "due", "初期並びは期限が近い順");
  await page.screenshot({ path: shotPath("proposals-list-pc.png"), fullPage: true });

  // 画面をタブで分割。管理画面とKPIを縦に積まない。
  check(await page.locator("#pp-view-list").isVisible(), "提案履歴の明示リンクは個別一覧を開く");
  check(await page.locator("#pp-view-kpi").isHidden(), "KPIは一覧の下に表示しない");
  check(await page.locator("#pp-view-admin").isHidden(), "連携履歴は一覧の下に表示しない");
  await page.locator("#pp-tab-kpi").click();
  check(await page.locator("#pp-view-kpi").isVisible(), "KPIタブへ移動できる");
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
  await page.locator("#f-q").fill("該当しない検索語");
  await page.locator("#rows").getByText("この条件の提案はありません", { exact: true }).waitFor();
  check(await page.locator("#pp-pagination").isHidden(), "0件ではページ送りを表示しない");
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 営業担当：マッチング初期表示・展開式連絡と履歴 ===");
{
  const {page,errs}=await openAs(S1);
  check(await page.locator("#rows tr.click").count()===4,"営業担当も提案一覧を確認できる");
  const heights=await page.locator('#rows tr.click').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
  check(Math.max(...heights)-Math.min(...heights)<=1,"一覧の行高をそろえる");
  const readonly=page.locator("#rows tr.click",{hasText:"株式会社ミライ"}).locator("input[type=checkbox]");
  await readonly.check();
  check(await readonly.isChecked(),"閲覧専用提案の選択はできる");
  for(const id of ["pp-bulk-edit","pp-bulk-archive","pp-bulk-restore"])
    check(await page.locator("#"+id).isDisabled(),"他担当の一括変更は禁止："+id);
  await readonly.uncheck();
  await page.locator("#rows tr.click",{hasText:"株式会社ミライ"}).click();
  check(await page.locator('#pp-detail-tab-matching').getAttribute('aria-selected')==='true',
    "モーダルはマッチングが初期タブ");
  check(await page.locator("#pp-detail").getByRole('tab').count()===3,"詳細は3タブだけ");
  await page.keyboard.press("Escape");

  await page.locator("#rows tr.click",{hasText:"株式会社サンプル商事"}).click();
  await page.locator("#pp-detail .pp-match-big-number").waitFor();
  check(await page.locator("#pp-detail-tab-matching").getAttribute('aria-selected')==='true',
    "提案を開くたびマッチングから始まる");
  check((await page.locator(".pp-match-big-number").innerText()).includes("100%"),
    "登録スキル一致率を大きく表示する");
  check((await page.locator(".pp-match-chips").innerText()).includes("Java"),
    "何のスキルがマッチしたか表示する");
  check(await page.locator('#pp-detail .pp-contact-side').count()===2,
    "企業側と人材側の連絡先を上部に集約する");
  const pair=page.getByRole('region',{name:'人材と案件の比較'});
  const talent=pair.getByRole('region',{name:'人材サマリー'});
  const job=pair.getByRole('region',{name:'案件サマリー'});
  await talent.locator('.pp-compare-quick').getByText('Java / SQL',{exact:true}).waitFor();
  await job.locator('.pp-compare-quick').getByText('Java / PostgreSQL',{exact:true}).waitFor();
  check((await talent.boundingBox()).x<(await job.boundingBox()).x,"人材と案件は左右に表示する");
  await talent.locator(".pp-inline-entity > summary").click();
  check((await talent.innerText()).includes('所属テスト社'),"詳細は同じカードの下に展開する");
  await talent.locator(".pp-inline-sheet > summary").click();
  check((await talent.innerText()).includes('経験年数'),"スキルシートも下に展開する");
  check(await page.locator('#pp-entity .pp-entity-dialog').count()===0,
    "詳細だけで別モーダルを増やさない");

  await page.locator("#pp-detail").getByRole('tab',{name:'商談',exact:true}).click();
  await page.locator('.pp-compat-summary').waitFor();
  check((await page.locator('.pp-compat-summary').innerText()).includes('企業との進行相性'),
    "企業との相性・人材との相性を別々に表示する");
  check((await page.locator('.pp-compat-summary').innerText()).includes('面談通過・合格確率ではありません'),
    "相性の数値を実際の面談確率と誤認させない");
  const contact=page.locator("#pp-detail .pp-contact-side").first();
  check(await contact.locator('a[href^="tel:"]').count()===1,"電話はワンクリックで開ける");
  await contact.getByRole('button',{name:'連絡する'}).click();
  check(await page.locator('#pp-mail-form').isVisible(),"連絡フォームが商談タブの下に開く");
  await page.locator('#pp-mail-subject').fill('面談候補日について');
  await page.locator('#pp-mail-body').fill('面談をご検討いただけますでしょうか。');
  await page.locator('#pp-mail-record').click();
  check((await page.locator('#pp-mail-status').innerText()).includes('実際に送信'),
    "明示確認なく送信済みを記録しない");
  await page.locator('#pp-mail-confirm').check();
  await page.locator('#pp-mail-record').click();
  await page.locator('#pp-inline-compose[hidden]').waitFor({state:'attached'});
  check(await page.locator('#pp-inline-compose').isHidden(),"保存後は作成フォームを閉じる");

  const src=page.locator(".pp-business-source");
  await src.locator(':scope > summary').click();
  const coordination=page.getByRole('region',{name:'ENGERとの連携'});
  await coordination.getByText("企業の回答",{exact:true}).waitFor();
  check(await coordination.getByText("人材の回答",{exact:true}).isVisible(),
    "ENGERの双方回答を商談の展開内で確認できる");
  await coordination.getByRole('button',{name:'記録',exact:true}).click();
  await coordination.getByLabel('確認したこと・決まったこと').fill('開始日の回答を待つ');
  await coordination.getByLabel('次の対応・担当・期限').fill('営業一郎が24日までに回答');
  await coordination.getByRole('button',{name:'共有',exact:true}).click();
  check(coordinationRecord?.decision==='開始日の回答を待つ',"ENGERとの認識合わせを保存できる");

  const editor=page.locator('.pp-business-editor');
  await editor.locator('summary').click();
  check(await page.locator('#pr-note').isVisible(),"進捗フォームは必要なときだけ開く");
  await page.locator('#pr-note').fill('入力中の商談メモ');
  await page.getByRole('tab',{name:'履歴',exact:true}).click();
  check(await page.locator('.pp-history-item').count()>0,"履歴をコンパクトな行で表示する");
  await page.locator('.pp-history-item summary').first().click();
  check(await page.locator('.pp-history-item[open] time').count()===1,
    "履歴を開くと日時と内容を確認できる");
  await page.getByRole('tab',{name:'商談',exact:true}).click();
  check((await page.locator('#pr-note').inputValue())==='入力中の商談メモ',"タブ切替で入力内容が消えない");
  await page.locator('#pr-note').fill('');

  await page.getByRole('tab',{name:'マッチング',exact:true}).click();
  const assessment=page.getByRole('region',{name:'成約分析'});
  await assessment.locator('[data-readiness-more] > summary').click();
  await assessment.getByRole('button',{name:'編集',exact:true}).click();
  await assessment.getByLabel('意思確認の経路').selectOption('sheet');
  await assessment.getByRole('button',{name:'保存',exact:true}).click();
  check(readinessRevision===1 && readinessFacts.candidateContact==='sheet',
    "マッチング評価の根拠を保存できる");

  await openDetailTools(page);
  await page.locator('#pp-detail button',{hasText:'電話の結果を記録'}).click();
  await page.locator("#m-ok").click();
  check((await page.locator("#m-msg").innerText()).includes("結果を選んでください"),
    "電話結果の未入力は保存させない");
  await page.locator("#kp-action-feedback").getByRole("button",{name:"閉じる"}).click();
  await page.locator('input[name="m-result"][value="no_answer"]').check();
  await page.locator("#m-ok").click();
  await page.waitForTimeout(300);
  await openDetailTools(page);
  await page.locator('#pp-detail button',{hasText:'確認メールを送った'}).click();
  await page.locator('#m-ok').click();
  await page.waitForTimeout(300);

  await page.getByRole('tab',{name:'商談',exact:true}).click();
  await page.locator('.pp-business-editor > summary').click();
  await page.getByLabel('進捗',{exact:true}).selectOption('conditions');
  await page.getByLabel('対応結果・メモ',{exact:true}).fill('単価と開始日を確認');
  await page.getByLabel('次にやること',{exact:true}).fill('企業へ条件確認');
  await page.getByLabel('期限（日本時間）',{exact:true}).fill('2026-12-01T15:00');
  await page.getByLabel('売上見込み（円・税抜）',{exact:true}).fill('800000');
  await page.getByLabel('原価見込み（円・税抜）',{exact:true}).fill('700000');
  await page.locator('#pp-record-form').getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForTimeout(400);
  check((await page.locator('#rows').innerText()).includes('月額 80万円'),
    "商談で保存した売上が提案一覧にも反映される");

  await page.getByRole('tab',{name:'商談',exact:true}).click();
  if(!(await page.locator('.pp-business-editor').evaluate(el=>el.open)))
    await page.locator('.pp-business-editor > summary').click();
  await page.getByLabel('進捗',{exact:true}).selectOption('won');
  await page.getByLabel('対応結果・メモ',{exact:true}).fill('契約内容を双方で確認');
  await page.getByLabel('契約が確定している').check();
  const savedWon=page.waitForResponse(r=>r.url().endsWith('/api/sales/proposals/detail')&&r.request().method()==='POST');
  await page.locator('#pp-record-form').getByRole('button',{name:'保存',exact:true}).click();
  check((await savedWon).status()===200,"面談・条件調整を経て成約登録できる");
  check(!errs.length,"画面エラーなし："+errs.join(" / "));
  await page.close();
}

console.log("\n=== 営業担当：提案待ち → 企業へ提案した → 電話待ち ===");
{
  const { page, errs } = await openAs(S1);
  await page.getByText("詳しい条件・表示設定",{exact:true}).click();
  await page.locator("#pp-more-filters > summary").click();
  await page.locator("#filters-extra button", { hasText: "マッチング済み" }).click();
  await page.waitForTimeout(400);
  check(await page.locator("#rows tr.click").count() === 1, "「マッチング済み」（提案待ち）で絞ると1件");
  await page.locator("#rows tr.click", { hasText: "株式会社マッチ確定" }).click();
  await page.waitForSelector("#pp-detail .pp-readiness");
  await page.locator("#pp-detail").getByRole("tab",{name:"商談",exact:true}).click();
  const d = await page.locator("#pp-detail").innerText();
  check(d.includes("提案準備"), "未送信は提案準備を次の行動に表示");
  check(d.includes("企業へはまだ提案していません"), "まだ企業へ提案していないと出る");
  check(await page.locator("#pp-detail button", { hasText: "電話の結果を記録" }).count() === 0, "提案待ちには電話の記録ボタンを出さない");
  await page.locator("#pp-detail").getByRole("tab",{name:"商談",exact:true}).click();
  await page.locator(".pp-business-editor > summary").click();
  check(await page.locator("#pr-note").isVisible(), "提案待ちでも編集欄を展開できる");
  await openDetailTools(page);
  await page.screenshot({ path: shotPath("proposals-waiting-pc.png") });
  await page.locator("#pp-detail button", { hasText: "企業への提案送信を記録" }).click();
  await page.locator("#m-ch").selectOption("phone");
  await page.locator("#m-ok").click();
  await page.waitForTimeout(500);
  await page.locator("#pp-detail").getByRole("tab",{name:"商談",exact:true}).click();
  const after = await page.locator("#pp-detail").innerText();
  check(after.includes("初回電話（提案から30分以内）"), "初回電話のタスクができる");
  await openDetailTools(page);
  check((await page.locator("#pp-detail").innerText()).includes("提案送信（Sales で記録）"), "履歴に提案送信（Sales で記録）");
  check(await page.locator("#pp-detail button", { hasText: "電話の結果を記録" }).count() === 1, "送ったあとは電話を記録できる");
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== スマホ（390px） ===");
{
  const { page, errs } = await openAs(S1, { width: 390, height: 844 });
  check(await page.locator(".pp-tablewrap").isHidden(), "表は隠れる");
  check(await page.locator("#cards .pp-card").count() === 4, "カードでもチーム全件4件が閲覧可能");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(over <= 1, `横にはみ出さない（${over}px）`);
  await page.screenshot({ path: shotPath("proposals-list-mobile.png"), fullPage: true });
  await page.locator("#cards .pp-card").first().click();
  await page.waitForSelector("#pp-detail .pp-readiness");

  const mobileSize=await page.locator('.pp-detail-dialog').boundingBox();
  check(mobileSize.width<=390&&mobileSize.width>=350,'スマホでは画面幅に収める');
  const pair = page.getByRole('region', { name: '人材と案件の比較' });
  const left = pair.getByRole('region', { name: '人材サマリー' });
  const right = pair.getByRole('region', { name: '案件サマリー' });
  await left.locator('.pp-compare-quick').getByText('Java / SQL', { exact: true }).waitFor();
  check(await pair.evaluate(el => el.scrollWidth <= el.clientWidth), 'スマホで人材・案件が横にはみ出さない');
  await page.locator('#pp-detail').getByRole('tab',{name:'商談',exact:true}).click();
  await page.locator('.pp-business-editor > summary').click();
  await page.locator('#pr-note').fill('スマホでも入力を保持');
  await page.locator('#pp-detail').getByRole('tab',{name:'商談',exact:true}).click();
  check(await page.locator('#pr-revenue').isVisible(),'スマホでも商談内の売上を編集できる');
  await page.locator('#pp-detail').getByRole('tab',{name:'商談',exact:true}).click();
  check((await page.locator('#pr-note').inputValue())==='スマホでも入力を保持','スマホのタブでも入力を保持');
  await page.screenshot({ path: shotPath("proposals-detail-mobile.png") });
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 面談候補から日程を記録 ===");
{
  const candidate = mem.rows.gw_sales_proposals.find(p => p.source_proposal_id === "p-2");
  candidate.status = "considering";
  candidate.contact_phone = null;
  process.env.SALES_SOURCE_STATE_ENABLED = "1";
  mem.rows.gw_sales_proposal_source_state = [{
    tenant_id: T1, source_proposal_id: "p-2", source_version: "1", deleted: false,
    company_response: "unanswered", candidate_response: "unanswered", observed_at: nowIso(),
  }];
  const { page, errs } = await openAs(S1);
  await page.locator("#filters").getByRole("button", { name: /面談候補/ }).click();
  await page.locator("#pp-meeting-hint").waitFor();
  const row = page.locator("#rows tr.click", { hasText: "テスト工業株式会社" });
  await row.getByText("検討中", { exact: true }).waitFor();
  check(await page.locator("#rows tr.click").count() === 1, "未確定の検討中だけを候補に表示");
  await row.click();
  await page.locator("#pp-detail").getByRole("tab",{name:"商談",exact:true}).click();
  check((await page.locator("#pp-detail").getByRole("link", { name: "メール", exact: true }).getAttribute("href")) ===
    "mailto:madoguchi@example.jp", "電話番号がなければ登録済みメールを使える");
  await page.getByRole("button", { name: "日程を記録", exact: true }).click();
  check(await page.locator('input[name="m-result"][value="scheduled"]').isChecked(), "日程確定が選択済みで開く");
  await page.locator("#m-nextat").fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
  await page.locator(".sl-modal").getByRole("button", { name: "保存", exact: true }).click();
  await page.locator("#rows").getByText("この条件の提案はありません", { exact: true }).waitFor();
  check(Boolean(candidate.meeting_at || mem.rows.gw_sales_proposals.find(p=>p.id===candidate.id).meeting_at), "保存した日程が案件に記録される");
  check(!errs.length, `画面のエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\n提案管理の画面は動いています");
process.exit(bad ? 1 : 0);

