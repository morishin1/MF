// 入退社の手順。誰が・いつまでに・何をやるか。
//
// ■ ここが1か所であること
//
//   入社のときにやることは、人事の頭の中と、Slackの過去ログと、
//   前任者の作ったスプレッドシートに分かれていた。
//   分かれていると、入社日の前日に「PCが無い」が起きる。
//
//   この表が正。画面もAPIも通知も、ここだけを見る。
//
// ■ 担当はロールで書く。人は登録のときに決める
//
//   「IT・管理」と書いておいて、登録した時点で社内ロールから
//   実際の人を1人決める（api/hr）。
//   ロールのまま置いておくと「IT・管理の誰か」になり、誰もやらない。
//
// ■ 段階は「いつやるか」
//
//   prep    … 入社日・退社日より前に終わっていないといけないもの
//   day1    … 初日にやるもの
//   lastday … 退社日にやるもの
//
//   終わったかどうかとは別。準備が全部終わっていても、
//   初日が来るまで「初日対応」にはならない。

export const ROLES = [
  { key: "hr",       label: "人事" },
  { key: "it",       label: "IT・管理" },
  { key: "manager",  label: "上長" },
  { key: "finance",  label: "経理" },
  // 社労士に投げる項目（資格取得届など）は、いまも既定のチェックリストに入る。
  // ここに書いておかないと、画面から黙って消える
  { key: "labor_advisor", label: "社労士" },
  { key: "employee", label: "本人" },
];
export const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r.label]));

/** 画面の3つのタブ。「完了」は入社・退社をまとめて出す */
export const TABS = [
  { key: "onboarding", label: "入社予定" },
  { key: "offboarding", label: "退社予定" },
  { key: "done", label: "完了" },
];

export const PHASES = {
  onboarding: [
    { key: "planned", label: "入社予定" },
    { key: "prep",    label: "入社準備" },
    { key: "day1",    label: "初日対応" },
    { key: "done",    label: "完了" },
  ],
  offboarding: [
    { key: "planned", label: "退社予定" },
    { key: "prep",    label: "退社準備" },
    { key: "lastday", label: "退社日対応" },
    { key: "done",    label: "完了" },
  ],
};
export const phaseLabel = (kind, key) =>
  (PHASES[kind] || PHASES.onboarding).find((p) => p.key === key)?.label || key || "";

// ---- 入社 ---------------------------------------------------------------------
//
// 並び順は、そのまま画面の並び順。担当ごとにまとめてある。
// href を書いた項目は、チェックの横に「開く」が出る。
// そこへ行かないと終わらない作業に、行き先を書いておく。
const ONBOARDING = [
  // 人事
  { key: "on_hr_terms",   role: "hr", phase: "prep", title: "労働条件・契約の確認",
    href: "admin-contracts.html" },
  { key: "on_hr_docs",    role: "hr", phase: "prep", title: "必要書類の回収" },
  { key: "on_hr_rules",   role: "hr", phase: "prep", title: "社内ルールの確認" },

  // IT・管理
  { key: "on_it_pc",      role: "it", phase: "prep", title: "会社PCの準備" },
  { key: "on_it_mail",    role: "it", phase: "prep", title: "メールの発行" },
  { key: "on_it_slack",   role: "it", phase: "prep", title: "Slack・グループウェアの発行" },
  { key: "on_it_agent",   role: "it", phase: "prep", title: "EIGHT Agent の設定",
    href: "admin-devices.html" },
  { key: "on_it_perm",    role: "it", phase: "prep", title: "必要システムの権限付与",
    href: "admin-members.html#roles" },

  // 上長
  { key: "on_mgr_work",   role: "manager", phase: "prep", title: "担当業務の設定",
    href: "admin-goals.html" },
  { key: "on_mgr_sched",  role: "manager", phase: "day1", title: "初日の予定の登録" },
  { key: "on_mgr_orient", role: "manager", phase: "day1", title: "オリエンテーション" },

  // 経理
  { key: "on_fin_pay",    role: "finance", phase: "prep", title: "給与・振込情報の確認" },
];

// ---- 退社 ---------------------------------------------------------------------
const OFFBOARDING = [
  // 人事
  { key: "off_hr_date",   role: "hr", phase: "prep", title: "退職日の確認" },
  { key: "off_hr_docs",   role: "hr", phase: "prep", title: "必要書類の受け渡し" },
  { key: "off_hr_handover", role: "hr", phase: "prep", title: "引継ぎの確認" },

  // IT・管理
  { key: "off_it_pc",     role: "it", phase: "lastday", title: "PCの返却" },
  { key: "off_it_mail",   role: "it", phase: "lastday", title: "メールの停止" },
  { key: "off_it_slack",  role: "it", phase: "lastday", title: "Slack の停止" },
  { key: "off_it_gw",     role: "it", phase: "lastday", title: "グループウェアの停止",
    href: "admin-members.html" },
  { key: "off_it_perm",   role: "it", phase: "lastday", title: "システム権限の削除",
    href: "admin-members.html#roles" },
  // 端末は「利用停止」と「削除」が別。手元に戻らないなら削除まで進める
  { key: "off_it_agent",  role: "it", phase: "lastday", title: "EIGHT Agent 端末の利用停止・削除",
    href: "admin-devices.html" },

  // 上長
  { key: "off_mgr_handover", role: "manager", phase: "prep", title: "業務の引継ぎ" },
  { key: "off_mgr_data",     role: "manager", phase: "prep", title: "データ・案件の確認" },

  // 経理
  { key: "off_fin_expense", role: "finance", phase: "prep", title: "経費精算",
    href: "admin-expenses.html" },
  { key: "off_fin_pay",     role: "finance", phase: "lastday", title: "最終給与等の確認" },
];

