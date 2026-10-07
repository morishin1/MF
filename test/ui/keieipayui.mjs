// 経営（/keiei/）の「給与管理」を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・メニューに「給与管理」があり、一覧に、いまの給与・適用開始日・状態（未登録・契約と不一致・変更予定）が出る
//   ・1人の画面に、いまの給与・参照（契約・内定・届出）・記録フォーム・履歴・監査ログが出る
//   ・記録は「内容を確認する」を通ってから。確認のあとで入力を変えたら、確認は消える（見たものと違うものを記録しない）
//   ・変更と訂正で、履歴が増える。前の行は残る（消す・書き換えるボタンは、どこにも無い）
//   ・理由が無い／画面が古い、などのサーバの断りは、押したボタンの近くに出る
//   ・表が無いときは「データ未連携」（0円とは出さない）
//   ・氏名などに HTML が入っていても、画面を壊さない
//   ・スマホ幅で横スクロールしない
//
// サーバの代わりに、本物の規則（lib/compensation.js）を使う小さな代役を置く。
// 画面が見るのは、その応答（本物の API と同じ形）。API そのものの検証は test/keieipayapi.mjs。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const { accessOf: serverAccessOf } = await import("../../lib/gw.js");
const C = await import("../../lib/compensation.js");
const K = await import("../../lib/compensation-candidate.js");

