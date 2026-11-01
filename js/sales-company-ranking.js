// ENGER提案先の実績ランキング。読み取り専用、外部送信・自動停止は行わない。
(function (root) {
  "use strict";
  const LOST = new Set(["lost", "closed_no_reply", "stopped"]);
  const UNKNOWN = new Set(["", "unknown", "other", "client_declined", "no_reply", "sales_hold", "client_considering"]);
  const MEETING = new Set(["meeting_adjust", "meeting_done", "won"]);
  const KNOWN_RESPONSE = new Set(["proceed", "pass"]);

  const safeDate = value => { const v = Date.parse(value || ""); return Number.isFinite(v) ? v : null; };
  const num = x => Number.isInteger(x) && x >= 0 ? x : 0;
  const round = (x, n) => Number.isFinite(x) ? Math.round(x * n) / n : null;
  const rate = (part, total) => total > 0 ? round(part / total * 100, 10) : null;
  const isEnger = p => p?.sourceSystem === "enger";
  const companyKey = p => p.companyId ? "local:" + p.companyId
    : p.sourceCompanyId ? "enger:" + p.sourceCompanyId : "unlinked:" + p.id;

  function build(proposals, { days = 90, now = new Date(), truncated = false } = {}) {
    const current = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(current) || !Number.isInteger(days) || days < 1 || days > 365)
      throw new TypeError("invalid ranking range");
    const since = current - days * 86400000;
    const groups = new Map();
    for (const p of proposals || []) {
      if (!p || !p.id || !isEnger(p) || p.sourceDeleted === true) continue;
      const key = companyKey(p);
      if (!groups.has(key)) groups.set(key, {
        key, companyName: p.companyName || "企業名未設定", companyId: p.companyId || null,
        sourceCompanyId: p.sourceCompanyId || null, verified: !key.startsWith("unlinked:"),
        proposals: [], sent: 0, meetings: 0, advanced: 0, won: 0, lost: 0,
        knownReasons: 0, buttonResponses: 0, unknownResponses: 0,
        contactStop: false, latest: null, lastSentAt: null, lastStatus: "未確認",
      });
      const g = groups.get(key);
      if (p.contactStop || p.status === "stopped") g.contactStop = true;
      const timestamp = safeDate(p.sentAt);
      if (timestamp == null || timestamp < since || timestamp > current) continue;
      g.proposals.push(p);
      g.sent++;
      if (g.lastSentAt == null || timestamp > g.lastSentAt) {
        g.lastSentAt = timestamp; g.latest = p; g.lastStatus = p.statusLabel || "未確認";
      }
      if (p.meetingCompleted || p.status === "meeting_done" || p.status === "won") g.meetings++;
      if (p.meetingCompleted || MEETING.has(p.status)) g.advanced++;
      if (p.status === "won") g.won++;
      if (LOST.has(p.status)) {
        g.lost++;
        if (!UNKNOWN.has(String(p.closeReason || ""))) g.knownReasons++;
      }
      if (p.sourceStatePending) g.unknownResponses++;
      else if (KNOWN_RESPONSE.has(p.companyResponse)) g.buttonResponses++;
    }
    const rows = [...groups.values()].filter(g => g.sent > 0).map(g => {
      const meetingRate = rate(g.meetings, g.sent);
      const progressRate = rate(g.advanced, g.sent);
      const lossRate = rate(g.lost, g.sent);
      const reasonRate = rate(g.knownReasons, g.lost);
      // 相手が押した企業回答・確定した理由の合計ではなく、提案単位で情報を得られた割合。
      const infoCount = g.proposals.filter(p => !p.sourceStatePending &&
        (KNOWN_RESPONSE.has(p.companyResponse) ||
          (LOST.has(p.status) && !UNKNOWN.has(String(p.closeReason || ""))))).length;
      const infoRate = g.unknownResponses ? null : rate(infoCount, g.sent);
      const complete = !truncated && g.verified && !g.unknownResponses;
      // 連絡停止の記録だけは最優先で伝える。売上不振だけでは禁止しない。
      const review = complete && (g.sent >= 15 && g.meetings === 0 ||
        (g.sent >= 10 && g.meetings / g.sent < .1 && g.lost >= 7 && g.knownReasons >= 5));
      let decision = g.contactStop ? "連絡停止・要確認"
        : !complete ? "評価保留"
        : review ? "提案見直し候補"
        : g.sent < 10 ? "データ蓄積中"
        : meetingRate >= 20 ? "重点提案候補"
        : meetingRate >= 10 ? "継続提案候補" : "改善確認";
      return { ...g, meetingRate, progressRate, lossRate, reasonRate, infoRate, infoCount,
        review, complete, decision, evidence: g.contactStop ? "連絡停止の記録あり"
        : !g.verified ? "企業ID未照合。社名だけでは名寄せしません"
        : truncated ? "最新2,000件までのため全件集計ではありません"
        : g.unknownResponses ? "ENGER回答の同期未確認あり"
        : g.sent < 10 ? "提案件数が10件未満のため評価保留"
        : review ? "継続可否の審査候補。自動停止ではありません"
        : "送信済み提案の面談実施記録を基準",
      };
    });
    const compare = (a, b, field) => (b[field] ?? -1) - (a[field] ?? -1);
    const ranking = (sort = "results") => [...rows].sort((a,b) => {
      if (sort === "review") return Number(b.review) - Number(a.review) ||
        Number(b.contactStop) - Number(a.contactStop) || compare(a,b,"lost") ||
        compare(a,b,"sent") || a.companyName.localeCompare(b.companyName,"ja");
      if (sort === "information") return Number(b.complete)-Number(a.complete) ||
        compare(a,b,"infoRate") || compare(a,b,"infoCount") ||
        compare(a,b,"sent") || a.companyName.localeCompare(b.companyName,"ja");
      return Number(b.complete)-Number(a.complete) ||
        compare(a,b,"meetingRate") || compare(a,b,"meetings") ||
        compare(a,b,"sent") || a.companyName.localeCompare(b.companyName,"ja");
    });
    return { rows, ranking, stats: { companies: rows.length,
      priority: rows.filter(g=>g.decision==="重点提案候補").length,
      review: rows.filter(g=>g.review).length,
      awaiting: rows.filter(g=>!g.complete).length },
      days, truncated: Boolean(truncated) };
  }
  root.SalesCompanyRanking = Object.freeze({ build });
})(typeof window !== "undefined" ? window : globalThis);
