// タスクの履歴。作成・担当変更・期限変更・AI提案・完了・持ち越し。
//
// ■ 追記だけ
//   更新も削除もしない。「いつ誰が変えたか」を後から読むためのもの。
//
// ■ 残らなくても、元の操作は止めない
//   073 をまだ流していない環境では表が無い。そこで落ちて
//   「担当を変えられません」になるのは本末転倒。console に出すだけにする。
//
// ■ 会社の監査ログとは別
//   gw_activity_log は社員には見せない。こちらは担当者と頼んだ人が読む。
//   混ぜると、見せてよいものと見せてはいけないものが同じ表に並ぶ。

import { admin } from "./supabase.js";

/**
 * @param {object} e
 *   tenantId  事業者
 *   taskId    gw_tasks.id
 *   kind      created|assigned|due|priority|status|focus|ai|carry|comment|edited
 *   actor     { id, name }
 *   detail    { from, to, ... }  kind ごとに決める
 */
export async function taskEvent(e) {
  if (!e?.tenantId || !e?.taskId || !e?.kind) return;
  try {
    const { error } = await admin().from("gw_task_events").insert({
      tenant_id: e.tenantId,
      task_id: e.taskId,
      kind: e.kind,
      actor_id: e.actor?.id ?? null,
      actor_name: e.actor?.name ?? null,
      detail: e.detail ?? null,
    });
    if (error) throw error;
  } catch (err) {
    console.error("[task-log] 履歴を残せませんでした:", err?.message || err);
  }
}

/** まとめて残す（1回の操作で2つ以上変わったとき） */
export async function taskEvents(base, list) {
  for (const e of list || []) {
    if (!e) continue;
    await taskEvent({ ...base, ...e });
  }
}
