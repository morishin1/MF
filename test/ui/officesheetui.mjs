// 勤務表の確認画面（/office/timesheet.html）と契約条件の画面（/office/terms.html）を、実際のブラウザで通す。
//
// ■ 本物の API を通す
//   ブラウザの通信は、本物の api/office/*.js のハンドラ（偽の Supabase＝test/_memdb.mjs、AI は偽の client）に
//   つなぐ。画面と API の約束が食い違えば、ここで落ちる。
//
// ■ 何を守るテストか
//   1. 左に勤務表（PDF・画像）、右に読取結果。要対応の日から確認できる（既定は「要対応のみ」）
//   2. 直すと、その日だけ保存し、実働・合計・確定の条件がその場で更新される。欄を離れてもフォーカスが消えない
//   3. 読めない入力は、理由を出して保存しない。確定の条件を満たすまで、確定できない
//   4. AI の結果は下書き。確定は人が押す。確定後は編集できず、取消し（理由つき）・差し戻し（理由つき）ができる
//   5. アップロード（同じファイルは登録しない／別の月・人に出ていたら確認）
//   6. 確認にかけた時間を記録する（AI の精度ではなく、確認の手間を測る）
//   7. 契約条件の登録・重なりの拒否・削除。スマホ幅で横に はみ出さない
import "../_officeharness.mjs";
import { mem, ctl, ai, call, atRoot, OWNER, uid, T1, E_PP, C_PP, C_BP, E_BP } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const O = await import(join(ROOT, "lib/office.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const M = "2026-10";
const BUCKET = "billing-submissions";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 7)]);
const PDF2 = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 9)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 5)]);
const rows = (t) => mem.rows[t] || [];
const sheetRow = () => rows("gw_timesheets").find((r) => r.target_month === M && r.employee_id === E_PP);
const progress = () => rows("gw_billing_progress").find((r) => r.employee_id === E_PP && r.billing_month === M);
const jstMonth = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);

function seed() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2"; ai.reply = null; ai.calls.length = 0;
  mem.rows.gw_employees = [
    { id: E_PP, tenant_id: T1, display_name: "田中 太郎", department: "常駐部", employee_kind: "proper", partner_company_id: null },
    { id: E_BP, tenant_id: T1, display_name: "鈴木 花子", employee_kind: "bp", partner_company_id: null },
  ];
  mem.rows.gw_site_contracts = [
    { id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "顧客A社", prime_company: null, period_from: "2026-04-01", period_to: null, renewal_status: "confirmed" },
    { id: C_BP, tenant_id: T1, employee_id: E_BP, engagement_kind: "pp", site_company: "顧客B社", prime_company: null, period_from: "2026-04-01", period_to: null, renewal_status: "confirmed" },
  ];
}
let seq = 200;
function seedFile({ bytes = PDF, contract = C_PP, employee = E_PP, hash = false, mime = "application/pdf", ext = "pdf" } = {}) {
  const id = uid(++seq);
  const path = `${T1}/${employee}/${id}.${ext}`;
  mem.rows.gw_submissions = [...rows("gw_submissions"), { id, tenant_id: T1, employee_id: employee, site_contract_id: contract, target_month: M, kind: "timesheet",
    file_name: "田中_10月.pdf", mime_type: mime, size_bytes: bytes.length, storage_path: path, submitted_at: "2026-11-02T00:00:00Z", source: "form", sha256: null, verified_at: null }];
  if (hash) { const r = rows("gw_submissions").at(-1); r.sha256 = require_hash(bytes); r.verified_at = "2026-11-02T00:00:00Z"; }
  mem.put(BUCKET, path, bytes);
  return id;
}
import nodeCrypto from "node:crypto";
const require_hash = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

