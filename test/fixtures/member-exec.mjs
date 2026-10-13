// 経営「メンバー実行状況」のテスト材料（架空の人・架空のタスク）。test/keieimembersapi.mjs と test/ui/keieimembersui.mjs が使う。
//
// 今日 2026-10-15（木）・前の営業日 10-14（水）・明日 10-16（金）
//   中村（e1）… 良好：日報あり（今日・前日）・今日の3つ 3/3・明日の3つ確定・期限超過なし
//   藤本（e2）… 要対応：日報なし（今日・前日・前々日＝日報未提出2日）・今日 1/3・期限超過2件・明日の3つ未登録
//   山内（e3）… 注意：日報あり・今日 2/3・期限超過1件・明日の3つは登録済み（未確定）
//   今福（e4）… 要対応：相談事項あり・5日止まっている仕事（ブロッカー）・今日 3/3・明日確定
//   ほか … 退職済み（left）・ログインなし（user_id なし）・招待中・他社 は、対象外
export const TENANT = "00000000-0000-4000-8000-0000000000e1";
export const OTHER = "00000000-0000-4000-8000-0000000000e2";
export const TODAY = "2026-10-15";
export const PREV = "2026-10-14";
export const PREV2 = "2026-10-13";
export const TOMORROW = "2026-10-16";
export const NOW_ISO = "2026-10-15T03:00:00Z";   // 日本時間 12:00

const emp = (id, user, name, extra = {}) => ({ id, tenant_id: TENANT, user_id: user, display_name: name, department: "営業", status: "active", ...extra });
let seq = 0;
const task = (assignee, date, rank, status, extra = {}) => ({
  id: `t${++seq}`, tenant_id: TENANT, title: `${date === TODAY ? "今日" : "明日"}の仕事${rank}`, assignee_id: assignee, focus_for: null,
  focus_date: date, focus_rank: rank, status, due_on: null, priority: "high", purpose: "売上を伸ばす", outcome: "商談化",
  done_condition: "先方に送付済み", kpi_link: "商談数", service: null, ai_review: null, carry_count: 0, is_template: false, ...extra,
});
const three = (assignee, date, done) => [1, 2, 3].map((r) => task(assignee, date, r, r <= done ? "done" : "todo"));
const nippo = (user, date, extra = {}) => ({
  id: `n-${user}-${date}`, user_id: user, user_name: user, work_date: date, submitted_at: `${date}T09:00:00Z`,
  work_items: [{ task: "提案書の作成", result: "2件送付" }], tomorrow_plan: "商談", consult_note: null, morning_note: null,
  issues: [], no_issues: true, top_priority: "提案書", goal_today: null, kgi_target: null, kgi_actual: null, kgi_achieved: null,
  wins: [], improved_note: null, ...extra,
});

export function memberExecRows() {
  seq = 0;
  return {
    gw_employees: [
      emp("e1", "u1", "中村 テスト"),
      emp("e2", "u2", "藤本 テスト", { department: "開発" }),
      emp("e3", "u3", "山内 テスト"),
      emp("e4", "u4", "今福 テスト"),
      emp("e5", "u5", "退職 テスト", { status: "left" }),
      emp("e6", null, "ログインなし テスト"),
      emp("e7", "u7", "招待中 テスト", { status: "invited" }),
      { id: "x1", tenant_id: OTHER, user_id: "ux", display_name: "他社 テスト", department: "営業", status: "active" },
    ],
    tc_nippo: [
      nippo("u1", TODAY), nippo("u1", PREV), nippo("u1", PREV2),
      nippo("u3", TODAY), nippo("u3", PREV), nippo("u3", PREV2),
      nippo("u4", TODAY, { consult_note: "見積の値引き幅を相談したい" }), nippo("u4", PREV), nippo("u4", PREV2),
      nippo("u5", TODAY), nippo("ux", TODAY),
    ],
    tc_nippo_replies: [{ id: "r1", nippo_id: "n-u1-2026-10-15", kind: "admin", body: "ok" }],
    gw_daily_kpis: [],
    gw_blockers: [{ id: "b1", user_id: "u4", title: "先方の決裁待ち", status: "open", blocked_since: "2026-10-09", escalation_level: 1 }],
    gw_action_items: [],
    gw_focus_days: [
      { employee_id: "e1", tenant_id: TENANT, focus_date: TOMORROW, status: "confirmed", ai: null, ai_at: "2026-10-15T08:00:00Z", confirmed_at: "2026-10-15T09:00:00Z" },
      { employee_id: "e3", tenant_id: TENANT, focus_date: TOMORROW, status: "ready", ai: null, ai_at: null, confirmed_at: null },
      { employee_id: "e4", tenant_id: TENANT, focus_date: TOMORROW, status: "confirmed", ai: null, ai_at: null, confirmed_at: "2026-10-15T09:00:00Z" },
    ],
    gw_tasks: [
      ...three("e1", TODAY, 3), ...three("e1", TOMORROW, 0),
      ...three("e2", TODAY, 1).map((t, i) => (i === 2 ? { ...t, carry_count: 2, done_condition: null } : t)),
      ...three("e3", TODAY, 2), ...three("e3", TOMORROW, 0),
      ...three("e4", TODAY, 3), ...three("e4", TOMORROW, 0),
      // 期限超過（未完了で期限が今日より前）：藤本2件・山内1件。完了済み・テンプレート・他社は数えない
      task("e2", null, null, "todo", { title: "請求書の再発行", due_on: "2026-10-10", focus_date: null }),
      task("e2", null, null, "doing", { title: "見積の修正", due_on: "2026-10-13", focus_date: null }),
      task("e3", null, null, "todo", { title: "議事録の共有", due_on: "2026-10-14", focus_date: null }),
      task("e3", null, null, "done", { title: "終わった仕事", due_on: "2026-10-01", focus_date: null }),
      task("e1", null, null, "todo", { title: "テンプレ", due_on: "2026-10-01", focus_date: null, is_template: true }),
      { ...task("x1", null, null, "todo", { title: "他社の仕事", due_on: "2026-10-01", focus_date: null }), tenant_id: OTHER },
    ],
  };
}
