// 社内文書・雛形（admin-docs.html）の画面：文書一覧｜雛形｜差し込み作成 の3つのタブ（2026-10-05 UI/UX 再設計）。
//
// ■ ここで守ること（機能・API・保存の形は変えていない。見た目と導線だけ変えた）
//   ・本文は3つのタブ。Office のサブタブ（社内文書｜お知らせ配信）は別物でそのまま
//   ・文書一覧：一覧が主役。登録フォームは「文書を登録」を押したときだけ（右のドロワー）。ファイル／リンクの2択
//     ファイル1つ・まとめて登録・リンク登録・公開状態の切り替え・削除が、これまでと同じ API・同じ本文で届く
//   ・雛形：一覧が主役。作成・編集は右のドロワー。select multiple は無い。対象の雇用区分は「全区分」が初期のチップ
//     全区分＝employmentTypes []（これまでと同じ保存の形）
//   ・差し込み作成：①雛形 → ②対象者 → ③プレビュー。選ぶまで空の大きな入力欄は出さない。
//     雛形の対象区分の人を先に並べる。コピー・テキスト保存ができる
//   ・390px で横にはみ出さない（タブは横スクロール）。画面のエラーが無い
//   データはテスト用の代役だけ
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const LIB = [
  { id: "l1", title: "就業規則（2026年4月版）", category: "rule", description: "2026/4/1 改定・全社員対象", file_path: "t1/rule.pdf", file_name: "就業規則_2026.pdf", mime_type: "application/pdf", size_bytes: 482113, link_url: null, published: true, sort_order: 1, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-09-12T03:00:00Z" },
  { id: "l2", title: "経費精算マニュアル", category: "manual", description: "", file_path: null, file_name: null, mime_type: null, size_bytes: null, link_url: "https://drive.google.com/file/d/test-0001/view", published: true, sort_order: 2, created_at: "2026-05-01T00:00:00Z", updated_at: "2026-08-02T03:00:00Z" },
  { id: "l3", title: "休暇申請書", category: "form", description: "様式第3号", file_path: "t1/form.xlsx", file_name: "休暇申請書.xlsx", mime_type: "application/vnd.ms-excel", size_bytes: 28311, link_url: null, published: false, sort_order: 3, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T03:00:00Z" },
  { id: "l4", title: "賃金規程（ドラフト）", category: "rule", description: "", file_path: null, file_name: null, mime_type: null, size_bytes: null, link_url: "https://docs.google.com/document/d/test-0002/edit", published: false, sort_order: 4, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-10-01T03:00:00Z" },
];
const TPL = [
  { id: "t1", name: "雇用契約書（正社員）", kind: "onboarding", employment_types: ["正社員"], body: "{{氏名}} 様\n\n{{会社名}}（以下「会社」）は、{{氏名}}（以下「従業員」）と次のとおり雇用契約を締結する。\n\n雇用区分：{{雇用区分}}\n所属：{{部署}}\n入社日：{{入社日}}\n\n{{今日}}", note: null, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
  { id: "t2", name: "業務委託契約の案内", kind: "onboarding", employment_types: ["業務委託"], body: "{{氏名}} 様\n\n業務委託契約についてご案内します。", note: null, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
  { id: "t3", name: "退職手続きのご案内", kind: "offboarding", employment_types: [], body: "{{氏名}} 様\n\n退職に伴う手続きについてご案内します。最終出社日までに…", note: null, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z" },
];
const EMP = [
  ["テスト 一郎", "開発部", "正社員"], ["テスト 花子", "人事部", "正社員"], ["テスト 次郎", "営業部", "契約社員"],
  ["テスト 三郎", "開発部", "業務委託"], ["テスト 四郎", "管理部", "パート"], ["テスト 五郎", "開発部", "正社員"],
].map(([n, d, t], i) => ({ id: `e${i}`, display_name: n, email: `test${i}@example.com`, department: d, position: "", employment_type: t, status: "active", joined_on: "2026-04-01", roles: [] }));

async function mock(page, { roles = ["finance"], calls = [] } = {}) {
  const { accessOf } = await import("../../lib/gw.js");
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "h.eyJzdWIiOiJ1LTEifQ.s", email: "a@b.c" })); });
  const lib = structuredClone(LIB), tpl = structuredClone(TPL);
  await page.route("**/storage-upload/**", (r) => r.fulfill({ status: 200, body: "{}" }));
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url()); const m = req.method();
    let body = null; try { body = req.postDataJSON(); } catch {}
    calls.push({ path: u.pathname, search: u.search, method: m, body });
    const send = (b, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") return send({ email: "a@b.c", appRole: "member", isAdmin: false, roles: [], gw: { employee: { id: "me", display_name: "テスト 経理", status: "active" }, roles, tenantId: "t1", stage: null }, access: accessOf({ isAdmin: false, roles }) });
    if (u.pathname === "/api/library") {
      if (u.searchParams.get("sign")) return send({ uploadUrl: `${u.origin}/storage-upload/x`, path: `t1/${body.filename}` });
      if (m === "GET") return send({ documents: lib });
      if (m === "POST") { const d = { id: `n${lib.length + 1}`, tenant_id: "t1", title: body.title, category: body.category, description: body.description, file_path: body.filePath, file_name: body.fileName, mime_type: body.mimeType, size_bytes: body.sizeBytes, link_url: body.linkUrl, published: true, sort_order: body.sortOrder, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; lib.push(d); return send({ document: d }); }
      if (m === "PATCH") { const d = lib.find((x) => x.id === body.id); Object.assign(d, "published" in body ? { published: body.published } : {}, { updated_at: new Date().toISOString() }); return send({ document: d }); }
      if (m === "DELETE") { const i = lib.findIndex((x) => x.id === u.searchParams.get("id")); if (i >= 0) lib.splice(i, 1); return send({ ok: true }); }
    }
    if (u.pathname === "/api/templates") {
      if (m === "GET") return send({ templates: tpl });
      if (m === "POST") { const t = { id: `t${tpl.length + 1}`, name: body.name, kind: body.kind, employment_types: body.employmentTypes, body: body.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; tpl.push(t); return send({ template: t }); }
      if (m === "PATCH") { const t = tpl.find((x) => x.id === body.id); Object.assign(t, { name: body.name, kind: body.kind, employment_types: body.employmentTypes, body: body.body, updated_at: new Date().toISOString() }); return send({ template: t }); }
      if (m === "DELETE") { const i = tpl.findIndex((x) => x.id === u.searchParams.get("id")); if (i >= 0) tpl.splice(i, 1); return send({ ok: true }); }
    }
    if (u.pathname === "/api/employees") return send({ employees: EMP, canManage: true, canGrantRoles: false });
    if (u.pathname === "/api/settings") return send({ tenant: { name: "テスト株式会社" } });
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    if (u.pathname === "/api/badges") return send({ badges: {} });
    return send({});
  });
}

async function open(path = "admin-docs.html", { width = 1280, roles } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo", acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const calls = [];
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)|net::ERR|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  await mock(page, { roles, calls });
  await page.goto(`${BASE}/${path}`);
  await page.waitForSelector("#d-rows tr[data-id]", { state: "attached", timeout: 8000 });
  return { page, ctx, calls, errs };
}
const sent = (calls, method, pred = () => true) => calls.filter((c) => c.path === "/api/library" && c.method === method && !c.search.includes("sign") && pred(c));
const tsent = (calls, method) => calls.filter((c) => c.path === "/api/templates" && c.method === method);