const dayAi = (d, o = {}) => ([1, 2, 5].includes(d)
  ? { day: d, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high", ...o }
  : { day: d, kind: "off", blank: false, note: "公休", confidence: "high", ...o });
const sheetInput = (over = {}, dayOver = {}) => ({ sheet_month: M, employee_name: "田中 太郎", total_worked: null, break_column: "present",
  days: Array.from({ length: 31 }, (_, i) => dayAi(i + 1, dayOver[i + 1] || {})), ...over });
const reply = (input) => ({ model: "claude-test-1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "read_timesheet", input }], usage: { input_tokens: 10, output_tokens: 10 } });
// 要対応が3日ある勤務表：3日は自信が低い／5日は休憩が空／6日は勤務か休みか判断できない
const MESSY = () => sheetInput({}, {
  3: { kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "low", reason: "手書きでかすれている" },
  5: { break: null },
  6: { kind: "unknown", confidence: "low", reason: "判読不能" },
});

// ---- ブラウザの準備：API は本物のハンドラへつなぐ -------------------------------------
async function open(url, { access = { office: true }, viewport = { width: 1440, height: 1000 }, list } = {}) {
  const posts = [];
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  const errs = [];
  const dialogs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.example/.test(m.text())) errs.push(m.text()); });
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "keiri@8grp.co.jp" })); });
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      const me = { email: "keiri@8grp.co.jp", appRole: "member", isAdmin: false, shows: {}, gw: { employee: { id: "e-me", display_name: "経理 花子", status: "active" }, roles: ["finance"], isAdmin: false, tenantId: "t1", stage: null } };
      if (access !== null) me.access = access;
      return send(me);
    }
    if (u.pathname === "/api/office" && list) return send(list(u.searchParams.get("month")));
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.route("**/api/office/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const h = { "/api/office/timesheet": sheetApi, "/api/office/file": fileApi, "/api/office/terms": termsApi }[u.pathname];
    if (!h) return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    posts.push({ path: u.pathname, method: req.method(), body });
    const r = await call(h, u.pathname + u.search, { method: req.method(), body });
    return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  // 勤務表のファイル（署名付きURL）と、アップロード先
  await page.route("https://storage.example/**", (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (req.method() === "PUT") {
      const m = /^\/upload\/([^/]+)\/(.+)$/.exec(u.pathname);
      if (m) mem.put(m[1], m[2], req.postDataBuffer());
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: "<html><head><meta charset='utf-8'></head><body style='font-family:sans-serif'>勤務表（テスト用の表示）</body></html>" });
  });
  await page.goto(`${BASE}${url}`);
  return { page, posts, errs, dialogs };
}
const TS = `/office/timesheet.html?contract=${C_PP}&month=${M}`;
const row = (page, d) => page.locator(`#dayrows tr[data-date="${M}-${String(d).padStart(2, "0")}"]`);
const kpi = (page) => page.locator(".ts-kpi .v").allInnerTexts();
const waitPost = (page) => page.waitForResponse((r) => r.url().includes("/api/office/timesheet") && r.request().method() === "POST");

