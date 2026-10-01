// /office の「状態の色」と「次にやること（CTA）」を、実際のブラウザで通す。
//
//   2026年10月の【Office Phase3 TEST】（要員・現場契約・契約条件・月次進捗。db/office_phase3_test_seed.sql と同じ値）で、
//   未提出 → 勤務表を追加（ファイル選択）→ 登録（attach）→ 勤務表の確認画面
//         → AIで読み取る → 内容を確認する → 確定内容を見る
//   を、画面の操作だけで進める。
//
// ■ 守ること
//   ・状態は 色＋文字＋アイコン：未提出＝赤／未作成＝橙／要確認・未読取＝黄／確定済＝緑／対象外＝灰
//   ・未完了に ○（radio_button_unchecked）を使わない。チェックのアイコンは、完了（緑）だけ
//   ・「次にやること」は押せる：未提出 → 「勤務表を追加」を押すと、その場でファイル選択が開く（カード全体でも）
//     選ぶと アップロード → 登録（attach）→ 勤務表の確認画面（/office/timesheet.html）へ進む
//   ・状態でボタンが変わる：ファイルなし=勤務表を追加／未読取=AIで読み取る／下書き=内容を確認する／確定=確定内容を見る
//   ・固定の文言「勤務表を開いて確認・確定」は無い
//   ・使えないファイル・同じファイルは、理由を出して進まない
//
// ■ 何を通しているか
//   ブラウザの通信は、本物の api/office/*.js のハンドラにつなぐ（DB・Storage は偽：test/_memdb.mjs）。AI は偽の client。
//
// 画面の写真：E2E_SHOTS=<ディレクトリ> を付けて実行する。アイコンのフォントは、オフラインだと読めないので、
//   E2E_FONTS=<material-symbols-rounded.woff2 のあるディレクトリ> を付けると、そこから読み込む（写真のときだけ）
import "../_officeharness.mjs";
import { mem, ctl, ai, call, atRoot, OWNER, uid, T1 } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import fs from "node:fs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const SHOTS = process.env.E2E_SHOTS || "";
const FONTS = process.env.E2E_FONTS || "";
const shot = async (page, name) => { await page.screenshot({ path: SHOTS ? `${SHOTS}/${name}.png` : shotPath(`cta-${name}.png`), fullPage: false }); };

const TAG = "【Office Phase3 TEST】";
const EMP = "e13db73f-3d85-45ca-ac0a-7f26a5d53610";
const CON = "3688ccc1-bf24-4fcd-81fa-50e4a2086c7b";
const TERMS = "73c4e190-160b-4ea9-b697-f7afe7a26b45";
const PROG = "d309c095-8c2a-4a21-b713-ba43acd61698";
const M = "2026-10";
const rows = (t) => mem.rows[t] || [];
const SAMPLE = "test/fixtures/office-timesheet/sample-2026-10.pdf";
const EXPECTED = JSON.parse(fs.readFileSync(atRoot("test/fixtures/office-timesheet/expected.json"), "utf8"));
const clock = (m) => (m == null ? null : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);

