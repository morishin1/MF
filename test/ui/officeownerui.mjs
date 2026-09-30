// 経営者（owner）が、二段階認証（MFA）なしで、Office に入れること。実際のブラウザで見る。
//
//   経営者でログイン（MFA は未登録・6桁の確認もしていない＝aal1）
//     → ヘッダーの「Office」をクリック
//     → /office が開く（マイページの MFA 登録へ飛ばされない）
//     → 対象月を 2026年10月 にすると、テスト案件（【Office Phase3 TEST】）が1行出る
//     → 勤務表の画面（/office/timesheet.html）も開く
//
// ■ 何を通しているか
//   ブラウザの通信は、本物の api/office/{index,timesheet,file,terms}.js のハンドラにつなぐ（DB は偽：test/_memdb.mjs）。
//   DB の中身は、db/office_phase3_test_seed.sql が本番に作る4行と同じ値（要員・現場契約・契約条件・月次進捗）。
//   /api/me は「MFA が要る対象・未登録・強制日を過ぎている」経営者を返す（実際には、MFA を促す帯が出るだけで、Office は止まらない）。
//
// ■ 守ること（2026-09-30 の決定：Office は MFA を要求しない）
//   ・/api/office* の応答は、どれも 403 mfa_required にならない（200）
//   ・URL が /mypage.html#mfa に変わらない
//   ・権限（access.office）が無い人は、MFA の有無にかかわらず、Office に入れない（home.html へ）
import "../_officeharness.mjs";
import { mem, ctl, ai, call, atRoot, OWNER, uid, T1 } from "../_officeharness.mjs";
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { default: fileApi } = await import(atRoot("api/office/file.js"));
const { default: termsApi } = await import(atRoot("api/office/terms.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const TAG = "【Office Phase3 TEST】";
const EMP = "e13db73f-3d85-45ca-ac0a-7f26a5d53610";
const CON = "3688ccc1-bf24-4fcd-81fa-50e4a2086c7b";
const TERMS = "73c4e190-160b-4ea9-b697-f7afe7a26b45";
const PROG = "d309c095-8c2a-4a21-b713-ba43acd61698";

function seed() {
  mem.reset();
  // MFA を登録していない・6桁の確認もしていない経営者
  ctl.who = { ...OWNER, factors: [] }; ctl.aal = "aal1"; ai.reply = null; ai.calls.length = 0;
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
    { id: PROG, tenant_id: T1, employee_id: EMP, site_contract_id: CON, billing_month: "2026-10", note: `${TAG}Office の操作確認用`,
      timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
  ];
}

const seen = [];        // 画面が呼んだ /api/office* の応答（パス・状態・エラー）
async function open(url, { access = { recruit: true, sell: true, office: true }, roles = ["owner"] } = {}) {
  const page = await br.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|storage\.example/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@8grp.co.jp" })); });
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const u = new URL(req.url());
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      // 経営者。MFA の対象で、未登録で、強制日（2026-10-01）を過ぎている。登録を促す帯は出るが、Office は止まらない
      return send({
        email: "owner@8grp.co.jp", appRole: "owner", isAdmin: false, shows: {}, roles: [], access,
        mfa: { required: true, enrolled: false, verified: false, enforced: true, enrollUntil: "2026-09-30", enforceFrom: "2026-10-01", blocked: true },
        gw: { employee: { id: "e-owner", display_name: "経営 一郎", status: "active" }, roles, isAdmin: false, tenantId: "t1", stage: null },
      });
    }
    const h = { "/api/office": indexApi, "/api/office/timesheet": sheetApi, "/api/office/file": fileApi, "/api/office/terms": termsApi }[u.pathname];
    if (h) {
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const r = await call(h, u.pathname + u.search, { method: req.method(), body });
      seen.push({ path: u.pathname + u.search, status: r.statusCode, error: r.body?.error || null });
      return route.fulfill({ status: r.statusCode, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (u.pathname.startsWith("/api/notifications")) return send({ notifications: [], unread: 0 });
    if (u.pathname.startsWith("/api/badges")) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  return { page, errs };
}

console.log("\n=== 経営者（MFA 未登録・aal1）：Office をクリック → /office → 2026-10 のテスト案件 ===");
{
  seed();
  const { page, errs } = await open("/admin-dashboard.html");
  await page.waitForSelector(".topbar [data-shortcut='office']");
  check(true, "ダッシュボードのヘッダーに「Office」が出ている（access.office のとおり）");
  check(await page.locator(".kp-mfa-nudge").count() === 1, "MFA の登録を促す帯は出ている（案内だけ。Office を止めない）");

  // Office をクリック
  await Promise.all([page.waitForURL(/\/office\/?(index\.html)?(\?.*)?$/), page.click(".topbar [data-shortcut='office']")]);
  check(new URL(page.url()).pathname.startsWith("/office"), `クリックで /office が開く（いま ${new URL(page.url()).pathname}）`);
  errs.length = 0;      // ここまでは開始地点（ダッシュボード。疑似 API は空を返すだけ）。Office に入ってからのエラーを見る
  const shown = await page.waitForSelector("#month", { timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(600);
  check(!/mypage\.html/.test(page.url()), `マイページの MFA 登録へは飛ばされない（いま ${new URL(page.url()).pathname}${new URL(page.url()).hash}）`);
  check(shown, `Office の画面が表示される。応答：${seen.map((s) => `${s.status}${s.error ? " " + s.error : ""}`).join(", ")}`);
  if (!shown) { await page.close(); throw new Error("Office が開かないので、以降は見られません"); }

  // 対象月を 2026年10月 にする（画面の「次の月」／「前の月」）
  for (let i = 0; i < 6 && (await page.inputValue("#month")) !== "2026-10"; i++) {
    const cur = await page.inputValue("#month");
    await page.click(cur < "2026-10" ? "#next" : "#prev");
    await page.waitForTimeout(500);
  }
  check((await page.inputValue("#month")) === "2026-10", "対象月を 2026年10月 にできる");
  await page.waitForSelector("#rows tr[data-id]");
  const rows = await page.locator("#rows tr[data-id]").evaluateAll((t) => t.map((r) => ({
    name: r.querySelector('[data-label="要員"] .of-nm')?.textContent,
    client: r.querySelector('[data-label="客先"] .of-nm')?.textContent,
    stage: r.querySelector('[data-label="現在工程"]')?.textContent.trim(),
  })));
  check(rows.length === 1, `2026-10 の一覧に1行（いま ${rows.length}行）`);
  check(rows[0]?.name === `${TAG}テスト 太郎`, `要員：${rows[0]?.name}`);
  check(rows[0]?.client === `株式会社テスト${TAG}`, `客先：${rows[0]?.client}`);
  check(/勤務表待ち/.test(rows[0]?.stage || ""), `現在工程：${rows[0]?.stage}`);
  await page.screenshot({ path: shotPath("office-owner-no-mfa-list.png") });

  // 9月には出ない（契約は 10/1 から）
  await page.click("#prev");
  await page.waitForTimeout(600);
  check((await page.inputValue("#month")) === "2026-09" && await page.locator("#rows tr[data-id]").count() === 0, "2026年9月には出ない（契約は 10/1 から）");

  // 応答：すべて 200。403 mfa_required は1つも無い
  const office = seen.filter((s) => s.path.startsWith("/api/office"));
  check(office.length >= 2, `Office の API を呼んだ（${office.length}回。月が替わる日でも通るよう、2回以上）`);
  check(office.every((s) => s.status === 200), `Office の API の応答が、すべて 200（${office.map((s) => s.status).join(",")}）`);
  check(!seen.some((s) => s.error === "mfa_required" || s.status === 403), "403・mfa_required は1つも無い");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.close();
}

console.log("\n=== 経営者（MFA 未登録・aal1）：勤務表の画面も開く ===");
{
  seed(); seen.length = 0;
  const { page, errs } = await open(`/office/timesheet.html?contract=${CON}&month=2026-10`);
  await page.waitForSelector("#files, .of-hd, h1", { timeout: 8000 });
  await page.waitForTimeout(800);
  check(new URL(page.url()).pathname === "/office/timesheet.html", "/office/timesheet.html のまま（MFA 登録へ飛ばされない）");
  const t = await page.locator("body").innerText();
  check(t.includes(`${TAG}テスト 太郎`) && t.includes(`株式会社テスト${TAG}`), "要員・客先が出る");
  check(seen.length >= 1 && seen.every((s) => s.status === 200), `勤務表の API の応答が、すべて 200（${seen.map((s) => s.status).join(",")}）`);
  check(errs.length === 0, `画面のエラーなし ${errs.join(" | ").slice(0, 200)}`);
  await page.screenshot({ path: shotPath("office-owner-no-mfa-sheet.png") });
  await page.close();
}

console.log("\n=== 権限（access.office）が無い人は、MFA の有無にかかわらず入れない ===");
{
  seed(); seen.length = 0;
  const { page } = await open("/office/index.html?month=2026-10", { access: { recruit: true, sell: false, office: false }, roles: ["hr"] });
  await page.waitForTimeout(1200);
  check(/home\.html/.test(page.url()), `権限が無い人は home.html へ送られる（いま ${new URL(page.url()).pathname}）`);
  check(!/mypage\.html/.test(page.url()), "MFA の登録画面へは誘導しない");
  check(seen.length === 0, "その人のために、Office の API は呼ばない");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
