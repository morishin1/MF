// Office 定例業務：Excel 年間予定表を「最新版として同期」（lib/office-excel-sync.js・api/office-tasks/recurring.js の sync_preview / sync_commit・db/128）。
//
// ■ 何を守るテストか（指示書のテスト 1〜11。12＝スマホは test/ui/officesyncui.mjs）
//   1. 初回：Excel 180件・DB 0件 → 新規180
//   2. 同じ Excel をもう1回 → 新規0・更新0・停止0・変更なし180（重複しない）
//   3. 1件追加 → 新規1
//   4. 1件削除 → 停止1（消さない。is_active=false）。今日以降の未完了の予定は消える。過去・完了・今回なしは残る
//   5. 停止した1件を戻す → 再有効化1
//   6. 日付変更（5日→6日）→ 更新1（新規にならない）。今日以降の未完了の予定は6日で作り直す
//   7. 業務名の微修正（給与振込確認 → 給与振込の確認）→ 更新（新規＋停止にしない）。自信がなければ要確認（人が選ぶまで同期しない）
//   8. 手動のマスター：Excel に無くても停止しない。似た名前でも触らない
//   9. 完了済みの予定：マスターを更新しても残る
//   10. 未来の未完了の予定：最新のルールで作り直す
//   11. 権限：経理しか直せない業務を、権限のない人は同期できない（権限不足として残す）
//   12. 基準日の変更で同じ期に2件にしない（Excel 同期だけ）：その月（毎年はその年）に完了・今回なしの回があれば、新しい日の回を作らない。
//       翌月（翌年）からは新しいルール。未完了の回は作り直して1件だけ。手動でマスターを直したときの動きは変えない
//   ほか：Excel が持たない項目（担当・優先度・URL・備考）を空欄に戻さない／プレビューのあとで変わったら 409／
//        同時に2つは走らせない／監査ログ／期をシート名から出す・2026年を決め打ちしない／最終同期が一覧で分かる／db/128 が無ければ 503
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const T1 = "00000000-0000-4000-8000-000000000001";
const TODAY = "2026-10-08";

const R = await import(atRoot("lib/office-recurring.js"));
const S = await import(atRoot("lib/office-excel-sync.js"));
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

// ---- 材料：年間予定表のセル（2026年9月〜2027年8月。架空の業務名） ----------------------------------
const SHEETS = Array.from({ length: 12 }, (_, i) => { const m = ((8 + i) % 12) + 1, y = m >= 9 ? 2026 : 2027; return { name: `${y}${String(m).padStart(2, "0")}月`, m }; });
const COLS = ["C", "G", "M", "N", "O", "P", "Q"];
/** 毎月110件・毎年70件（合わせて180件）。over で文言・日を差し替え、drop で消す、add で足す */
function book({ over = {}, drop = [], add = [] } = {}) {
  const items = [];
  for (let i = 0; i < 110; i++) items.push({ id: `m${i}`, col: COLS[i % 7], text: `月次作業${String(i).padStart(3, "0")}`, day: (i % 27) + 1, months: "all" });
  for (let i = 0; i < 70; i++) items.push({ id: `y${i}`, col: COLS[i % 7], text: `年末調整の手続き${String(i).padStart(3, "0")}`, day: (i % 27) + 1, months: [((i % 12) + 1)] });
  items.push(...add);
  const cells = [];
  for (const it0 of items) {
    if (drop.includes(it0.id)) continue;
    const it = { ...it0, ...(over[it0.id] || {}) };
    for (const s of SHEETS) {
      if (it.months !== "all" && !it.months.includes(s.m)) continue;
      cells.push({ sheet: s.name, header: `${s.m}月度`, row: 4 + it.day, day: it.day, col: it.col, text: `・${it.text}` });
    }
  }
  return cells;
}
const classify = (cells) => R.classifyExcel(cells, { periodStart: "2026-09" }).rows;
const PERMS_ALL = { hr: true, fin: true, app: true, admin: false };
const PERMS_HR = { hr: true, fin: false, app: false, admin: false };
let seq = 0;
/** 計画どおりにマスターを作った・直したとみなす（lib だけのテスト用） */
function apply(masters, plan) {
  const out = masters.map((m) => ({ ...m }));
  for (const x of plan.ops.inserts) out.push({ id: `id${++seq}`, tenant_id: T1, source: "excel", source_key: x.key, is_active: true, updated_at: "t", ...x.value });
  for (const u of plan.ops.updates) Object.assign(out.find((m) => m.id === u.id), u.set);
  for (const st of plan.ops.stops) out.find((m) => m.id === st.id).is_active = false;
  return out;
}