const TODAY = C.todayJst();
const day = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ---- サーバの代役 --------------------------------------------------------------------
function makeServer({ linked = true, evil = false } = {}) {
  const st = { rows: [], audit: [], posts: [], n: 0, auditSeq: 1000, failNext: null };
  const emps = [
    { id: "p1", name: evil ? `<img src=x onerror="window.__pwn=1">山田` : "山田 月給", department: "開発", position: "エンジニア", status: "active", joinedOn: "2025-04-01" },
    { id: "p2", name: "佐藤 未登録", department: "営業", position: null, status: "active", joinedOn: "2026-09-01" },
    { id: "p3", name: "鈴木 契約違い", department: "開発", position: null, status: "active", joinedOn: "2025-04-01" },
    { id: "p4", name: "高橋 退職", department: null, position: null, status: "left", joinedOn: "2024-04-01" },
    { id: "p5", name: "田中 候補なし", department: "総務", position: null, status: "active", joinedOn: "2026-08-01" },
    { id: "p6", name: "伊藤 入社準備", department: "開発", position: null, status: "invited", joinedOn: "2026-10-15" },
  ];
  const contracts = {
    p1: { id: "k1", type: "正社員", periodFrom: "2025-04-01", periodTo: null, wageType: "月給", wageAmount: 300000, wageNote: "役職手当 20000円" },
    p2: { id: "k2", type: "正社員", periodFrom: "2026-09-01", periodTo: null, wageType: "月給", wageAmount: 280000, wageNote: null },
    p3: { id: "k3", type: "正社員", periodFrom: "2025-04-01", periodTo: null, wageType: "月給", wageAmount: 260000, wageNote: null },
    p6: { id: "k6", type: "正社員", periodFrom: "2026-10-15", periodTo: null, wageType: "年俸", wageAmount: 4800000, wageNote: "資格手当 5000円" },
  };
  const offers = { p2: { wageType: "月給", wageAmount: 270000, from: "内定（合格通知）" } };
  const declared = { p2: 9000 };

  const dbRow = (id, employee, effective_from, extra = {}) => ({
    id, employee_id: employee, effective_from, revision: 1, kind: "initial", source: "owner", wage_type: "月給", base_amount: 300000,
    allowances: [], commute_amount: null, commute_note: null, contract_id: null, contract_wage_type: null, contract_wage_amount: null,
    reason: "入社時", before: null, created_by_name: "森田 経営", created_at: "2026-04-01T01:00:00Z", ...extra });
  st.rows.push(
    dbRow("r1", "p1", "2025-04-01", { base_amount: 280000 }),
    dbRow("r2", "p1", "2026-04-01", { kind: "change", base_amount: 300000, allowances: [{ name: "役職手当", amount: 20000 }], commute_amount: 10000, reason: "昇給と役職手当",
      before: { effectiveFrom: "2025-04-01", revision: 1, wageType: "月給", baseAmount: 280000, allowances: [], commuteAmount: null } }),
    dbRow("r3", "p3", "2025-04-01", { base_amount: 250000 }),
    dbRow("r4", "p4", "2024-04-01", { base_amount: 200000 }));
  const log = (action, employeeId, detail = null) => st.audit.unshift({ id: ++st.auditSeq, ts: new Date().toISOString(), action, actor_name: "森田 経営", employee_id: employeeId, record_id: null, detail });

  for (const [a, e] of [["create", "p1"], ["create", "p1"], ["view_detail", "p3"], ["view_list", null]]) log(a, e, a === "create" ? { kind: "change", source: "owner", effective_from: "2026-04-01", revision: 1, reason: "昇給" } : null);
  const recsOf = (id) => st.rows.filter((r) => r.employee_id === id).map(C.viewOf);
  const meta = { wageTypes: C.WAGE_TYPES, allowancePresets: C.ALLOWANCE_PRESETS, kindLabel: C.KIND_LABEL, sourceLabel: C.SOURCE_LABEL, limits: C.LIMITS };
  const contractRow = (id) => (contracts[id] ? { id: contracts[id].id, wage_type: contracts[id].wageType, wage_amount: contracts[id].wageAmount } : null);

  const buildFor = (id) => {
    const e = emps.find((x) => x.id === id);
    return K.buildCandidate({ contract: contracts[id] || null, contractCount: contracts[id] ? 1 : 0, offer: offers[id] || null,
      commuteDeclared: declared[id] ?? null, employee: { joinedOn: e.joinedOn } });
  };
  const candidateOf = (id, e, recs) => {
    if (recs.length) return { candidate: null, candidateWhy: [] };
    const b = buildFor(id);
    return { candidate: b.candidate ? { ...b.candidate, warnings: b.warnings, dateHints: b.dateHints } : null, candidateWhy: b.why };
  };
  const candidates = () => {
    const rows = emps.filter((e) => ["active", "leaving", "invited"].includes(e.status) && !st.rows.some((r) => r.employee_id === e.id)).map((e) => {
      const b = buildFor(e.id);
      return { ...e, isBp: false, candidate: b.candidate, warnings: b.warnings, why: b.why, dateHints: b.dateHints };
    }).sort((a, b) => Number(Boolean(b.candidate)) - Number(Boolean(a.candidate)));
    log("view_list", null, { via: "candidates", rows: rows.length });
    return { linked: true, rows, meta, summary: { total: rows.length, withCandidate: rows.filter((r) => r.candidate).length, withoutCandidate: rows.filter((r) => !r.candidate).length } };
  };
  const list = () => {
    const rows = emps.map((e) => {
      const recs = recsOf(e.id);
      const cur = C.currentAt(recs, TODAY);
      const chk = C.contractCheck(cur, contractRow(e.id));
      return { ...e, isBp: false, recordCount: recs.length, current: cur, next: C.upcomingAfter(recs, TODAY)[0] || null,
        flags: C.statusFlags(recs, contractRow(e.id), TODAY),
        contract: chk.contract ? { wageType: chk.contract.wageType, wageAmount: chk.contract.wageAmount, state: chk.state } : null };
    });
    const inService = rows.filter((r) => ["active", "leaving"].includes(r.status));
    const totals = inService.map((r) => r.current?.monthly?.total).filter((n) => n != null);
    log("view_list", null);
    return { linked: true, today: TODAY, rows, meta, summary: {
      inService: inService.length, registered: inService.filter((r) => r.current).length,
      unregistered: inService.filter((r) => r.flags.includes("unregistered") || r.flags.includes("future_only")).length,
      upcoming: inService.filter((r) => r.flags.includes("upcoming")).length, mismatch: inService.filter((r) => r.flags.includes("mismatch")).length,
      monthlyTotal: totals.reduce((s, n) => s + n, 0), monthlyCounted: totals.length, hourlyLike: 0, bpExcluded: 1, contractsLinked: true } };
  };
  const detail = (id, { quiet = false } = {}) => {
    const e = emps.find((x) => x.id === id);
    const recs = recsOf(id);
    const cur = C.currentAt(recs, TODAY);
    if (!quiet) log("view_detail", id);
    const chk = C.contractCheck(cur, contractRow(id));
    return { linked: true, today: TODAY, employee: { id: e.id, name: e.name, department: e.department, position: e.position, employmentType: null, status: e.status, joinedOn: e.joinedOn, isBp: false },
      current: cur, upcoming: C.upcomingAfter(recs, TODAY),
      groups: C.historyGroups(recs).map((g) => ({ effectiveFrom: g.effectiveFrom, latestRevision: g.latest.revision,
        revisions: g.revisions.map((r) => ({ ...r, changes: C.diffSnapshots(r.before, C.snapshotOf(r)), basisText: K.describeBasis(r.basis) })) })),
      recordCount: recs.length, flags: C.statusFlags(recs, contractRow(id), TODAY),
      ...candidateOf(id, e, recs),
      references: { contract: { view: contracts[id] || null, check: chk.state }, offer: offers[id] || null, commuteDeclared: declared[id] ?? null },
      audit: st.audit.filter((a) => a.employee_id === id).slice(0, 50).map(C.auditView), auditUnavailable: false, meta };
  };
  const plan = (post) => {
    const norm = C.normalizeRecordInput(post);
    if (norm.error) return { status: 400, body: { error: norm.error, field: norm.field, hint: norm.hint } };
    let basis = null;
    if (post.candidate === true) {
      if (recsOf(post.employeeId).length) return { status: 409, body: { error: "candidate_not_initial", hint: "候補は、最初の記録にだけ使えます。この人には、すでに記録があります" } };
      const built = buildFor(post.employeeId);
      if (!built.candidate) return { status: 409, body: { error: "no_candidate", hint: built.why.join("／") } };
      norm.value.source = K.sourceOf(built.candidate, norm.value);
      basis = K.basisOf(built.candidate, norm.value);
    }
    const planned = C.planRecord(recsOf(post.employeeId), norm.value, { today: TODAY, contract: contractRow(post.employeeId) });
    if (planned.error) return { status: 409, body: { error: planned.error, hint: planned.hint } };
    return { norm: norm.value, plan: planned.plan, basis };
  };
  const handle = (method, url, post) => {
    if (!linked) return { body: { linked: false, hint: "この機能に必要なテーブルがまだ作られていません。管理者に db/105_compensation.sql の実行を依頼してください" } };
    if (method === "GET") {
      const q = new URL(url).searchParams;
      const view = q.get("view") || "list";
      if (view === "list") return { body: list() };
      if (view === "detail") return { body: detail(q.get("employeeId")) };
      if (view === "candidates") return { body: candidates() };
      // audit: 2 ページ（新しい順）
      log("view_audit", null);
      const before = Number(q.get("before") || 0);
      const all = [...st.audit];
      const rows = (before ? all.filter((a) => a.id < before) : all).slice(0, 3);
      const more = (before ? all.filter((a) => a.id < before) : all).length > 3;
      return { body: { linked: true, rows: rows.map((r) => ({ ...C.auditView(r), employeeName: emps.find((e) => e.id === r.employee_id)?.name || null })), nextBefore: more ? String(rows[rows.length - 1].id) : null } };
    }
    st.posts.push(post);
    if (st.failNext) { const f = st.failNext; st.failNext = null; return { status: f.status, body: f.body }; }
    const p = plan(post);
    if (p.status) return p;
    if (post.action === "preview_record") {
      return { body: { preview: { basis: p.basis ? { text: K.describeBasis(p.basis), edited: p.basis.edited, sources: p.basis.sources.map((x) => x.type) } : null, kind: p.plan.kind, kindLabel: C.KIND_LABEL[p.plan.kind], revision: p.plan.revision, effectiveFrom: p.plan.after.effectiveFrom,
        before: p.plan.before, after: p.plan.after, changes: p.plan.changes, warnings: p.plan.warnings, basisId: p.plan.basisId,
        monthly: C.viewOf({ wage_type: p.norm.wageType, base_amount: p.norm.baseAmount, allowances: p.norm.allowances, commute_amount: p.norm.commuteAmount }).monthly,
        contractCheck: (() => { const c = C.contractCheck({ wageType: p.norm.wageType, baseAmount: p.norm.baseAmount }, contractRow(post.employeeId)); return { state: c.state, contract: c.contract }; })() } } };
    }
    if (post.basisId !== undefined && (post.basisId || null) !== p.plan.basisId) return { status: 409, body: { error: "stale_basis", hint: "画面を開いたあとに、この人の給与が更新されました。開き直して、内容を確かめてから記録してください" } };
    const id = `n${++st.n}`;
    st.rows.push(dbRow(id, post.employeeId, p.norm.effectiveFrom, {
      revision: p.plan.revision, kind: p.plan.kind, source: p.norm.source, wage_type: p.norm.wageType, base_amount: p.norm.baseAmount,
      allowances: p.norm.allowances, commute_amount: p.norm.commuteAmount, commute_note: p.norm.commuteNote, reason: p.norm.reason,
      before: p.plan.before, basis: p.basis, created_at: new Date().toISOString() }));
    log(p.plan.kind === "correction" ? "correct" : "create", post.employeeId, { kind: p.plan.kind, source: p.norm.source, effective_from: p.norm.effectiveFrom, revision: p.plan.revision, reason: p.norm.reason, candidate: p.basis != null });
    return { body: { ...detail(post.employeeId, { quiet: true }), result: { recordId: id, kind: p.plan.kind, revision: p.plan.revision, effectiveFrom: p.norm.effectiveFrom } } };
  };
  return { st, handle };
}