function seed() {
  mem.reset();
  ctl.who = { ...OWNER, factors: [] }; ctl.aal = "aal1"; ai.calls.length = 0;
  // AI の返答：サンプル勤務表の「書かれているとおり」。読めない所（10/14 休憩・10/21 終了）は空のまま
  const input = {
    sheet_month: M, employee_name: EXPECTED.employee, total_worked: clock(EXPECTED.totalWorkedMin), break_column: "present",
    days: EXPECTED.days.map((e) => {
      const p = e.printed;
      const row = p.kind === "off"
        ? { day: e.day, kind: "off", blank: !e.note, note: e.note, confidence: "high" }
        : { day: e.day, kind: "work", start: clock(p.start), end: clock(p.end), break: clock(p.break), worked: clock(p.worked), note: e.note, confidence: "high" };
      if (EXPECTED.unreadable.includes(e.date)) { row.confidence = "low"; row.reason = "文字が読めない"; }
      return row;
    }),
  };
  ai.reply = { model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "read_timesheet", input }], usage: { input_tokens: 4200, output_tokens: 2100 } };
  mem.rows.gw_employees = [
    { id: EMP, tenant_id: T1, display_name: `${TAG}テスト 太郎`, department: "Office Phase3 TEST", status: "active", employee_kind: "proper", partner_company_id: null },
    { id: uid(11), tenant_id: T1, display_name: "経営 一郎", department: null, status: "active", employee_kind: "proper", partner_company_id: null },
  ];
  mem.rows.gw_site_contracts = [
    { id: CON, tenant_id: T1, employee_id: EMP, engagement_kind: "pp", site_company: `株式会社テスト${TAG}`, prime_company: null,
      period_from: "2026-10-01", period_to: null, unit_price: null, unit_price_type: "月額", renewal_status: "confirmed", note: `${TAG}Office の操作確認用` },
  ];
  mem.rows.gw_site_contract_terms = [
    { id: TERMS, tenant_id: T1, site_contract_id: CON, valid_from: "2026-10-01", valid_to: null, pricing_type: "monthly",
      sales_unit_price: 700000, purchase_unit_price: null, settlement_mode: "range", settle_min_minutes: 8400, settle_max_minutes: 10800,
      settle_unit_minutes: null, rounding_mode: null, rounding_scope: null, over_rate_per_hour: 4000, under_rate_per_hour: 3500,
      prorate: false, amount_rounding: "floor" },
  ];
  mem.rows.gw_billing_progress = [
    { id: PROG, tenant_id: T1, employee_id: EMP, site_contract_id: CON, billing_month: M, note: `${TAG}Office の操作確認用`,
      timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
  ];
}
const api = (h, path, method = "GET", body) => call(h, path, { method, body });
const sheetPost = (action, extra = {}) => api(sheetApi, "/api/office/timesheet", "POST", { action, siteContractId: CON, month: M, ...extra });

