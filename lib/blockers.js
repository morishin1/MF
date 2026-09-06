// 止まっている仕事（Blocker）。
//
// ■ 日報の「困りごと」とは別に持つ理由
//   困りごとはその日の記録で、翌日には流れる。
//   Blocker は外れるまで残るので、「何日止まっているか」が数えられる。
//   管理職の仕事は命令することではなく、これを外すこと（要件定義 §24）。
//   何日止まっているかが見えないと、外す順番が決められない。
//
// ■ 長期化の線引き
//   3営業日を超えたら「長い」とする。
//   1〜2日は、待っているだけのこともある。
//   5日にすると、1週間近く放置されてから初めて見えることになる。

export const LONG_DAYS = 3;

export const ESCALATION = [
  { level: 0, label: "本人が対応中" },
  { level: 1, label: "相談済み" },
  { level: 2, label: "経営判断待ち" },
];

/** 止まってから何日か（当日を1日目と数える） */
export function blockerDays(b, today) {
  const from = new Date(`${b.blocked_since}T00:00:00Z`);
  const to = new Date(`${today}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

export function shapeBlocker(b, today, userName) {
  const days = blockerDays(b, today);
  return {
    id: b.id,
    userId: b.user_id,
    userName: userName ?? null,
    title: b.title,
    description: b.description,
    status: b.status,
    escalationLevel: b.escalation_level,
    escalationLabel: ESCALATION[b.escalation_level]?.label || "",
    blockedSince: b.blocked_since,
    days,
    // 長期化。管理画面で先に出す
    long: b.status === "open" && days > LONG_DAYS,
    actionItemId: b.action_item_id,
    resolution: b.resolution,
    resolvedAt: b.resolved_at,
    resolvedBy: b.resolved_by,
  };
}

/** AIに渡す形。本文は要らない。何が何日止まっているかだけあればよい */
export const forPrompt = (list) =>
  list.filter((b) => b.status === "open")
    .map((b) => ({ title: b.title, days: b.days, escalation_level: b.escalationLevel }));
