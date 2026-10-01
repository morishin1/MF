// 経営ハブの集計（lib/keiei-hub.js）。DB に触れない純粋な判定だけ。
//
// ■ 何を守るのか
//   1. 4ブロックの形: ①今日の確認 ②人・組織 ③お金 ④リスク・未処理。Board は「未接続」の1表示だけ
//   2. 同じ事実を、2つのブロックに出さない（契約更新は14日以内→①、15〜45日→④。Blocker は経営判断待ち→①、長期→④）
//   3. 重要度の高い順（重要 → 注意 → 確認）
//   4. 読めなかった元データ（null）は、0件・問題なしにしない。unreadable に出し、その判定は出さない
//   5. 給与・手当の金額・単価は、どこにも出さない
//   6. 押した先（href）は、決めた元システムだけ
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildHub, buildSecurity, securityRisks, LINKS, SEVERITY, SEVERITY_LABEL,
  RENEWAL_TODAY_DAYS, RENEWAL_WATCH_DAYS, JOIN_NEAR_DAYS, JOIN_URGENT_DAYS, CLOSING_DUE_DAY, BILLING_STALE_DAY,
} from "../lib/keiei-hub.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TODAY = "2026-09-30";
const plus = (d) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const quiet = () => ({
  people: { total: 12, proper: 10, bp: 2 },
  expenses: { ownerWaiting: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, payable: { count: 0, amount: 0 } },
  requests: 0, applicants: [],
  onboarding: { inProgress: 0, company: 0, rows: [] },
  blockers: [], renewals: [], closing: { closed: true }, billing: [], journals: 0,
  owners: [{ name: "経営A", active: true, canLogin: true, mfa: "enrolled" }, { name: "経営B", active: true, canLogin: true, mfa: "enrolled" }],
});
const hub = (over = {}, today = TODAY) => buildHub({ today, facts: { ...quiet(), ...over } });
const keys = (list) => list.map((i) => i.key);

console.log("— 静か（何もない日）—");

ok("何もなければ、①も④も空。未読込も無い。Board は未接続の1表示", () => {
  const h = hub();
  assert.deepEqual(h.attention, []);
  assert.deepEqual(h.risks, []);
  assert.deepEqual(h.unreadable, []);
  assert.deepEqual(h.money.board, { status: "unlinked", message: "売上・請求は Board 連携後に表示します" });
  assert.deepEqual(h.summary, { attention: 0, risks: 0, high: 0 });
});

ok("Board のブロックは1つだけ。「データ未連携」の空カードを並べない", () => {
  const h = hub();
  assert.equal(JSON.stringify(h).includes("データ未連携"), false);
  assert.equal(Object.keys(h.money).join(), "board,internal");
  assert.deepEqual(h.money.internal.map((m) => m.key), ["expense_pending", "payable", "journals"]);
});

ok("②人・組織の5つ（在籍・入社予定・採用選考中・内定・入社準備未完了）", () => {
  assert.deepEqual(hub().people.tiles.map((t) => t.key), ["headcount", "joining", "recruiting", "offers", "onboarding_open"]);
});

console.log("\n— ①今日の確認 —");

ok("代表の承認待ち（経費・稟議）・社長判断待ち・会社の対応待ち・経営判断待ちのBlocker は ①（重要）", () => {
  const h = hub({
    expenses: { ownerWaiting: { count: 2, amount: 150000 }, pending: { count: 5, amount: 200000 }, payable: { count: 1, amount: 8000 } },
    requests: 1,
    applicants: [{ stage: "ceo_interview", status: "ceo_decision_pending" }],
    onboarding: { inProgress: 3, company: 2, rows: [] },
    blockers: [{ escalation_level: 2, blocked_since: plus(-4) }],
  });
  assert.deepEqual(keys(h.attention).sort(), ["blocker_owner", "ceo_decision", "expense_approval", "onboarding_company", "request_approval"]);
  assert.ok(h.attention.every((i) => i.block === "today" && i.severity === "high"));
  const exp = h.attention.find((i) => i.key === "expense_approval");
  assert.match(exp.detail, /2件が代表の承認待ち.*150,000円/);
  assert.equal(exp.href, "/admin-expenses.html");
  assert.match(h.attention.find((i) => i.key === "blocker_owner").detail, /最長5日/);
});

ok("代表の承認待ちが0件なら、項目そのものを出さない（0件の行を並べない）", () => {
  assert.deepEqual(hub().attention, []);
});