// ============================================================================
console.log("\n=== 左に勤務表・右に読取結果。要対応の日から ===");
{
  seed(); seedFile(); ai.reply = reply(MESSY());
  const { page, errs } = await open(TS);
  await page.waitForSelector("#readMain");
  check((await page.locator("#title").innerText()).includes("田中 太郎"), "見出し：要員名");
  check((await page.locator("#sub").innerText()).includes("顧客A社") && (await page.locator("#sub").innerText()).includes("2026年10月"), "見出し：客先・対象月");
  check((await page.locator("#stateBadge").innerText()).includes("提出済み"), "状態：提出済み（未読取）");
  await page.waitForSelector("#view iframe");
  check((await page.locator("#view iframe").getAttribute("src")).startsWith("https://storage.example/"), "左：勤務表のファイルを、署名付きURLで表示");
  check(await page.locator("#days table").count() === 0, "読取前は、日ごとの表を出さない");

  await page.locator("#readMain").click();
  await page.waitForSelector("#dayrows tr");
  check((await page.locator("#stateBadge").innerText()).includes("確認待ち"), "読取のあと：確認待ち（下書き）");
  check(await page.locator("#dayrows tr").count() === 3, "既定は「要対応のみ」：3日だけ出る");
  const dates = await page.locator("#dayrows tr").evaluateAll((t) => t.map((r) => r.dataset.date));
  check(dates.join() === `${M}-03,${M}-05,${M}-06`, `要対応の日：3・5・6日（いま ${dates}）`);
  check(await row(page, 5).evaluate((e) => e.className) === "blocking", "実働を出せない日は、赤い印");
  check(await row(page, 3).evaluate((e) => e.className) === "review", "要確認の日は、黄色い印");
  check((await row(page, 3).innerText()).includes("手書きでかすれている") && (await row(page, 3).innerText()).includes("AI 低"), "AI の理由と自信度が見える");
  check((await row(page, 5).innerText()).includes("休憩が不明です"), "休憩が空の日：補完せず、理由を出す");
  check(await row(page, 5).locator('[data-f="break"]').inputValue() === "", "休憩は空のまま（推測で埋めない）");
  const k = await kpi(page);
  check(k[0].startsWith("24") && k[2].startsWith("2") && k[3].startsWith("1"), `集計：合計24h（3日はAI低でも実働は出る）・入力が必要2日・要確認1日（いま ${k.slice(0, 4)}）`);
  check(await page.locator("#confirmBtn").isDisabled(), "確定できない（確定ボタンが押せない）");
  const blockers = await page.locator(".ts-foot ul li").allInnerTexts();
  check(blockers.some((b) => b.includes("実働を出せない日が 2 日")) && blockers.some((b) => b.includes("要確認の日が 1 日")), "確定できない理由が並ぶ");
  check((await page.locator("#tools").innerText()).includes("要対応のみ（3）") && (await page.locator("#days").innerText()).includes("問題のない 28日は表示していません"), "問題のない日は畳んでいる");
  await page.locator('[data-filter="all"]').click();
  check(await page.locator("#dayrows tr").count() === 31, "「すべての日」で31日ぶん");
  await page.locator('[data-filter="attention"]').click();
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 直す：その日だけ保存・その場で更新・フォーカスが消えない ===");
{
  seed(); seedFile(); ai.reply = reply(MESSY());
  const { page, posts } = await open(TS);
  await page.waitForSelector("#readMain"); await page.locator("#readMain").click(); await page.waitForSelector("#dayrows tr");
  await page.waitForTimeout(2300);                                        // 画面を見ていた時間
  const br5 = row(page, 5).locator('[data-f="break"]');
  await br5.fill("1:00");
  const saved = waitPost(page);
  await page.keyboard.press("Tab");
  await saved;
  await page.waitForFunction(() => document.querySelector('#dayrows tr[data-date$="-05"] td.w')?.textContent.includes("08:00"));
  const sv = posts.filter((p) => p.body?.action === "save").at(-1);
  check(sv && sv.body.days.length === 1 && sv.body.days[0].workDate === `${M}-05` && sv.body.days[0].break === "1:00", "その日の、その項目だけを送る");
  check(sv.body.reviewSeconds >= 2 && sv.body.reviewSeconds <= 8, `確認にかけた時間を一緒に送る（${sv.body.reviewSeconds}秒）`);
  check((await row(page, 5).locator("td.w").innerText()).includes("08:00"), "実働が、その場で 08:00 になる");
  check(await row(page, 5).evaluate((e) => e.className) === "ok", "直した日は、赤い印が消える");
  check(await page.evaluate(() => document.activeElement?.dataset?.f) === "note", "Tab で進んだ先（備考）のフォーカスが、保存のあとも残る");
  const k = await kpi(page);
  check(k[2].startsWith("1"), `入力が必要な日が 2 → 1（いま ${k[2]}）`);
  check(sheetRow().edit_count === 1 && sheetRow().review_seconds >= 2, "直した回数・確認にかけた時間が、サーバーに残る");
  check(await row(page, 5).count() === 1, "直した日は、その場では消えない（並びが動かない）");

  // 読めない入力：理由を出して保存しない
  const st6 = row(page, 6).locator('[data-f="start"]');
  await st6.fill("9:5");
  const s2 = waitPost(page);
  await page.keyboard.press("Tab");
  const r2 = await s2;
  check(r2.status() === 400, "読めない時刻は 400");
  check((await row(page, 6).innerText()).includes("開始「9:5」を、時刻（例 9:00）で入れてください"), "理由を、その日の行に出す");
  check(await st6.getAttribute("aria-invalid") === "true", "その欄に、エラーの印");
  check(rows("gw_timesheet_days").find((d) => d.work_date === `${M}-06`).start_min == null, "保存されていない");

  // 確認済みにする
  await row(page, 3).locator("[data-review]").click();
  await page.waitForFunction(() => !document.querySelector('#dayrows tr[data-date$="-03"] [data-review]'));
  check((await row(page, 3).innerText()).includes("確認済み"), "「確認した」で、要確認の日が確認済みに");
  await page.close();
}

console.log("\n=== まとめて直す・確定 ===");
{
  seed(); seedFile(); ai.reply = reply(MESSY());
  const { page, posts } = await open(TS);
  await page.waitForSelector("#readMain"); await page.locator("#readMain").click(); await page.waitForSelector("#dayrows tr");
  check(await page.locator('[data-bulk="mark_off_unread"]').isDisabled() === false, "「読めなかった日を休みに」は、押せる（該当あり）");
  check((await page.locator('[data-bulk="fill_break"]').innerText()).includes("（1）"), "休憩の一括入力：該当の日数が見える");
  await page.locator('[data-bulk="fill_break"]').click();
  await page.waitForSelector(".ts-dlg");
  await page.locator("#dlg-in").fill("1");                                  // 単位が無い：読まない
  await page.locator("#dlg-ok").click();
  await page.waitForSelector("#banner .of-banner.err");
  check((await page.locator("#banner").innerText()).includes("分か時間か分かりません"), "単位のない「1」は、分か時間か分からないので断る");
  await page.locator('[data-bulk="fill_break"]').click();
  await page.waitForSelector(".ts-dlg");
  await page.locator("#dlg-in").fill("1:00");
  await page.locator("#dlg-ok").click();
  await page.waitForFunction(() => !document.querySelector('#dayrows tr[data-date$="-05"]') || document.querySelector('#dayrows tr[data-date$="-05"]').className === "ok" || true);
  await page.waitForTimeout(400);
  check(rows("gw_timesheet_days").find((d) => d.work_date === `${M}-05`).break_min === 60, "休憩が空の勤務日に、1:00 が入る");

  await page.locator('[data-bulk="mark_off_unread"]').click();
  await page.waitForTimeout(400);
  check(rows("gw_timesheet_days").find((d) => d.work_date === `${M}-06`).kind === "off", "読めなかった日が、休みになる");
  await page.locator('[data-bulk="review_flagged"]').click();
  await page.waitForTimeout(400);
  check((await page.locator(".ts-foot .ok").count()) === 1, "条件を満たすと「確定できます」");
  check(await page.locator("#confirmBtn").isEnabled(), "確定ボタンが押せる");
  check(sheetRow().status === "draft", "ここまでは、下書きのまま（AI・一括操作では確定しない）");

  await page.locator("#confirmBtn").click();
  await page.waitForFunction(() => document.querySelector("#stateBadge")?.textContent.includes("確定"));
  check((await page.locator("#top").innerText()).includes("確定済みです") && (await page.locator("#top").innerText()).includes("32h"), "確定：稼働時間 32h（4日 × 8h）");
  check(sheetRow().status === "confirmed" && sheetRow().total_minutes === 1920, "サーバーに確定として残る");
  check(progress().timesheet_received === true && progress().work_confirmed === true, "既存の5つの印（受領・稼働確認）が同期する");
  check(await page.locator("#dayrows input").first().isDisabled(), "確定後は編集できない");
  check(await page.locator("#confirmBtn").count() === 0, "確定ボタンは消える");

  // 確定の取消し（理由つき）
  await page.locator('[data-act="reopen"]').click();
  await page.waitForSelector(".ts-dlg");
  await page.locator("#dlg-ok").click();
  check((await page.locator("#dlg-er").innerText()).includes("入力してください"), "理由が無ければ取り消せない");
  await page.locator("#dlg-in").fill("休憩の入力ミス");
  await page.locator("#dlg-ok").click();
  await page.waitForFunction(() => document.querySelector("#stateBadge")?.textContent.includes("確認待ち"));
  check(progress().work_confirmed === false && sheetRow().status === "draft", "取り消すと、下書きに戻り、稼働確認の印も外れる");
  check(rows("gw_office_events").some((e) => e.kind === "timesheet.reopen" && e.detail.reason === "休憩の入力ミス"), "履歴に理由が残る");
  await page.close();
}

console.log("\n=== 勤務表の合計が違うときは、承知してから確定 ===");
{
  seed(); seedFile(); ai.reply = reply(sheetInput({ total_worked: "25:00" }));
  const { page } = await open(TS);
  await page.waitForSelector("#readMain"); await page.locator("#readMain").click(); await page.waitForSelector("#stateBadge:has-text('確認待ち')");
  await page.locator('[data-filter="all"]').click();
  check((await page.locator(".ts-kpi").innerText()).includes("計算−表"), "勤務表の合計との差が見える");
  check(await page.locator("[data-ack]").count() === 1 && await page.locator("#confirmBtn").isDisabled(), "承知のチェックが要り、それまで確定できない");
  await page.locator("[data-ack]").check();
  check(await page.locator("#confirmBtn").isEnabled(), "チェックすると確定できる");
  await page.locator("#confirmBtn").click();
  await page.waitForFunction(() => document.querySelector("#stateBadge")?.textContent.includes("確定"));
  check(rows("gw_office_events").find((e) => e.kind === "timesheet.confirm").detail.acks.includes("total_mismatch"), "承知したことが、履歴に残る");
  await page.close();
}

console.log("\n=== AI が読めなかったとき／手入力／差し戻し ===");
{
  seed(); seedFile();
  ai.reply = { stop_reason: "end_turn", content: [{ type: "text", text: "読めません" }] };
  const { page } = await open(TS);
  await page.waitForSelector("#readMain"); await page.locator("#readMain").click();
  await page.waitForSelector("#top:has-text('AI が読み取れませんでした')");
  check((await page.locator("#banner").innerText()).includes("AI が読み取り結果を返しませんでした") && (await page.locator("#top").innerText()).includes("もう一度読み取る"), "失敗の理由と、次の手段（もう一度・手入力）が出る");
  check(await page.locator('[data-act="blank"]').count() === 1, "「手入力で始める」がある");
  await page.locator('[data-act="blank"]').click();
  await page.waitForSelector("#dayrows tr");
  check(await page.locator("#dayrows tr").count() === 31, "手入力：全日が空の表（要対応が31日）");
  check((await kpi(page))[2].startsWith("31"), "全日が「入力が必要」");
  await row(page, 1).locator('[data-f="kind"]').selectOption("work");
  await page.waitForTimeout(300);
  await row(page, 1).locator('[data-f="start"]').fill("9:00"); await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await row(page, 1).locator('[data-f="end"]').fill("18:00"); await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await row(page, 1).locator('[data-f="break"]').fill("60分"); await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.querySelector('#dayrows tr[data-date$="-01"] td.w')?.textContent.includes("08:00"));
  check(true, "手入力：区分・開始・終了・休憩を入れると、実働が出る");
  await page.locator('[data-act="return"]').click();
  await page.waitForSelector(".ts-dlg");
  await page.locator("#dlg-in").fill("記入が抜けています。再提出をお願いします");
  await page.locator("#dlg-ok").click();
  await page.waitForSelector("#top:has-text('差し戻し中です')");
  check((await page.locator("#top").innerText()).includes("記入が抜けています") && (await page.locator("#top").innerText()).includes("メールを送りません"), "差し戻し：理由を表示。メールは送らないと明記");
  check(progress()?.timesheet_received !== true, "受領の印は立たない（差し戻し中は、届いたことにしない）");
  await page.close();
}