// ---- ブラウザ（本物のハンドラにつなぐ）-----------------------------------------------------------
const seenApi = [];
async function open(url, { viewport = { width: Number(process.env.E2E_WIDTH) || 1440, height: 1000 } } = {}) {
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|fonts\.gstatic|net::ERR|Failed to load resource|manifest|storage\.example/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@8grp.co.jp" })); });
  if (FONTS) {
    await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css",
      body: /Material\+Symbols/.test(route.request().url())
        ? "@font-face{font-family:'Material Symbols Rounded';font-style:normal;font-weight:100 700;src:url(https://fonts.gstatic.com/local/msr.woff2) format('woff2');}"
        : "" }));
    await page.route("https://fonts.gstatic.com/local/msr.woff2", (route) => route.fulfill({ status: 200, contentType: "font/woff2", body: fs.readFileSync(`${FONTS}/material-symbols-rounded.woff2`) }));
  }
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({ email: "owner@8grp.co.jp", appRole: "owner", isAdmin: false, shows: {}, roles: [], access: { recruit: true, sell: true, office: true },
        gw: { employee: { id: "e-owner", display_name: "経営 一郎", status: "active" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    const h = { "/api/office": indexApi, "/api/office/timesheet": sheetApi, "/api/office/file": fileApi, "/api/office/terms": termsApi }[u.pathname];
    if (h) {
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
      seenApi.push({ method: req.method(), path: u.pathname, action: body?.action || null, status: r.statusCode, error: r.body?.error || null });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.route("https://storage.example/**", (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (req.method() === "PUT") {
      const m = /^\/upload\/([^/]+)\/(.+)$/.exec(u.pathname);
      if (m) mem.put(m[1], m[2], req.postDataBuffer());
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    const ext = /\.(png|jpe?g)(\?|$)/i.exec(u.pathname)?.[1]?.toLowerCase();
    const f = ext === "png" ? ["png", "image/png"] : ext ? ["jpg", "image/jpeg"] : ["pdf", "application/pdf"];
    return route.fulfill({ status: 200, contentType: f[1], body: fs.readFileSync(atRoot(`test/fixtures/office-timesheet/sample-2026-10.${f[0]}`)) });
  });
  await page.goto(`${BASE}${url}`);
  return { page, errs };
}
const ROW = "#rows tr[data-id]";
const cell = (page, label) => page.locator(`${ROW} [data-label="${label}"]`);
const pillOf = async (loc) => loc.locator(".of-st").first().evaluate((n) => {
  const cs = getComputedStyle(n);
  return { text: n.textContent.replace(/\s+/g, "").replace(/^[a-z_]+(?=[^\x00-\x7F])/, ""), cls: n.className, bg: cs.backgroundColor, fg: cs.color, icon: n.querySelector(".material-symbols-outlined")?.textContent || "" };
});
const noCircle = async (page, where) => check(!(await page.content()).includes("radio_button_unchecked"), `${where}：未完了に ○（radio_button_unchecked）を使っていない`);
const bodyText = (page) => page.locator("body").innerText();

// ============================================================================
console.log("\n=== 1. 未提出：赤いラベル＋「勤務表を追加」 ===");
{
  seed();
  const { page, errs } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  await page.waitForTimeout(400);
  const ts = await pillOf(cell(page, "勤務表"));
  check(ts.text === "未提出" && ts.cls.includes("red") && ts.bg === "rgb(253, 228, 226)" && ts.fg === "rgb(179, 38, 30)", `勤務表：「未提出」は薄い赤の背景＋赤い文字（${ts.text} ${ts.bg} ${ts.fg}）`);
  check(ts.icon !== "" && ts.icon !== "radio_button_unchecked" && !/check|task_alt/.test(ts.icon), `未提出のアイコンは ○ でも チェックでもない（${ts.icon}）`);
  const sales = await pillOf(cell(page, "売上請求"));
  check(sales.text === "未作成" && sales.cls.includes("orange") && sales.bg === "rgb(255, 233, 209)", `売上請求：「未作成」は橙（${sales.text} ${sales.bg}）`);
  const vend = await pillOf(cell(page, "仕入請求")), pay = await pillOf(cell(page, "支払"));
  check(vend.text === "対象外" && vend.cls.includes("gray") && pay.text === "対象外" && pay.cls.includes("gray"), "仕入請求・支払：「対象外」は灰色");
  check((await cell(page, "稼働時間").locator(".of-st").count()) === 0, "稼働時間：勤務表が無いうちは、状態のラベルを出さない（—）");
  await noCircle(page, "一覧");

  // 次にやること：何が起きていて、何を押せばよいか
  const cta = cell(page, "次にやること");
  const t = await cta.innerText();
  check(t.includes("勤務表が未提出です") && t.includes("期限 11/5") && t.includes("勤務表を追加"), `次にやること：勤務表が未提出です／期限 11/5／勤務表を追加（${t.replace(/\s+/g, " ")}）`);
  check(!(await bodyText(page)).includes("提出状況を見る"), "「提出状況を見る」は出ない");
  check(await page.locator("thead th").last().innerText() === "次にやること", "見出しは「次にやること」");
  await shot(page, "01-list-not-submitted");

  // ページの一番上の「次にやること」：探さずに押せる
  const now = page.locator("#now .of-now");
  const nt = await now.innerText();
  check(await now.isVisible() && nt.includes(`${TAG}テスト 太郎`) && nt.includes("勤務表が未提出です") && nt.includes("期限 11/5") && nt.includes("勤務表を追加"),
    `ページの一番上：誰の何が未提出か・期限・「勤務表を追加」（${nt.replace(/\s+/g, " ")}）`);
  const nowBox = await now.boundingBox();
  check(nowBox.y < 200, `一番上の帯は、数字カードより上（上から ${Math.round(nowBox.y)}px）`);
  check((await page.locator("#now .of-now-item").count()) === 1, "件数ぶんだけ出る（1件）");
  const [fcNow] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), now.locator('button[data-cta="pick"]').click()]);
  check(!!fcNow && await page.locator(".of-drawer").count() === 0, "一番上の「勤務表を追加」→ その場でファイル選択（ドロワーは開かない）");
  const [fcNow2] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), now.locator(".what b").click()]);
  check(!!fcNow2, "帯の全体（文言の上）を押しても、ファイル選択が開く");

  // 「勤務表を追加」を押す → その場でファイル選択が開く（右ドロワーは開かない）
  const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), cta.locator('button[data-cta="pick"]').click()]);
  check(true, "一覧の「勤務表を追加」を押すと、その場でファイル選択が開く");
  check(await page.locator(".of-drawer").count() === 0, "ドロワーは開かない（1クリックでファイル選択）");
  check((await fc.isMultiple()) === false, "選べるのは1ファイル");
  await page.close();
}