console.log("— タブ：文書一覧｜雛形｜差し込み作成（Office のサブタブはそのまま）—");
{
  const { page, ctx, errs } = await open();
  const tabs = (await page.locator(".dc-tabs [role=tab]").allInnerTexts()).map((x) => x.replace(/\d+/g, "").replace(/\s+/g, "").replace(/(folder_shared|folder_copy|auto_fix_high)/g, ""));
  check(tabs.join("|") === "文書一覧|雛形|差し込み作成", `本文のタブは 文書一覧｜雛形｜差し込み作成（いま ${tabs.join("|")}）`);
  check(await page.locator("#kp-office-nav .kp-ostab.on > span").innerText() === "社内文書", "Office のサブタブは「社内文書」が選ばれたまま");
  check(await page.locator("#tab-docs").getAttribute("aria-selected") === "true" && await page.locator("#pane-docs").isVisible()
    && !(await page.locator("#pane-templates").isVisible()) && !(await page.locator("#pane-merge").isVisible()), "最初は文書一覧だけを出す（縦に4枚並べない）");
  await page.locator("#tab-templates").click();
  check(/[?&]tab=templates/.test(page.url()) && await page.locator("#pane-templates").isVisible() && !(await page.locator("#pane-docs").isVisible()), "雛形タブを押すと雛形だけ（URL に ?tab=templates）");
  await page.reload(); await page.waitForSelector("#list tr[data-id]");
  check(await page.locator("#pane-templates").isVisible(), "?tab=templates で開くと雛形タブ");
  check(errs.length === 0, `画面のエラーが無い ${errs.join(" / ").slice(0, 160)}`);
  await ctx.close();
}

