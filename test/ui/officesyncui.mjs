// Office 定例業務：「年間予定表を最新版として同期」を実際のブラウザで通す（/office/recurring.html）。
//
// ■ 何を守るテストか
//   画面に返す中身は、本物の api/office-tasks/recurring.js を偽の DB（test/_memdb.mjs）で動かして作る（手で書いた応答ではない）。
//   Excel は、このテストで作る年間予定表（2026年9月〜2027年8月の12シート＋使い方シート。架空の業務名）。
//   1. ファイルを選ぶと、シート名から期の始まり（2026-09）が入る。読み込んだだけでは何も変わらない
//   2. 差分の件数（新規・更新・変更なし・停止予定・合計）と、差分の一覧（状態・業務名・カテゴリ・現在・Excel最新版・変更内容・対応）
//   3. 確認ダイアログ（新規・更新・停止の件数と「手動登録した業務と過去の履歴は変更されません」）→ 同期 → 結果と最終同期
//   4. 2回目（1件消して日付も1件変える）：停止予定は「削除」ではなく「停止」と、理由を出す／更新は変更内容を出す。手動の業務は出ない
//   5. 要確認（業務名も日も変わった）：扱いを選ぶまで「最新版として同期する」を押せない
//   6. 390px：アップロード・差分の件数・差分の一覧・同期ボタンが操作でき、横にはみ出さない
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { launch, BASE } from "../_browser.mjs";
import { createMemDb } from "../_memdb.mjs";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const atRoot = (p) => join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001";
const TODAY = "2026-10-08";

const mem = createMemDb({ schema: {
  gw_office_recurring_tasks: { defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_key: null, is_active: true,
    priority: "normal", assignee_employee_id: null, note: null, url: null, department: null, description: null, end_on: null, due_rule: { type: "same" } }), unique: [["tenant_id", "source_key"]] },
  gw_office_calendar_events: { defaults: () => ({ created_at: new Date().toISOString(), source_id: null, completed_at: null }), unique: [["recurring_task_id", "event_date"], ["tenant_id", "source_id"]] },
  gw_office_excel_syncs: { defaults: () => ({ created_at: new Date().toISOString(), committed_at: null, lock_key: null }), unique: [["tenant_id", "lock_key"]] },
} });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-me" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
const GW = await import(atRoot("lib/gw.js"));
const CTX = { tenantId: T1, isAdmin: false, roles: ["manager", "finance", "hr"], apps: ["office"], isHr: true, employee: { id: "e-me", display_name: "経理 太郎" } };
mock.module(atRoot("lib/gw.js"), { namedExports: { ...GW, gwContext: async () => CTX } });
const TC = await import(atRoot("lib/timecard.js"));
mock.module(atRoot("lib/timecard.js"), { namedExports: { ...TC, jstDate: () => TODAY } });
const api = (await import(atRoot("api/office-tasks/recurring.js"))).default;
mem.reset();
Object.assign(mem.rows, {
  gw_employees: [{ id: "e-me", tenant_id: T1, display_name: "経理 太郎", status: "active" }, { id: "e-fuji", tenant_id: T1, display_name: "藤本 花子", status: "active" }],
  gw_office_recurring_tasks: [{ id: "man1", tenant_id: T1, title: "手動で作った業務", category: "finance", recurrence_type: "monthly", recurrence_rule: { day: 3 },
    start_on: "2026-10-01", is_active: true, source: "manual", source_key: null, priority: "normal", due_rule: { type: "same" }, updated_at: "2026-10-01T00:00:00Z" }],
  gw_office_calendar_events: [], gw_office_excel_syncs: [],
});
async function callApi(method, body) {
  const r = { statusCode: 0, setHeader() {}, end(b) { r.body = b; } };
  await api({ method, headers: {}, url: "/api/office-tasks/recurring", body }, r);
  return r;
}