ok("「経費 承認待ち」の数字（③）は、管理部の承認待ちも含む全件。代表の分だけが①に出る", () => {
  const h = hub({ expenses: { ownerWaiting: { count: 1, amount: 60000 }, pending: { count: 4, amount: 100000 }, payable: { count: 0, amount: 0 } } });
  assert.equal(h.money.internal[0].value, 4);
  assert.match(h.attention[0].detail, /1件/);
});

console.log("\n— 同じ事実を2か所に出さない —");

ok("契約更新: 14日以内は①、15〜45日は④、46日以上と終了予定・更新済みは出ない", () => {
  const h = hub({ renewals: [
    { period_to: plus(RENEWAL_TODAY_DAYS), renewal_status: "pending" },
    { period_to: plus(RENEWAL_TODAY_DAYS + 1), renewal_status: "pending" },
    { period_to: plus(RENEWAL_WATCH_DAYS), renewal_status: "confirmed" },
    { period_to: plus(RENEWAL_WATCH_DAYS + 1), renewal_status: "pending" },
    { period_to: plus(5), renewal_status: "renewed" },
    { period_to: plus(5), renewal_status: "ending" },
    { period_to: plus(-3), renewal_status: "pending" },
    { period_to: null, renewal_status: "pending" },
  ] });
  assert.equal(h.attention.find((i) => i.key === "renewal_soon").count, 1);
  assert.equal(h.risks.find((i) => i.key === "renewal_watch").count, 2);
  assert.equal(h.attention.length + h.risks.length, 2);
});

ok("Blocker: 経営判断待ち（escalation 2）は①だけ。それ以外の長期（4日以上）は④だけ。3日以内は出ない", () => {
  const h = hub({ blockers: [
    { escalation_level: 2, blocked_since: plus(-10) },
    { escalation_level: 1, blocked_since: plus(-6) },
    { escalation_level: 0, blocked_since: plus(-3) },      // 4日目 → 長期
    { escalation_level: 0, blocked_since: plus(-2) },      // 3日目 → まだ
  ] });
  assert.equal(h.attention.find((i) => i.key === "blocker_owner").count, 1);
  assert.equal(h.risks.find((i) => i.key === "blocker_long").count, 2);
  assert.match(h.risks.find((i) => i.key === "blocker_long").detail, /最長7日/);
});

ok("どの key も、①と④の両方には出ない", () => {
  const h = hub({
    renewals: [{ period_to: plus(3), renewal_status: "pending" }, { period_to: plus(30), renewal_status: "pending" }],
    blockers: [{ escalation_level: 2, blocked_since: plus(-9) }, { escalation_level: 0, blocked_since: plus(-9) }],
  });
  const a = new Set(keys(h.attention));
  assert.ok(keys(h.risks).every((k) => !a.has(k)));
});

console.log("\n— ④リスク・未処理（重要度の高い順）—");

ok("入社日が近いのに準備未完了: 7日以内・過ぎている→重要、8〜14日→注意、完了済み・15日先・日付なしは出ない", () => {
  const rows = (arr) => ({ inProgress: arr.length, company: 0, rows: arr });
  const r = (name, d, complete = false) => ({ name, joinOn: d == null ? null : plus(d), daysToStart: d, complete });
  const urgent = hub({ onboarding: rows([r("佐藤", JOIN_URGENT_DAYS), r("田中", -2), r("済み", 1, true), r("先", JOIN_NEAR_DAYS + 1), r("未定", null)]) });
  const it = urgent.risks.find((i) => i.key === "join_near");
  assert.equal(it.severity, SEVERITY.HIGH);
  assert.equal(it.count, 2);
  assert.match(it.detail, /佐藤・田中/);
  const mid = hub({ onboarding: rows([r("鈴木", JOIN_URGENT_DAYS + 1)]) });
  assert.equal(mid.risks.find((i) => i.key === "join_near").severity, SEVERITY.MID);
});

ok("入社日が近い人の名前は3人まで。残りは「ほかN人」", () => {
  const rows = ["A", "B", "C", "D", "E"].map((n) => ({ name: n, joinOn: plus(2), daysToStart: 2, complete: false }));
  const it = hub({ onboarding: { inProgress: 5, company: 0, rows } }).risks[0];
  assert.match(it.detail, /A・B・C ほか2人/);
});