console.log("\n— 文書一覧：一覧が主役・登録はドロワー・ファイル／リンクの2択 —");
{
  const { page, ctx, calls, errs } = await open();
  const head = (await page.locator("#pane-docs thead th").allInnerTexts()).map((x) => x.trim());
  check(head.join("|") === "種類|タイトル・説明|保存先|公開状態|更新日|操作", `一覧の列（いま ${head.join("|")}）`);
  check(await page.locator("#d-rows tr[data-id]").count() === 4, "一覧に4件");
  check(!(await page.locator("#doc-drawer").isVisible()) && !(await page.locator("#d-title").isVisible()), "登録フォームは最初は出していない");
  const r2 = await page.locator('#d-rows tr[data-id="l2"]').innerText();
  check(r2.includes("リンク・drive.google.com") && r2.includes("公開中"), "保存先（リンク・ドメイン）と公開状態を出す");
  check((await page.locator('#d-rows tr[data-id="l1"]').innerText()).includes("ファイル・就業規則_2026.pdf"), "保存先（ファイル名）を出す");
  check(await page.locator("#pane-docs select").count() === 0, "公開／非公開は select ではない");

  // 公開状態：押すと切り替わる
  await page.locator('[data-pub="l3"]').click();
  await page.waitForTimeout(400);
  const p = sent(calls, "PATCH");
  check(p.length === 1 && p[0].body.id === "l3" && p[0].body.published === true, "非公開を押すと published:true を送る（同じ API）");
  check((await page.locator('[data-pub="l3"]').innerText()).includes("公開中"), "表示が「公開中」に変わる");

  // リンクで登録
  await page.locator("#d-add").click();
  check(await page.locator("#doc-drawer").isVisible(), "「文書を登録」で右のドロワーが開く");
  check(await page.locator("#d-drop").isVisible() && !(await page.locator("#d-link").isVisible()), "最初は「ファイルを登録」（リンク欄は出さない）");
  await page.locator('input[name="d-mode"][value="link"]').check();
  check(await page.locator("#d-link").isVisible() && !(await page.locator("#d-drop").isVisible()), "「リンクを登録」を選ぶとリンク欄だけ");
  await page.locator("#d-save").click();
  check((await page.locator("#d-msg").innerText()).includes("リンク"), "リンクが無いと止める");
  await page.fill("#d-link", "https://drive.google.com/file/d/test-9/view");
  await page.locator("#d-save").click();
  check((await page.locator("#d-msg").innerText()).includes("タイトル"), "タイトルが無いと止める");
  await page.fill("#d-title", "テスト 規程");
  await page.selectOption("#d-category", "manual");
  await page.fill("#d-desc", "テスト用");
  await page.locator("#d-save").click();
  await page.waitForTimeout(500);
  const post = sent(calls, "POST");
  check(post.length === 1 && post[0].body.linkUrl === "https://drive.google.com/file/d/test-9/view" && post[0].body.filePath === null
    && post[0].body.title === "テスト 規程" && post[0].body.category === "manual" && post[0].body.description === "テスト用", "リンク登録：これまでと同じ本文で POST /api/library");
  check(!(await page.locator("#doc-drawer").isVisible()) && await page.locator("#d-rows tr[data-id]").count() === 5, "登録するとドロワーが閉じ、一覧に出る");

  // ファイル1つ
  await page.locator("#d-add").click();
  await page.locator("#d-drop input[type=file]").setInputFiles({ name: "01_賃金規程.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
  await page.waitForFunction(() => document.getElementById("d-file-label").textContent.includes("賃金規程"));
  check(await page.inputValue("#d-title") === "賃金規程", "ファイルを選ぶと題名をファイル名から入れる（直せる）");
  await page.locator("#d-save").click();
  await page.waitForTimeout(500);
  const post2 = sent(calls, "POST")[1];
  check(post2 && post2.body.filePath === "t1/01_賃金規程.pdf" && post2.body.linkUrl === null && post2.body.fileName === "01_賃金規程.pdf", "ファイル登録：アップロードした path で POST");

  // まとめて登録
  await page.locator("#d-add").click();
  await page.selectOption("#d-category", "form");
  await page.locator("#d-drop input[type=file]").setInputFiles([
    { name: "様式A.xlsx", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("a") },
    { name: "様式B.xlsx", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("b") }]);
  await page.waitForFunction(() => document.querySelectorAll("#d-rows tr[data-id]").length === 8, null, { timeout: 5000 }).catch(() => {});
  const many = sent(calls, "POST").slice(2);
  check(many.length === 2 && many.every((c) => c.body.category === "form") && many.map((c) => c.body.title).join("|") === "様式A|様式B", "複数ファイル：1件ずつ登録（題名はファイル名・種類は選んだもの）");
  check(!(await page.locator("#doc-drawer").isVisible()) && (await page.locator("#d-list-msg").innerText()).includes("2 件を登録"), "まとめて登録したら閉じて件数を知らせる");

  // 削除
  await page.locator('[data-del="l4"]').click();
  await page.waitForTimeout(400);
  check(calls.some((c) => c.path === "/api/library" && c.method === "DELETE" && c.search.includes("id=l4")), "削除は DELETE /api/library?id=");
  // Esc で閉じる
  await page.locator("#d-add").click();
  await page.keyboard.press("Escape");
  check(!(await page.locator("#doc-drawer").isVisible()), "Esc でドロワーを閉じる");
  check(errs.length === 0, `画面のエラーが無い ${errs.join(" / ").slice(0, 160)}`);
  await ctx.close();
}

console.log("\n— 雛形：一覧が主役・作成／編集はドロワー・対象区分はチップ（全区分が初期）—");
{
  const { page, ctx, calls, errs } = await open("admin-docs.html?tab=templates");
  await page.waitForSelector("#list tr[data-id]");
  check(await page.locator("#list tr[data-id]").count() === 3, "雛形の一覧に3件");
  check(await page.locator("select[multiple]").count() === 0, "select multiple は無い");
  check(!(await page.locator("#tpl-drawer").isVisible()), "作成フォームは最初は出していない");
  await page.locator("#t-add").click();
  check(await page.locator("#tpl-drawer").isVisible() && await page.locator("#form-title").innerText() === "雛形を作成", "「雛形を作成」で右のドロワー");
  const all = page.locator("#f-types input[data-all]");
  check(await all.isChecked() && await page.locator("#f-types input:checked").count() === 1, "対象の雇用区分は「全区分」が初期");
  await page.locator('#f-types label:has-text("正社員")').click();
  await page.locator('#f-types label:has-text("契約社員")').click();
  check(!(await all.isChecked()), "区分を選ぶと「全区分」は外れる");
  await page.fill("#f-name", "テスト 雛形");
  await page.selectOption("#f-kind", "general");
  await page.locator("#f-body").click();
  await page.locator('.dc-tokens button:has-text("{{氏名}}")').click();
  await page.locator("#f-body").type(" 様");
  await page.locator("#btn-save").click();
  await page.waitForTimeout(500);
  const post = tsent(calls, "POST");
  check(post.length === 1 && post[0].body.name === "テスト 雛形" && post[0].body.kind === "general"
    && JSON.stringify(post[0].body.employmentTypes) === JSON.stringify(["正社員", "契約社員"]) && post[0].body.body === "{{氏名}} 様",
    `作成：これまでと同じ本文で POST /api/templates（${JSON.stringify(post[0]?.body)}）`);
  check(!(await page.locator("#tpl-drawer").isVisible()) && await page.locator("#list tr[data-id]").count() === 4, "保存するとドロワーが閉じ、一覧に出る");

  // 全区分 → []
  await page.locator('[data-edit="t1"]').click();
  check(await page.locator("#form-title").innerText() === "雛形を編集" && await page.inputValue("#f-name") === "雇用契約書（正社員）"
    && await page.locator('#f-types input[value="正社員"]').isChecked() && !(await all.isChecked()), "編集：ドロワーに今の内容（対象区分も）");
  await page.locator('#f-types label:has-text("正社員")').click();
  check(await all.isChecked(), "区分を全部外すと「全区分」に戻る");
  await page.locator("#btn-save").click();
  await page.waitForTimeout(500);
  const patch = tsent(calls, "PATCH");
  check(patch.length === 1 && patch[0].body.id === "t1" && JSON.stringify(patch[0].body.employmentTypes) === "[]", "編集：全区分は [] で PATCH（保存の形は同じ）");

  await page.locator('[data-remove="t2"]').click();
  await page.waitForTimeout(400);
  check(calls.some((c) => c.path === "/api/templates" && c.method === "DELETE" && c.search.includes("id=t2")), "削除は DELETE /api/templates?id=");
  check(errs.length === 0, `画面のエラーが無い ${errs.join(" / ").slice(0, 160)}`);
  await ctx.close();
}

console.log("\n— 差し込み作成：①雛形 → ②対象者 → ③プレビュー —");
{
  const { page, ctx, errs } = await open("admin-docs.html?tab=merge");
  await page.waitForTimeout(300);
  check(!(await page.locator("#m-out").isVisible()) && await page.locator("#m-wait").isVisible(), "選ぶまで、空の大きな入力欄は出さない");
  check(await page.locator("#m-employee").isDisabled(), "雛形を選ぶまで、対象者は選べない");
  await page.selectOption("#m-template", "t1");
  check(!(await page.locator("#m-employee").isDisabled()), "雛形を選ぶと対象者を選べる");
  const groups = await page.locator("#m-employee optgroup").evaluateAll((gs) => gs.map((g) => `${g.label}:${g.children.length}`));
  check(groups.length === 2 && groups[0].startsWith("この雛形の対象（正社員）:3") && groups[1] === "その他のメンバー:3", `対象区分（正社員）の人を先に並べる（${groups.join(" / ")}）`);
  check(!(await page.locator("#m-out").isVisible()), "対象者を選ぶまではプレビューを出さない");
  await page.selectOption("#m-employee", "e1");
  const out = await page.inputValue("#m-out");
  check(await page.locator("#m-out").isVisible() && out.startsWith("テスト 花子 様") && out.includes("テスト株式会社") && out.includes("所属：人事部"), "選ぶとプレビュー（差し込み済み）");
  await page.locator("#m-copy").click();
  await page.waitForTimeout(200);
  check((await page.evaluate(() => navigator.clipboard.readText())) === out && (await page.locator("#m-msg").innerText()).includes("コピーしました"), "コピー");
  // ファイル名は a.download で付ける（テスト用の headless Chromium は日本語のファイル名を "download" にしてしまうので、付けた名前を直接見る）
  await page.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; return c.call(this); }; });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#m-save").click()]);
  const { readFileSync } = await import("node:fs");
  const saved = readFileSync(await dl.path(), "utf8").replace(/^\uFEFF/, "");
  const name = await page.evaluate(() => window.__dlName);
  check(name === "雇用契約書（正社員）_テスト 花子.txt" && saved === out, `テキスト保存（${name}・中身はプレビューと同じ）`);
  // 雛形一覧の「この雛形で作成」から
  await page.locator("#tab-templates").click();
  await page.locator('[data-use="t2"]').click();
  check(await page.locator("#pane-merge").isVisible() && await page.inputValue("#m-template") === "t2", "「この雛形で作成」→ 差し込み作成に、その雛形を選んだ状態で");
  const g2 = await page.locator("#m-employee optgroup").first().getAttribute("label");
  check(g2 === "この雛形の対象（業務委託）", `業務委託の雛形なら業務委託の人を先に（${g2}）`);
  check(errs.length === 0, `画面のエラーが無い ${errs.join(" / ").slice(0, 160)}`);
  await ctx.close();
}

console.log("\n— 768px・390px：横にはみ出さない —");
for (const width of [768, 390]) {
  for (const tab of ["docs", "templates", "merge"]) {
    const { page, ctx, errs } = await open(`admin-docs.html?tab=${tab}`, { width });
    await page.waitForTimeout(300);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(ov <= 0 && errs.length === 0, `${width}px・${tab}：横にはみ出さない（${ov}px）・エラーなし`);
    if (width === 390 && tab === "docs") {
      const tabsOv = await page.locator(".dc-tabs").evaluate((n) => getComputedStyle(n).overflowX);
      check(tabsOv === "auto", "390px：本文のタブは横スクロールできる");
      await page.locator("#d-add").click();
      const box = await page.locator("#doc-drawer").boundingBox();
      check(box && box.width <= 390, "390px：登録のドロワーは画面の幅に収まる");
    }
    await ctx.close();
  }
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