console.log("\n=== 同期の計画（lib） ===\n");

let base = [];
await ok("1. 初回：Excel 180件・DB 0件 → 新規180", async () => {
  const rows = classify(book());
  assert.equal(rows.length, 180);
  const p = S.planSync({ excelRows: rows, masters: [], perms: PERMS_ALL });
  assert.deepEqual(p.summary, { new: 180, update: 0, unchanged: 0, stop: 0, reactivate: 0, review: 0, forbidden: 0, total: 180 });
  base = apply([], p);
  assert.equal(base.length, 180);
});

await ok("2. 同じ Excel をもう1回 → 変更なし180（新規・更新・停止0。重複しない）", async () => {
  const p = S.planSync({ excelRows: classify(book()), masters: base, perms: PERMS_ALL });
  assert.deepEqual([p.summary.new, p.summary.update, p.summary.stop, p.summary.unchanged], [0, 0, 0, 180]);
  assert.equal(p.ops.inserts.length + p.ops.updates.length + p.ops.stops.length, 0, "何も変えない");
});

await ok("3. 1件追加 → 新規1", async () => {
  const p = S.planSync({ excelRows: classify(book({ add: [{ id: "n1", col: "Q", text: "新しい月次の確認", day: 12, months: "all" }] })), masters: base, perms: PERMS_ALL });
  assert.deepEqual([p.summary.new, p.summary.update, p.summary.stop, p.summary.unchanged], [1, 0, 0, 180]);
  assert.equal(p.rows.find((r) => r.action === "new").title, "新しい月次の確認");
});

let stopped = [];
await ok("4. 1件削除 → 停止1（停止予定。理由つき）", async () => {
  const p = S.planSync({ excelRows: classify(book({ drop: ["m5"] })), masters: base, perms: PERMS_ALL });
  assert.deepEqual([p.summary.new, p.summary.update, p.summary.stop, p.summary.unchanged], [0, 0, 1, 179]);
  const st = p.rows.find((r) => r.action === "stop");
  assert.equal(st.title, "月次作業005");
  assert.match(st.reason, /今回の Excel にはありません/);
  assert.match(st.reason, /過去の履歴は残ります/);
  stopped = apply(base, p);
  assert.equal(stopped.find((m) => m.title === "月次作業005").is_active, false, "消さずに停止");
  assert.equal(stopped.length, 180);
});

await ok("5. 停止した1件を Excel に戻す → 再有効化1", async () => {
  const p = S.planSync({ excelRows: classify(book()), masters: stopped, perms: PERMS_ALL });
  assert.deepEqual([p.summary.new, p.summary.reactivate, p.summary.stop, p.summary.unchanged], [0, 1, 0, 179]);
  assert.equal(p.ops.updates[0].set.is_active, true);
});

await ok("6. 日付変更（5日→6日）→ 更新1（新規にならない）", async () => {
  const p = S.planSync({ excelRows: classify(book({ over: { m4: { day: 6 } } })), masters: base, perms: PERMS_ALL });
  assert.deepEqual([p.summary.new, p.summary.update, p.summary.stop], [0, 1, 0]);
  const u = p.rows.find((r) => r.action === "update");
  assert.equal(u.title, "月次作業004");
  assert.deepEqual(u.changes.map((c) => [c.field, c.before?.day, c.after?.day]), [["recurrence_rule", 5, 6]]);
  assert.equal(u.changes[0].afterText, "毎月 6日");
});