async function open(who, { width = 1280, server, hash = "#pay" } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me");
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: false, roles: [],
        gw: { employee: { id: "e1", display_name: "森田 経営", status: "active" }, roles: who.roles || ["owner"], tenantId: "t1", stage: null },
        access: serverAccessOf({ isAdmin: false, roles: who.roles || ["owner"] }) });
    }
    if (/\/api\/keiei\/pay/.test(url)) {
      const req = route.request();
      const r = server.handle(req.method(), url, req.method() === "POST" ? JSON.parse(req.postData() || "{}") : null);
      return send(r.body, r.status || 200);
    }
    return send({});
  });
  await page.goto(`${BASE}/keiei/index.html${hash}`);
  await page.waitForTimeout(900);
  return page;
}
const text = (page, sel = "body") => page.locator(sel).innerText();
const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

console.log("— 一覧 —");
{
  const server = makeServer();
  const page = await open({}, { server });
  // 横タブ：ホーム｜売上・営業｜人・組織｜財務｜リスク。給与管理は「人・組織」の中（2段目）にある
  const tabs = (await page.locator("#kp-keiei-nav .kp-otab").evaluateAll((ns) => ns.map((n) => n.dataset.ktab))).join(",");
  check(tabs === "home,sales,people,finance,risk", `横タブは5つ（${tabs}）`);
  check((await page.locator("#kp-keiei-nav .kp-otab.on").getAttribute("data-ktab")) === "people", "給与管理を開くと、「人・組織」のタブが選ばれる");
  const subs = (await page.locator("#kp-keiei-nav .kp-ostab[data-kview]").evaluateAll((ns) => ns.map((n) => n.dataset.kview))).join(",");
  check(subs === "onboarding,pay,people", `「人・組織」の2段目に「給与管理」がある（入社準備・給与管理・概要の順。${subs}）`);
  check((await page.locator('[data-role="to-payroll"]').getAttribute("href")) === "#payroll", "人件費の集計への入口（メニューから外したので、給与管理の一覧から入る）");
  check((await page.locator("#kp-keiei-nav .kp-ostab.on").getAttribute("data-kview")) === "pay", "2段目の強調は「給与管理」");
  const t = await text(page);
  check(t.includes("給与管理") && t.includes("山田 月給") && t.includes("佐藤 未登録") && t.includes("鈴木 契約違い"), "在籍の人が並ぶ");
  check(!t.includes("高橋 退職"), "退職者は、既定では出さない");
  check(await page.locator('tr[data-employee="p1"]').innerText().then((s) => s.includes("300,000円") && s.includes("330,000円") && s.includes("2026/04/01")),
    "山田: 基本給・月額の見立て（基本給＋手当＋通勤手当）・適用開始日が出る");
  check(await page.locator('tr[data-employee="p2"] [data-flag="unregistered"]').count() === 1, "佐藤: 「未登録」");
  check(await page.locator('tr[data-employee="p3"] [data-flag="mismatch"]').count() === 1, "鈴木: 「契約と不一致」");
  check((await text(page, '[data-role="s-mismatch"]')).includes("1"), "集計: 契約と不一致 1人");
  check((await text(page, '[data-role="s-total"]')).includes("580,000円"), "集計: 月額の合計は、330,000＋250,000＝580,000円");
  check(t.includes("人事・管理者の既存の画面での給与の扱いは、この工程では変わりません"), "既存のHR側の権限は変わらないと明記");
  // 表示の切替
  await page.selectOption("#pay-scope", "left");
  check((await text(page, '[data-role="pay-table"]')).includes("高橋 退職"), "「退職者」を選ぶと出る");
  await page.selectOption("#pay-scope", "service");
  await page.selectOption("#pay-flag", "mismatch");
  check(await page.locator("tbody tr[data-employee]").count() === 1, "状態「契約と不一致」で絞れる");
  await page.selectOption("#pay-flag", "");
  await page.fill("#pay-q", "佐藤");
  check(await page.locator("tbody tr[data-employee]").count() === 1, "氏名で絞れる");
  check(await page.locator("button:has-text('削除')").count() === 0, "削除ボタンは無い");
  await page.screenshot({ path: shotPath("keiei-pay-list-pc.png") });
  await page.close();
}

