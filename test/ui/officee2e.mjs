// Phase 3 の完成条件：1人分の勤務表が、最初から最後まで通ること。
//
//   /office 一覧（勤務表待ち）
//     → 勤務表を登録（アップロード）
//     → 重複チェック（同じファイルは登録しない）
//     → AI読取（下書き）
//     → 左に勤務表・右に読取結果を並べて確認
//     → 誤読箇所を修正（3か所）
//     → 稼働確定（人が押す）
//     → 月間稼働時間・契約条件の精算が出る
//     → /office 一覧が「稼働確定」へ進む（請求作成待ち）
//
// ■ 何を通しているか
//   ブラウザの通信は、本物の api/office/{index,timesheet,file,terms}.js と api/billing-submission/public.js
//   （外部提出フォーム）のハンドラにつなぐ。DB は偽（test/_memdb.mjs：制約・RLS・Storage を真似る）、
//   AI は偽の client（本物の読取の検査・正規化は通る）。
//
// ■ 勤務表（2026年10月・1人分）
//   勤務日 21日（10/12 は祝日）。9:00〜18:00・休憩 1:00 が基本。誤読・欠落は3か所：
//     10/8  … 終了を 19:00 と誤読（実際は 18:00）。AI の自信は低
//     10/14 … 休憩の欄が空白（実際は 1:00）
//     10/21 … 終了が判読できない（実際は 18:00）
//   10/23 は 9:00〜18:30（実働 8:30）。正しい合計は 20日 × 8:00 ＋ 8:30 = 168:30（勤務表の合計欄と一致）
//
// 画面の写真を残すとき：E2E_SHOTS=<ディレクトリ> を付けて実行する
import "../_officeharness.mjs";
import { mem, ctl, ai, call, atRoot, OWNER, uid, T1, E_PP, C_PP } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import nodeCrypto from "node:crypto";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));
const { default: publicApi } = await import(atRoot("api/billing-submission/public.js"));
const { sha256: tokenHash } = await import(atRoot("lib/billing-submission.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const SHOTS = process.env.E2E_SHOTS || "";
// 画面の写真：E2E_SHOTS があればそこへ、無ければ一時領域へ（落ちたときに、何が出ていたかを見るため）
// （E2E_SHOTS のときだけ）オフラインでは、アイコンのフォントが読めず、アイコン名の文字が出る。写真では隠す
const shot = async (page, name) => {
  if (SHOTS) await page.addStyleTag({ content: ".material-symbols-outlined { visibility:hidden !important; }" });
  await page.screenshot({ path: SHOTS ? `${SHOTS}/${name}.png` : shotPath(`e2e-${name}.png`), fullPage: false });
};

const M = "2026-10";
const BUCKET = "billing-submissions";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(600, 7)]);
const rows = (t) => mem.rows[t] || [];
const sheetRow = () => rows("gw_timesheets").find((r) => r.target_month === M && r.employee_id === E_PP);
const progress = () => rows("gw_billing_progress").find((r) => r.employee_id === E_PP && r.billing_month === M);
const hash = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