await ok("7. 業務名の微修正 → 更新（同じ基準日・同じカテゴリ）。基準日も違えば要確認（選ぶまで同期しない）", async () => {
  const ms = [{ id: "k1", tenant_id: T1, source: "excel", source_key: "xl:Q|給与振込確認", is_active: true, title: "給与振込確認",
    category: "finance", recurrence_type: "monthly", recurrence_rule: { day: 25 }, updated_at: "t", assignee_employee_id: "e-fuji" }];
  const cells = (text, day) => SHEETS.map((s) => ({ sheet: s.name, header: "", row: 30, day, col: "Q", text }));
  const p = S.planSync({ excelRows: classify(cells("給与振込の確認", 25)), masters: ms, perms: PERMS_ALL });
  assert.deepEqual([p.summary.new, p.summary.update, p.summary.stop, p.summary.review], [0, 1, 0, 0], JSON.stringify(p.summary));
  assert.equal(p.rows[0].id, "k1");
  assert.deepEqual(p.rows[0].changes.map((c) => c.field), ["title"]);
  assert.equal(p.ops.updates[0].set.source_key, "xl:Q|給与振込の確認", "次からはキーで一致する");
  assert.equal(p.ops.updates[0].set.assignee_employee_id, undefined, "担当は送らない（そのまま）");
  // 名前も日も変わった → 要確認。決めるまで停止も新規もしない
  const q = S.planSync({ excelRows: classify(cells("給与振込の最終確認", 26)), masters: ms, perms: PERMS_ALL });
  assert.deepEqual([q.summary.new, q.summary.update, q.summary.stop, q.summary.review], [0, 0, 0, 1], JSON.stringify(q.summary));
  assert.equal(q.rows[0].candidate.title, "給与振込確認");
  assert.equal(q.ops.inserts.length + q.ops.updates.length + q.ops.stops.length, 0);
  const link = S.planSync({ excelRows: classify(cells("給与振込の最終確認", 26)), masters: ms, perms: PERMS_ALL, decisions: { "xl:Q|給与振込の最終確認": "link" } });
  assert.deepEqual([link.summary.update, link.summary.new, link.summary.stop], [1, 0, 0], "同じ業務として更新");
  const sep = S.planSync({ excelRows: classify(cells("給与振込の最終確認", 26)), masters: ms, perms: PERMS_ALL, decisions: { "xl:Q|給与振込の最終確認": "separate" } });
  assert.deepEqual([sep.summary.update, sep.summary.new, sep.summary.stop], [0, 1, 1], "別の業務：新規＋前のものは停止");
  // まったく違う名前なら、ただの新規＋停止
  const far = S.planSync({ excelRows: classify(cells("社内報の配信", 25)), masters: ms, perms: PERMS_ALL });
  assert.deepEqual([far.summary.new, far.summary.stop, far.summary.review], [1, 1, 0]);
});

await ok("8. 手動のマスターは比べない（Excel に無くても停止しない・同じ名前でも更新しない）", async () => {
  const manual = { id: "man1", tenant_id: T1, source: "manual", source_key: null, is_active: true, title: "月次作業000", category: "all",
    recurrence_type: "monthly", recurrence_rule: { day: 1 }, updated_at: "t" };
  const p = S.planSync({ excelRows: classify(book({ drop: ["m0"] })), masters: [...base, manual], perms: PERMS_ALL });
  assert.ok(!p.rows.some((r) => r.id === "man1"), "手動は行に出ない");
  assert.ok(!p.ops.stops.some((x) => x.id === "man1") && !p.ops.updates.some((x) => x.id === "man1"));
  assert.equal(p.summary.stop, 1, "止まるのは Excel 由来の m0 だけ");
});

await ok("11. 権限：経理しか直せない業務は、人事だけの人には「権限不足」（同期しない・停止もしない）", async () => {
  const p = S.planSync({ excelRows: classify(book({ drop: ["m6"], over: { m13: { day: 20 } } })), masters: base, perms: PERMS_HR });
  // m6 は Q列（経理）、m13 も Q列（経理）
  const st = p.rows.find((r) => r.action === "stop"), up = p.rows.find((r) => r.action === "update");
  assert.ok(st.forbidden && up.forbidden);
  assert.equal(p.ops.stops.length + p.ops.updates.length, 0);
  assert.equal(p.summary.forbidden, 2);
  assert.ok(p.rows.filter((r) => r.category === "finance").every((r) => r.title === "（見る権限のないカテゴリの業務）"), "見られないカテゴリは名前を伏せる");
});

