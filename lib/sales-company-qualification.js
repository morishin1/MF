// 取引先企業の提案先判定。送信済み提案の履歴から算出（自動書込み・営業禁止の代替ではない）。
// 同一企業はSales企業ID、ENGER企業ID、会社名の順で識別する。
export function qualificationKey(p) {
  if (p.company_id) return `sales:${p.company_id}`;
  if (p.source_company_id) return `enger:${p.source_company_id}`;
  return `name:${String(p.company_name || "").replace(/[\s　]+/g, "").toLocaleLowerCase("ja-JP")}`;
}

export function qualificationGrade(sent, meetings) {
  if (sent >= 15 && meetings === 0) return "blast";
  if (sent >= 10 && meetings === 0) return "C";
  if (sent >= 10 && meetings / sent >= .2) return "A";
  if (sent >= 10 && meetings / sent >= .1) return "B";
  if (sent >= 10) return "C";
  return "review";
}

export function companyQualifications(proposals, activities) {
  const meetingDone = new Set((activities || [])
    .filter(a => a.kind === "meeting" && a.result === "done")
    .map(a => a.proposal_id));
  const byKey = new Map();
  const byProposal = new Map();
  for (const p of proposals || []) {
    const key = qualificationKey(p);
    let group = byKey.get(key);
    if (!group) {
      group = { key, companyName: p.company_name || "（社名なし）", companyId: p.company_id || null,
        sourceCompanyId: p.source_company_id || null, sent: 0, meetings: 0,
        lost: 0, unknownReasons: 0, reasons: {}, lastSentAt: null, stopContact: false };
      byKey.set(key, group);
    }
    byProposal.set(p.id, key);
    if (p.contact_stop || p.status === "stopped") group.stopContact = true;
    if (!p.sent_at || p.archived_at) continue;
    group.sent++;
    if (p.sent_at > (group.lastSentAt || "")) group.lastSentAt = p.sent_at;
    if (p.status === "meeting_done" || meetingDone.has(p.id)) group.meetings++;
    if (["lost", "closed_no_reply", "stopped"].includes(p.status)) {
      group.lost++;
      const reason = p.close_reason || "unknown";
      group.reasons[reason] = (group.reasons[reason] || 0) + 1;
      if (["unknown", "other", "client_declined"].includes(reason)) group.unknownReasons++;
    }
  }
  const companies = [...byKey.values()].map(g => ({
    ...g, rate: g.sent ? Math.round(g.meetings * 1000 / g.sent) / 10 : null,
    grade: qualificationGrade(g.sent, g.meetings),
    blastOnly: qualificationGrade(g.sent, g.meetings) === "blast",
  }));
  const map = new Map(companies.map(g => [g.key, g]));
  return { companies, byProposal: new Map([...byProposal].map(([id, key]) => [id, map.get(key)])) };
}
