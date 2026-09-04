// GET /api/cron/escalate
// 期限を過ぎた未完了タスクを拾い、担当者と「期限超過時の連絡先」に通知を作る。
// Vercel Cron から1日1回呼ばれる（vercel.json の crons を参照）。
//
// 認証:
//   CRON_SECRET が設定されていれば Authorization: Bearer <secret> を要求する。
//   Vercel Cron はこのヘッダを自動で付ける。手動で叩くときも同じヘッダが要る。
//   未設定なら誰でも叩けてしまうため、必ず設定すること。
//
// 冪等性:
//   gw_notifications の (employee_id, dedupe_key) が一意なので、
//   同じタスクについて何度実行しても通知は増えない。
//   タスク側にも escalated_at を立てて、処理済みが分かるようにする。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";

const MAX_TASKS = 500;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const today = new Date().toISOString().slice(0, 10);

  const { data: tasks, error } = await sb
    .from("gw_tasks")
    .select("id, tenant_id, title, due_on, assignee_id, escalate_to, escalated_at")
    .in("status", ["todo", "doing"])
    .lt("due_on", today)
    .is("escalated_at", null)
    .limit(MAX_TASKS);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  const list = tasks || [];
  if (!list.length) return json(res, 200, { ok: true, checked: 0, notified: 0 });

  const rows = [];
  for (const t of list) {
    const overdueDays = daysBetween(t.due_on, today);
    const body = `期限は ${formatDate(t.due_on)}（${overdueDays}日超過）です。`;

    // 担当者へ
    if (t.assignee_id) {
      rows.push({
        tenant_id: t.tenant_id, employee_id: t.assignee_id, kind: "task_overdue",
        title: `期限が過ぎています：${t.title}`, body, link: "tasks.html",
        dedupe_key: `task_overdue:${t.id}`,
      });
    }
    // 責任者へ（担当者と同じ人なら重ねない）
    if (t.escalate_to && t.escalate_to !== t.assignee_id) {
      rows.push({
        tenant_id: t.tenant_id, employee_id: t.escalate_to, kind: "task_overdue",
        title: `担当分が期限超過です：${t.title}`, body, link: "admin-tasks.html",
        dedupe_key: `task_overdue:${t.id}`,
      });
    }
  }

  let notified = 0;
  if (rows.length) {
    // 同じ用件の通知は作り直さない
    const { data: made, error: ie } = await sb
      .from("gw_notifications")
      .upsert(rows, { onConflict: "employee_id,dedupe_key", ignoreDuplicates: true })
      .select("id");
    if (ie) return json(res, 500, { error: "db_insert_failed", detail: ie.message });
    notified = (made || []).length;
  }

  // 通知を作れたかに関わらず、拾い直さないよう印を付ける
  const now = new Date().toISOString();
  const { error: ue } = await sb
    .from("gw_tasks")
    .update({ escalated_at: now })
    .in("id", list.map((t) => t.id));
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  return json(res, 200, { ok: true, checked: list.length, notified });
}

function daysBetween(from, to) {
  const ms = new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86400000));
}

function formatDate(d) {
  const [y, m, day] = String(d).split("-");
  return `${Number(m)}月${Number(day)}日`;
}
