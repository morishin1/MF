// 要フォロー（lib/follow.js の findFollowUps）の材料を読む部品。
//
// ■ なぜ分けたか
//   日報・勤怠（api/nippo/admin.js）と、経営のメンバー実行状況（api/keiei?view=members）が、
//   同じ「今日の要フォロー」を出す。読み方が2つあると、片方だけ直したときに画面どうしで数が食い違う。
//   だから材料（直近14営業日の日報・KPI・止まっている仕事・期限切れの次の行動）は、ここ1か所で読む。
//
// ■ テナント
//   tc_nippo・gw_daily_kpis・gw_blockers・gw_action_items には tenant_id が無い（auth の user_id で持つ）。
//   名簿（そのテナントの user_id）で絞って読む。絞らないと、他社の人の行まで読みにいくことになる。
//
// ■ 読めなかったとき
//   どれか1つでも読めなければ ok:false（呼ぶ側は「読めませんでした」と出し、0人とは言わない）。

import { recentWorkdays } from "./follow.js";
import { chunks } from "./pg-read.js";

// 日報の欄。issues / no_issues は 036 より前の形の「困りごと」、consult_note は今の形の「相談事項」。
// どちらも「相談あり」の判定（lib/follow.js）に使う
export const FOLLOW_NIPPO_FIELDS = "user_id, work_date, work_items, tomorrow_plan, consult_note, morning_note, issues, no_issues";

/** 直近14営業日の範囲（いちばん古い日） */
export const followSpanFrom = (date) => {
  const span = recentWorkdays(date, 14);
  return span[span.length - 1];
};

async function readByUsers(make, userIds) {
  if (!userIds.length) return { data: [], error: null };
  const out = [];
  for (const part of chunks(userIds, 100)) {
    const r = await make(part);
    if (r?.error) return { data: null, error: r.error };
    out.push(...(r?.data || []));
  }
  return { data: out, error: null };
}

/**
 * @param {object} sb  admin()
 * @param {{date:string, userIds:string[]}} p
 * @returns {Promise<{ok:boolean, spanFrom:string, nippos:object[], kpis:object[], blockers:object[], items:object[], error?:string}>}
 */
export async function readFollowSources(sb, { date, userIds }) {
  const spanFrom = followSpanFrom(date);
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const [nippos, kpis, blockers, items] = await Promise.all([
    readByUsers((part) => sb.from("tc_nippo").select(FOLLOW_NIPPO_FIELDS)
      .in("user_id", part).gte("work_date", spanFrom).lte("work_date", date).limit(5000), ids),
    readByUsers((part) => sb.from("gw_daily_kpis").select("user_id, work_date, target, actual")
      .in("user_id", part).gte("work_date", spanFrom).lte("work_date", date).limit(5000), ids),
    // 止まっている仕事。管理職の仕事はこれを外すこと（要件定義 §24）
    readByUsers((part) => sb.from("gw_blockers").select("*").eq("status", "open")
      .in("user_id", part).order("blocked_since").limit(300), ids),
    // 期限を過ぎたまま開いている「次にやること」
    readByUsers((part) => sb.from("gw_action_items").select("user_id, status, due_date")
      .in("user_id", part).lte("due_date", date).gte("due_date", spanFrom).limit(5000), ids),
  ]);
  const failed = [nippos, kpis, blockers, items].find((r) => r.error);
  return {
    ok: !failed,
    error: failed ? String(failed.error?.message || failed.error) : undefined,
    spanFrom,
    nippos: nippos.data || [],
    kpis: kpis.data || [],
    blockers: blockers.data || [],
    items: items.data || [],
  };
}