await ok("期：シート名から出す・表示・期の外のシート（2026年を決め打ちしない）", async () => {
  assert.equal(S.periodFromSheets(["使い方", "202609月", "202610月", "202708月", "前年度_単発除外参考"]), "2026-09");
  assert.equal(S.periodFromSheets(["202709月", "202808月"]), "2027-09");
  assert.equal(S.periodLabel("2026-09"), "2026年9月〜2027年8月");
  assert.equal(S.periodLabel("2027-09"), "2027年9月〜2028年8月");
  assert.deepEqual(S.sheetsOutOfPeriod(["202608月", "202609月", "202708月", "202709月"], "2026-09"), ["202608月", "202709月"]);
  assert.equal(S.similarity("給与振込確認", "給与振込の確認"), 1, "「の」を除くと同じ");
});

await ok("期の判定（lib）：毎月はその月・毎年はその年。donePeriods に入っている期は作らない", async () => {
  const m = { id: "a", tenant_id: T1, title: "x", category: "finance", recurrence_type: "monthly", recurrence_rule: { day: 6 }, start_on: "2026-01-01", is_active: true, due_rule: { type: "same" } };
  assert.equal(R.periodKeyOf(m, "2026-11-06"), "2026-11");
  assert.equal(R.periodKeyOf({ ...m, recurrence_type: "yearly" }, "2026-11-06"), "2026");
  assert.equal(R.periodKeyOf({ ...m, recurrence_type: "weekly" }, "2026-11-06"), null);
  const rows = R.planGeneration([m], new Set(), { from: "2026-10-08", to: "2026-12-31" }, { donePeriods: new Set(["a|2026-11"]) });
  assert.deepEqual(rows.map((r) => r.event_date), ["2026-12-06"]);
  assert.deepEqual(R.planGeneration([m], new Set(), { from: "2026-10-08", to: "2026-12-31" }).map((r) => r.event_date), ["2026-11-06", "2026-12-06"], "指定しなければ従来どおり");
});

await ok("かっこ書きだけの文言どうしが同じキーにならない", async () => {
  const cells = ["（健康診断の回収期限）", "（賞与アンケートの回収）"].map((text, i) => ({ sheet: "202611月", header: "", row: 10 + i, day: 10 + i, col: "C", text: `${text}` }));
  const keys = R.classifyExcel(cells, { periodStart: "2026-09" }).rows.map((r) => r.key);
  assert.equal(new Set(keys).size, 2, keys.join(" / "));
});

console.log("\n=== API（sync_preview / sync_commit） ===\n");

const mem = createMemDb({
  schema: {
    gw_office_recurring_tasks: {
      defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_key: null, is_active: true,
        priority: "normal", assignee_employee_id: null, note: null, url: null, department: null, description: null, end_on: null, due_rule: { type: "same" } }),
      unique: [["tenant_id", "source_key"]],
    },
    gw_office_calendar_events: {
      defaults: () => ({ created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source_id: null, completed_at: null }),
      unique: [["recurring_task_id", "event_date"], ["tenant_id", "source_id"]],
    },
    gw_office_excel_syncs: {
      defaults: () => ({ created_at: new Date().toISOString(), committed_at: null, lock_key: null, error_detail: null }),
      unique: [["tenant_id", "lock_key"]],
      check: (r) => ((r.status === "applying") !== Boolean(r.lock_key) ? "lock" : (r.status === "committed") !== Boolean(r.committed_at) ? "done" : null),
    },
  },
});
const logged = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-me" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
let who = null;
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });
const REAL_TC = await import(atRoot("lib/timecard.js"));
mock.module(atRoot("lib/timecard.js"), { namedExports: { ...REAL_TC, jstDate: () => TODAY } });
const recApi = (await import(atRoot("api/office-tasks/recurring.js"))).default;
const res = () => { const r = { statusCode: 0 }; r.setHeader = () => {}; r.end = (b) => { r.body = JSON.parse(b); }; return r; };
const call = async (req) => { const r = res(); await recApi({ headers: {}, ...req }, r); return r; };
const rec = (body) => call({ method: "POST", url: "/api/office-tasks/recurring", body });
const ctxOf = ({ roles = [], apps = ["office"], isAdmin = false } = {}) =>
  ({ tenantId: T1, isAdmin, roles, apps, isHr: REAL_GW.isHrOf({ roles, apps }), employee: { id: "e-me", display_name: "経理 太郎" } });
const MGR = ctxOf({ roles: ["manager", "finance", "hr"] });
const HRONLY = ctxOf({ roles: ["hr"] });