console.log("\n=== アップロード（同じファイルの検知） ===");
{
  seed();
  const { page, dialogs } = await open(TS);
  await page.waitForSelector("#view .none");
  check((await page.locator("#view").innerText()).includes("勤務表のファイルが届いていません"), "ファイルが無いときの案内");
  await page.locator("#upfile").setInputFiles({ name: "田中_10月.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForSelector("#files .ts-file");
  check(rows("gw_submissions").length === 1 && rows("gw_submissions")[0].source === "office", "アップロード → 登録（Office から）");
  check(progress().timesheet_received === true, "受領の印が立つ");
  await page.waitForSelector("#view iframe");
  check(true, "左に表示される");

  await page.locator("#upfile").setInputFiles({ name: "コピー.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForSelector("#banner .of-banner.err");
  check((await page.locator("#banner").innerText()).includes("すでに届いています") && rows("gw_submissions").length === 1, "同じファイルの再登録は断る");

  // 別の人の勤務表として出ている同じファイル
  seedFile({ bytes: PDF2, contract: C_BP, employee: E_BP, hash: true });
  await page.locator("#upfile").setInputFiles({ name: "流用.pdf", mimeType: "application/pdf", buffer: PDF2 });
  await page.waitForFunction(() => document.querySelectorAll("#files .ts-file").length === 2);
  check(dialogs.some((d) => d.includes("別の月・別の人の勤務表としても提出されています")), "別の人に出ている同じファイルは、確認を出す");
  check(rows("gw_submissions").length === 3, "承知すれば登録される");
  check((await page.locator("#banner").innerText()).includes("別のファイルではありませんか"), "登録後も、警告を残す");
  await page.locator("#upfile").setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.waitForFunction(() => document.querySelector("#banner")?.textContent.includes("PDF・JPEG・PNG"));
  check(true, "PDF・画像以外は、送らずに断る");
  await page.close();
}

console.log("\n=== 画像の勤務表・スマホ幅 ===");
{
  seed(); seedFile({ bytes: PNG, mime: "image/png", ext: "png" }); ai.reply = reply(MESSY());
  const { page, errs } = await open(TS, { viewport: { width: 390, height: 844 } });
  await page.waitForSelector("#view img");
  check(true, "画像は <img> で表示する");
  await page.locator("#readMain").click(); await page.waitForSelector("#dayrows tr");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `横にはみ出さない（はみ出し ${over}px）`);
  check(await page.locator(".ts-days thead").evaluate((e) => getComputedStyle(e).display) === "none", "日ごとの表は、カードになる");
  check((await row(page, 5).locator("td").first().evaluate((e) => getComputedStyle(e, "::before").content)).includes("日付"), "各項目に見出し");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 契約条件と精算（確定後）===");
{
  seed(); seedFile(); ai.reply = reply(sheetInput());
  mem.rows.gw_site_contract_terms = [];
  const { page } = await open(TS);
  await page.waitForSelector("#readMain"); await page.locator("#readMain").click(); await page.waitForSelector("#stateBadge:has-text('確認待ち')");
  check((await page.locator("#kpi").innerText()).includes("契約条件が未登録"), "条件が無いと、精算幅との照合ができないことを案内");
  await page.locator("#confirmBtn").click();
  await page.waitForFunction(() => document.querySelector("#stateBadge")?.textContent.includes("確定"));
  check((await page.locator("#top").innerText()).includes("契約条件が未登録"), "確定後：精算は、条件が未登録のため計算しない");
  await page.close();

  // 契約条件を登録する
  const t = await open(`/office/terms.html?contract=${C_PP}&month=${M}`);
  await t.page.waitForSelector("#list");
  check((await t.page.locator("#sub").innerText()).includes("田中 太郎") && (await t.page.locator("#sub").innerText()).includes("顧客A社"), "契約条件：要員・客先が出る");
  check(await t.page.locator("#fsRange").isHidden(), "単価の種類を選ぶまで、月額の精算の欄は隠れている");
  await t.page.locator("#validFrom").fill("2026-04-01");
  await t.page.locator("#validTo").fill("2026-12-31");
  await t.page.locator("#pricingType").selectOption("hourly");
  await t.page.locator("#salesUnitPrice").fill("4500");
  await t.page.locator("#purchaseUnitPrice").fill("3800");
  await t.page.locator("#save").click();
  await t.page.waitForSelector("#list .tm-card");
  check((await t.page.locator("#list").innerText()).includes("時給 4,500円"), "登録：一覧に出る");
  check(rows("gw_site_contract_terms")[0].sales_unit_price === 4500 && rows("gw_site_contract_terms")[0].purchase_unit_price === 3800, "売上単価・仕入単価を別々に保存");
  check(mem.rows.gw_site_contracts[0].unit_price === undefined, "既存の unit_price には触れない");

  // 重なる期間は断る
  await t.page.locator("#validFrom").fill("2026-10-01");
  await t.page.locator("#pricingType").selectOption("hourly");
  await t.page.locator("#salesUnitPrice").fill("4800");
  await t.page.locator("#save").click();
  await t.page.waitForSelector("#err:has-text('重なっています')");
  check(rows("gw_site_contract_terms").length === 1, "期間が重なる条件は登録されない");
  // 読めない入力
  await t.page.locator("#salesUnitPrice").fill("abc");
  await t.page.locator("#save").click();
  await t.page.waitForSelector("#err li");
  check((await t.page.locator("#err").innerText()).includes("売上単価"), "読めない入力は、理由が出る");
  // 月額：精算幅
  await t.page.locator("#cancel").click().catch(() => {});
  await t.page.locator("#validFrom").fill("2027-01-01");
  await t.page.locator("#pricingType").selectOption("monthly");
  check(await t.page.locator("#fsRange").isVisible() && await t.page.locator("#rowRange").isHidden(), "月額を選ぶと精算の欄が出る（精算幅の欄は、方法を選ぶまで隠れる）");
  await t.page.locator("#settlementMode").selectOption("range");
  check(await t.page.locator("#rowRange").isVisible() && await t.page.locator("#rowRates").isVisible(), "精算幅ありで、下限・上限・超過・控除の欄が出る");
  await t.page.locator("#validTo").fill("");
  await t.page.locator("#salesUnitPrice").fill("700000");
  await t.page.locator("#settleMinHours").fill("140"); await t.page.locator("#settleMaxHours").fill("180");
  await t.page.locator("#overRatePerHour").fill("4000"); await t.page.locator("#underRatePerHour").fill("3500");
  await t.page.locator("#validFrom").fill("2026-10-01"); await t.page.locator("#validTo").fill("");
  await t.page.locator("#save").click();
  await t.page.waitForSelector("#err:has-text('重なっています')");
  await t.page.locator("#validFrom").fill("2027-01-01");
  await t.page.locator("#save").click();
  await t.page.waitForFunction(() => document.querySelectorAll("#list .tm-card").length === 2);
  check((await t.page.locator("#list").innerText()).includes("月額 700,000円（140〜180h）"), "月額（精算幅あり）が登録できる");
  // 編集・削除
  await t.page.locator('[data-edit]').first().click();
  check((await t.page.locator("#formTitle").innerText()) === "条件を直す", "編集：フォームに読み込む");
  await t.page.locator("#cancel").click();
  await t.page.locator('[data-del]').first().click();                   // 新しい順：先頭は 2027-01-01 の月額
  await t.page.waitForFunction(() => document.querySelectorAll("#list .tm-card").length === 1);
  check(rows("gw_site_contract_terms").length === 1, "削除できる（確認のうえ）");
  await t.page.close();

  // 契約条件があれば、確定した勤務表から精算が出る
  const p2 = await open(TS);
  await p2.page.waitForSelector("#top");
  check((await p2.page.locator("#top").innerText()).includes("時給 4,500円"), "確定した勤務表に、契約条件が出る");
  check((await p2.page.locator("#top").innerText()).includes("108,000円"), "売上の精算：24h × 4,500円 = 108,000円");
  await p2.page.close();
}

console.log("\n=== 一覧（/office）：勤務表の状態・稼働時間・リンク ===");
{
  const NONE = { timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false };
  const marks = (m) => { const o = { ...NONE, ...m }; for (const k of Object.keys(NONE)) o[`${k}_at`] = o[k] ? "2026-09-30T01:00:00Z" : null; return o; };
  const raw = (id, name, m, sheet, extra = {}) => ({ siteContractId: id, progressId: null, employeeId: `e-${id}`, employeeName: name, department: null,
    employeeKind: "proper", partnerName: null, engagementKind: "pp", siteCompany: `顧客${id}社`, primeCompany: null, periodFrom: "2026-04-01", periodTo: null,
    renewalStatus: "confirmed", marks: marks(m), submissions: [], sheet, terms: { status: "ok", partial: false }, ...extra });
  const SH = (o) => ({ state: "confirmed", totalMinutes: 9750, workDays: 20, unresolved: 0, review: 0, warnings: [], ...o });
  const list = (month) => {
    const deadline = O.timesheetDeadline(month);
    const rs = [
      raw("A", "田中 太郎", { timesheet_received: true, work_confirmed: true }, SH(), { settle: { status: "calculated", amount: 731250, reasons: [] } }),
      raw("B", "鈴木 花子", { timesheet_received: true }, SH({ state: "draft", unresolved: 2, review: 1 })),
      raw("C", "佐藤 次郎", { timesheet_received: true }, SH({ state: "submitted", totalMinutes: null })),
      raw("D", "高橋 三郎", { timesheet_received: true, work_confirmed: true }, SH(), { settle: { status: "none", amount: null, reasons: ["この月に効く契約条件が登録されていません"] }, terms: { status: "none", partial: false } }),
    ].map((r) => O.deriveRow(r, { today: "2026-10-06", deadline }));
    return { month, today: "2026-10-06", deadline, rows: O.sortRows(rs), summary: O.summarize(rs), stages: O.STAGES, filters: O.FILTERS, phase3: { ready: true } };
  };
  const { page, errs } = await open("/office/index.html?month=2026-09", { list });
  await page.waitForSelector("#rows tr[data-id]");
  const tr = (n) => page.locator(`#rows tr:has-text("${n}")`);
  check((await tr("田中 太郎").locator('[data-label="稼働時間"]').innerText()).includes("162.5h") && (await tr("田中 太郎").locator('[data-label="稼働時間"]').innerText()).includes("確認済"), "確定済み：稼働時間 162.5h・確認済");
  check((await tr("鈴木 花子").locator('[data-label="稼働時間"]').innerText()).includes("確認待ち") && (await tr("鈴木 花子").locator('[data-label="勤務表"]').innerText()).includes("確認待ち"), "下書き：確認待ち（時間は出さない）");
  check((await tr("佐藤 次郎").locator('[data-label="稼働時間"]').innerText()).includes("未読取"), "ファイルだけ届いた：未読取");
  check((await tr("鈴木 花子").locator('[data-label="要対応"]').innerText()).includes("入力が必要な日 2日"), "次にやること：入力が必要な日・要確認の日");
  const href = await tr("鈴木 花子").locator('a:has-text("勤務表を確認")').getAttribute("href");
  check(href === `timesheet.html?contract=B&month=2026-09`, `勤務表の確認画面へのリンク（${href}）`);
  const today = await page.locator("#today button").allInnerTexts();
  check(today.some((t) => t.includes("稼働確認待ち") && t.includes("未読取 1件") && t.includes("確認待ち 1件")), "今日やること：稼働確認待ちの内訳（未読取・確認待ち）");
  check(today.some((t) => t.includes("契約条件の確認")), "今日やること：契約条件の確認");
  await page.locator('#today button:has-text("契約条件の確認")').click();
  check(await page.locator("#rows tr[data-id]").count() === 1, "契約条件の確認で絞り込める");
  await page.locator('#rows tr:has-text("高橋 三郎")').click();
  await page.waitForSelector(".of-drawer");
  const dr = await page.locator(".of-drawer").innerText();
  check(dr.includes("契約条件は、まだ登録されていません") && dr.includes("契約条件が未登録のため、計算できません"), "ドロワー：契約条件が未登録・精算できない理由");
  check(await page.locator('.of-drawer a[href^="terms.html?contract=D"]').count() === 1 && await page.locator('.of-drawer a[href^="timesheet.html?contract=D"]').count() === 1, "ドロワーから、契約条件・勤務表の画面へ");
  await page.keyboard.press("Escape");
  await page.locator("#reset").click();
  await tr("田中 太郎").click();
  await page.waitForSelector(".of-drawer");
  check((await page.locator(".of-drawer").innerText()).includes("731,250円"), "ドロワー：確定済みの行は、売上の精算を出す");
  check(errs.length === 0, `ブラウザのエラーが無い ${errs.join(" / ")}`);
  await page.close();

  // Phase 3 が未適用なら、案内を出し、従来の表示のまま
  const legacy = await open("/office/index.html?month=2026-09", { list: (m) => ({ ...list(m), phase3: { ready: false, message: "管理者に db/101 の実行を依頼してください" } }) });
  await legacy.page.waitForSelector("#rows tr[data-id]");
  check((await legacy.page.locator("#banner").innerText()).includes("db/101"), "未適用なら、理由を出す");
  check(await legacy.page.locator('a:has-text("勤務表を確認・確定")').count() === 0, "未適用なら、勤務表の確認へのリンクは出さない");
  await legacy.page.close();
}

console.log("\n=== 権限・引数 ===");
{
  seed();
  const a = await open(TS, { access: { office: false } });
  await a.page.waitForURL(/home\.html/);
  check(true, "Office 権限が無ければ home.html へ");
  await a.page.close();
  const b = await open("/office/timesheet.html");
  await b.page.waitForSelector("#banner .of-banner.err");
  check((await b.page.locator("#banner").innerText()).includes("対象（現場契約・月）が指定されていません"), "対象の指定が無ければ、案内を出す");
  await b.page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