console.log("\n=== 2. ドロワーの「次にやること」＝押せるカード（カード全体でも動く） ===");
{
  seed();
  const { page } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  await page.locator(`${ROW} [data-label="要員"]`).click();
  await page.waitForSelector(".of-drawer #dr-next");
  const card = page.locator("#dr-next");
  const ct = await card.innerText();
  check(ct.includes("勤務表が未提出です") && ct.includes("期限 11/5") && ct.includes("勤務表を追加") && ct.includes("PDF・JPEG・PNG"), `カード：勤務表が未提出です／期限 11/5／勤務表を追加／PDF・JPEG・PNG（${ct.replace(/\s+/g, " ")}）`);
  check(!(await bodyText(page)).includes("勤務表を開いて確認・確定"), "固定の文言「勤務表を開いて確認・確定」は無い");
  const steps = await page.locator(".of-steps").innerText();
  check(steps.includes("未提出") && steps.includes("未作成") && steps.includes("対象外"), "進捗の並び：未提出・未作成・対象外");
  await noCircle(page, "ドロワー");
  await shot(page, "02-drawer-not-submitted");
  // カード全体（ボタン以外の場所）を押しても、ファイル選択が開く
  const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), card.locator(".ttl").click()]);
  check(!!fc, "カード全体（見出しの上）を押しても、ファイル選択が開く");
  const [fc2] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), card.locator('.go button[data-cta="pick"]').click()]);
  check(!!fc2, "カードの中のボタンでも開く");
  await page.close();
}

console.log("\n=== 3. ファイルを選ぶ → アップロード → 登録（attach）→ 勤務表の確認画面 ===");
{
  seed();
  seenApi.length = 0;
  const { page, errs } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), cell(page, "次にやること").locator('button[data-cta="pick"]').click()]);
  await fc.setFiles(atRoot(SAMPLE));
  await page.waitForURL(/\/office\/timesheet\.html\?contract=/, { timeout: 15000 });
  const u = new URL(page.url());
  check(u.pathname === "/office/timesheet.html" && u.searchParams.get("contract") === CON && u.searchParams.get("month") === M, `勤務表の確認画面へ進む（${u.pathname}${u.search}）`);
  await page.waitForSelector("#stateBadge .of-pill");
  await page.waitForTimeout(800);
  check((await page.locator("#stateBadge").innerText()).includes("提出済み"), "確認画面：状態は「提出済み（未読取）」");
  check((await page.locator("#files").innerText()).includes("sample-2026-10.pdf"), "左に、いま登録した勤務表のファイル");
  check(await page.locator("#readMain").count() === 1, "「AIで読み取る」のボタンが、確認画面に出ている");
  const acts = seenApi.filter((s) => s.path === "/api/office/timesheet").map((s) => `${s.action || s.method}:${s.status}`);
  check(acts.slice(0, 2).join() === "upload:200,attach:200", `API：upload → attach の順（${acts.join(",")}）`);
  const sub = rows("gw_submissions");
  check(sub.length === 1 && sub[0].source === "office" && sub[0].file_name === "sample-2026-10.pdf" && sub[0].target_month === M && sub[0].employee_id === EMP && !!sub[0].sha256, "DB：勤務表のファイルが1件登録された（source=office・sha256あり）");
  check(rows("gw_billing_progress").length === 1 && rows("gw_billing_progress")[0].id === PROG && rows("gw_billing_progress")[0].timesheet_received === true, "月次進捗：受領の印が立った（同じ行を更新）");
  await shot(page, "03-review-after-upload");
  await page.close();
}