console.log("\n— 初めて記録する（契約の賃金を写す → 確認 → 記録）—");
{
  const server = makeServer();
  const page = await open({}, { server });
  await page.click('tr[data-employee="p2"] [data-role="open"]');
  await page.waitForTimeout(500);
  check((await text(page, '[data-role="title"]')) === "佐藤 未登録", "1人の画面が開く");
  check(await page.locator('[data-role="no-current"]').count() === 1, "まだ記録が無いと出る");
  check((await text(page, '[data-role="ref-contract"]')).includes("280,000円"), "参照: 契約上の賃金");
  check((await text(page, '[data-role="ref-offer"]')).includes("270,000円"), "参照: 内定時の給与");
  check((await text(page, '[data-role="ref-commute"]')).includes("9,000円"), "参照: 本人が届け出た定期代");
  check((await text(page)).includes("ここから書き換わりません"), "参照は書き換わらないと明記");
  // 理由なしで確認 → サーバが断る（理由は必須）
  await page.fill('[name="effectiveFrom"]', "2026-09-01");
  await page.fill('[name="baseAmount"]', "280000");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  check((await text(page, '[data-role="form-err"]')).includes("変更理由"), "理由が空だと、フォームの近くに断りが出る");
  check(await page.locator('[data-role="preview"]').count() === 0, "確認は出ない");
  // 契約から写す
  await page.click('[data-act="import-contract"]');
  check(await page.inputValue('[name="baseAmount"]') === "280000" && await page.inputValue('[name="wageType"]') === "月給", "契約の賃金が入力欄に入る");
  check((await page.inputValue('[name="reason"]')).includes("契約"), "理由の下書きが入る（直せる）");
  check(server.st.rows.filter((r) => r.employee_id === "p2").length === 0, "写しただけでは、何も記録されない");
  await page.fill('[name="effectiveFrom"]', "2026-09-01");
  await page.fill('[name="commuteAmount"]', "9,000");
  await page.click('[data-act="add-allow"]');
  await page.fill('.pay-arow [name="a-name"]', "資格手当");
  await page.fill('.pay-arow [name="a-amount"]', "5000");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  const pv = await text(page, '[data-role="preview"]');
  check(pv.includes("初回") && pv.includes("2026/09/01") && pv.includes("資格手当"), "確認: 初回・適用開始日・手当が出る");
  check(pv.includes("294,000円"), "確認: 月額の見立て 280,000＋5,000＋9,000＝294,000円");
  check(pv.includes("最初の記録です"), "確認: 最初の記録と分かる");
  // 確認のあとで入力を変えたら、確認は消える
  await page.fill('[name="baseAmount"]', "290000");
  check(await page.locator('[data-role="preview"]').count() === 0, "確認のあとで入力を変えると、確認が消える（見たものと違うものを記録しない）");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  check((await text(page, '[data-role="preview"]')).includes("304,000円"), "確認し直すと、新しい値で出る");
  await page.screenshot({ path: shotPath("keiei-pay-preview-pc.png"), fullPage: true });
  await page.click('[data-role="record-btn"]');
  await page.waitForTimeout(600);
  check((await text(page, '[data-role="msg"]')).includes("初回として記録しました"), "記録すると、完了の表示");
  check((await text(page, '[data-role="base"]')).includes("290,000円"), "いまの給与に反映される");
  check((await text(page, '[data-role="allowances"]')).includes("資格手当"), "手当が出る");
  check((await text(page, '[data-role="commute"]')).includes("9,000円"), "通勤手当が出る");
  check(await page.locator('[data-role="history"] tbody tr').count() === 1, "履歴が1行できる");
  const rec = server.st.rows.find((r) => r.employee_id === "p2");
  check(rec && rec.source === "owner" && rec.kind === "initial", "サーバへ渡った記録は初回");
  check(server.st.posts.at(-1).basisId === null, "最初の記録には、変更前の記録が無い（basisId=null）");
  check((await text(page, '[data-role="audit"]')).includes("給与を記録した"), "その人の監査ログに残る");
  await page.close();
}

