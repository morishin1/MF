// 有給・稟議の申請まわりの共通処理。
//
// 承認の道すじは設定に出していない。迷いどころを増やさないため、
// 有給は1段（管理部）、稟議は2段（管理部→代表）で固定にしている。

import { admin } from "./supabase.js";

export const KINDS = ["leave", "ringi"];
export const LEAVE_TYPES = ["paid", "am", "pm", "special", "absence"];

export const LEAVE_LABEL = {
  paid: "有給（全日）", am: "午前半休", pm: "午後半休",
  special: "特別休暇", absence: "欠勤",
};

export const STATUS_LABEL = {
  pending: "承認待ち（管理部）",
  pending_owner: "承認待ち（代表）",
  approved: "承認済み",
  rejected: "却下",
  cancelled: "取消",
};

/** 1段目の承認が付いたあとの状態。稟議だけ代表の承認が要る */
export const nextStatusFor = (kind) => (kind === "ringi" ? "pending_owner" : "approved");

/**
 * 年度（4月始まり）。2026-03-31 は 2025年度、2026-04-01 は 2026年度。
 * 会計期間（4月開始/3月決算）に合わせている。
 */
export function fiscalYear(date = new Date()) {
  const d = new Date(date);
  return d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1;
}

export const fiscalRange = (year) => ({
  from: `${year}-04-01`,
  to: `${year + 1}-03-31`,
});

/**
 * 有給の残日数。付与＋繰越から、承認済み・承認待ちの消化分を引く。
 * 承認待ちも引いているのは、二重に出して足りなくなるのを防ぐため。
 * 欠勤は有給を消費しないので数えない。
 */
export async function leaveBalance(employeeId, year = fiscalYear()) {
  const sb = admin();
  const { from, to } = fiscalRange(year);

  const [{ data: grant }, { data: used }] = await Promise.all([
    sb.from("gw_leave_grants")
      .select("granted_days, carried_days")
      .eq("employee_id", employeeId).eq("fiscal_year", year)
      .maybeSingle()
      .then((r) => r, () => ({ data: null })),
    sb.from("gw_requests")
      .select("days, status, leave_type")
      .eq("employee_id", employeeId).eq("kind", "leave")
      .in("status", ["pending", "approved"])
      .gte("starts_on", from).lte("starts_on", to)
      .then((r) => r, () => ({ data: [] })),
  ]);

  const rows = (used || []).filter((r) => r.leave_type !== "absence");
  const num = (v) => Number(v || 0);
  const granted = num(grant?.granted_days) + num(grant?.carried_days);
  const takenApproved = rows.filter((r) => r.status === "approved").reduce((s, r) => s + num(r.days), 0);
  const takenPending = rows.filter((r) => r.status === "pending").reduce((s, r) => s + num(r.days), 0);

  return {
    year,
    granted: round1(granted),
    taken: round1(takenApproved),
    pending: round1(takenPending),
    remaining: round1(granted - takenApproved - takenPending),
    // 付与が未登録なら残日数は出しても意味がない。画面でその旨を出すための印
    hasGrant: !!grant,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** 「9月10日〜9月12日（3日）」のような見出し */
export function leaveLabel(r) {
  const fmt = (d) => new Date(`${d}T00:00:00+09:00`)
    .toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric" });
  const period = r.starts_on === r.ends_on ? fmt(r.starts_on) : `${fmt(r.starts_on)}〜${fmt(r.ends_on)}`;
  return `${period}（${r.days}日・${LEAVE_LABEL[r.leave_type] || r.leave_type}）`;
}

export const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