ok("月次締め: 前月が未締めなら①。5日までは注意、6日以降は重要。締まっていれば出ない", () => {
  const early = hub({ closing: { closed: false } }, "2026-10-03");
  assert.equal(early.attention[0].key, "closing");
  assert.equal(early.attention[0].severity, SEVERITY.MID);
  assert.match(early.attention[0].label, /2026年9月の月次締め/);
  const late = hub({ closing: { closed: false } }, `2026-10-0${CLOSING_DUE_DAY + 1}`);
  assert.equal(late.attention[0].severity, SEVERITY.HIGH);
  assert.deepEqual(hub({ closing: { closed: true } }).attention, []);
});

ok("請求進捗: 前月以前の未完了は常に、当月の未完了は10日を過ぎてから④（注意）。5段階済みは数えない", () => {
  const full = { timesheet_received: true, work_confirmed: true, board_created: true, sent: true, bp_invoice_received: true };
  const part = { timesheet_received: true };
  const rows = [{ billing_month: "2026-09", ...full }, { billing_month: "2026-08", ...part }, { billing_month: "2026-10", ...part }];
  // 10月5日: 9月分は5段階済み（数えない）、8月分は前月以前の未完了（数える）、10月分は当月で10日前（まだ数えない）
  const early = hub({ billing: rows }, "2026-10-05");
  assert.equal(early.risks.find((i) => i.key === "billing_stale").count, 1);
  assert.equal(early.risks.find((i) => i.key === "billing_stale").severity, SEVERITY.MID);
  // 10月11日: 当月の未完了も数える
  assert.equal(hub({ billing: rows }, "2026-10-11").risks.find((i) => i.key === "billing_stale").count, 2);
});

ok("請求進捗: 当月の行は BILLING_STALE_DAY を過ぎてから", () => {
  const part = { billing_month: "2026-10", timesheet_received: true };
  assert.equal(hub({ billing: [part] }, `2026-10-${String(BILLING_STALE_DAY).padStart(2, "0")}`).risks.length, 0);
  assert.equal(hub({ billing: [part] }, `2026-10-${BILLING_STALE_DAY + 1}`).risks.length, 1);
});

ok("採用の対応期限超過は④（注意）。終わった応募者は数えない", () => {
  const h = hub({ applicants: [
    { stage: "applied", status: "todo", decision_due_on: plus(-1) },
    { stage: "applied", status: "passed", decision_due_on: plus(-30) },
    { stage: "applied", status: "todo", decision_due_on: plus(3) },
  ] });
  assert.equal(h.risks.find((i) => i.key === "recruit_overdue").count, 1);
});

ok("経営者が1人だけなら、④（重要）で、押すと経営設定・セキュリティへ。二段階認証が未登録でも、警告にしない（任意）", () => {
  const h = hub({ owners: [{ name: "経営A", active: true, canLogin: true, mfa: "none" }] });
  assert.deepEqual(keys(h.risks), ["owner_single"], "二段階認証の未登録は、リスクに出ない");
  assert.ok(h.risks.every((i) => i.severity === "high" && i.href === "#security"));
  assert.ok(!JSON.stringify(h).includes("mfa_missing") && !/二段階認証が未登録/.test(JSON.stringify(h)), "未登録の警告が、どこにも出ない");
});

ok("経営者が2人いて、全員が二段階認証を未登録でも、警告なし（二段階認証は任意）", () => {
  const h = hub({ owners: [{ name: "経営A", active: true, canLogin: true, mfa: "none" }, { name: "経営B", active: true, canLogin: true, mfa: "none" }] });
  assert.deepEqual(h.risks, []);
  assert.deepEqual(h.unreadable, []);
});

ok("経営者が2人いて全員登録済みなら、警告なし。退職・ログインできない経営者は、人数に数えない", () => {
  assert.deepEqual(hub().risks, []);
  const h = hub({ owners: [
    { name: "経営A", active: true, canLogin: true, mfa: "enrolled" },
    { name: "退職した経営者", active: false, canLogin: true, mfa: "enrolled" },
    { name: "未連携の経営者", active: true, canLogin: false, mfa: "unknown" },
  ] });
  assert.deepEqual(keys(h.risks), ["owner_single"], "実際に入れる経営者は1人");
});