function setup() {
  mem.reset(); logged.length = 0; mem.state.missing = null;
  mem.rows.gw_employees = [
    { id: "e-me", tenant_id: T1, display_name: "経理 太郎", status: "active" },
    { id: "e-fuji", tenant_id: T1, display_name: "藤本 花子", status: "active" },
  ];
  mem.rows.gw_office_recurring_tasks = [];
  mem.rows.gw_office_calendar_events = [];
  mem.rows.gw_office_excel_syncs = [];
}
const masters = () => mem.rows.gw_office_recurring_tasks;
const events = () => mem.rows.gw_office_calendar_events;
async function sync(cells, extra = {}) {
  const p = await rec({ action: "sync_preview", cells, ...extra });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  const c = await rec({ action: "sync_commit", cells, syncToken: p.body.syncToken, fileName: "年間予定表.xlsx", fileHash: "ab12", ...extra });
  return { p, c };
}

await ok("API 1・2：初回は新規180（予定もできる）→ 同じ Excel をもう1回は変更なし180。重複しない", async () => {
  setup(); who = MGR;
  const pv = await rec({ action: "sync_preview", cells: book() });
  assert.equal(masters().length + events().length + mem.rows.gw_office_excel_syncs.length, 0, "プレビューでは何も変えない");
  assert.equal(pv.body.syncToken.length, 32);
  const { p, c } = await sync(book());
  assert.equal(p.body.periodStart, "2026-09", "シート名から期を出す");
  assert.equal(p.body.periodLabel, "2026年9月〜2027年8月");
  assert.equal(p.body.summary.new, 180);
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.new, c.body.update, c.body.stop, c.body.unchanged], [180, 0, 0, 0]);
  assert.equal(masters().length, 180);
  assert.ok(masters().every((m) => m.source === "excel" && m.start_on === TODAY));
  assert.ok(events().length > 0, "今日から先の予定を作る");
  const before = events().length;
  const again = await sync(book());
  assert.deepEqual([again.p.body.summary.new, again.p.body.summary.update, again.p.body.summary.stop, again.p.body.summary.unchanged], [0, 0, 0, 180]);
  assert.equal(again.c.statusCode, 200);
  assert.equal(masters().length, 180, "重複しない");
  assert.equal(events().length, before, "予定も増えない");
  const st = mem.rows.gw_office_excel_syncs;
  assert.equal(st.length, 2);
  assert.ok(st.every((x) => x.status === "committed" && x.lock_key === null && x.committed_at));
  assert.deepEqual([st[0].period_start, st[0].new_count, st[0].original_filename], ["2026-09", 180, "年間予定表.xlsx"]);
  const log = logged.find((l) => l.action === "office.recurring.sync");
  assert.deepEqual([log.detail.periodStart, log.detail.new, log.detail.unchanged, typeof log.detail.batchId], ["2026-09", 180, 0, "string"], "監査ログ");
  const list = await call({ method: "GET", url: "/api/office-tasks/recurring" });
  assert.equal(list.body.sync.ready, true);
  assert.equal(list.body.sync.last.periodLabel, "2026年9月〜2027年8月", "最終同期の期");
  assert.ok(list.body.sync.last.committedAt, "最終同期の日時");
});

await ok("API 4・9・10：削除 → 停止（消さない）。今日以降の未完了は消え、過去・完了・今回なしは残る。担当・URL は残る", async () => {
  setup(); who = MGR;
  await sync(book());
  const m = masters().find((x) => x.title === "月次作業004");   // 毎月5日
  Object.assign(m, { assignee_employee_id: "e-fuji", priority: "high", url: "https://example.jp/a", note: "備考" });
  const mine = () => events().filter((e) => e.recurring_task_id === m.id);
  // 過去（完了）・今日以降の完了・今回なしを置く
  events().push({ id: "past", tenant_id: T1, recurring_task_id: m.id, title: m.title, category: m.category, event_date: "2026-09-05", status: "done", completed_at: "2026-09-05T01:00:00Z" });
  const fut = mine().find((e) => e.event_date === "2026-11-05");
  Object.assign(fut, { status: "done", completed_at: "2026-10-08T01:00:00Z" });
  const skip = mine().find((e) => e.event_date === "2026-12-05");
  skip.status = "skipped";
  // 4. Excel から消す → 停止
  const { c } = await sync(book({ drop: ["m4"] }));
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.stop, 1);
  assert.equal(masters().length, 180, "消さない");
  assert.equal(m.is_active, false);
  assert.deepEqual(mine().map((e) => `${e.event_date}:${e.status}`).sort(), ["2026-09-05:done", "2026-11-05:done", "2026-12-05:skipped"], "残るのは過去・完了・今回なしだけ");
  // 5. 戻す → 再有効化。担当・優先度・URL・備考は空欄に戻さない
  const back = await sync(book());
  assert.equal(back.c.body.reactivate, 1);
  assert.equal(m.is_active, true);
  assert.deepEqual([m.assignee_employee_id, m.priority, m.url, m.note], ["e-fuji", "high", "https://example.jp/a", "備考"]);
  assert.ok(mine().some((e) => e.event_date === "2027-01-05" && e.status === "pending"), "先の予定を作り直す");
  assert.equal(mine().filter((e) => e.event_date === "2026-11-05").length, 1, "完了の回は作り直さない");
});

