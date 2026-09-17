// 業務イベント → 共通タスクの自動生成エンジン。
//
// ■ 考え方
//
//   イベントを別の表に貯めない。呼び出し側（api/cron/task-events.js や、
//   手続きの作成など「事が起きたその場」）が「いまの事実」から対象を数え、
//   1件ぶんを buildTask() で gw_tasks の1行にして、runEventTasks() に渡すだけ。
//
//   タスクの置き場所は増やさない（db/068 と同じ gw_tasks）。
//   一覧・ホーム・ドロワーは今までどおり。機能ごとに別のチェックリストや
//   通知の仕組みを持たせない（GW統合方針）。
//
// ■ 二重生成の防止
//
//   db/068_task_flow.sql の occ_key（繰り返しタスクの二重防止に使っている列）を
//   そのまま使う。繰り返しタスクは `<template_id>|<YYYY-MM-DD>` という形を
//   使っているので、業務イベントは `evt:<イベントの種類>:<対象>` という
//   別の形にして、絶対にぶつからないようにしてある。
//
//   一意制約（gw_tasks_occ_key_uidx）はテーブル全体に1つなので、
//   このファイルを経由しない限り occ_key の形を変えないこと。
//
// ■ 一度作ったら、作り直さない
//
//   対象が「まだ済んでいない」ままでも、同じ occ_key のタスクは1件しか
//   できない（繰り返しタスクで cancelled にした回を作り直さないのと同じ）。
//   片付いたら status を変えるだけで、次の周期はまた別の occ_key
//   （月初タスクなら月が変わる、等）で1件できる。

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.eventKey   イベントの種類。例: "device_missing" "contract_expiry"
 * @param {string} p.entityId   対象を一意に決める文字列（社員IDだけ／社員ID+年月など）
 * @param {string} p.title
 * @param {string|null} [p.body]
 * @param {string|null} [p.assigneeId]
 * @param {string|null} [p.escalateTo]
 * @param {string|null} [p.dueOn]     YYYY-MM-DD
 * @param {string} p.category
 * @param {"low"|"normal"|"high"} [p.priority]
 * @param {string|null} [p.link]      押すと開く画面
 * @param {string|null} [p.createdBy]
 */
export function buildTask({
  tenantId, eventKey, entityId, title, body = null,
  assigneeId = null, escalateTo = null, dueOn = null,
  category, priority = "normal", link = null, createdBy = null,
}) {
  return {
    tenant_id: tenantId,
    title, body,
    assignee_id: assigneeId,
    escalate_to: escalateTo,
    due_on: dueOn,
    priority,
    status: "todo",
    category,
    link,
    created_by: createdBy,
    occ_key: `evt:${eventKey}:${entityId}`,
  };
}

/**
 * buildTask() で作った行を、まとめて流す。
 * 既にある occ_key は静かに無視する（何度呼んでも増えない）。
 *
 * @param {object} sb  admin() クライアント（service_role。cron・イベント発火時に使う）
 * @param {object[]} rows
 * @returns {Promise<{made:number, skipped:number}>}
 */
export async function runEventTasks(sb, rows) {
  const out = { made: 0, skipped: 0 };
  if (!rows?.length) return out;

  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error, count } = await sb.from("gw_tasks")
      .upsert(chunk, { onConflict: "occ_key", ignoreDuplicates: true, count: "exact" });
    if (error) {
      console.error("[task-events] insert", error.message);
      out.skipped += chunk.length;
      continue;
    }
    out.made += count ?? chunk.length;
  }
  return out;
}
