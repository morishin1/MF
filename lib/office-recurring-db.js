// Office 定例業務（db/125）の表を読み書きする部品。api/office-tasks/recurring.js・api/office-tasks/calendar.js・api/cron/office-recurring.js が使う。
//
// ■ 予定を作る（generate）
//   有効なマスターについて、範囲の予定日のうち、まだ予定が無いもの（完了・今回なしも「ある」とみなす）だけ作る。
//   同じマスター・同じ日は一意の索引（uq_gw_office_events_recurring）でも止まる。まとめて入れて一意の衝突が出たら、
//   1件ずつ入れ直して衝突したものだけ飛ばす（同時に2か所で作っても二重にならない）。
//
// ■ マスターを直したとき（syncMaster）
//   今日以降の「未完了」の予定だけ消して作り直す（業務名・担当・期限の変更を先の予定へ反映）。完了・今回なし・過去の予定は残す。
//   停止したときは、今日以降の未完了の予定を消すだけ。

import { planGeneration, periodKeyOf, HORIZON_DAYS, addDays } from "./office-recurring.js";

export const MASTER_FIELDS = "id, tenant_id, title, description, category, assignee_employee_id, department, priority, note, url, "
  + "recurrence_type, recurrence_rule, start_on, end_on, due_rule, is_active, source, source_key, created_at, updated_at";
export const EVENT_FIELDS = "id, tenant_id, recurring_task_id, title, description, category, event_date, due_on, assignee_employee_id, "
  + "department, priority, note, url, status, source, source_id, completed_at, completed_by, completed_by_name, created_at, updated_at";

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

/**
 * 予定を作る。作った件数を返す
 * @param {{preserveTerminalPeriod?: boolean}} [opts]
 *   preserveTerminalPeriod … 同じマスターのその期（毎月＝その月／毎年＝その年）に、完了・今回なしの回がすでにあれば作らない。
 *   Excel 最新版の同期（基準日の変更）だけで使う：11/5 を完了したあと 5日→6日 に変えても、11/6 を作って11月を2件にしない。
 *   手動でマスターを直したときの動き（syncMaster）は変えない
 */
export async function generate(sb, masters, { from, to }, { preserveTerminalPeriod = false } = {}) {
  const list = (masters || []).filter((m) => m.is_active);
  if (!list.length || from > to) return 0;
  const have = new Set();
  const donePeriods = preserveTerminalPeriod ? new Set() : null;
  const readFrom = preserveTerminalPeriod ? `${from.slice(0, 4)}-01-01` : addDays(from, -7);   // 毎年の業務は、その年の初めから見る
  // すでにある回（状態は問わない）。マスターごとに範囲で読む
  const byId = new Map(list.map((m) => [m.id, m]));
  for (let i = 0; i < list.length; i += 100) {
    const ids = list.slice(i, i + 100).map((m) => m.id);
    const rows = await must(sb.from("gw_office_calendar_events").select("recurring_task_id, event_date, status")
      .in("recurring_task_id", ids).gte("event_date", readFrom).lte("event_date", addDays(to, 7)).limit(20000));
    for (const r of rows || []) {
      have.add(`${r.recurring_task_id}|${r.event_date}`);
      if (donePeriods && (r.status === "done" || r.status === "skipped")) {
        const pk = periodKeyOf(byId.get(r.recurring_task_id), r.event_date);
        if (pk) donePeriods.add(`${r.recurring_task_id}|${pk}`);
      }
    }
  }
  const rows = planGeneration(list, have, { from, to }, { donePeriods });
  if (!rows.length) return 0;
  let made = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await sb.from("gw_office_calendar_events").insert(chunk);
    if (!error) { made += chunk.length; continue; }
    if (error.code !== "23505") throw error;
    // 同時に作られた回がある。1件ずつ入れて、衝突したものは飛ばす
    for (const r of chunk) {
      const { error: e1 } = await sb.from("gw_office_calendar_events").insert(r);
      if (!e1) made++;
      else if (e1.code !== "23505") throw e1;
    }
  }
  return made;
}

/** マスターを直した・止めた・再開したあと。今日以降の未完了の予定を作り直す */
export async function syncMaster(sb, master, today) {
  await must(sb.from("gw_office_calendar_events").delete()
    .eq("recurring_task_id", master.id).eq("status", "pending").gte("event_date", today).select("id"));
  if (!master.is_active) return 0;
  return generate(sb, [master], { from: today, to: addDays(today, HORIZON_DAYS) });
}

/** テナントの有効なマスター（生成用） */
export async function activeMasters(sb, tenantId) {
  let q = sb.from("gw_office_recurring_tasks").select(MASTER_FIELDS).eq("is_active", true).limit(2000);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  return (await must(q)) || [];
}
