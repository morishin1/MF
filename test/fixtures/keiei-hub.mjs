// 経営ハブ（/keiei ホーム・経営設定）の画面テスト用データ。
// 応答は、実物の lib/keiei-hub.js（buildHub / buildSecurity）に事実を渡して作る。
// 画面が見るのは、サーバが返す形そのもの（作り話の形を画面テストに持ち込まない）。
import { buildHub, buildSecurity } from "../../lib/keiei-hub.js";

export const TODAY = "2026-09-30";
const plus = (d) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

/** 何もない日 */
export const quietFacts = () => ({
  people: { total: 12, proper: 10, bp: 2 },
  expenses: { ownerWaiting: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, payable: { count: 0, amount: 0 } },
  requests: 0, applicants: [{ stage: "applied", status: "todo" }, { stage: "offer", status: "offer_sent" }],
  onboarding: { inProgress: 1, company: 0, rows: [{ name: "山田 太郎", joinOn: plus(40), daysToStart: 40, complete: false }] },
  blockers: [], renewals: [], closing: { closed: true }, billing: [], journals: 0,
  owners: [{ name: "森田 経営", active: true, canLogin: true, mfa: "enrolled" }, { name: "経営 二郎", active: true, canLogin: true, mfa: "enrolled" }],
});

/** 忙しい日（①も④も出る） */
export const busyFacts = () => ({
  ...quietFacts(),
  expenses: { ownerWaiting: { count: 2, amount: 150000 }, pending: { count: 5, amount: 230000 }, payable: { count: 3, amount: 41800 } },
  requests: 1,
  applicants: [
    { stage: "ceo_interview", status: "ceo_decision_pending" }, { stage: "casual_interview", status: "scheduling" },
    { stage: "applied", status: "todo", decision_due_on: plus(-3) }, { stage: "applied", status: "todo" },
    { stage: "offer", status: "offer_sent" }, { stage: "offer", status: "accepted" },
  ],
  onboarding: { inProgress: 3, company: 1, rows: [
    { name: "佐藤 花子", joinOn: plus(3), daysToStart: 3, complete: false },
    { name: "鈴木 一郎", joinOn: plus(20), daysToStart: 20, complete: false },
    { name: "高橋 次郎", joinOn: plus(-10), daysToStart: -10, complete: true },
  ], notice: { unpublished: 1, unconfirmed: 2 } },
  blockers: [{ escalation_level: 2, blocked_since: plus(-6) }, { escalation_level: 0, blocked_since: plus(-9) }, { escalation_level: 1, blocked_since: plus(-5) }],
  renewals: [{ period_to: plus(9), renewal_status: "pending" }, { period_to: plus(33), renewal_status: "confirmed" }],
  closing: { closed: false },
  billing: [{ billing_month: "2026-09", timesheet_received: true }, { billing_month: "2026-08", timesheet_received: true, work_confirmed: true }],
  journals: 4,
  owners: [{ name: "森田 経営", active: true, canLogin: true, mfa: "enrolled" }, { name: "経営 二郎", active: true, canLogin: true, mfa: "none" }],
});

export const hubQuiet = () => buildHub({ today: TODAY, facts: quietFacts() });
export const hubBusy = () => buildHub({ today: TODAY, facts: busyFacts() });
/** 経費・採用・止まっている仕事が読めなかった日 */
export const hubUnreadable = () => buildHub({ today: TODAY, facts: { ...busyFacts(), expenses: null, applicants: null, blockers: null } });

export const securityBody = (over = {}) => ({
  status: "exact",
  ...buildSecurity({
    today: TODAY,
    owners: [
      { employeeId: "e1", name: "森田 経営", status: "active", active: true, canLogin: true, mfa: "enrolled" },
      { employeeId: "e2", name: "経営 二郎", status: "active", active: true, canLogin: true, mfa: "none" },
      { employeeId: "e9", name: "元 経営者", status: "left", active: false, canLogin: true, mfa: "enrolled" },
    ],
    people: [{ id: "e1", user_id: "u1", display_name: "森田 経営" }, { id: "e2", user_id: "u2", display_name: "経営 二郎" }],
    events: [
      { ts: "2026-09-29T01:00:00Z", action: "owner.grant", actor_id: "u1", target: "employee:e2", detail: { name: "経営 二郎" } },
      { ts: "2026-09-20T05:30:00Z", action: "mfa.reset_denied", actor_id: "ux", target: "employee:e1", detail: {} },
    ],
  }),
  historyReadable: true,
  ...over,
});

// ---- 2026-10 Phase 1：10月の目標と実績・営業ファネル・担当者別（lib/keiei-sales.js の実物で作る）----
import { buildSales, stalledItem, overdueItem } from "../../lib/keiei-sales.js";
import { targetsOf } from "../../lib/keiei-targets.js";

export const OCT = "2026-10-05";
const octTs = (day, hh = 3) => `2026-10-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:00:00Z`;
export const salesPeople = () => [
  { id: "p1", display_name: "山内 太郎", status: "active" }, { id: "p2", display_name: "中村 次郎", status: "active" },
  { id: "p3", display_name: "藤本 三郎", status: "active" }, { id: "p4", display_name: "池永 四郎", status: "active" },
  { id: "p5", display_name: "工藤 五郎", status: "active" }, { id: "p6", display_name: "今福 六郎", status: "active" },
  { id: "p7", display_name: "魚住 七郎", status: "active" }, { id: "p8", display_name: "野澤 八郎", status: "active" },
];
/**
 * テスト用の Sales・Tasks の事実（2026-10-05 時点）
 *   アタック 121件の送信（うち1件は送れなかった・1件は先月）→ 100社。中村 90社（送信90件）・山内 30社（送信30件）
 *   案件：今月作成 7件（cd1 に2件）→ 商談 6社。今月 提案以降に進んだ 4社（cd3・cd4・cd5、提案のあと失注した cd10 も数える）
 *         成約 1社（cd5・48万円）。停滞：d2（提案のまま 9/25 から動きなし・10日）だけ。
 *         d8 は案件の更新は 9/20 だが、会社の営業履歴が 10/2 にあるので停滞ではない
 */
