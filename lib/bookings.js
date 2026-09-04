// スペース予約の共通処理。
//
// 承認者の割り出しと、入力時刻の検証をここにまとめる。
// エンドポイントが増えても「誰に通知するか」の定義が1か所で済むようにする。

import { admin } from "./supabase.js";

export const MAX_HOURS = 12;          // 1件あたりの上限
export const MAX_DAYS_AHEAD = 365;    // これより先は受け付けない

/**
 * 承認できる人（管理者・経営者・人事）の社員IDを集める。
 * 会計側の memberships（admin/staff）と、グループウェア側の
 * gw_role_grants（owner/hr）の両方から拾う。
 */
export async function approverEmployeeIds(tenantId) {
  const sb = admin();
  const ids = new Set();

  const { data: grants } = await sb
    .from("gw_role_grants")
    .select("employee_id, role")
    .eq("tenant_id", tenantId)
    .in("role", ["owner", "hr"]);
  for (const g of grants || []) if (g.employee_id) ids.add(g.employee_id);

  const { data: staff } = await sb
    .from("memberships")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .in("role", ["admin", "staff"]);
  const userIds = (staff || []).map((m) => m.user_id).filter(Boolean);
  if (userIds.length) {
    const { data: emps } = await sb
      .from("gw_employees")
      .select("id")
      .eq("tenant_id", tenantId)
      .in("user_id", userIds);
    for (const e of emps || []) ids.add(e.id);
  }

  return [...ids];
}

/**
 * 申請された時間帯を検証する。
 * @returns {{error:string, hint?:string}|{startsAt:string, endsAt:string}}
 */
export function validateRange(startsAt, endsAt) {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return { error: "invalid_time", hint: "日時の形式が正しくありません" };
  }
  if (e <= s) return { error: "invalid_time", hint: "終了時刻は開始時刻より後にしてください" };

  const hours = (e - s) / 3600000;
  if (hours > MAX_HOURS) {
    return { error: "too_long", hint: `1件あたり ${MAX_HOURS} 時間までにしてください` };
  }

  // 過去日の申請を止める。時計のずれで弾かれないよう5分の余裕を持たせる
  if (s.getTime() < Date.now() - 5 * 60 * 1000) {
    return { error: "in_the_past", hint: "過ぎた日時は申請できません" };
  }
  if (s.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400000) {
    return { error: "too_far", hint: "1年より先は申請できません" };
  }
  return { startsAt: s.toISOString(), endsAt: e.toISOString() };
}

/** 予約1件の見出し（通知や画面で使う「9月10日 14:00〜15:00」） */
export function rangeLabel(startsAt, endsAt) {
  const fmt = (d, opts) => new Date(d).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", ...opts });
  const day = fmt(startsAt, { month: "long", day: "numeric" });
  const from = fmt(startsAt, { hour: "2-digit", minute: "2-digit" });
  const to = fmt(endsAt, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${from}〜${to}`;
}