await ok("API 6・10：日付変更（5日→6日）は更新。今日以降の未完了は6日で作り直し、完了済みは残る。担当はそのまま", async () => {
  setup(); who = MGR;
  await sync(book());
  const m = masters().find((x) => x.title === "月次作業004");
  m.assignee_employee_id = "e-fuji";
  const done = events().find((e) => e.recurring_task_id === m.id && e.event_date === "2026-11-05");
  Object.assign(done, { status: "done", completed_at: "2026-10-08T01:00:00Z" });
  const { p, c } = await sync(book({ over: { m4: { day: 6 } } }));
  assert.deepEqual([p.body.summary.update, p.body.summary.new, p.body.summary.stop], [1, 0, 0]);
  assert.equal(c.body.update, 1);
  assert.equal(masters().length, 180, "新規にならない");
  assert.deepEqual(m.recurrence_rule, { day: 6 });
  assert.equal(m.assignee_employee_id, "e-fuji", "担当を空欄に戻さない");
  const mine = events().filter((e) => e.recurring_task_id === m.id).map((e) => `${e.event_date}:${e.status}`).sort();
  assert.ok(mine.includes("2026-11-05:done"), "完了済みは残る");
  assert.ok(mine.includes("2026-12-06:pending") && !mine.includes("2026-12-05:pending"), `先の未完了は6日で作り直す（${mine.join(",")}）`);
});

// ---- 12. 基準日の変更で同じ期に2件にしない ----
const evOf = (id) => events().filter((e) => e.recurring_task_id === id).map((e) => `${e.event_date}:${e.status}`).sort();
const markAs = (id, date, status) => {
  const e = events().find((x) => x.recurring_task_id === id && x.event_date === date);
  if (!e) throw new Error(`予定がありません ${date}`);
  Object.assign(e, { status, completed_at: status === "done" ? "2026-10-08T01:00:00Z" : null });
};

await ok("12-1 毎月・完了：11/5 を完了 → 5日→6日。11月に6日を作らない。12月以降は6日", async () => {
  setup(); who = MGR;
  await sync(book());
  const m = masters().find((x) => x.title === "月次作業004");   // 毎月5日
  markAs(m.id, "2026-11-05", "done");
  const { c } = await sync(book({ over: { m4: { day: 6 } } }));
  assert.equal(c.body.update, 1);
  const got = evOf(m.id);
  assert.ok(got.includes("2026-11-05:done"), "完了は残す");
  assert.ok(!got.some((x) => x.startsWith("2026-11-06")), `11月に2件目を作らない（${got.join(",")}）`);
  assert.equal(got.filter((x) => x.startsWith("2026-11-")).length, 1);
  assert.ok(got.includes("2026-12-06:pending") && got.includes("2027-01-06:pending"), `翌月からは6日（${got.join(",")}）`);
  assert.ok(!got.some((x) => /^2026-12-05|^2027-01-05/.test(x)), "古い5日は残さない");
});

await ok("12-2 毎月・今回なし：11/5 を今回なし → 5日→6日。11月に6日を作らない", async () => {
  setup(); who = MGR;
  await sync(book());
  const m = masters().find((x) => x.title === "月次作業004");
  markAs(m.id, "2026-11-05", "skipped");
  await sync(book({ over: { m4: { day: 6 } } }));
  const got = evOf(m.id);
  assert.ok(got.includes("2026-11-05:skipped"), "今回なしは残す");
  assert.equal(got.filter((x) => x.startsWith("2026-11-")).length, 1, `11月は1件だけ（${got.join(",")}）`);
  assert.ok(got.includes("2026-12-06:pending"));
});

