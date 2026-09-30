// GET   /api/hr/retention                 … 種別ごとの期限・期限が来る人・削除の記録
// PATCH /api/hr/retention {kind, months, autoDelete} … 期限を変える
// POST  /api/hr/retention {action:"delete", employeeId, kind, confirm:true} … 手で消す
//
// ■ 消すのは人事・管理者だけ。二段階認証つき
//   取り消しがきかない。誰が押したかを残す（gw_retention_log と gw_activity_log）。
//
// ■ 「期限が来た」と「消した」は別
//   期限が来ても、auto_delete を付けていない種別は消さない。一覧に出るだけ。
//   消す判断は人がする。自動で消すと決めた種別だけ cron が消す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { logSensitive } from "../../lib/sensitive-log.js";
import {
  RETENTION_KEYS, kindOf, rulesWith, scheduleOf, collectPeople, deleteFor,
} from "../../lib/retention.js";

const SQL = "db/071_onboarding_stage2.sql";
const SENSITIVE_KIND = { resume: "file", identity: "file", bank: "bank", contract: "contract", profile: "profile" };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(res, ctx);
  if (req.method === "PATCH") return setRule(res, ctx, user, await readJson(req));
  if (req.method === "POST") return remove(req, res, ctx, user, await readJson(req));
  return methodNotAllowed(res, ["GET", "PATCH", "POST"]);
}

const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

async function read(res, ctx) {
  const sb = admin();
  const { data: rows, error } = await sb.from("gw_retention_rules")
    .select("kind, months, auto_delete, updated_at").eq("tenant_id", ctx.tenantId);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  const rules = rulesWith(rows || []);
  const people = await collectPeople(sb, ctx.tenantId);
  const schedule = scheduleOf(rules, people, today());
  const { data: log } = await sb.from("gw_retention_log")
    .select("id, subject_name, kind, target, label, actor_name, reason, due_on, deleted_at")
    .eq("tenant_id", ctx.tenantId).order("deleted_at", { ascending: false }).limit(100);

  return json(res, 200, {
    today: today(),
    rules,
    schedule,
    expired: schedule.filter((s) => s.expired).length,
    log: (log || []).map((l) => ({
      id: l.id, name: l.subject_name, kind: l.kind, kindLabel: kindOf(l.kind)?.label || l.kind,
      label: l.label, target: l.target, by: l.actor_name || "自動", reason: l.reason,
      dueOn: l.due_on, at: l.deleted_at,
    })),
  });
}

async function setRule(res, ctx, user, body) {
  const kind = String(body?.kind || "");
  if (!RETENTION_KEYS.includes(kind)) return json(res, 400, { error: "bad_request", hint: "種別が違います" });
  const months = Number(body?.months);
  if (!Number.isInteger(months) || months < 1 || months > 240) {
    return json(res, 400, { error: "bad_request", hint: "月数は 1〜240 で" });
  }
  const sb = admin();
  const { error } = await sb.from("gw_retention_rules").upsert({
    tenant_id: ctx.tenantId, kind, months, auto_delete: body?.autoDelete === true,
    updated_by: user.id, updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,kind" });
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_upsert_failed", detail: error.message });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retention.rule",
                target: `retention:${kind}`, detail: { months, autoDelete: body?.autoDelete === true } });
  return json(res, 200, { ok: true });
}

async function remove(req, res, ctx, user, body) {
  if (body?.action !== "delete") return json(res, 400, { error: "unknown_action" });
  const kind = String(body.kind || "");
  const rule = kindOf(kind);
  if (!rule) return json(res, 400, { error: "bad_request", hint: "種別が違います" });
  if (!body.employeeId) return json(res, 400, { error: "bad_request", required: ["employeeId"] });
  if (body.confirm !== true) return json(res, 400, { error: "confirm_required", hint: "確認のチェックが要ります" });

  const sb = admin();
  const { data: emp } = await sb.from("gw_employees").select("id, display_name")
    .eq("id", body.employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const r = await deleteFor(sb, {
    tenantId: ctx.tenantId, employeeId: emp.id, kind,
    actor: { id: user.id, name: ctx.employee?.display_name || user.email || null },
    reason: "manual", dueOn: body.dueOn || null,
  });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retention.delete",
                target: `employee:${emp.id}`,
                detail: { name: emp.display_name, kind, deleted: r.deleted, errors: r.errors.length } });
  await logSensitive({
    tenantId: ctx.tenantId, actor: { id: user.id, name: ctx.employee?.display_name },
    subjectId: emp.id, selfId: ctx.employee?.id,
    kind: SENSITIVE_KIND[kind] || "file", action: "delete",
    target: `retention:${kind}`, detail: { deleted: r.deleted }, req,
  });
  return json(res, 200, { ok: true, deleted: r.deleted, logged: r.log, errors: r.errors });
}