console.log("\n— 変更（適用開始日つき）と訂正：履歴は増え、前の行は残る —");
{
  const server = makeServer();
  const page = await open({}, { server, hash: "#pay/p1" });
  check((await text(page, '[data-role="base"]')).includes("300,000円"), "山田: いまの基本給 300,000円");
  check((await text(page, '[data-role="allowances"]')).includes("役職手当 20,000円"), "手当が出る");
  check(await page.locator('[data-role="history"] tbody tr').count() === 2, "履歴は2行（初回・変更）");
  const hist0 = await text(page, '[data-role="history"]');
  check(hist0.includes("280,000円 → 300,000円") || (hist0.includes("280,000円") && hist0.includes("300,000円")), "変更前 → 変更後が出る");
  check(hist0.includes("昇給と役職手当") && hist0.includes("森田 経営"), "理由と変更者が出る");
  check(await page.inputValue('[name="baseAmount"]') === "300000", "フォームは、いまの値が入っている");
  check(await page.inputValue('[name="effectiveFrom"]') === "", "適用開始日は空（いつからかを、必ず自分で入れる）");
  // 変更: 来月から 320,000円
  const from = day(30);
  await page.fill('[name="effectiveFrom"]', from);
  await page.fill('[name="baseAmount"]', "320000");
  await page.fill('[name="reason"]', "定期昇給");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  const pv = await text(page, '[data-role="preview"]');
  check(pv.includes("変更") && pv.includes("300,000円") && pv.includes("320,000円"), "確認: 変更前 300,000円 → 変更後 320,000円");
  check(pv.includes("これから適用される給与です"), "確認: これから適用される、という注意");
  check(await page.locator('[data-role="warning"]').count() >= 1, "注意が出る");
  await page.click('[data-role="record-btn"]');
  await page.waitForTimeout(600);
  check((await text(page, '[data-role="msg"]')).includes("変更として記録しました"), "変更として記録");
  check((await text(page, '[data-role="base"]')).includes("300,000円"), "予定なので、いまの給与はまだ 300,000円のまま");
  check((await text(page, '[data-role="upcoming"]')).includes("320,000円"), "「これから」に予定が出る");
  check(await page.locator('[data-role="history"] tbody tr').count() === 3, "履歴は3行（前の2行は残る）");
  check((await text(page, '[data-role="history"]')).includes("予定"), "予定の印が付く");
  check(server.st.posts.at(-1).basisId === "r2", "変更前は「いまの記録」（basisId=r2）");

  // 訂正: 同じ適用開始日の次の版
  await page.check('input[name="mode"][value="correct"]');
  await page.waitForTimeout(200);
  check(await page.locator('[data-role="correct-date"]').count() === 1, "訂正では、適用開始日を「選ぶ」");
  await page.selectOption('[data-role="correct-date"]', from);
  check(await page.inputValue('[name="baseAmount"]') === "320000", "選んだ日付の記録の値が入る");
  await page.fill('[name="baseAmount"]', "330000");
  await page.fill('[name="reason"]', "金額の入力ミス（320,000円→330,000円）");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  const pv2 = await text(page, '[data-role="preview"]');
  check(pv2.includes("訂正") && pv2.includes("版2"), "確認: 訂正（版2）");
  check(pv2.includes("前の版は履歴に残り"), "確認: 前の版は残ると明記");
  await page.click('[data-role="record-btn"]');
  await page.waitForTimeout(600);
  check((await text(page, '[data-role="msg"]')).includes("訂正として記録しました"), "訂正として記録");
  check(await page.locator('[data-role="history"] tbody tr').count() === 4, "履歴は4行（訂正前の版も残る）");
  const rows = await page.locator('[data-role="history"] tbody tr').evaluateAll((ns) => ns.map((n) => ({ dim: n.classList.contains("dim"), t: n.innerText })));
  check(rows.filter((r) => r.dim).length === 1 && rows.some((r) => r.dim && r.t.includes("320,000円") && r.t.includes("訂正前")),
    "訂正前の版（320,000円）は、薄い行として残っている");
  check(rows.some((r) => !r.dim && r.t.includes("330,000円")), "有効な版は 330,000円");
  const hb = await page.locator('[data-role="history"] button').count();
  check(hb === 0, "履歴の中に、消す・書き換えるボタンは無い");
  check(await page.locator('button:has-text("削除"), button:has-text("編集"), [data-act="delete"], [data-act="edit"]').count() === 0, "削除・編集のボタンはどこにも無い");
  // 監査ログ
  const au = await text(page, '[data-role="audit"]');
  check(au.includes("給与を訂正した") && au.includes("給与を記録した") && au.includes("個人の給与を開いた"), "その人の監査ログ: 記録・訂正・開いた");
  await page.screenshot({ path: shotPath("keiei-pay-detail-pc.png"), fullPage: true });
  await page.close();
}