ok("重要度の順（重要→注意→確認）。同じなら出した順", () => {
  const h = hub({
    renewals: [{ period_to: plus(30), renewal_status: "pending" }],                     // 確認
    blockers: [{ escalation_level: 0, blocked_since: plus(-9) }],                       // 注意
    owners: [{ name: "経営A", active: true, canLogin: true, mfa: "enrolled" }],          // 重要（1人だけ）
  });
  assert.deepEqual(h.risks.map((i) => i.severity), ["high", "mid", "low"]);
  assert.equal(SEVERITY_LABEL.high, "重要");
});

ok("①も重要度順（月初の月次締め（注意）より、代表の承認（重要）が先）", () => {
  const h = hub({ closing: { closed: false }, requests: 2 }, "2026-10-03");
  assert.deepEqual(keys(h.attention), ["request_approval", "closing"]);
});

console.log("\n— 読めなかった元データ（null）を、0件・問題なしにしない —");

ok("null のものは unreadable に出て、その判定は出ない。ほかは出る", () => {
  const h = hub({ expenses: null, applicants: null, blockers: null, requests: 4 });
  assert.deepEqual(h.unreadable.sort(), ["採用", "止まっている仕事", "経費"]);
  assert.deepEqual(keys(h.attention), ["request_approval"]);
});

ok("読めない数字は value:null（0 ではない）。人数も同じ", () => {
  const h = hub({ expenses: null, journals: null, people: null, applicants: null, onboarding: null });
  assert.deepEqual(h.money.internal.map((m) => m.value), [null, null, null]);
  assert.deepEqual(h.people.tiles.map((t) => t.value), [null, null, null, null, null]);
  for (const t of [...h.money.internal, ...h.people.tiles]) assert.notEqual(t.value, 0);
  assert.ok(h.unreadable.includes("社員名簿") && h.unreadable.includes("会計（仕訳）") && h.unreadable.includes("入社準備"));
});

ok("すべて null でも落ちない（何も出さず、全部を未読込にする）", () => {
  const h = buildHub({ today: TODAY, facts: {} });
  assert.deepEqual(h.attention, []);
  assert.deepEqual(h.risks, []);
  assert.ok(h.unreadable.length >= 10, h.unreadable.join());
});

ok("経営者の二段階認証が不明（管理用の取得に失敗）でも、警告にも「未読込」にもしない（二段階認証は任意）", () => {
  const h = hub({ owners: [{ name: "A", active: true, canLogin: true, mfa: "unknown" }, { name: "B", active: true, canLogin: true, mfa: "enrolled" }] });
  assert.deepEqual(h.risks, []);
  assert.deepEqual(h.unreadable, []);
});

console.log("\n— ②人数と③社内の数字 —");

ok("採用選考中・内定・入社予定・入社準備未完了の数え方", () => {
  const h = hub({
    applicants: [
      { stage: "applied", status: "todo" }, { stage: "casual_interview", status: "scheduling" }, { stage: "ceo_interview", status: "ceo_decision_pending" },
      { stage: "applied", status: "passed" },                     // 見送り → 選考中に数えない
      { stage: "offer", status: "offer_sent" }, { stage: "offer", status: "accepted" },   // 承諾済みも内定
      { stage: "offer", status: "declined" },                     // 辞退 → 内定に数えない
      { stage: "joining_scheduled", status: "done" },              // 入社予定（採用の段階）はどちらにも数えない
    ],
    onboarding: { inProgress: 2, company: 0, rows: [
      { name: "a", joinOn: plus(10), daysToStart: 10, complete: false },
      { name: "b", joinOn: plus(0), daysToStart: 0, complete: true },
      { name: "c", joinOn: plus(-5), daysToStart: -5, complete: false },
    ] },
  });
  const v = Object.fromEntries(h.people.tiles.map((t) => [t.key, t.value]));
  assert.deepEqual(v, { headcount: 12, joining: 2, recruiting: 3, offers: 2, onboarding_open: 2 });
});

ok("経費・立替・仕訳の数字（件数と金額）", () => {
  const h = hub({ expenses: { ownerWaiting: { count: 0, amount: 0 }, pending: { count: 3, amount: 45000 }, payable: { count: 2, amount: 12345 } }, journals: 7 });
  const m = Object.fromEntries(h.money.internal.map((x) => [x.key, x]));
  assert.equal(m.expense_pending.value, 3);
  assert.match(m.expense_pending.sub, /45,000円/);
  assert.equal(m.payable.value, 2);
  assert.match(m.payable.sub, /12,345円/);
  assert.equal(m.journals.value, 7);
});

