// Sales ホーム：提案起点のコホート分析。表示する件数は提案ID単位で重複させない。
// 「期間内の起票」が分母。提案・引継ぎ・成約は、その起票が後日どこまで進んだかを見る。
// 経過日や売上ではなく、記録済みの事実だけを集計する。
import { CLOSE_REASON_LABEL } from "./sales-proposals.js";
import { ymd as jstYmd } from "./jst.js";

const LOST = new Set(["lost", "stopped", "closed_no_reply"]);
const LATE_STAGE = new Set(["meeting_adjust", "meeting_done"]);
const fallback = (s) => String(s || "").trim() || "担当未登録";

function metricOf(p, facts) {
  const sent = Boolean(p.sent_at);
  const cs = Boolean(p.cs_owner_id || p.closing_owner_id || p.handoff_stage === "closing");
  const closing = Boolean(p.closing_owner_id || p.handoff_stage === "closing");
  return {
    sent,
    called: facts.calls.has(p.id),
    meeting: Boolean(p.meeting_at || facts.meetings.has(p.id) || LATE_STAGE.has(p.status)),
    cs, closing, won: p.status === "won", lost: LOST.has(p.status),
  };
}

const count = (rows, k) => rows.filter((r) => r.m[k]).length;
const rate = (n, d) => d ? Math.round(1000 * n / d) / 10 : null;
const ymdToMs = (s) => Date.parse(s + "T00:00:00Z");
const dayLabel = (s) => s.slice(5).replace("-", "/");

function groupRoles(rows, role, nameOf, sentBy) {
  const map = new Map();
  for (const r of rows) {
    const p = r.p;
    if (role === "cs" && !r.m.cs) continue;
    if (role === "closing" && !r.m.closing) continue;
    // 提案段階：送信行動の実施者を優先。記録がない場合は起点担当を暫定表示。
    const name = role === "proposal"
      ? fallback(nameOf(sentBy.get(p.id)) || p.matching_owner_name || nameOf(p.sales_owner_id))
      : role === "cs" ? fallback(nameOf(p.cs_owner_id)) : fallback(nameOf(p.closing_owner_id));
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(r);
  }
  return [...map.entries()].map(([name, items]) => ({
    name, total: items.length, sent: count(items, "sent"), called: count(items, "called"),
    meeting: count(items, "meeting"), cs: count(items, "cs"), closing: count(items, "closing"),
    won: count(items, "won"), lost: count(items, "lost"),
    closingRate: rate(count(items, "closing"), items.length),
    winRate: rate(count(items, "won"), items.length),
  })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ja"));
}

export function computeSalesDashboardMetrics(proposals, activities, { since, days, nameOf = () => null } = {}) {
  const all = (proposals || []).filter((p) => !p.archived_at);
  const cohort = all.filter((p) => {
    const at = p.matched_at || p.created_at || p.sent_at;
    return at && jstYmd(at) >= since;
  });
  const ids = new Set(cohort.map((p) => p.id));
  const facts = { calls: new Set(), meetings: new Set() };
  const sentBy = new Map();
  for (const a of activities || []) {
    if (!ids.has(a.proposal_id)) continue;
    if (a.kind === "call") facts.calls.add(a.proposal_id);
    if (a.kind === "meeting" && ["done", "scheduled"].includes(a.result)) facts.meetings.add(a.proposal_id);
    if (["call", "reply"].includes(a.kind) && a.outcome === "meeting") facts.meetings.add(a.proposal_id);
    if (a.kind === "sent" && a.employee_id &&
      (!sentBy.has(a.proposal_id) || a.occurred_at < sentBy.get(a.proposal_id).at)) {
      sentBy.set(a.proposal_id, { at: a.occurred_at, id: a.employee_id });
    }
  }
  const sentActors = new Map([...sentBy].map(([id, a]) => [id, a.id]));
  const rows = cohort.map((p) => ({ p, m: metricOf(p, facts) }));
  const counts = {
    matched: rows.length, sent: count(rows, "sent"), called: count(rows, "called"),
    meeting: count(rows, "meeting"), cs: count(rows, "cs"),
    closing: count(rows, "closing"), won: count(rows, "won"),
    lost: count(rows, "lost"),
  };
  counts.sentRate = rate(counts.sent, counts.matched);
  counts.closingRate = rate(counts.closing, counts.sent);
  counts.winRate = rate(counts.won, counts.sent);

  const lossMap = new Map();
  for (const r of rows.filter((r) => r.m.lost)) {
    const reason = r.p.close_reason || "unrecorded";
    const label = CLOSE_REASON_LABEL[reason] || (reason === "unrecorded" ? "理由未入力" : "その他・旧コード");
    const key = CLOSE_REASON_LABEL[reason] ? reason : reason === "unrecorded" ? "unrecorded" : "other_legacy";
    const cur = lossMap.get(key) || { key, label, count: 0 };
    cur.count++;
    lossMap.set(key, cur);
  }
  const reasons = [...lossMap.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ja"));

  // 1日・7日は日別に描画（1日は1本、7日は7本）。
  // 30日以上は表示の密度を抑えて週・約2週・約1か月単位で比較する。
  const span = days <= 7 ? 1 : days <= 30 ? 7 : days <= 90 ? 14 : 30;
  const start = ymdToMs(since);
  const buckets = Array.from({ length: Math.ceil(days / span) }, (_, i) => {
    const s = new Date(start + i * span * 86400000).toISOString().slice(0, 10);
    const e = new Date(start + Math.min(days - 1, (i + 1) * span - 1) * 86400000).toISOString().slice(0, 10);
    return { label: s === e ? dayLabel(s) : dayLabel(s) + "〜" + dayLabel(e), matched: 0, sent: 0, won: 0 };
  });
  for (const r of rows) {
    const at = jstYmd(r.p.matched_at || r.p.created_at || r.p.sent_at);
    const idx = Math.floor((ymdToMs(at) - start) / 86400000 / span);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx].matched++;
    if (r.m.sent) buckets[idx].sent++;
    if (r.m.won) buckets[idx].won++;
  }

  return {
    days, since, counts, reasons, trend: buckets,
    roles: {
      proposal: groupRoles(rows, "proposal", nameOf, sentActors),
      cs: groupRoles(rows, "cs", nameOf, sentActors),
      closing: groupRoles(rows, "closing", nameOf, sentActors),
    },
  };
}