// ---- 年間予定表（2026年9月〜2027年8月） ----
const SHEETS = Array.from({ length: 12 }, (_, i) => { const m = ((8 + i) % 12) + 1, y = m >= 9 ? 2026 : 2027; return { name: `${y}${String(m).padStart(2, "0")}月`, m }; });
const COLI = { C: 2, G: 6, M: 12, N: 13, O: 14, P: 15, Q: 16 };
function makeBook(items) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Office 定例業務 取り込み用（テスト）"], [], ["対象期間", "2026年9月〜2027年8月"]]), "使い方");
  for (const s of SHEETS) {
    const aoa = [["月間スケジュール管理表", "", "", "", "", "", "", `${s.m}月度`], [], [], ["日", "曜日", "全体"]];
    for (let d = 1; d <= 31; d++) aoa.push([d]);
    for (const it of items) {
      if (it.months !== "all" && !it.months.includes(s.m)) continue;
      const row = aoa[4 + it.day - 1];
      const ci = COLI[it.col];
      row[ci] = row[ci] ? `${row[ci]}\n・${it.text}` : `・${it.text}`;
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), s.name);
  }
  // 日本語のファイル名のまま渡す（この環境はパスに日本語を使えないので、中身で渡す）
  return { name: "年間予定表_2026.9〜2027.8_定例業務_最新版.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) };
}
const ITEMS = [
  { col: "Q", text: "給与振込確認", day: 25, months: "all" },
  { col: "Q", text: "月次の入金確認", day: 5, months: "all" },
  { col: "O", text: "勤怠の締め", day: 1, months: "all" },
  { col: "C", text: "会計資料の提出", day: 10, months: "all" },
  { col: "C", text: "年末調整の案内", day: 16, months: [10] },
];

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open(width) {
  const page = await br.newPage({ viewport: { width, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.clock.setFixedTime(new Date(`${TODAY}T03:00:00Z`));
  const errs = [], dialogs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await page.route("https://cdnjs.cloudflare.com/ajax/libs/xlsx/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(require.resolve("xlsx/dist/xlsx.full.min.js"), "utf8") }));
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "fin@example.jp" })); for (const k of ["kp_layout", "kp_me"]) localStorage.removeItem(k); });
  await page.route("**/api/**", async (r) => {
    const req = r.request(), u = new URL(req.url());
    const send = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: typeof b === "string" ? b : JSON.stringify(b) });
    if (u.pathname === "/api/me") {
      return send({ email: "fin@example.jp", appRole: "member", isAdmin: false, roles: [], memberships: [],
        gw: { employee: { id: "e-me", display_name: "経理 太郎", status: "active" }, roles: CTX.roles, tenantId: T1, stage: { key: "member", allowed: [] } },
        access: GW.accessOf({ isAdmin: false, roles: CTX.roles, apps: ["office"] }) });
    }
    if (u.pathname === "/api/office-tasks/recurring") {
      const out = await callApi(req.method(), req.method() === "POST" ? JSON.parse(req.postData() || "{}") : undefined);
      return send(out.body, out.statusCode);
    }
    if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/office/recurring.html`);
  await page.waitForSelector("#syncOpen:not([hidden])", { timeout: 8000 }).catch(() => {});
  return { page, errs, dialogs };
}
async function upload(page, file) {
  if (await page.locator("#syncBox").isHidden()) await page.click("#syncOpen");
  await page.setInputFiles("#syncFile", file);
  await page.waitForFunction(() => document.getElementById("syncPeriod").value !== "", null, { timeout: 5000 }).catch(() => {});
  const period = await page.inputValue("#syncPeriod");
  await page.click("#syncRead");
  await page.waitForSelector("#sySum", { timeout: 8000 }).catch(async () => { console.log("NG: 差分が出ない：", await page.locator("#syncMsg").innerText()); });
  return period;
}
const sum = async (page) => Object.fromEntries(await page.locator("#sySum [data-sum]").evaluateAll((ns) => ns.map((n) => [n.dataset.sum, Number(n.querySelector("b").textContent)])));

console.log("\n=== 1回目：初めての同期（1280px） ===");
{
  const { page, errs, dialogs } = await open(1280);
  check((await page.locator('[data-role="sync-info"]').innerText()).includes("まだ同期していません"), "上部：まだ同期していない");
  await page.click("#syncOpen");
  check((await page.locator("#syncBox").innerText()).includes("Excelに追加された業務は新規登録、変更された業務は更新、Excelから削除された業務は停止します"), "説明文");
  const period = await upload(page, makeBook(ITEMS));
  check(period === "2026-09", `シート名から期の始まり（${period}）`);
  check(mem.rows.gw_office_recurring_tasks.length === 1 && mem.rows.gw_office_excel_syncs.length === 0, "読み込んだだけでは何も変わらない");
  const s = await sum(page);
  check(s.new === 5 && s.update === 0 && s.unchanged === 0 && s.stop === 0 && s.total === 5, `差分の件数（${JSON.stringify(s)}）`);
  check((await page.locator("#syncResult h3").innerText()).includes("2026年9月〜2027年8月"), "期の表示");
  const row = page.locator('.sy-row[data-action="new"]', { hasText: "給与振込確認" });
  const rt = await row.innerText();
  check(["新規", "経理", "Excel最新版", "毎月 25日", "Excel に追加された業務", "担当"].every((x) => rt.includes(x)), `差分の一覧の列（${rt.replace(/\s+/g, " ")}）`);
  check(!(await page.locator("#syList").innerText()).includes("手動で作った業務"), "手動の業務は差分に出ない");
  await row.locator("select").selectOption("e-fuji");
  await page.click("#syncCommit");
  await page.waitForSelector('[data-role="sync-done"]', { timeout: 8000 });
  check(/新規：5件/.test(dialogs[0]) && /更新：0件/.test(dialogs[0]) && /停止：0件/.test(dialogs[0]) && /手動登録した業務と過去の履歴は変更されません/.test(dialogs[0]), "確認ダイアログ（件数と注意）");
  const done = await page.locator('[data-role="sync-done"]').innerText();
  check((await page.locator('[data-role="sync-info"]').innerText()).includes("年間予定表_2026.9〜2027.8_定例業務_最新版.xlsx"), "上部：最新版にしたファイル名（日本語）");
  check(done.includes("2026年9月〜2027年8月 の年間予定表を最新版として同期しました") && done.includes("新規 5件") && done.includes("Excel由来定例業務：5件") && /最終同期：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(done), `結果（${done.replace(/\s+/g, " ")}）`);
  check((await page.locator('[data-role="sync-info"]').innerText()).includes("Excel最新版　2026年9月〜2027年8月"), "上部：Excel最新版の期と最終同期");
  const kyu = mem.rows.gw_office_recurring_tasks.find((m) => m.title === "給与振込確認");
  check(kyu?.assignee_employee_id === "e-fuji", "新規に担当を付けられる");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 2回目：1件消す・日付を変える（停止は「停止」と理由） ===");
{
  const { page, errs, dialogs } = await open(1280);
  const items = ITEMS.filter((x) => x.text !== "勤怠の締め").map((x) => x.text === "月次の入金確認" ? { ...x, day: 6 } : x);
  await upload(page, makeBook(items));
  const s = await sum(page);
  check(s.new === 0 && s.update === 1 && s.unchanged === 3 && s.stop === 1 && s.total === 4, `差分の件数（${JSON.stringify(s)}）`);
  const st = await page.locator('.sy-row[data-action="stop"]').innerText();
  check(st.includes("停止予定") && st.includes("勤怠の締め") && st.includes("今回の Excel にはありません") && st.includes("過去の履歴は残ります") && !st.includes("削除します"), `停止予定の行（${st.replace(/\s+/g, " ")}）`);
  const up = await page.locator('.sy-row[data-action="update"]').innerText();
  check(up.includes("基準日：毎月 5日 → 毎月 6日"), `更新の変更内容（${up.replace(/\s+/g, " ")}）`);
  check(await page.locator('.sy-row[data-action="unchanged"]').count() === 0, "初めは変更がある行だけ");
  await page.click('[data-filter="unchanged"]');
  check(await page.locator('.sy-row[data-action="unchanged"]').count() === 3, "「変更なし」で変わらない行も見られる");
  await page.click("#syncCommit");
  await page.waitForSelector('[data-role="sync-done"]', { timeout: 8000 });
  check(/停止：1件/.test(dialogs[0]), "確認ダイアログに停止の件数");
  check(mem.rows.gw_office_recurring_tasks.find((m) => m.title === "勤怠の締め")?.is_active === false, "消さずに停止");
  check(mem.rows.gw_office_recurring_tasks.find((m) => m.source === "manual").is_active === true, "手動の業務は止まらない");
  check(mem.rows.gw_office_recurring_tasks.find((m) => m.title === "給与振込確認").assignee_employee_id === "e-fuji", "担当は空欄に戻らない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 3回目：要確認（業務名も日も変わった）・390px ===");
{
  const { page, errs } = await open(390);
  const items = ITEMS.filter((x) => x.text !== "勤怠の締め").map((x) => x.text === "月次の入金確認" ? { ...x, day: 6 } : x.text === "給与振込確認" ? { ...x, text: "給与振込の最終確認", day: 26 } : x);
  await upload(page, makeBook(items));
  const s = await sum(page);
  check(s.review === 1, `要確認 1件（${JSON.stringify(s)}）`);
  check(await page.locator("#syncCommit").isDisabled(), "扱いを選ぶまで同期できない");
  const rv = page.locator('.sy-row[data-action="review"]');
  check((await rv.innerText()).includes("給与振込確認") && (await rv.innerText()).includes("給与振込の最終確認"), "前の業務と Excel の業務を並べる");
  await rv.locator('input[value="link"]').check();
  await page.waitForFunction(() => !document.getElementById("syncCommit").disabled, null, { timeout: 5000 }).catch(() => {});
  check(!(await page.locator("#syncCommit").isDisabled()), "選ぶと同期できる");
  check((await sum(page)).update === 1, "「同じ業務として更新」で更新1");
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `390px：横にはみ出さない（${over}）`);
  for (const sel of ["#syncFile", "#syncRead", "#sySum", "#syList", "#syncCommit"]) {
    const b = await page.locator(sel).boundingBox();
    check(b && b.x >= 0 && b.x + b.width <= 391, `390px：${sel} が画面の中にある`);
  }
  await page.locator("#syncCommit").scrollIntoViewIfNeeded();
  await page.click("#syncCommit");
  await page.waitForSelector('[data-role="sync-done"]', { timeout: 8000 });
  const kyu = mem.rows.gw_office_recurring_tasks.find((m) => m.source_key === "xl:Q|給与振込の最終確認");
  check(kyu && kyu.title === "給与振込の最終確認" && kyu.assignee_employee_id === "e-fuji", "同じマスターを更新（担当はそのまま）");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
