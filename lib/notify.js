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
    return { created: (data || []).length };
  } catch (e) {
    console.error("[notify] failed:", e?.message || e);
    return { created: 0, error: String(e?.message || e) };
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