await ok("12-3 毎年・完了：今年分を完了 → 日付変更。同じ年に2件目を作らない。翌年は新しい日", async () => {
  setup(); who = MGR;
  // 毎年10月20日の業務（今日 10/8 から先90日に今年分が入る）
  const yearly = (day) => SHEETS.filter((x) => x.m === 10).map((s0) => ({ sheet: s0.name, header: "", row: 4 + day, day, col: "O", text: "・年末調整の準備" }));
  const cellsA = [...book(), ...yearly(20)], cellsB = [...book(), ...yearly(22)];
  await sync(cellsA);
  const m = masters().find((x) => x.title === "年末調整の準備");
  assert.equal(m.recurrence_type, "yearly");
  markAs(m.id, "2026-10-20", "done");
  const { c } = await sync(cellsB);
  assert.equal(c.body.update, 1);
  assert.deepEqual(m.recurrence_rule, { month: 10, day: 22 });
  const got = evOf(m.id);
  assert.deepEqual(got, ["2026-10-20:done"], `2026年に2件目（10/22）を作らない（${got.join(",")}）`);
  // 翌年は新しいルール（先の日付まで作って確かめる）
  const { generate } = await import(atRoot("lib/office-recurring-db.js"));
  await generate(mem.admin(), [m], { from: "2027-01-01", to: "2027-12-31" }, { preserveTerminalPeriod: true });
  assert.ok(evOf(m.id).includes("2027-10-22:pending"), `翌年は10/22（${evOf(m.id).join(",")}）`);
});

await ok("12-4 未完了のとき：旧5日が未完了 → 5日→6日。作り直して6日の1件だけ", async () => {
  setup(); who = MGR;
  await sync(book());
  const m = masters().find((x) => x.title === "月次作業004");
  assert.ok(evOf(m.id).includes("2026-11-05:pending"));
  await sync(book({ over: { m4: { day: 6 } } }));
  const nov = evOf(m.id).filter((x) => x.startsWith("2026-11-"));
  assert.deepEqual(nov, ["2026-11-06:pending"], `11月は6日の1件だけ（${nov.join(",")}）`);
});

await ok("12-5 手動でマスターを直したときの動きは変えない（期の判定は Excel 同期だけ）", async () => {
  setup(); who = MGR;
  const made = await rec({ action: "create", title: "手動の月次", category: "finance", recurrenceType: "monthly", recurrenceRule: { day: 5 } });
  const id = made.body.master.id;
  markAs(id, "2026-11-05", "done");
  await rec({ action: "update", id, title: "手動の月次", category: "finance", recurrenceType: "monthly", recurrenceRule: { day: 6 } });
  assert.ok(evOf(id).includes("2026-11-06:pending"), "手動の編集は従来どおり（#95 のまま）");
});

await ok("API 8：手動のマスターは、Excel に無くても停止しない・同じ名前でも変えない", async () => {
  setup(); who = MGR;
  const made = await rec({ action: "create", title: "月次作業000", category: "all", recurrenceType: "monthly", recurrenceRule: { day: 3 } });
  assert.equal(made.statusCode, 200);
  await sync(book({ drop: ["m0"] }));
  await sync(book({ drop: ["m0"] }));
  const man = masters().find((x) => x.source === "manual");
  assert.equal(man.is_active, true);
  assert.deepEqual(man.recurrence_rule, { day: 3 });
  assert.equal(masters().filter((x) => x.source === "excel").length, 179);
});

await ok("API 11：権限のない人は、そのカテゴリを同期できない（人事だけの人 → 経理の行は権限不足のまま）", async () => {
  setup(); who = MGR;
  await sync(book());
  who = HRONLY;
  const { p, c } = await sync(book({ drop: ["m6"] }));     // m6 は Q列（経理）
  assert.equal(p.body.summary.forbidden, 1);
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.stop, 0);
  assert.equal(masters().find((x) => x.source_key === "xl:Q|月次作業006").is_active, true, "経理の業務は止めない");
  assert.equal(c.body.skippedForbidden, 1);
});