console.log("\n=== 3b. PNG・JPEG も、同じ流れで確認画面へ ===");
for (const [ext, mime] of [["png", "image/png"], ["jpg", "image/jpeg"]]) {
  seed();
  const { page } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector("#now .of-now");
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.locator('#now button[data-cta="pick"]').click()]);
  await fc.setFiles({ name: `sample-2026-10.${ext}`, mimeType: mime, buffer: fs.readFileSync(atRoot(`test/fixtures/office-timesheet/sample-2026-10.${ext}`)) });
  await page.waitForURL(/timesheet\.html/, { timeout: 15000 });
  await page.waitForSelector("#files .ts-file, #files [data-pick]", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  check(rows("gw_submissions").length === 1 && rows("gw_submissions")[0].mime_type === mime, `${ext.toUpperCase()}：登録され、確認画面へ進む（${rows("gw_submissions")[0]?.mime_type}）`);
  check((await page.locator("#stateBadge").innerText()).includes("提出済み"), `${ext.toUpperCase()}：確認画面の状態は「提出済み（未読取）」`);
  if (ext === "png") await shot(page, "03b-review-png");
  await page.close();
}

console.log("\n=== 4. ファイルあり・未読取：「AIで読み取る」→ 確認画面で読み取りが始まる ===");
{
  // ファイル1件・未読取の状態にする（実際の操作と同じ：勤務表を追加）
  seed();
  {
    const { page: up } = await open(`/office/index.html?month=${M}`);
    await up.waitForSelector("#now .of-now");
    const [fcU] = await Promise.all([up.waitForEvent("filechooser"), up.locator('#now button[data-cta="pick"]').click()]);
    await fcU.setFiles(atRoot(SAMPLE));
    await up.waitForURL(/timesheet\.html/, { timeout: 15000 });
    await up.close();
  }
  const { page } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  await page.waitForTimeout(300);
  const ts = await pillOf(cell(page, "勤務表"));
  check(ts.text === "未読取" && ts.cls.includes("yellow") && ts.bg === "rgb(253, 240, 184)", `勤務表：「未読取」は黄色（${ts.text} ${ts.bg}）`);
  const cta = cell(page, "次にやること");
  const t = await cta.innerText();
  check(t.includes("勤務表が届いています") && t.includes("AIで読み取る") && !t.includes("勤務表を追加"), `次にやること：勤務表が届いています／AIで読み取る（${t.replace(/\s+/g, " ")}）`);
  check(await cta.locator("a.of-btn").getAttribute("href") === `/office/timesheet.html?contract=${CON}&month=${M}&read=1`, "「AIで読み取る」は、確認画面（&read=1）へ");
  await noCircle(page, "未読取の一覧");
  const nt4 = await page.locator("#now .of-now").innerText();
  check(nt4.includes("勤務表が届いています") && nt4.includes("AIで読み取る"), "ページの一番上も「AIで読み取る」");
  await shot(page, "04-list-file-arrived");
  await page.locator(`${ROW} [data-label="要員"]`).click();
  await page.waitForSelector("#dr-next");
  check((await page.locator("#dr-next").innerText()).includes("AIで読み取る"), "ドロワーのカードも「AIで読み取る」");
  await page.click("#dr-next .ttl");                             // カード全体でも進む
  await page.waitForURL(/timesheet\.html/, { timeout: 8000 });
  check(true, "カード全体を押しても、確認画面へ進む");
  await page.waitForFunction(() => document.querySelector("#stateBadge")?.textContent.includes("確認待ち"), null, { timeout: 15000 });
  check(ai.calls.length === 1, "開くとすぐ AI の読み取りが始まった（1回だけ）");
  check(!new URL(page.url()).searchParams.has("read"), "URL から read=1 が消える（再読込で、もう一度読み取らない）");
  check((await page.locator("#stateBadge").innerText()).includes("確認待ち"), "読み取り後：下書き（確認待ち）。確定にはなっていない");
  check(rows("gw_billing_progress")[0].work_confirmed === false, "読み取っただけでは、稼働確認の印は立たない");
  await shot(page, "05-review-after-ai-read");
  await page.close();
}