console.log("\n— サーバの断りは、押したボタンの近くに出る —");
{
  const server = makeServer();
  const page = await open({}, { server, hash: "#pay/p1" });
  await page.fill('[name="effectiveFrom"]', day(5));
  await page.fill('[name="baseAmount"]', "310000");
  await page.fill('[name="reason"]', "昇給");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  // 確認のあとで、別の人が先に記録した（画面が古い）
  server.st.failNext = { status: 409, body: { error: "stale_basis", hint: "画面を開いたあとに、この人の給与が更新されました。開き直して、内容を確かめてから記録してください" } };
  await page.click('[data-role="record-btn"]');
  await page.waitForTimeout(400);
  check((await text(page, '[data-role="form-err"]')).includes("開き直して"), "画面が古いときは、開き直すよう案内が出る");
  check(server.st.rows.filter((r) => r.employee_id === "p1").length === 2, "記録は増えていない");
  // 同じ適用開始日の二重記録
  await page.fill('[name="effectiveFrom"]', "2026-04-01");
  await page.fill('[name="reason"]', "二重");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  check((await text(page, '[data-role="form-err"]')).includes("すでにあります"), "同じ適用開始日は「訂正として」と案内される");
  await page.close();
}

console.log("\n— 初回給与の候補：確認 → 修正 → 理由入力 → 登録（自動では登録しない）—");
{
  const server = makeServer();
  const page = await open({}, { server, hash: "#pay" });
  check(await page.locator('[data-role="to-candidates"]').count() === 1, "一覧から「初回給与の候補」へ行ける");
  await page.click('[data-role="to-candidates"]');
  await page.waitForTimeout(500);
  check((await text(page, '[data-role="title"]')).includes("初回給与の候補"), "候補の一覧が開く");
  check((await page.locator("#kp-keiei-nav .kp-ostab.on").getAttribute("data-kview")) === "pay", "横タブは「給与管理」のまま");
  const t = await text(page);
  check(t.includes("自動では登録しません"), "自動では登録しないと明記");
  check((await text(page, '[data-role="c-total"]')).includes("3") && (await text(page, '[data-role="c-with"]')).includes("2") && (await text(page, '[data-role="c-without"]')).includes("1"),
    "記録がない人 3（佐藤・田中・伊藤）／候補あり 2／候補なし 1");
  const rows = await page.locator('[data-role="candidates"] tbody tr').evaluateAll((ns) => ns.map((n) => ({ id: n.dataset.employee, t: n.innerText, dim: n.classList.contains("dim") })));
  check(rows.length === 3 && rows[2].id === "p5" && rows[2].dim, "候補がある人が先、候補なしは最後（薄い行）");
  check(rows.find((r) => r.id === "p2").t.includes("280,000円") && rows.find((r) => r.id === "p2").t.includes("契約") && rows.find((r) => r.id === "p2").t.includes("本人の届出"),
    "佐藤: 候補（契約の基本給・届出の定期代）と基準が出る");
  check(rows.find((r) => r.id === "p2").t.includes("内定時の給与が、契約の賃金と違います"), "佐藤: 契約と内定の食い違いの注意が出る");
  check(rows.find((r) => r.id === "p6").t.includes("年俸") && rows.find((r) => r.id === "p6").t.includes("手当は候補にできない"), "伊藤: 契約の注記に文章があると、手当は候補にできないと出る");
  check(rows.find((r) => r.id === "p5").t.includes("有効な契約がありません"), "田中: 候補なしの理由が出る");
  check(server.st.rows.filter((r) => ["p2", "p5", "p6"].includes(r.employee_id)).length === 0, "一覧を開いただけでは、何も登録されない");
  await page.screenshot({ path: shotPath("keiei-pay-candidates-pc.png"), fullPage: true });

  // 確認して登録 → 候補が入力欄に入る（登録はまだ）
  await page.click('tr[data-employee="p2"] [data-role="review"]');
  await page.waitForTimeout(600);
  check((await text(page, '[data-role="title"]')) === "佐藤 未登録", "1人の画面が開く");
  check(await page.inputValue('[name="baseAmount"]') === "280000" && await page.inputValue('[name="wageType"]') === "月給" && await page.inputValue('[name="commuteAmount"]') === "9000",
    "候補が入力欄に入っている（基本給・種別・通勤手当）");
  check(await page.inputValue('[name="effectiveFrom"]') === "", "適用開始日は空（経営者が決める）");
  check(await page.inputValue('[name="reason"]') === "", "変更理由は空（経営者が入れる）");
  check((await text(page, '[data-role="msg"]')).includes("まだ登録されていません"), "「まだ登録されていません」と出る");
  check(await page.locator('[data-role="candidate-on"]').count() === 1 && (await text(page, '[data-role="candidate-on"]')).includes("契約の開始日"), "参考の日付（契約の開始日）が出る");
  check((await text(page, '[data-role="candidate-basis"]')).includes("契約") && (await text(page, '[data-role="candidate-basis"]')).includes("本人の届出"), "基準にしたデータが出る");
  check(server.st.rows.filter((r) => r.employee_id === "p2").length === 0, "写しただけでは、登録されない");
  await page.screenshot({ path: shotPath("keiei-pay-candidate-form-pc.png"), fullPage: true });

  // 理由なし → 断られる
  await page.fill('[name="effectiveFrom"]', "2026-09-01");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  check((await text(page, '[data-role="form-err"]')).includes("変更理由"), "理由を入れないと、確認に進めない");
  // 修正（基本給を直す）→ 理由入力 → 確認
  await page.fill('[name="baseAmount"]', "290000");
  await page.fill('[name="reason"]', "入社時の合意額に合わせて修正");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  const bt = await text(page, '[data-role="basis"]');
  check(bt.includes("候補から登録（基準: 有効な契約の賃金・本人が届け出た定期代）") && bt.includes("候補から直した項目: 基本給"), "確認: 基準と、直した項目が出る");
  // 登録
  await page.click('[data-role="record-btn"]');
  await page.waitForTimeout(600);
  check((await text(page, '[data-role="msg"]')).includes("初回として記録しました"), "登録される");
  check(await page.locator('[data-role="next-candidate"]').count() === 1, "「次の候補へ」が出る");
  const row = server.st.rows.find((r) => r.employee_id === "p2");
  check(row.basis && row.basis.kind === "candidate" && row.basis.edited.join() === "baseAmount" && row.source === "owner", "基準（候補・直した項目）が記録に残り、基本給を直したので取り込み元は経営者の入力");
  check(server.st.posts.at(-1).candidate === true, "候補から入れたことがサーバに伝わる");
  check((await text(page, '[data-role="basis-text"]')).includes("候補から直した項目: 基本給"), "履歴に、基準と直した項目が出る");
  check(await page.locator('[data-role="candidate-on"]').count() === 0 && await page.locator('[data-section="candidate"]').count() === 0, "登録後は、候補の欄が消える");

  // 次の候補へ → 一覧から消えている
  await page.click('[data-role="next-candidate"]');
  await page.waitForTimeout(500);
  check(await page.locator('[data-role="candidates"] tbody tr[data-employee="p2"]').count() === 0, "登録した人は、候補の一覧から外れる");
  check((await text(page, '[data-role="c-total"]')).includes("2"), "残りは 2 人");

  // 候補なしの人: 手入力へ。候補の欄に理由が出る
  await page.click('tr[data-employee="p5"] [data-role="manual"]');
  await page.waitForTimeout(500);
  check(await page.locator('[data-role="no-candidate"]').count() === 1, "候補なしの人: 理由が出て、手入力へ案内される");
  check(await page.inputValue('[name="baseAmount"]') === "", "入力欄は空のまま");
  await page.close();
}
{
  // 候補の欄から「入力欄に写す」ボタンで写す（一覧を経由しない）。写したあとに手動で全部消しても、登録できるのは経営者の入力だけ
  const server = makeServer();
  const page = await open({}, { server, hash: "#pay/p6" });
  check(await page.locator('[data-role="use-candidate"]').count() === 1, "個人の画面に「この候補を入力欄に写す」がある");
  check(await page.inputValue('[name="baseAmount"]') === "", "開いただけでは、入力欄は空");
  await page.click('[data-role="use-candidate"]');
  check(await page.inputValue('[name="baseAmount"]') === "4800000" && await page.inputValue('[name="wageType"]') === "年俸", "写すと入力欄に入る（年俸）");
  await page.click('[data-act="date-hint"]');
  check(await page.inputValue('[name="effectiveFrom"]') === "2026-10-15", "参考の日付を押すと、適用開始日に入る（経営者が押した場合だけ）");
  await page.fill('[name="reason"]', "契約どおりに登録");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  const pv = await text(page, '[data-role="preview"]');
  check(pv.includes("初回") && pv.includes("4,800,000円") && pv.includes("候補のまま"), "確認: 候補のまま");
  check(pv.includes("これから適用される給与です"), "確認: 入社前（未来の適用開始日）の注意");
  await page.close();
}
{
  // すでに記録がある人には、候補の欄が無い。サーバが断った場合の表示
  const server = makeServer();
  const page = await open({}, { server, hash: "#pay/p1" });
  check(await page.locator('[data-section="candidate"]').count() === 0, "記録がある人には、候補の欄が無い");
  await page.close();
}

