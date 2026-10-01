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