console.log("\n=== 5. AI読取済（下書き）：「内容を確認する」 ===");
{
  const { page } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  await page.waitForTimeout(300);
  const ts = await pillOf(cell(page, "勤務表")), wk = await pillOf(cell(page, "稼働時間"));
  check(ts.text === "要確認" && ts.cls.includes("yellow"), `勤務表：「要確認」は黄色（${ts.text}）`);
  check(wk.text === "要確認" && wk.cls.includes("yellow"), `稼働時間：「要確認」は黄色（${wk.text}）`);
  const t = await cell(page, "次にやること").innerText();
  check(t.includes("読取結果の確認待ちです") && t.includes("入力が必要な日 2日") && t.includes("内容を確認する"), `次にやること：読取結果の確認待ち／入力が必要な日 2日／内容を確認する（${t.replace(/\s+/g, " ")}）`);
  await noCircle(page, "下書きの一覧");
  check((await page.locator("#now .of-now").innerText()).includes("内容を確認する"), "ページの一番上も「内容を確認する」");
  await page.locator(`${ROW} [data-label="要員"]`).click();
  await page.waitForSelector("#dr-next");
  await shot(page, "06-drawer-draft");
  check((await page.locator("#dr-next").innerText()).includes("内容を確認する"), "ドロワーのカードも「内容を確認する」");
  check((await page.locator("#dr-timesheet").innerText()).includes("内容を確認する"), "勤務表の欄の操作も、状態に合っている（内容を確認する）");
  await page.close();
}

console.log("\n=== 6. 確定：「確定内容を見る」。完了のラベルだけがチェック ===");
{
  // 人が、書いた人の知っている値を入れて、確定する（API）
  const truth = (date) => EXPECTED.days.find((d) => d.date === date).truth;
  const sv = await sheetPost("save", { days: [{ workDate: "2026-10-14", break: clock(truth("2026-10-14").break) }, { workDate: "2026-10-21", end: clock(truth("2026-10-21").end) }] });
  const cf = await sheetPost("confirm");
  check(sv.statusCode === 200 && cf.statusCode === 200, "（準備）空欄を埋めて、確定した");
  const { page } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  await page.waitForTimeout(300);
  const ts = await pillOf(cell(page, "勤務表")), wk = await pillOf(cell(page, "稼働時間"));
  check(ts.text === "確定済" && ts.cls.includes("green") && ts.bg === "rgb(217, 240, 217)" && ts.icon === "check_circle", `勤務表：「確定済」は薄い緑＋チェック（${ts.text} ${ts.bg} ${ts.icon}）`);
  check(wk.text === "確定済" && wk.cls.includes("green"), "稼働時間：「確定済」は緑");
  check((await cell(page, "稼働時間").innerText()).includes("154.75h"), "稼働時間：154.75h（= 154:45）");
  const t = await cell(page, "次にやること").innerText();
  check(t.includes("売上請求書を作成してください") && t.includes("確定内容を見る") && t.includes("請求の状況を見る"), `次にやること：請求書の作成／確定内容を見る／請求の状況を見る（${t.replace(/\s+/g, " ")}）`);
  check(!t.includes("勤務表を追加") && !t.includes("AIで読み取る"), "確定後は、追加・読取のボタンを出さない");
  check((await page.locator("#now .of-now").innerText()).includes("確定内容を見る"), "ページの一番上も「確定内容を見る」（請求書の作成へ）");
  // チェックのアイコンは、完了（緑）だけ
  const checks = await page.locator(".of-st").evaluateAll((ns) => ns.filter((n) => /check/.test(n.textContent)).map((n) => n.className));
  check(checks.length > 0 && checks.every((c) => c.includes("green")), `チェックのアイコンは、緑（完了）だけ（${checks.join(" | ")}）`);
  await noCircle(page, "確定後の一覧");
  await shot(page, "07-list-confirmed");
  await page.locator(`${ROW} [data-label="要員"]`).click();
  await page.waitForSelector("#dr-next");
  check((await page.locator("#dr-next").innerText()).includes("確定内容を見る"), "ドロワーのカードも「確定内容を見る」");
  await shot(page, "08-drawer-confirmed");
  await page.locator("#dr-next").getByText("確定内容を見る").click();
  await page.waitForURL(/timesheet\.html/);
  await page.waitForSelector("#stateBadge .of-pill");
  check((await page.locator("#top").innerText()).includes("確定済みです"), "「確定内容を見る」→ 確認画面に、確定済みの内容が出る");
  await page.close();
}