console.log("\n— 給与は出さない・押した先 —");

ok("結果のどこにも、給与・手当・単価に関わる語も、金額の項目もない（経費の金額は別）", () => {
  const h = hub({ people: { total: 5, proper: 4, bp: 1 } });
  const s = JSON.stringify(h);
  for (const w of ["給与", "基本給", "手当", "単価", "wage", "salary", "unit_price", "commute"]) assert.equal(s.includes(w), false, w);
});

ok("押した先は、決めた元システムだけ。実在する画面（/ 始まり）か、/keiei 内（# 始まり）", () => {
  const allowed = new Set(Object.values(LINKS));
  const h = hub({
    expenses: { ownerWaiting: { count: 1, amount: 1 }, pending: { count: 1, amount: 1 }, payable: { count: 1, amount: 1 } },
    requests: 1, applicants: [{ stage: "ceo_interview", status: "ceo_decision_pending", decision_due_on: plus(-1) }],
    onboarding: { inProgress: 1, company: 1, rows: [{ name: "a", joinOn: plus(1), daysToStart: 1, complete: false }] },
    blockers: [{ escalation_level: 2, blocked_since: plus(-9) }, { escalation_level: 0, blocked_since: plus(-9) }],
    renewals: [{ period_to: plus(3), renewal_status: "pending" }, { period_to: plus(30), renewal_status: "pending" }],
    closing: { closed: false }, billing: [{ billing_month: "2026-08" }], journals: 1,
    owners: [{ name: "A", active: true, canLogin: true, mfa: "none" }],
  });
  const all = [...h.attention, ...h.risks, ...h.money.internal, ...h.people.tiles];
  for (const i of all) {
    assert.ok(allowed.has(i.href), `${i.key}: ${i.href}`);
    assert.ok(i.linkLabel, `${i.key} に押す先の名前`);
  }
  assert.ok(all.length > 15);
});

ok("LINKS の相対パスは、リポジトリに実在する画面", () => {
  for (const [k, v] of Object.entries(LINKS)) {
    if (v.startsWith("#")) continue;
    const file = v.endsWith("/") ? join(ROOT, v, "index.html") : join(ROOT, v);
    assert.ok(existsSync(file), `${k}: ${v}`);
  }
});

console.log("\n— 経営設定・セキュリティ —");

ok("securityRisks: 人数から警告を作る（ホームと同じ判定）。二段階認証の登録状況は、警告に使わない", () => {
  const r = securityRisks([{ name: "A", active: true, canLogin: true, mfa: "enrolled" }, { name: "B", active: true, canLogin: true, mfa: "none" }]);
  assert.deepEqual(r.risks, [], "経営者が2人。未登録の人がいても警告なし");
  assert.equal(r.loginable, 2);
  assert.deepEqual(securityRisks([{ name: "A", active: true, canLogin: true, mfa: "none" }]).risks.map((x) => x.key), ["owner_single"]);
});

ok("buildSecurity: 履歴は実行者・対象の名前に直る。名簿に無ければ detail の名前", () => {
  const s = buildSecurity({
    today: TODAY,
    owners: [{ employeeId: "e1", name: "経営A", status: "active", active: true, canLogin: true, mfa: "enrolled" }],
    people: [{ id: "e1", user_id: "u1", display_name: "経営A" }, { id: "e2", user_id: "u2", display_name: "経営B" }],
    events: [
      { ts: "2026-09-29T00:00:00Z", action: "owner.grant", actor_id: "u1", target: "employee:e2", detail: { name: "経営B" } },
      { ts: "2026-09-20T00:00:00Z", action: "owner.revoke", actor_id: "u1", target: "employee:gone", detail: { name: "退職した人" } },
      { ts: "2026-09-10T00:00:00Z", action: "mfa.reset_denied", actor_id: "ux", target: "employee:e1", detail: {} },
    ],
  });
  assert.deepEqual(s.history.map((h) => [h.label, h.actor, h.target]), [
    ["経営者に追加", "経営A", "経営B"],
    ["経営者から外した", "経営A", "退職した人"],
    ["経営者の二段階認証リセットを断った", null, "経営A"],
  ]);
  assert.equal(s.links.payAudit, "#pay-audit");
  assert.equal(s.warnings.length, 1, "経営者が1人だけ");
  assert.ok(!("mfaUnknown" in s) && !("mfaPolicy" in s), "二段階認証の強制日・不明の警告は、返さない");
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