console.log("\n— 全員の監査ログ —");
{
  const server = makeServer();
  const page = await open({}, { server, hash: "#pay" });
  await page.click('[data-role="to-audit"]');
  await page.waitForTimeout(500);
  check((await text(page, '[data-role="title"]')).includes("監査ログ"), "監査ログの画面が開く");
  check((await page.locator("#kp-keiei-nav .kp-ostab.on").getAttribute("data-kview")) === "pay", "横タブは「給与管理」のまま");
  const before = await page.locator('[data-role="audit-all"] tbody tr').count();
  check(before === 3, `新しい順に 3 件ずつ（いま ${before}）`);
  const more = page.locator('[data-act="more"]');
  check(await more.count() === 1, "続きがあれば「続きを読む」が出る");
  await more.click();
  await page.waitForTimeout(400);
  check(await page.locator('[data-role="audit-all"] tbody tr').count() > before, "続きを足して読み込む");
  check((await text(page, '[data-role="audit-all"]')).includes("一覧を開いた"), "一覧を開いたことも残っている");
  await page.close();
}

console.log("\n— 表が無いとき／HTML を含む氏名 —");
{
  const page = await open({}, { server: makeServer({ linked: false }) });
  const t = await text(page);
  check(t.includes("データ未連携") && t.includes("db/105_compensation.sql"), "表が無いと「データ未連携」と手順が出る");
  check(await page.locator("table").count() === 0 && !/\d円/.test(t), "0円や金額は出さない");
  await page.close();
}
{
  const page = await open({}, { server: makeServer({ evil: true }) });
  check(await page.evaluate(() => window.__pwn) === undefined, "氏名の HTML は実行されない（一覧）");
  check(await page.locator("img[src='x']").count() === 0, "氏名が要素にならない（一覧）");
  await page.goto(`${BASE}/keiei/index.html#pay/p1`);
  await page.waitForTimeout(600);
  check(await page.evaluate(() => window.__pwn) === undefined && await page.locator("img[src='x']").count() === 0, "氏名の HTML は実行されない（個人）");
  await page.close();
}

console.log("\n— スマホ幅：横スクロールしない —");
for (const width of [390, 360]) {
  const server = makeServer();
  const page = await open({}, { server, width });
  check(await overflowOf(page) <= 0, `${width}px 一覧: 横スクロールが出ない（はみ出し ${await overflowOf(page)}px）`);
  await page.goto(`${BASE}/keiei/index.html#pay/p1`);
  await page.waitForTimeout(700);
  check(await overflowOf(page) <= 0, `${width}px 個人: 横スクロールが出ない（はみ出し ${await overflowOf(page)}px）`);
  await page.fill('[name="effectiveFrom"]', day(30));
  await page.fill('[name="baseAmount"]', "320000");
  await page.fill('[name="reason"]', "昇給");
  await page.click('[data-role="preview-btn"]');
  await page.waitForTimeout(400);
  check(await overflowOf(page) <= 0, `${width}px 確認: 横スクロールが出ない（はみ出し ${await overflowOf(page)}px）`);
  if (width === 390) await page.screenshot({ path: shotPath("keiei-pay-detail-sp.png"), fullPage: true });
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