console.log("\n=== 7. 使えないファイル・同じファイル：理由を出して、進まない ===");
{
  seed(); seenApi.length = 0;
  const { page } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), cell(page, "次にやること").locator('button[data-cta="pick"]').click()]);
  await fc.setFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.waitForSelector(".of-cta .er");
  check((await cell(page, "次にやること").innerText()).includes("PDF・JPEG・PNG のファイルを選んでください"), "PDF・JPEG・PNG 以外は、理由を出す");
  check(page.url().includes("/office/index.html") && seenApi.every((s) => s.action !== "upload"), "移動せず、アップロードもしない");
  check(await cell(page, "次にやること").locator('button[data-cta="pick"]').isEnabled(), "もう一度、選び直せる");
  await page.close();

  // 同じファイルをもう一度（1回目を登録してから）
  seed(); seenApi.length = 0;
  const a = await open(`/office/index.html?month=${M}`);
  await a.page.waitForSelector(ROW);
  const [fc1] = await Promise.all([a.page.waitForEvent("filechooser"), cell(a.page, "次にやること").locator('button[data-cta="pick"]').click()]);
  await fc1.setFiles(atRoot(SAMPLE));
  await a.page.waitForURL(/timesheet\.html/);
  await a.page.close();
  const b = await open(`/office/index.html?month=${M}`);
  await b.page.waitForSelector(ROW);
  await b.page.locator(`${ROW} [data-label="要員"]`).click();
  await b.page.waitForSelector("#dr-timesheet");
  const more = b.page.locator('#dr-timesheet button[data-cta="pick"]');
  check((await more.innerText()).includes("別のファイルを追加"), "届いているときは、「別のファイルを追加」（追加・差し替え）");
  const [fc2] = await Promise.all([b.page.waitForEvent("filechooser"), more.click()]);
  await fc2.setFiles(atRoot(SAMPLE));
  await b.page.waitForSelector("#dr-next .er", { timeout: 8000 });
  check((await b.page.locator("#dr-next .er").innerText()).includes("すでに届いています"), "同じファイル：「すでに届いています」と出て、登録しない");
  check(rows("gw_submissions").length === 1, "ファイルは1件のまま");
  check(b.page.url().includes("/office/index.html"), "移動しない");
  await b.page.close();
}

console.log("\n=== 8. スマホ幅：押せる場所が、横にはみ出さず見える ===");
{
  seed();
  const { page } = await open(`/office/index.html?month=${M}`, { viewport: { width: 390, height: 844 } });
  await page.waitForSelector(ROW);
  await page.waitForTimeout(300);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(ov <= 1, `横スクロールが要らない（はみ出し ${ov}px）`);
  const top = page.locator('#now button[data-cta="pick"]');
  const tb = await top.boundingBox();
  check(await top.isVisible() && tb.y + tb.height <= 844, `最初の画面（スクロールなし）に「勤務表を追加」が見える（下端 ${Math.round(tb.y + tb.height)}px / 画面 844px）`);
  const btn = cell(page, "次にやること").locator('button[data-cta="pick"]');
  check(await btn.isVisible(), "一覧の行にも「勤務表を追加」が見える");
  const box = await btn.boundingBox();
  check(box.height >= 30 && box.x >= 0 && box.x + box.width <= 390, `ボタンの大きさ・位置（高さ ${Math.round(box.height)}px）`);
  await shot(page, "09-mobile");
  await page.close();
}

console.log("\n=== 9. 一覧の状態の色（BP・期限超過）は officeui.mjs で見る。ここでは、ページ全体にエラーが無いこと ===");
{
  seed();
  const { page, errs } = await open(`/office/index.html?month=${M}`);
  await page.waitForSelector(ROW);
  await page.locator(`${ROW} [data-label="要員"]`).click();
  await page.waitForSelector("#dr-next");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