await ok("プレビューのあとで Excel・定例業務が変わったら 409。要確認が残っていたら 400。担当は名簿の人だけ", async () => {
  setup(); who = MGR;
  const cells = book();
  const p = await rec({ action: "sync_preview", cells });
  const c = await rec({ action: "sync_commit", cells: book({ drop: ["m1"] }), syncToken: p.body.syncToken });
  assert.equal(c.statusCode, 409);
  assert.equal(masters().length, 0);
  assert.equal((await rec({ action: "sync_commit", cells, syncToken: "x" })).statusCode, 409);
  const bad = await rec({ action: "sync_commit", cells, syncToken: p.body.syncToken, assignees: { "xl:C|月次作業000": "e-unknown" } });
  assert.equal(bad.statusCode, 400);
  const good = await rec({ action: "sync_commit", cells, syncToken: p.body.syncToken, assignees: { "xl:C|月次作業000": "e-fuji" } });
  assert.equal(good.statusCode, 200);
  assert.equal(masters().find((x) => x.source_key === "xl:C|月次作業000").assignee_employee_id, "e-fuji", "新規に担当を付けられる");
  // 要確認
  const k = masters().find((x) => x.source_key === "xl:Q|月次作業006");
  const renamed = book({ over: { m6: { text: "月次作業006の最終確認", day: 20 } } });
  const q = await rec({ action: "sync_preview", cells: renamed });
  assert.equal(q.body.summary.review, 1, JSON.stringify(q.body.summary));
  const r1 = await rec({ action: "sync_commit", cells: renamed, syncToken: q.body.syncToken });
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.body.error, "undecided");
  const dec = { [q.body.rows.find((r) => r.action === "review").key]: "link" };
  const q2 = await rec({ action: "sync_preview", cells: renamed, decisions: dec });
  const r2 = await rec({ action: "sync_commit", cells: renamed, syncToken: q2.body.syncToken, decisions: dec });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(k.title, "月次作業006の最終確認", "同じマスターを更新");
  assert.equal(masters().length, 180);
});

await ok("同時に2つは走らせない（同期中は 409）。止まったままの古い同期は外して進める", async () => {
  setup(); who = MGR;
  mem.rows.gw_office_excel_syncs.push({ id: "busy", tenant_id: T1, period_start: "2026-09", status: "applying", lock_key: "sync", created_at: new Date().toISOString() });
  const { c } = await sync(book());
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, "busy");
  assert.equal(masters().length, 0);
  mem.rows.gw_office_excel_syncs[0].created_at = new Date(Date.now() - 3600000).toISOString();
  const again = await sync(book());
  assert.equal(again.c.statusCode, 200, JSON.stringify(again.c.body));
  assert.equal(mem.rows.gw_office_excel_syncs.find((x) => x.id === "busy").status, "failed");
});

await ok("途中で失敗したら、同期は「失敗」で鍵を外す（もう一度同期すると残りが入る）", async () => {
  setup(); who = MGR;
  const p = await rec({ action: "sync_preview", cells: book() });
  mem.state.missing = "gw_office_calendar_events";
  const c = await rec({ action: "sync_commit", cells: book(), syncToken: p.body.syncToken });
  mem.state.missing = null;
  assert.notEqual(c.statusCode, 200);
  const s = mem.rows.gw_office_excel_syncs[0];
  assert.deepEqual([s.status, s.lock_key], ["failed", null]);
  const again = await sync(book());
  assert.equal(again.c.statusCode, 200, JSON.stringify(again.c.body));
  assert.equal(masters().length, 180, "再実行しても重複しない");
});

await ok("db/128 が無いとき：一覧は動き（同期だけ ready=false）、確定は 503", async () => {
  setup(); who = MGR;
  mem.state.missing = "gw_office_excel_syncs";
  try {
    const list = await call({ method: "GET", url: "/api/office-tasks/recurring" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.sync.ready, false);
    assert.match(list.body.sync.hint, /128_office_excel_sync/);
    const p = await rec({ action: "sync_preview", cells: book() });
    assert.equal(p.statusCode, 200);
    assert.equal(p.body.ready, false);
    const c = await rec({ action: "sync_commit", cells: book(), syncToken: p.body.syncToken });
    assert.equal(c.statusCode, 503);
    assert.equal(masters().length, 0);
  } finally { mem.state.missing = null; }
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
