// GET /api/cron/reminders
// 15分おきに回して、その時刻に来ている人へ声をかける。
//
// ■ 監視ではなく、リズムを作るためのもの
//     ゴールを決める → 動く → 途中で見る → 日報 → AI → 翌日の最初の一手
//   区切りで一声かけるだけ。誰が押したかを集計する仕組みにはしない。
//
// ■ 済んでいる人には送らない
//   朝の入力が終わっていれば朝の通知は出さない。
//   日報を出していれば、昼も夜も出さない。
//   終わったことを催促されるのが、いちばん通知を切りたくなる。
//
// ■ 時刻は人ごと
//   本人が決めていれば その時刻。
//   決めていなければ 勤務時間（gw_contracts.work_hours）から
//   始業 / まんなか / 終業15分前 を出す（lib/reminders.js）。
//
// ■ 二重送信
//   gw_reminder_log の (社員, 日付, 枠) が主キー。
//   先に記録してから送るので、cron が重なっても2回送らない。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { sendToDevices, pushConfigured } from "../../lib/webpush.js";
import { SLOTS, slotDueAt, jstNow } from "../../lib/reminders.js";
import { notify } from "../../lib/notify.js";

const SLOT_BY_KEY = new Map(SLOTS.map((s) => [s.key, s]));

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const now = jstNow();
  const sb = admin();
  const out = { at: `${now.date} ${now.hhmm}`, weekday: now.weekday, due: 0, sent: 0, skipped: 0, devices: 0 };

  if (!pushConfigured()) {
    return json(res, 200, { ...out, note: "VAPID の鍵が未設定のため、送信はしていません" });
  }

  // 通知を許可している人だけを見る。端末が1つも無い人は対象外
  const { data: subs, error } = await sb
    .from("gw_push_subs")
    .select("id, tenant_id, employee_id, endpoint, p256dh, auth, fail_count")
    .limit(1000);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!subs?.length) return json(res, 200, { ...out, note: "通知を許可している端末がありません" });

  const empIds = [...new Set(subs.map((s) => s.employee_id))];
  const byEmp = new Map();
  for (const s of subs) {
    if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, []);
    byEmp.get(s.employee_id).push(s);
  }

  const [{ data: emps }, { data: prefsRows }, { data: contracts }] = await Promise.all([
    sb.from("gw_employees").select("id, tenant_id, user_id, display_name, status").in("id", empIds),
    sb.from("gw_reminder_prefs").select("*").in("employee_id", empIds),
    sb.from("gw_contracts").select("employee_id, work_hours, created_at")
      .in("employee_id", empIds).eq("status", "active").order("created_at", { ascending: false }),
  ]);

  const prefsBy = new Map((prefsRows || []).map((p) => [p.employee_id, p]));
  const hoursBy = new Map();
  for (const c of contracts || []) if (!hoursBy.has(c.employee_id)) hoursBy.set(c.employee_id, c.work_hours);

  // 今日の日報。朝が済んでいるか・出したかを見る
  const userIds = (emps || []).map((e) => e.user_id).filter(Boolean);
  const { data: nippos } = userIds.length
    ? await sb.from("tc_nippo").select("user_id, morning_at, submitted_at")
        .eq("work_date", now.date).in("user_id", userIds)
    : { data: [] };
  const nippoBy = new Map((nippos || []).map((n) => [n.user_id, n]));

  for (const emp of emps || []) {
    // 退職した人には送らない。入社準備中の人には、まだ書くものが無い
    if (emp.status !== "active" && emp.status !== "leaving") continue;

    const prefs = prefsBy.get(emp.id) || null;
    const slot = slotDueAt(prefs, hoursBy.get(emp.id), now.hhmm);
    if (!slot) continue;

    const days = prefs?.workdays || [1, 2, 3, 4, 5];
    if (!days.includes(now.weekday)) continue;

    out.due++;

    // もう終わっているなら、声をかけない
    const n = nippoBy.get(emp.user_id) || null;
    if (n?.submitted_at) { out.skipped++; continue; }
    if (slot === "morning" && n?.morning_at) { out.skipped++; continue; }

    // 先に記録する。ここで衝突したら、別の実行がもう送っている
    const { error: le } = await sb.from("gw_reminder_log")
      .insert({ employee_id: emp.id, on_date: now.date, slot, devices: 0 });
    if (le) { out.skipped++; continue; }

    const s = SLOT_BY_KEY.get(slot);
    const r = await sendToDevices(sb, byEmp.get(emp.id) || [], {
      title: s.title,
      body: s.body,
      url: s.url,
      tag: s.tag,
    });

    await sb.from("gw_reminder_log")
      .update({ devices: r.sent })
      .eq("employee_id", emp.id).eq("on_date", now.date).eq("slot", slot);

    // ベルにも残す。通知を見逃しても、画面を開けば分かるように。
    // 3つとも同じ dedupe_key にして、1日1件だけ残す
    await notify([{
      tenantId: emp.tenant_id, employeeId: emp.id,
      kind: "general", title: s.title, body: s.body,
      link: s.url.replace(/^\//, ""),
      dedupeKey: `rhythm:${now.date}`,
    }]);

    out.sent++;
    out.devices += r.sent;
  }

  return json(res, 200, out);
}