// ---- 勤務表（AI の読取結果）--------------------------------------------------------
const WORK = [1, 2, 5, 6, 7, 8, 9, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30];        // 21日
const dayAi = (d) => {
  if (!WORK.includes(d)) return { day: d, kind: "off", blank: false, note: "休", confidence: "high" };
  const base = { day: d, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high" };
  if (d === 8) return { ...base, end: "19:00", confidence: "low", reason: "18 と 19 が判別しづらい" };       // 誤読
  if (d === 14) return { ...base, break: null };                                                            // 休憩の欄が空白
  if (d === 21) return { ...base, end: null, unreadable: ["end"], confidence: "low", reason: "字が潰れている" }; // 判読不能
  if (d === 23) return { ...base, end: "18:30", worked: "8:30" };
  return base;
};
const AI_INPUT = { sheet_month: M, employee_name: "田中 太郎", total_worked: "168:30", break_column: "present",
  days: Array.from({ length: 31 }, (_, i) => dayAi(i + 1)) };
const aiReply = (input) => ({ model: "claude-test-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "read_timesheet", input }], usage: { input_tokens: 4200, output_tokens: 2100 } });

function seed() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2"; ai.reply = aiReply(AI_INPUT); ai.calls.length = 0;
  mem.rows.gw_employees = [{ id: E_PP, tenant_id: T1, display_name: "田中 太郎", department: "常駐部", employee_kind: "proper", partner_company_id: null }];
  mem.rows.gw_site_contracts = [{ id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "株式会社ABC", prime_company: null,
    period_from: "2026-04-01", period_to: null, renewal_status: "confirmed",
    unit_price: 999999, unit_price_type: "月額", settlement_condition: "既存の条件（意味は未確認）" }];
  // 契約条件：月額 700,000円・精算幅 140〜180h・超過 4,000円/h・控除 3,500円/h
  mem.rows.gw_site_contract_terms = [{ id: uid(700), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-04-01", valid_to: null, pricing_type: "monthly",
    sales_unit_price: 700000, purchase_unit_price: 600000, settlement_mode: "range", settle_min_minutes: 8400, settle_max_minutes: 10800,
    over_rate_per_hour: 4000, under_rate_per_hour: 3500, amount_rounding: "floor", prorate: false }];
}

async function open(url, { viewport = { width: 1440, height: 1000 } } = {}) {
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = []; const dialogs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.example/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "keiri@8grp.co.jp" })); });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({ email: "keiri@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, access: { office: true },
        gw: { employee: { id: "e-me", display_name: "経理 花子", status: "active" }, roles: ["finance"], isAdmin: false, tenantId: "t1", stage: null } });
    }
    const h = { "/api/office": indexApi, "/api/office/timesheet": sheetApi, "/api/office/file": fileApi, "/api/office/terms": termsApi }[u.pathname];
    if (h) {
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
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
    return route.fulfill({ status: 200, contentType: "text/html", body: "<html><head><meta charset='utf-8'></head><body style='font-family:sans-serif;padding:24px;line-height:2'><h3>勤務表（テスト用の表示）</h3>2026年10月　田中 太郎<br>10/1 09:00-18:00 休憩1:00<br>10/8 09:00-18:00 休憩1:00<br>10/14 09:00-18:00 ／<br>10/21 09:00-（判読不能）<br>合計 168:30</body></html>" });
  });
  await page.goto(`${BASE}${url}`);
  return { page, errs, dialogs };
}
const row = (page, d) => page.locator(`#dayrows tr[data-date="${M}-${String(d).padStart(2, "0")}"]`);
const waitSave = (page) => page.waitForResponse((r) => r.url().includes("/api/office/timesheet") && r.request().method() === "POST" && r.status() === 200);
const kpi = (page) => page.locator(".ts-kpi .v").allInnerTexts();
async function edit(page, d, field, value) {
  const done = waitSave(page);
  await row(page, d).locator(`[data-f="${field}"]`).fill(value);
  await page.keyboard.press("Tab");
  await done;
}

