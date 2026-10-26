// Sales提案管理の見送り分析。日時は見送り確定時（closedAt）を使用し、更新日時で代用しない。
// 提案IDにつき1件、アーカイブ除外。理由が無い場合は「理由未入力」として見える化。
import { CLOSE_REASON_LABEL } from "./sales-proposals.js";

export const LOSS_PERIODS = [1, 7, 30, 90, 365, "all"];
const dayOf = (timestamp) => {
  if (!timestamp) return null;
  const n = Date.parse(timestamp);
  return Number.isFinite(n) ? new Date(n + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
};
const startDay = (today, days) => {
  const d = Date.parse(today + "T00:00:00Z");
  return new Date(d - (days - 1) * 86400000).toISOString().slice(0, 10);
};

function aggregate(items, since, today) {
  const included = items.filter((x) => since === null || x.day && x.day >= since && x.day <= today);
  const byReason = new Map(), byOwner = new Map();
  for (const { p } of included) {
    const raw = String(p.closeReason || "").trim();
    const key = raw && CLOSE_REASON_LABEL[raw] ? raw : raw ? "other_legacy" : "unrecorded";
    const label = key === "unrecorded" ? "理由未入力" : key === "other_legacy" ? "その他（旧コード）" : CLOSE_REASON_LABEL[key];
    if (!byReason.has(key)) byReason.set(key, { key, label, count: 0 });
    byReason.get(key).count++;
    const owner = String(p.salesOwnerName || "担当未登録").trim() || "担当未登録";
    if (!byOwner.has(owner)) byOwner.set(owner, { name: owner, count: 0 });
    byOwner.get(owner).count++;
  }
  return {
    count: included.length,
    unknownDate: since === null ? items.filter((x) => !x.day).length : 0,
    since,
    to: today,
    reasons: [...byReason.values()].sort((a,b) => b.count - a.count || a.label.localeCompare(b.label,"ja")),
    owners: [...byOwner.values()].sort((a,b) => b.count - a.count || a.name.localeCompare(b.name,"ja")),
    missingReason: included.filter(({p})=> !p.closeReason).length,
  };
}

export function buildLossReport(proposals, now = new Date().toISOString()) {
  const today = dayOf(now);
  if (!today) throw new Error("invalid now");
  const items = (proposals || []).filter((p) => p.status === "lost" && !p.archived).map((p)=>({
    p, day: dayOf(p.closedAt),
  }));
  return {
    total: items.length,
    asOf: today,
    periods: Object.fromEntries(LOSS_PERIODS.map((key)=>[
      String(key), aggregate(items, key === "all" ? null : startDay(today,key), today),
    ])),
  };
}
