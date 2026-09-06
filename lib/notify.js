// 社内通知の作成ヘルパ。
//
// 通知は「用件ごとに1件」にまとめる。dedupe_key を同じにしておくと、
// 同じスレッドへの連投で通知が積み上がらず、最新の内容で上書きされる。
//
// 失敗しても本処理（メッセージの投稿など）は止めない。届かない通知より、
// 送れないメッセージのほうが困るため。

import { admin } from "./supabase.js";

/**
 * @param {object[]} rows { tenantId, employeeId, kind, title, body?, link?, dedupeKey? }
 * @param {{replace?: boolean}} opts replace=true なら同じ dedupe_key を上書きして未読に戻す
 */
export async function notify(rows, { replace = true } = {}) {
  const list = (rows || []).filter((r) => r?.tenantId && r?.employeeId && r?.title);
  if (!list.length) return { created: 0 };

  const now = new Date().toISOString();
  const payload = list.map((r) => ({
    tenant_id: r.tenantId,
    employee_id: r.employeeId,
    kind: r.kind || "general",
    title: r.title,
    body: r.body ?? null,
    link: r.link ?? null,
    dedupe_key: r.dedupeKey ?? null,
    read_at: null,
    created_at: now,
  }));

  try {
    const { data, error } = await admin()
      .from("gw_notifications")
      .upsert(payload, { onConflict: "employee_id,dedupe_key", ignoreDuplicates: !replace })
      .select("id");
    if (error) throw error;

    // 決めた種類だけ、デスクトップにも出す
    await pushIfImportant(list).catch((e) =>
      console.error("[notify] push failed:", e?.message || e));

    return { created: (data || []).length };
  } catch (e) {
    console.error("[notify] failed:", e?.message || e);
    return { created: 0, error: String(e?.message || e) };
  }
}

// ---- デスクトップ通知に回すもの ---------------------------------------------
//
// ■ 1日3回の声かけ以外で、割り込んでよいもの
//   止まっていること（blocker）
//   期限を過ぎた・迫っているタスク（task_overdue）
//   人からのメッセージ（message）
//   面談・研修（meeting）
//
//   申請の承認待ち（expense / request / booking）と、お知らせ（notice）は
//   ここに入れない。急がないものまで割り込むと、
//   そのうち全部が無視されるようになる。ベルには出るので、見落としはしない。
//
// ■ 押すまで消えないもの
//   止まっていることと期限だけ。放っておくと止まったままになるため。
const PUSH_KINDS = new Set(["blocker", "task_overdue", "message", "meeting"]);
const STICKY_KINDS = new Set(["blocker", "task_overdue"]);

async function pushIfImportant(rows) {
  const targets = rows.filter((r) => PUSH_KINDS.has(r.kind));
  if (!targets.length) return;

  // 動的に読む。VAPID 未設定の環境で、通知そのものを止めないため
  const { pushConfigured, sendToDevices } = await import("./webpush.js");
  if (!pushConfigured()) return;

  const sb = admin();
  const ids = [...new Set(targets.map((r) => r.employeeId))];
  const { data: subs } = await sb.from("gw_push_subs")
    .select("id, employee_id, endpoint, p256dh, auth, fail_count")
    .in("employee_id", ids);
  if (!subs?.length) return;

  // 通知そのものを止めている人には送らない
  const { data: prefs } = await sb.from("gw_reminder_prefs")
    .select("employee_id, enabled").in("employee_id", ids);
  const off = new Set((prefs || []).filter((p) => p.enabled === false).map((p) => p.employee_id));

  const byEmp = new Map();
  for (const s of subs) {
    if (off.has(s.employee_id)) continue;
    if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, []);
    byEmp.get(s.employee_id).push(s);
  }

  for (const r of targets) {
    const devices = byEmp.get(r.employeeId);
    if (!devices?.length) continue;
    await sendToDevices(sb, devices, {
      title: r.title,
      body: r.body || "",
      url: r.link ? `/${String(r.link).replace(/^\//, "")}` : "/home.html",
      // 同じ用件の通知は積み上げない
      tag: r.dedupeKey || `kind:${r.kind}`,
      sticky: STICKY_KINDS.has(r.kind),
    });
  }
}

/** 用件が片付いたときに、対応する通知を既読にする */
export async function clearNotification(employeeId, dedupeKey) {
  if (!employeeId || !dedupeKey) return;
  try {
    await admin()
      .from("gw_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("employee_id", employeeId)
      .eq("dedupe_key", dedupeKey)
      .is("read_at", null);
  } catch (e) {
    console.error("[notify] clear failed:", e?.message || e);
  }
}