// ============================================================================
console.log("\n=== E2E 1：Office から勤務表を登録して、稼働確定まで ===");
{
  seed();
  const { page, errs, dialogs } = await open(`/office/monthly.html?month=${M}`);

  // 1. 一覧：勤務表待ち
  await page.waitForSelector("#rows tr[data-id]");
  const tr = page.locator('#rows tr:has-text("田中 太郎")');
  check((await tr.locator('[data-label="現在工程"]').innerText()).includes("勤務表待ち"), "1. 一覧：現在工程は「勤務表待ち」");
  check((await tr.locator('[data-label="稼働時間"]').innerText()).includes("—"), "1. 一覧：稼働時間は未確定（—）");
  const vals0 = await page.locator("#sum .of-card .v").allInnerTexts();
  check(vals0[1] === "1" && vals0[2] === "0", `1. 一覧：勤務表待ち 1・稼働確認待ち 0（いま ${vals0.slice(0, 3)}）`);
  await shot(page, "1-list-before");

  // 2. 勤務表を登録：一覧の「勤務表を追加」→ ファイル選択 → アップロード → 登録 → 勤務表の確認画面
  check((await tr.locator('[data-label="次にやること"]').innerText()).includes("勤務表が未提出です"), "1. 一覧：次にやること「勤務表が未提出です」");
  const [fcUp] = await Promise.all([page.waitForEvent("filechooser"), tr.locator('button[data-cta="pick"]').click()]);
  await fcUp.setFiles({ name: "田中_10月勤務表.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForURL(/timesheet\.html\?contract=/);
  await page.waitForSelector("#upfile", { state: "attached" });
  await page.waitForSelector("#files .ts-file");
  await page.waitForSelector("#view iframe");
  check(rows("gw_submissions").length === 1 && rows("gw_submissions")[0].sha256 === hash(PDF) && rows("gw_submissions")[0].source === "office", "2. アップロード：登録された（sha256・Office から・確認日時）");
  check((await page.locator("#stateBadge").innerText()).includes("提出済み"), "2. 状態：提出済み（未読取）");
  check(progress()?.timesheet_received === true, "2. 既存の印：勤務表受領が立つ");

  // 3. 重複チェック
  await page.locator("#upfile").setInputFiles({ name: "田中_10月勤務表(コピー).pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForSelector("#banner .of-banner.err");
  check((await page.locator("#banner").innerText()).includes("すでに届いています") && rows("gw_submissions").length === 1, "3. 重複チェック：同じファイルは登録されない（1件のまま）");
  check(ai.calls.length === 0, "3. ここまで、AI は呼んでいない（費用がかからない）");

  // 4. AI読取 → 左右で確認
  await page.locator("#readMain").click();
  await page.waitForSelector("#dayrows tr");
  check((await page.locator("#stateBadge").innerText()).includes("確認待ち"), "4. AI読取：確認待ち（下書き）。確定ではない");
  check(sheetRow().status === "draft" && !sheetRow().confirmed_at && progress().work_confirmed === false, "4. AI読取だけでは確定にならない（稼働確認の印も立たない）");
  const dates = await page.locator("#dayrows tr").evaluateAll((t) => t.map((r) => r.dataset.date.slice(8)));
  check(dates.join() === "08,14,21", `4. 要対応は3日だけ：10/8（誤読の疑い）・10/14（休憩が空）・10/21（判読不能）（いま ${dates}）`);
  const vb = await page.locator("#view").boundingBox(); const tb = await page.locator("#days table").boundingBox();
  check(vb && tb && vb.x + vb.width <= tb.x + 2 && vb.width > 300 && tb.width > 450, `4. 左に勤務表・右に読取結果（左 x=${Math.round(vb.x)} 幅${Math.round(vb.width)} ／ 右 x=${Math.round(tb.x)} 幅${Math.round(tb.width)}）`);
  check(await page.locator("#view iframe").isVisible(), "4. 勤務表は、読取結果と同時に見えている");
  check((await row(page, 8).innerText()).includes("18 と 19 が判別しづらい") && (await row(page, 8).innerText()).includes("AI 低"), "4. 10/8：AI の自信は低・理由つき");
  check((await row(page, 14).innerText()).includes("休憩が不明です") && await row(page, 14).locator('[data-f="break"]').inputValue() === "", "4. 10/14：休憩は補完せず空のまま・理由を表示");
  check(await row(page, 21).locator('[data-f="end"]').inputValue() === "" && (await row(page, 21).innerText()).includes("判読できませんでした"), "4. 10/21：判読不能は空のまま（推測で埋めない）");
  const k0 = await kpi(page);
  check(k0[2].startsWith("2") && k0[3].startsWith("1"), `4. 集計：入力が必要 2日・要確認 1日（いま ${k0[2]} / ${k0[3]}）`);
  check(await page.locator("#confirmBtn").isDisabled(), "4. まだ確定できない");
  await shot(page, "2-timesheet-review");

  // 5. 誤読箇所を修正（人が画面を見ていた時間が、確認時間として記録される）
  await page.waitForTimeout(2200);
  await edit(page, 8, "end", "18:00");
  check((await row(page, 8).locator("td.w").innerText()).includes("08:00") && await row(page, 8).evaluate((e) => e.className) === "ok", "5. 10/8：終了を 18:00 に直す → 実働 8:00・印が消える");
  await edit(page, 14, "break", "1:00");
  check((await row(page, 14).locator("td.w").innerText()).includes("08:00"), "5. 10/14：休憩 1:00 を入れる → 実働 8:00");
  await edit(page, 21, "end", "18:00");
  check((await row(page, 21).locator("td.w").innerText()).includes("08:00"), "5. 10/21：終了 18:00 を入れる → 実働 8:00");
  const k1 = await kpi(page);
  check(k1[0].startsWith("168.5") && k1[1].startsWith("21") && k1[2].startsWith("0") && k1[3].startsWith("0") && k1[4].includes("一致"), `5. 月間稼働：168.5h・21日・入力が必要 0・要確認 0・勤務表の合計と一致（いま ${k1.join(" | ").replace(/\n/g, " ")}）`);
  check((await page.locator("#kpi").innerText()).includes("140〜180h") && (await page.locator("#kpi").innerText()).includes("168.5h（幅の中）"), "5. 契約の精算幅（140〜180h）の中");
  check(sheetRow().edit_count === 3 && sheetRow().review_seconds >= 2, `5. 直した回数 3・確認にかけた時間 ${sheetRow().review_seconds}秒 が残る`);
  check(sheetRow().status === "draft", "5. 直しても、下書きのまま");

  // 6. 稼働確定
  check(await page.locator("#confirmBtn").isEnabled(), "6. 確定できる状態になる");
  await shot(page, "3-timesheet-ready");
  await page.locator("#confirmBtn").click();
  await page.waitForFunction(() => document.querySelector("#stateBadge")?.textContent.includes("確定"));
  const top = await page.locator("#top").innerText();
  check(top.includes("確定済みです") && top.includes("168.5h") && top.includes("稼働 21日"), "6. 確定：168.5h・稼働 21日");
  check(top.includes("700,000円") && top.includes("精算幅の中"), "6. 契約条件との照合：月額 700,000円・精算幅の中 → 売上の精算 700,000円");
  check(sheetRow().status === "confirmed" && sheetRow().total_minutes === 10110 && sheetRow().work_days === 21 && sheetRow().confirmed_by === "u-1", "6. サーバー：確定・合計 10110分（168:30）・稼働 21日・確定者");
  check(progress().timesheet_received === true && progress().work_confirmed === true && progress().work_confirmed_at, "6. 既存の印：勤務表受領・稼働確認が立つ");
  check(progress().board_created === false && progress().sent === false, "6. 請求の印には触らない");
  const kinds = rows("gw_office_events").map((e) => e.kind);
  check(kinds.join() === "timesheet.upload,timesheet.read,timesheet.save,timesheet.save,timesheet.save,timesheet.confirm", `6. 履歴：${kinds.join(" → ")}`);
  check(await page.locator("#dayrows input").first().isDisabled(), "6. 確定後は、日別の値を編集できない");
  await shot(page, "4-timesheet-confirmed");

  // 7. /office 一覧が「稼働確定」へ進む
  await page.locator("#back").click();
  await page.waitForSelector("#rows tr[data-id]");
  // 戻ると、いま見ていた案件の右ドロワーが開いた状態で戻る（一覧の続きから作業できる）
  await page.waitForSelector(".of-drawer");
  const dr = await page.locator(".of-drawer").innerText();
  check(dr.includes("確定した稼働時間") && dr.includes("168.5h") && dr.includes("700,000円"), "7. 戻ると、右ドロワーに確定した稼働時間と売上の精算が出る");
  check(await page.locator('.of-drawer a[href^="/office/timesheet.html?contract="]').count() >= 1, "7. ドロワーから、勤務表の画面へ戻れる");
  await page.keyboard.press("Escape");
  const tr2 = page.locator('#rows tr:has-text("田中 太郎")');
  check((await tr2.locator('[data-label="稼働時間"]').innerText()).includes("168.5h") && (await tr2.locator('[data-label="稼働時間"]').innerText()).includes("確定済"), "7. 一覧：稼働時間 168.5h・確認済");
  check((await tr2.locator('[data-label="現在工程"]').innerText()).includes("請求作成待ち"), "7. 一覧：現在工程が「勤務表待ち」→「請求作成待ち」へ進む");
  check((await tr2.locator('[data-label="次にやること"]').innerText()).includes("売上請求書を作成してください"), "7. 一覧：次にやることは、売上請求書の作成");
  const vals = await page.locator("#sum .of-card .v").allInnerTexts();
  check(vals[1] === "0" && vals[2] === "0" && vals[3] === "1", `7. 数字カード：勤務表待ち 0・稼働確認待ち 0・請求未送付 1（いま ${vals.slice(0, 4)}）`);
  const prog = (await page.locator("#prog .num").allInnerTexts()).join("|");
  check(prog.startsWith("1 / 1|1 / 1"), `7. 月次進捗：勤務表回収 1/1・稼働確認 1/1（いま ${prog}）`);
  check(!(await tr2.innerText()).includes("要確認"), "7. 印と勤務表が一致しているので、要確認は出ない");
  check(!(await page.locator("#rows").innerText()).match(/700,000|999,999|既存の条件/), "7. 一覧に、単価・既存の unit_price は出ない");
  await shot(page, "5-list-after");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  check(dialogs.length === 0, "確認ダイアログは出ていない（この流れでは、承知の確認が要らない）");
  check(rows("gw_site_contracts")[0].unit_price === 999999 && rows("gw_site_contracts")[0].settlement_condition === "既存の条件（意味は未確認）", "既存の unit_price・settlement_condition は、そのまま");
  await page.close();
}

console.log("\n=== E2E 2：外部提出フォームから届いた勤務表（二重提出）===");
{
  seed();
  // 本人が外部提出フォーム（本物のハンドラ）から、同じ勤務表を2回送ってしまう
  const token = "t".repeat(48);
  mem.rows.gw_submission_links = [{ id: uid(800), tenant_id: T1, employee_id: E_PP, token_hash: tokenHash(token), expires_at: "2099-01-01T00:00:00Z", revoked_at: null }];
  const submitForm = async () => {
    const r = await call(publicApi, "/api/billing-submission/public", { method: "POST", body: { token, targetMonth: M, kind: "timesheet", siteContractId: C_PP,
      filename: "田中_10月.pdf", mimeType: "application/pdf", sizeBytes: PDF.length } });
    if (r.statusCode !== 200) throw new Error(`外部フォームが ${r.statusCode}: ${JSON.stringify(r.body)}`);
    mem.put(BUCKET, mem.uploadUrls.at(-1).path, PDF);            // ブラウザが署名付きURLへ PUT したものとする
    return r.body.submissionId;
  };
  const first = await submitForm(); await submitForm();
  check(rows("gw_submissions").length === 2 && rows("gw_submissions").every((s) => !s.sha256), "外部フォーム：2回届いた（届いた時点では、中身は未確認）");
  check(progress().timesheet_received === true, "外部フォーム：従来どおり、勤務表受領の印が立つ");

  const { page, errs } = await open(`/office/monthly.html?month=${M}`);
  await page.waitForSelector("#rows tr[data-id]");
  const tr = page.locator('#rows tr:has-text("田中 太郎")');
  check((await tr.locator('[data-label="稼働時間"]').innerText()).includes("未読取"), "一覧：ファイルは届いているが「未読取」");
  check((await tr.locator('[data-label="現在工程"]').innerText()).includes("稼働確認待ち"), "一覧：現在工程は「稼働確認待ち」（受領の印が付いているため）");
  check((await tr.locator('[data-label="次にやること"]').innerText()).includes("勤務表が複数届いています"), "一覧：同じファイルが2件届いている行は「勤務表が複数届いています」（自動では読み取らせない）");
  const linkHref = await tr.locator('[data-label="次にやること"] a.of-btn').getAttribute("href");
  check(!/read=1/.test(linkHref) && (await tr.locator('[data-label="次にやること"] a.of-btn').innerText()).includes("ファイルを確認する"), `「ファイルを確認する」は、読み取りを始めない（${linkHref}）`);
  await tr.locator('[data-label="次にやること"] a.of-btn').click();
  await page.waitForSelector("#files .ts-file");
  await page.waitForFunction(() => document.querySelectorAll("#files .ts-tag.warn").length === 2);
  check(ai.calls.length === 0, "画面を開いた時点で、同じファイルと分かる（AI は呼ばない）");
  check((await page.locator("#files").innerText()).includes("同じファイルが複数"), "重複：2件とも「同じファイルが複数」の印");
  check(rows("gw_submissions").every((s) => s.sha256 === hash(PDF) && s.verified_at), "開いたとき、外部フォームの行の中身を確かめて sha256 を埋める");
  await page.locator(`#files [data-read="${first}"]`).click();
  await page.waitForSelector("#dayrows tr");
  check((await page.locator("#stateBadge").innerText()).includes("確認待ち") && sheetRow().submission_id === first, "原本（最初に届いたほう）を読み取る → 下書き");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== E2E 3：PDF・JPEG・PNG のどれでも、同じ流れ ===");
{
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 5)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 3)]);
  for (const [name, buf, mime, sel, media] of [["JPEG", JPG, "image/jpeg", "#view img", "image"], ["PNG", PNG, "image/png", "#view img", "image"], ["PDF", PDF, "application/pdf", "#view iframe", "document"]]) {
    seed();
    const { page } = await open(`/office/timesheet.html?contract=${C_PP}&month=${M}`);
    await page.waitForSelector("#upfile", { state: "attached" });
    await page.locator("#upfile").setInputFiles({ name: `勤務表.${name.toLowerCase()}`, mimeType: mime, buffer: buf });
    await page.waitForSelector(sel);
    await page.locator("#readMain").click();
    await page.waitForSelector("#dayrows tr");
    const sent = ai.calls.at(-1).params.messages[0].content[0];
    check(sent.type === media && (media === "document" ? sent.source.media_type === "application/pdf" : sent.source.media_type === mime), `${name}：登録 → 表示（${sel}）→ AI へ ${media} ブロックとして渡す`);
    check(rows("gw_timesheet_days").length === 31, `${name}：読取 → 31日ぶんの下書き`);
    await page.close();
  }
  // HEIC など、PDF・JPEG・PNG 以外は、登録の入口で断る（対応を増やさない）
  seed();
  const { page } = await open(`/office/timesheet.html?contract=${C_PP}&month=${M}`);
  await page.waitForSelector("#upfile", { state: "attached" });
  await page.locator("#upfile").setInputFiles({ name: "IMG_0001.heic", mimeType: "image/heic", buffer: Buffer.from("ftypheic") });
  await page.waitForFunction(() => document.querySelector("#banner")?.textContent.includes("PDF・JPEG・PNG"));
  check(rows("gw_submissions").length === 0 && mem.uploadUrls.length === 0, "PDF・JPEG・PNG 以外（例：HEIC）は、送信も登録もしない");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