export const FLOW = { onboarding: ONBOARDING, offboarding: OFFBOARDING };

/** その種別の手順。並び順を付けて返す */
export function flowItems(kind) {
  const list = FLOW[kind] || FLOW.onboarding;
  return list.map((it, i) => ({ ...it, sortOrder: (i + 1) * 10 }));
}

/** 鍵から1つ引く。画面に出す見出し・行き先に使う */
const BY_KEY = new Map([...ONBOARDING, ...OFFBOARDING].map((i) => [i.key, i]));
export const flowOf = (key) => BY_KEY.get(key) || null;

// ---- 進み具合 -------------------------------------------------------------------

const isDone = (i) => i.status === "done" || i.status === "na";

/**
 * 「7/10完了」の数え方。
 *
 * 本人が出す書類（owner='employee'）は、ここには数えない。
 * 本人の進み具合は入社手続きの画面が持っていて、
 * ここで混ぜると「担当者がやること」の分母がぼやける
 */
export function progressOf(items) {
  const mine = (items || []).filter((i) => i.owner !== "employee");
  return { done: mine.filter(isDone).length, total: mine.length };
}

/**
 * いまどの段階か。
 *
 * 日付と、終わったかどうかの両方で決める。
 *   ・全部終わっていれば done
 *   ・入社日・退社日が来ていれば day1 / lastday
 *   ・それ以外は、1つでも手を付けていれば prep、まだなら planned
 *
 * @param {string} kind
 * @param {string|null} targetOn  入社日・退社日（YYYY-MM-DD）
 * @param {object[]} items
 * @param {string} today 日本時間の今日
 */
export function phaseOf(kind, targetOn, items, today) {
  const p = progressOf(items);
  if (p.total && p.done === p.total) return "done";
  if (targetOn && today && targetOn <= today) {
    return kind === "offboarding" ? "lastday" : "day1";
  }
  return p.done > 0 ? "prep" : "planned";
}

/**
 * 次にやること。1件だけ返す。
 *
 * 一覧の「次の担当」と、詳細のいちばん上に出す。
 * 10件並べても、結局いちばん上しか読まれない。
 *
 * 選び方は、段階の早いもの → 並び順。
 * 「初日対応」が残っていても、準備が終わっていなければ準備が先
 */
export function nextUp(items) {
  const order = { prep: 0, day1: 1, lastday: 1 };
  const open = (items || [])
    .filter((i) => !isDone(i) && i.owner !== "employee")
    .sort((a, b) => (order[a.phase] ?? 9) - (order[b.phase] ?? 9)
      || (a.sort_order || 0) - (b.sort_order || 0));
  return open[0] || null;
}

/** 担当ごとにまとめる。画面のチェックリストはこの順で出す */
export function byRole(items) {
  const out = [];
  for (const r of ROLES) {
    const mine = (items || []).filter((i) => i.owner === r.key);
    if (!mine.length) continue;
    out.push({
      role: r.key, label: r.label, items: mine,
      done: mine.filter(isDone).length, total: mine.length,
    });
  }
  return out;
}

/**
 * 期日までの日数。「入社まで3日」を出すのに使う。
 * 過ぎていれば負の数
 */
export function daysUntil(targetOn, today) {
  if (!targetOn || !today) return null;
  const a = Date.parse(`${targetOn}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * 期日の言い方。数字だけ出しても、急ぐのかどうかが伝わらない
 */
export function dueLabel(kind, targetOn, today) {
  const d = daysUntil(targetOn, today);
  const what = kind === "offboarding" ? "退社" : "入社";
  if (d == null) return `${what}日 未定`;
  if (d === 0) return `今日 ${what}`;
  if (d === 1) return `明日 ${what}`;
  if (d > 0) return `${what}まで${d}日`;
  return `${what}から${-d}日`;
}

/**
 * 急ぎかどうか。画面の色分けに使う。
 *
 * 「赤は3日前から」のような数字は、ここ1か所に置く。
 * 画面ごとに書くと、一覧と詳細で色が違う、が起きる
 */
export function urgency(kind, targetOn, items, today) {
  const p = progressOf(items);
  if (p.total && p.done === p.total) return "ok";
  const d = daysUntil(targetOn, today);
  if (d == null) return "warn";       // 日付が決まっていない
  if (d <= 0) return "late";          // 当日を過ぎて、まだ残っている
  if (d <= 3) return "soon";
  return "ok";
}