export const salesFacts = () => {
  const approaches = Array.from({ length: 120 }, (_, i) => ({ id: `a${i}`, company_id: `cx${i % 100}`, employee_id: i < 90 ? "p2" : "p1", sent_at: octTs(1 + (i % 4)), failed_at: null }));
  approaches.push({ id: "afail", company_id: "cx200", employee_id: "p2", sent_at: octTs(2), failed_at: octTs(2) });   // 送れなかった：数えない
  approaches.push({ id: "aold", company_id: "cx201", employee_id: "p2", sent_at: "2026-09-29T03:00:00Z", failed_at: null });   // 先月：数えない
  const deal = (id, company, owner, stage, extra = {}) => ({ id, company_id: company, owner_id: owner, title: `テスト案件 ${id}`, stage, amount: null,
    won_on: null, created_at: octTs(2), updated_at: octTs(4), ...extra });
  const deals = [
    deal("d1", "cd1", "p3", "meeting"),
    deal("d7", "cd1", "p3", "meeting"),   // 同じ会社の2件目：商談は1社
    deal("d2", "cd2", "p3", "proposal", { created_at: "2026-09-20T03:00:00Z", updated_at: "2026-09-25T03:00:00Z" }),
    deal("d3", "cd3", "p3", "proposal"),
    deal("d4", "cd4", "p4", "negotiation", { updated_at: octTs(1, 0) }),
    deal("d5", "cd5", "p1", "won", { amount: 480000, won_on: "2026-10-03" }),
    deal("d6", "cd6", "p2", "meeting"),
    deal("d8", "cd8", "p4", "proposal", { created_at: "2026-09-10T03:00:00Z", updated_at: "2026-09-20T03:00:00Z" }),
    deal("d10", "cd10", "p3", "lost", { updated_at: octTs(3) }),   // 提案のあと失注：今月の提案には数える
  ];
  const h = (id, d, stage, at) => ({ id, deal_id: d, company_id: deals.find((x) => x.id === d).company_id, stage, changed_at: at });
  const history = [
    h("h1", "d3", "proposal", octTs(3)), h("h2", "d4", "negotiation", octTs(1, 0)),
    h("h3", "d5", "proposal", octTs(2)), h("h4", "d5", "won", octTs(3)),
    h("h5", "d10", "proposal", octTs(2)), h("h6", "d10", "lost", octTs(3)),
    h("h7", "d1", "meeting", octTs(2)), h("h8", "d7", "meeting", octTs(2)),
  ];
  return {
    companies: [
      ...["cd1", "cd2", "cd3", "cd4", "cd5", "cd6", "cd8", "cd10"].map((id, i) => ({ id, name: `テスト株式会社${id.slice(2)}`, status: "meeting", owner_id: "p3", hidden_at: null })).slice(0, 6),
      ...Array.from({ length: 40 }, (_, i) => ({ id: `cx${i}`, name: `テスト企業${i}`, status: i < 30 ? "attacked" : "clicked", owner_id: "p2", hidden_at: null })),
      { id: "cd8", name: "テスト株式会社8", status: "proposal", owner_id: "p4", hidden_at: null },
      { id: "cd10", name: "テスト株式会社10", status: "lost", owner_id: "p3", hidden_at: null },
    ],
    approaches,
    dealState: "ok",
    deals,
    history,
    // 停滞の判定：いま提案・最終調整の案件の、すべての段階の記録と、その会社の営業履歴
    lastStage: [
      h("s1", "d2", "proposal", "2026-09-25T03:00:00Z"), h("s2", "d3", "proposal", octTs(3)),
      h("s3", "d4", "negotiation", octTs(1, 0)), h("s4", "d8", "proposal", "2026-09-20T03:00:00Z"),
    ],
    lastEvent: [{ id: "ev1", company_id: "cd8", occurred_at: octTs(2) }, { id: "ev2", company_id: "cd2", occurred_at: "2026-09-21T03:00:00Z" }],
    tasks: [{ id: "t1", assignee_id: "p8", due_on: "2026-10-01", status: "doing" }, { id: "t2", assignee_id: null, due_on: "2026-10-20", status: "todo" }],
  };
};
export const salesOct = (facts = salesFacts()) => buildSales({ today: OCT, facts, targets: targetsOf("2026-10"), people: salesPeople() });
/** 10月のホーム（忙しい日＋営業）。停滞案件は「今日の確認」にも出る（API と同じ組み立て） */
export const hubOctober = (facts = salesFacts()) => {
  const out = buildHub({ today: OCT, facts: busyFacts() });
  const sales = salesOct(facts);
  const stall = stalledItem(sales);
  if (stall) { const at = out.attention.findIndex((i) => i.severity !== "high"); out.attention.splice(at < 0 ? out.attention.length : at, 0, stall); }
  const late = overdueItem(sales);
  if (late) { const at = out.attention.findIndex((i) => i.severity !== "high" && i.key !== "sales_stalled"); out.attention.splice(at < 0 ? out.attention.length : at, 0, late); }
  return { ...out, sales };
};
