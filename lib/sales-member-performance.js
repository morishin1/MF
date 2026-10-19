// /sales ホームのメンバー別実績・月間カレンダー。既存の行動ログだけで集計する。
// 誰が「今」担当かではなく、対応時の actor / マッチング元の確かなIDに帰属させる。
// 手動・dx.enger 両方の提案を含む。メールが一致しなければ勝手に人名へ名寄せしない。

export const PERFORMANCE_METRICS = [
  { key: "attacks", label: "フォーム送信", short: "アタック", unit: "件" },
  { key: "matches", label: "マッチング確定", short: "確定", unit: "件" },
  { key: "sent", label: "企業への提案送信", short: "提案", unit: "件" },
  { key: "calls", label: "CS電話", short: "電話", unit: "回" },
  { key: "connected", label: "企業接続", short: "接続", unit: "件" },
  { key: "decisions", label: "CS進行判断", short: "CS判断", unit: "件" },
  { key: "handoffs", label: "クロージング引継ぎ", short: "引継ぎ", unit: "件" },
  { key: "meetings", label: "面談設定", short: "面談", unit: "件" },
  { key: "won", label: "成約", short: "成約", unit: "件" },
];
export const PERFORMANCE_KEYS = PERFORMANCE_METRICS.map((m) => m.key);
export const PERFORMANCE_DEFINITIONS = {
  attacks: "送信完了したフォームアタック。送信担当者に計上（未送信は除外）",
  matches: "dx.engerでマッチングが確定した提案。登録メールと社員メールが一致した人に計上",
  sent: "企業への初回提案送信。Sales側の記録者、なければdx.engerの提案担当メール一致で計上",
  calls: "Salesに記録した電話の回数。電話した人に計上（不通を含む）",
  connected: "通話成功または企業からの返信。社員×提案ごとに月内初回だけを計上",
  decisions: "CSが「進行」「詳細確認が必要」と判断した記録の件数",
  handoffs: "CSからクロージングへ正式に引き継いだ件数。引継ぎ前のCS担当に計上",
  meetings: "Salesで面談日時を確定した記録の件数",
  won: "Salesで成約を記録した件数",
};
const empty = () => Object.fromEntries(PERFORMANCE_KEYS.map((k) => [k, 0]));
export const dayJst = (value) => {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
};
export function monthBounds(ym) {
  if (!/^(20\d{2})-(0[1-9]|1[0-2])$/.test(String(ym || ""))) return null;
  const [year, month] = ym.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return {
    month: ym, first: ym + "-01", next,
    sinceIso: new Date(ym + "-01T00:00:00+09:00").toISOString(),
    untilIso: new Date(next + "T00:00:00+09:00").toISOString(),
  };
}

export function summarizePerformance({
  month, employees = [], memberIds = [], settings = {}, approaches = [], proposals = [],
  activities = [], handoffs = [], manager = false, viewerId = null,
}) {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error("invalid_month");
  const names = new Map(employees.map((p) => [p.id, p.display_name || "（不明）"]));
  // 同一メールアドレスの社員が複数いたら安全のため紐付けない（名前だけでは推測しない）
  const byMail = new Map(), dupMail = new Set();
  for (const e of employees) {
    const email = String(e.email || "").trim().toLowerCase();
    if (!email) continue;
    if (byMail.has(email)) dupMail.add(email);
    else byMail.set(email, e.id);
  }
  const known = (email) => {
    const m = String(email || "").trim().toLowerCase();
    return !m || dupMail.has(m) ? null : byMail.get(m) || null;
  };
  const rows = new Map();
  const isVisible = (id) => manager || (viewerId && id === viewerId);
  const ensure = (id) => {
    if (!isVisible(id)) return null;
    const key = id || "unassigned";
    if (!rows.has(key)) rows.set(key, {
      employeeId: id, name: id ? names.get(id) || "（退職・不明）" : "担当者を特定できない実績",
      totals: empty(), days: {}, role: [],
    });
    return rows.get(key);
  };
  if (manager) for (const id of memberIds) ensure(id);
  else if (viewerId) ensure(viewerId);

  const increment = (id, at, metric) => {
    const date = dayJst(at);
    if (!date || date.slice(0, 7) !== month || !PERFORMANCE_KEYS.includes(metric)) return;
    const r = ensure(id);
    if (!r) return;
    r.totals[metric]++;
    (r.days[date] ||= empty())[metric]++;
  };
  for (const a of approaches) if (a.channel === "form" && a.sent_at) {
    increment(a.employee_id || null, a.sent_at, "attacks");
  }
  const byProposal = new Map(proposals.map((p) => [p.id, p]));
  const firstSentActor = new Map();
  for (const a of [...activities].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))) {
    if (a.kind === "sent" && a.result !== "resent" && a.employee_id && !firstSentActor.has(a.proposal_id)) {
      firstSentActor.set(a.proposal_id, a.employee_id);
    }
  }
  for (const p of proposals) {
    // マッチングは提案時点のCL/提案担当メールに帰属。手動提案はマッチング確定を数えない
    if (p.matched_at) increment(known(p.matching_owner_email), p.matched_at, "matches");
    if (p.sent_at) increment(firstSentActor.get(p.id) || known(p.matching_owner_email), p.sent_at, "sent");
  }
  // 同じ相手から複数回の折返しや返信があっても「接続した提案件数」は月内に1件
  const connectedKeys = new Set();
  for (const a of [...activities].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))) {
    const id = a.employee_id || null, at = a.occurred_at;
    if (a.kind === "call") increment(id, at, "calls");
    if ((a.kind === "call" && a.result === "connected") || a.kind === "reply") {
      const key = (id || "unassigned") + ":" + a.proposal_id;
      if (!connectedKeys.has(key)) { connectedKeys.add(key); increment(id, at, "connected"); }
    }
    if (a.kind === "cs_decision" && ["advance", "needs_detail"].includes(a.result)) increment(id, at, "decisions");
    if (a.kind === "meeting" && a.result === "scheduled") increment(id, at, "meetings");
    if (a.kind === "result" && a.result === "won") increment(id, at, "won");
  }
  for (const h of handoffs) if (h.to_stage === "closing") {
    // 「誰がCS業務を行い引き継いだか」を表すため、ボタンを押した管理者ではなく前CS担当で数える
    increment(h.from_owner_id || h.actor_employee_id || null, h.created_at, "handoffs");
  }

  const csIds = new Set(settings.csMembers || []);
  const closingIds = new Set(settings.closingMembers || []);
  const allRows = [...rows.values()].map((r) => {
    r.role = [csIds.has(r.employeeId) && "CS", closingIds.has(r.employeeId) && "クロージング"].filter(Boolean);
    return r;
  }).sort((a, b) => {
    const score = (r) => PERFORMANCE_KEYS.reduce((sum, k) => sum + r.totals[k], 0);
    return score(b) - score(a) || String(a.name).localeCompare(String(b.name), "ja");
  });
  const totals = empty(), days = {};
  for (const r of allRows) {
    for (const metric of PERFORMANCE_KEYS) totals[metric] += r.totals[metric];
    for (const [day, counts] of Object.entries(r.days)) {
      const item = days[day] ||= empty();
      for (const k of PERFORMANCE_KEYS) item[k] += counts[k];
    }
  }
  return {
    month, first: bounds.first, next: bounds.next, manager, metrics: PERFORMANCE_METRICS,
    definitions: PERFORMANCE_DEFINITIONS, totals, days, members: allRows,
  };
}
